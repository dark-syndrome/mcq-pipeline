"""
A/B test: per-Bloom multi-call generation vs legacy batched generation.

Runs the SAME lesson twice — once with enable_per_bloom_generation=True (one
Generator call per active Bloom level) and once False (single batched call) —
then reports the REAL per-stage token/cost deltas read from each run's
<label>_run_config.json (the SQLite `runs` table stores a fake 50/50 token
split, so it is NOT a reliable source for this comparison).

Usage:
    python scripts/ab_bloom_tokens.py --input examples/Reading_Material.md --count 10

Both runs hit the real LLM API and cost money. The Analyzer is MD5-cached, so
only the FIRST run pays for analysis; the comparison below isolates the
Generator stage, which is the only stage this change affects.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


_BLOOM_ORDER = ["remember", "understand", "apply", "analyze", "evaluate", "create"]


def _run(input_file: str, count: int, per_bloom: bool, output_dir: Path) -> dict:
    """Invoke the pipeline once with the given mode.

    Returns {"config": <run_config dict>, "accepted": <path to accepted.json>}.
    """
    env = dict(os.environ)
    env["ENABLE_PER_BLOOM_GENERATION"] = "true" if per_bloom else "false"

    before = set(output_dir.glob("*_run_config.json"))
    cmd = [
        sys.executable, "-m", "mcq_agent.cli", "generate",
        "--input", input_file,
        "--output-dir", str(output_dir),
        "--count", str(count),
    ]
    print(f"\n=== Running mode: {'PER-BLOOM' if per_bloom else 'BATCHED'} ===")
    print("    " + " ".join(cmd))
    proc = subprocess.run(cmd, env=env, capture_output=True, text=True)
    if proc.returncode != 0:
        print(proc.stdout[-2000:])
        print(proc.stderr[-2000:], file=sys.stderr)
        raise SystemExit(f"Run failed (mode per_bloom={per_bloom}).")

    after = set(output_dir.glob("*_run_config.json"))
    new = after - before
    if not new:
        raise SystemExit("No new run_config.json produced — cannot read tokens.")
    # The newest run_config for this run.
    latest = max(new, key=lambda p: p.stat().st_mtime)
    cfg = json.loads(latest.read_text(encoding="utf-8"))
    label = cfg["run_label"]
    return {"config": cfg, "accepted": output_dir / f"{label}_accepted.json"}


def _bloom_distribution(accepted_path: Path) -> dict[str, int]:
    """Count accepted questions per bloom_level, in canonical Bloom order."""
    dist = {b: 0 for b in _BLOOM_ORDER}
    if not accepted_path.exists():
        return dist
    for q in json.loads(accepted_path.read_text(encoding="utf-8")):
        lvl = q.get("bloom_level")
        if lvl in dist:
            dist[lvl] += 1
        else:
            dist[lvl] = dist.get(lvl, 0) + 1  # unexpected level — still surface it
    return dist


def _summarize(label: str, run: dict) -> dict:
    cfg = run["config"]
    t = cfg["tokens"]
    c = cfg["cost_usd"]
    g_in, g_out = t["generator"]["input"], t["generator"]["output"]
    return {
        "label": label,
        "accepted": cfg["question_counts"]["total_accepted"],
        "generated": cfg["question_counts"]["generated"],
        "gen_in": g_in,
        "gen_out": g_out,
        "gen_total": g_in + g_out,
        "gen_cost": c["generator"],
        "total_tokens": t["total"],
        "total_cost": c["total"],
        "accepted_file": run["accepted"],
        "bloom_dist": _bloom_distribution(run["accepted"]),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", required=True, help="Path to source .md")
    ap.add_argument("--count", type=int, default=10, help="Questions to request")
    ap.add_argument("--output-dir", default="output/ab_test", help="Output dir")
    args = ap.parse_args()

    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)

    # Per-bloom first so the Analyzer cache is warm for BOTH runs (isolates the
    # generator-stage comparison from one-time analysis cost).
    pb = _summarize("per-bloom", _run(args.input, args.count, True, out))
    bt = _summarize("batched", _run(args.input, args.count, False, out))

    def pct(new, old):
        return f"{100 * (new - old) / old:+.0f}%" if old else "n/a"

    print("\n" + "=" * 64)
    print(f"  A/B RESULT — {args.input}  (requested {args.count})")
    print("=" * 64)
    row = "  {:<18}{:>12}{:>12}{:>14}"
    print(row.format("metric", "batched", "per-bloom", "delta"))
    print("  " + "-" * 56)
    print(row.format("accepted", bt["accepted"], pb["accepted"], ""))
    print(row.format("generated", bt["generated"], pb["generated"], ""))
    print(row.format("gen input tok", bt["gen_in"], pb["gen_in"], pct(pb["gen_in"], bt["gen_in"])))
    print(row.format("gen output tok", bt["gen_out"], pb["gen_out"], pct(pb["gen_out"], bt["gen_out"])))
    print(row.format("gen total tok", bt["gen_total"], pb["gen_total"], pct(pb["gen_total"], bt["gen_total"])))
    print(row.format("total tok (run)", bt["total_tokens"], pb["total_tokens"], pct(pb["total_tokens"], bt["total_tokens"])))
    print("  " + "-" * 56)
    print(f"  gen cost   : ${bt['gen_cost']:.5f} -> ${pb['gen_cost']:.5f}  ({pct(pb['gen_cost'], bt['gen_cost'])})")
    print(f"  total cost : ${bt['total_cost']:.5f} -> ${pb['total_cost']:.5f}  ({pct(pb['total_cost'], bt['total_cost'])})")

    # Bloom distribution of ACCEPTED questions — the quality signal. Per-bloom
    # should show a wider/flatter spread; batched tends to cluster on a few levels.
    print("\n" + "=" * 64)
    print("  BLOOM DISTRIBUTION (accepted questions)")
    print("=" * 64)
    brow = "  {:<14}{:>12}{:>12}"
    print(brow.format("bloom level", "batched", "per-bloom"))
    print("  " + "-" * 38)
    all_levels = list(_BLOOM_ORDER)
    for lvl in pb["bloom_dist"]:
        if lvl not in all_levels:
            all_levels.append(lvl)
    for lvl in all_levels:
        print(brow.format(lvl, bt["bloom_dist"].get(lvl, 0), pb["bloom_dist"].get(lvl, 0)))
    bt_spread = sum(1 for v in bt["bloom_dist"].values() if v > 0)
    pb_spread = sum(1 for v in pb["bloom_dist"].values() if v > 0)
    print("  " + "-" * 38)
    print(brow.format("levels covered", bt_spread, pb_spread))

    print("\n" + "=" * 64)
    print("  OUTPUT FILES — open these to verify quality manually")
    print("=" * 64)
    print(f"  batched   accepted : {bt['accepted_file']}")
    print(f"  per-bloom accepted : {pb['accepted_file']}")
    print("\n  The cost delta above only justifies per-bloom if the Bloom spread")
    print("  / question quality is meaningfully better in the per-bloom file.")


if __name__ == "__main__":
    main()
