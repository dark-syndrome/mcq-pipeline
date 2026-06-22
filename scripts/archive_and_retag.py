#!/usr/bin/env python
"""
scripts/archive_and_retag.py

One-time maintenance to give the question bank a clean slate before new runs:

  1. Re-tag every PASSED question that lacks a valid module tag, using the LLM to
     classify it into exactly one of the 8 GRIT Robotics L1 modules.
  2. Drop any question the LLM cannot place in one of those 8 modules.
  3. Write every surviving question into a single eval set (eval-sets/), carrying
     its module tag in the currently-defined tag structure.
  4. Consolidate the survivors in the DB under ONE new run (generation 1) and
     delete all other runs + all rejected questions, so the Generations tab is
     a single clean entry and the next real run becomes generation 2.

Safety:
  * runs.db is copied to a timestamped backup before any mutation.
  * LLM classifications are cached to output/retag_classifications.json so
    re-runs never repeat the calls.
  * The DB is only mutated when --apply is passed. Without it the script does
    classification + eval-set + a full dry-run report only.

Usage:
    python scripts/archive_and_retag.py            # classify + eval set + REPORT (no DB change)
    python scripts/archive_and_retag.py --apply    # also consolidate + prune the DB
    python scripts/archive_and_retag.py --refresh   # ignore cache, re-run LLM classification
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

# Make the package importable when run as a loose script.
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from pydantic import BaseModel  # noqa: E402

from mcq_agent import storage  # noqa: E402
from mcq_agent.config import load_config, load_dotenv_and_get_api_key  # noqa: E402
from mcq_agent.llm_client import make_client  # noqa: E402

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MODULES: list[str] = [
    "LINUX_ROS2_FUNDAMENTALS",
    "ROBOT_MODELLING",
    "ROBOT_MATHEMATICS",
    "SIMULATION",
    "SLAM",
    "NAVIGATION",
    "COMPUTER_VISION",
    "EMBEDDED_SYSTEMS",
]
MODULE_SET = set(MODULES)
COURSE_TAG = "GRIT_ROBOTICS_L1_MAIN"

MODULE_GUIDE = """\
- LINUX_ROS2_FUNDAMENTALS: Linux shell and ROS 2 core — nodes, topics, services,
  actions, parameters, packages, colcon build, workspace sourcing, launch files,
  ros2 CLI tools, rclpy/rclcpp basics.
- ROBOT_MODELLING: robot description — URDF/XACRO, links, joints, visual /
  collision / inertial elements, TF frames, robot_state_publisher, meshes.
- ROBOT_MATHEMATICS: kinematics and the maths — differential-drive velocity
  equations, forward/inverse kinematics, odometry derivation, rotations,
  transforms as equations, wheelbase / wheel-radius calculations.
- SIMULATION: Gazebo and simulation — worlds, spawning robots, Gazebo sensor
  plugins (ray/LiDAR, camera in sim), physics, sim time.
- SLAM: mapping and localisation — SLAM Toolbox, occupancy grids, scan matching,
  loop closure, posegraph serialization, map building.
- NAVIGATION: Nav2 stack — costmaps, inflation, global/local planners (DWB),
  AMCL, waypoint following, recovery behaviours, BasicNavigator.
- COMPUTER_VISION: vision — OpenCV, cv_bridge, image processing, thresholding,
  contours, ArUco markers, camera intrinsics, pose estimation from images.
- EMBEDDED_SYSTEMS: microcontrollers and hardware — ESP32 / Arduino, serial
  communication, baud rate, encoders, UART, hardware interfacing, rosserial.
"""

SYSTEM_PROMPT = (
    "You are a strict classifier for a robotics curriculum. Assign each question "
    "to EXACTLY ONE of these 8 modules by its PRIMARY topic. If a question does "
    "not clearly belong to any module, answer NONE.\n\n"
    f"MODULES:\n{MODULE_GUIDE}\n"
    "Use the question text and its source_heading. Respond with the module token "
    "EXACTLY as written above (uppercase, underscores), or NONE."
)

BATCH_SIZE = 12
CACHE_PATH = REPO_ROOT / "output" / "retag_classifications.json"
EVAL_DIR = REPO_ROOT / "eval-sets"
EVAL_NAME = "Archived Question Bank"


# ---------------------------------------------------------------------------
# LLM classification response schema
# ---------------------------------------------------------------------------


class _ClsItem(BaseModel):
    id: int
    module: str


class _ClsBatch(BaseModel):
    items: list[_ClsItem]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _basename(p: str) -> str:
    return os.path.basename(str(p).replace("\\", "/")) if p else ""


def _stem(text: str, limit: int = 320) -> str:
    t = " ".join(str(text).split())
    return t if len(t) <= limit else t[:limit] + "…"


def load_passed_rows(conn: sqlite3.Connection) -> list[dict]:
    """Every passed MCQ joined to its run's input_file."""
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT m.id AS id, m.run_id AS run_id, m.question_number AS qnum,
               m.mcq_json AS mcq_json, r.input_file AS input_file
          FROM mcqs m
          LEFT JOIN runs r ON r.run_id = m.run_id
         WHERE m.passed = 1
        """
    ).fetchall()
    out: list[dict] = []
    for r in rows:
        try:
            mcq = json.loads(r["mcq_json"])
        except (json.JSONDecodeError, TypeError):
            continue
        out.append(
            {
                "id": r["id"],
                "run_id": r["run_id"],
                "qnum": r["qnum"],
                "input_file": r["input_file"] or "",
                "mcq": mcq,
            }
        )
    return out


def load_cache() -> dict[str, str]:
    if CACHE_PATH.exists():
        try:
            return json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def save_cache(cache: dict[str, str]) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    CACHE_PATH.write_text(json.dumps(cache, indent=2), encoding="utf-8")


def classify(need: list[dict], cache: dict[str, str], refresh: bool) -> dict[int, str]:
    """Return {mcq_id: MODULE or 'NONE'} for every row in *need*, using cache."""
    result: dict[int, str] = {}
    todo: list[dict] = []
    for row in need:
        key = str(row["id"])
        if not refresh and key in cache:
            result[row["id"]] = cache[key]
        else:
            todo.append(row)

    if not todo:
        print(f"  classification: all {len(need)} from cache")
        return result

    settings = load_config()
    api_key = load_dotenv_and_get_api_key(settings.provider)
    # Disable headroom compression — it could mangle the per-question ids in the
    # prompt and break the id→module mapping.
    client = make_client(
        provider=settings.provider.value,
        api_key=api_key,
        default_model=settings.model,
        max_retries=settings.api_max_retries,
        initial_backoff=settings.api_retry_initial_backoff,
        use_headroom=False,
    )
    print(f"  classification: {len(result)} cached, {len(todo)} to call "
          f"({settings.provider.value} / {settings.model})")

    for start in range(0, len(todo), BATCH_SIZE):
        batch = todo[start:start + BATCH_SIZE]
        lines = []
        for row in batch:
            m = row["mcq"]
            lines.append(
                f"[id={row['id']}] heading: {m.get('source_heading', '') or '(none)'}\n"
                f"Q: {_stem(m.get('question', ''))}"
            )
        prompt = (
            "Classify each question into one module token (or NONE).\n\n"
            + "\n\n".join(lines)
        )
        resp, _usage = client.call(
            prompt=prompt,
            response_model=_ClsBatch,
            temperature=0.0,
            max_tokens=1500,
            system_prompt=SYSTEM_PROMPT,
        )
        got = {item.id: item.module for item in resp.items}
        for row in batch:
            raw = str(got.get(row["id"], "NONE")).strip().upper().replace(" ", "_")
            module = raw if raw in MODULE_SET else "NONE"
            result[row["id"]] = module
            cache[str(row["id"])] = module
        save_cache(cache)
        done = min(start + BATCH_SIZE, len(todo))
        print(f"    classified {done}/{len(todo)}")

    return result


def build_tags(module: str, bloom: str) -> list[str]:
    """[MODULE, BLOOM_LEVEL, IS_PUBLIC, COURSE_TAG] — the currently-defined structure."""
    return [module, str(bloom).upper(), "IS_PUBLIC", COURSE_TAG]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="mutate the DB (consolidate + prune)")
    ap.add_argument("--refresh", action="store_true", help="ignore cache, re-run LLM classification")
    ap.add_argument("--db", default=str(REPO_ROOT / "logs" / "runs.db"))
    args = ap.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        sys.exit(f"DB not found: {db_path}")

    conn = sqlite3.connect(str(db_path))
    rows = load_passed_rows(conn)
    print(f"Passed questions: {len(rows)}")

    already_valid = [r for r in rows if (r["mcq"].get("sub_topic") in MODULE_SET)]
    need = [r for r in rows if (r["mcq"].get("sub_topic") not in MODULE_SET)]
    print(f"  already tagged with a valid module: {len(already_valid)}")
    print(f"  need LLM classification:            {len(need)}")

    cache = load_cache()
    assigned = classify(need, cache, args.refresh)

    # Partition the classified rows.
    newly_tagged: list[tuple[dict, str]] = []
    dropped: list[dict] = []
    for r in need:
        module = assigned.get(r["id"], "NONE")
        if module in MODULE_SET:
            newly_tagged.append((r, module))
        else:
            dropped.append(r)

    # Final survivors = already-valid (keep their module) + newly-tagged.
    survivors: list[tuple[dict, str]] = [
        (r, r["mcq"]["sub_topic"]) for r in already_valid
    ] + newly_tagged

    # Distribution report.
    dist: dict[str, int] = {m: 0 for m in MODULES}
    for _r, module in survivors:
        dist[module] += 1
    print("\nModule distribution of survivors:")
    for m in MODULES:
        print(f"  {m:<28} {dist[m]}")
    print(f"  {'(dropped — no module)':<28} {len(dropped)}")
    print(f"\nSurvivors kept: {len(survivors)}  |  Dropped: {len(dropped)}")

    # ----- Build + write the eval set (always; non-destructive) -----
    now = datetime.now(timezone.utc).isoformat()
    eval_questions = []
    for seq, (r, module) in enumerate(survivors, start=1):
        m = r["mcq"]
        bloom = m.get("bloom_level", "")
        eq = {
            "id": r["id"],
            "run_id": r["run_id"],
            "question_number": seq,
            "generation_number": 1,
            "source_file": _basename(r["input_file"]),
            "question": m.get("question", ""),
            "options": m.get("options", []),
            "explanation": m.get("explanation"),
            "source_excerpt": m.get("source_excerpt"),
            "source_heading": m.get("source_heading", ""),
            "bloom_level": bloom,
            "difficulty": m.get("difficulty", ""),
            "question_type": m.get("question_type", ""),
            "sub_topic": module,
            "tags": build_tags(module, bloom),
            "passed": True,
            "annotation": {"rating": 0, "confirmed": None, "notes": ""},
        }
        if m.get("ordering_statements"):
            eq["ordering_statements"] = m["ordering_statements"]
        eval_questions.append(eq)

    eval_set = {"name": EVAL_NAME, "created_at": now, "questions": eval_questions}
    EVAL_DIR.mkdir(parents=True, exist_ok=True)
    eval_path = EVAL_DIR / f"{EVAL_NAME}.json"
    eval_path.write_text(json.dumps(eval_set, indent=2), encoding="utf-8")
    print(f"\nEval set written: {eval_path}  ({len(eval_questions)} questions)")

    if not args.apply:
        print("\n[dry-run] DB not modified. Re-run with --apply to consolidate + prune.")
        conn.close()
        return

    # ----- Apply: back up, consolidate under one run, prune the rest -----
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = db_path.with_suffix(db_path.suffix + f".bak-{ts}")
    shutil.copy2(db_path, backup)
    print(f"\nBacked up DB → {backup}")

    new_run_id = str(uuid.uuid4())
    run_cols = {row[1] for row in conn.execute("PRAGMA table_info(runs)")}
    run_values = {
        "run_id": new_run_id,
        "timestamp": now,
        "input_file": "ARCHIVE",
        "config_json": "{}",
        "generated_count": len(survivors),
        "passed_count": len(survivors),
        "total_input_tokens": 0,
        "total_output_tokens": 0,
        "cost_usd": 0.0,
        "generation_number": 1,
        "run_name": EVAL_NAME,
        "topic_tag": None,
        "course_tag": COURSE_TAG,
        "subtopics_json": json.dumps(MODULES),
    }
    cols = [c for c in run_values if c in run_cols]

    try:
        conn.execute("BEGIN")
        conn.execute(
            f"INSERT INTO runs ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
            [run_values[c] for c in cols],
        )
        # Re-point + re-tag each survivor under the new run.
        for seq, (r, module) in enumerate(survivors, start=1):
            m = r["mcq"]
            m["sub_topic"] = module
            m["tags"] = build_tags(module, m.get("bloom_level", ""))
            m["generation_number"] = 1
            m["question_number"] = seq
            conn.execute(
                "UPDATE mcqs SET run_id = ?, mcq_json = ?, question_number = ?, passed = 1 WHERE id = ?",
                (new_run_id, json.dumps(m), seq, r["id"]),
            )
        # Everything still pointing at an old run = rejected + dropped → remove.
        conn.execute("DELETE FROM mcqs WHERE run_id != ?", (new_run_id,))
        conn.execute("DELETE FROM runs WHERE run_id != ?", (new_run_id,))
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        shutil.copy2(backup, db_path)
        print("ERROR during DB mutation — rolled back and restored from backup.")
        raise

    # Verify.
    n_runs = conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0]
    n_mcqs = conn.execute("SELECT COUNT(*) FROM mcqs").fetchone()[0]
    next_gen = storage.get_run_count(db_path) + 1
    conn.close()
    print(f"\nDB consolidated: {n_runs} run, {n_mcqs} questions (all gen 1).")
    print(f"Next new generation will be #{next_gen}.")
    print("Restart the GUI (or trigger a reload) to see the cleaned Generations tab.")


if __name__ == "__main__":
    main()
