"""
Module: storage.py
SQLite-backed persistence for pipeline runs, MCQs, and concept map cache.

Tables
------
runs          — one row per PipelineRun (metadata + aggregates).
mcqs          — one row per MCQ (passed + rejected) linked to a run.
concept_maps  — cached ConceptMap keyed by MD5 hash of the source file.
               Avoids re-running the expensive Analyzer on unchanged files.

SQLite Primer (for first-time users)
-------------------------------------
SQLite is a file-based relational database — the entire database lives in a
single file (logs/runs.db by default).  No server needed, no installation
required; Python ships with the ``sqlite3`` module built in.

Key concepts:
  - Tables   : like spreadsheets with typed columns.
  - Rows     : individual records inserted via INSERT.
  - Queries  : SELECT statements that read and filter rows.
  - PRIMARY KEY : a column that uniquely identifies each row (like a dict key).
  - FOREIGN KEY : a column that references the PRIMARY KEY of another table,
                  enforcing referential integrity (a child row can't exist
                  without its parent).
  - conn.execute(sql, params) : runs a SQL statement; params are passed as a
                                tuple to prevent SQL injection.
  - conn.commit()             : saves all pending changes to disk.

The concept_maps table adds two new columns compared to previous versions:
  file_hash     TEXT  — MD5 hex digest of the source .md file content.
  concept_map_json TEXT — full ConceptMap serialised as JSON.

Lookup: if a run is about to call the Analyzer, we first check whether a row
exists in concept_maps with matching file_hash.  If it does, we deserialise
and return the cached map — zero API tokens spent.

Public API
----------
- init_db()              — create / migrate tables.
- log_run()              — insert a completed PipelineRun.
- get_run()              — reconstruct a PipelineRun by run_id.
- list_recent_runs()     — lightweight summary rows for CLI.
- get_cached_concept_map()  — look up a ConceptMap by file MD5.
- save_concept_map_cache()  — upsert a ConceptMap into the cache.
"""

import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any

from .schemas import ConceptMap, CritiqueResult, MCQ, MCQConfig, PipelineRun

# ---------------------------------------------------------------------------
# DDL
# ---------------------------------------------------------------------------

_CREATE_RUNS = """
CREATE TABLE IF NOT EXISTS runs (
    run_id                TEXT PRIMARY KEY,
    timestamp             TEXT NOT NULL,
    input_file            TEXT NOT NULL,
    config_json           TEXT NOT NULL,
    generated_count       INTEGER NOT NULL,
    passed_count          INTEGER NOT NULL,
    total_input_tokens    INTEGER NOT NULL,
    total_output_tokens   INTEGER NOT NULL,
    cost_usd              REAL NOT NULL,
    generation_number     INTEGER NOT NULL DEFAULT 0,
    run_name              TEXT,
    topic_tag             TEXT,
    course_tag            TEXT
);
"""

_CREATE_MCQS = """
CREATE TABLE IF NOT EXISTS mcqs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          TEXT    NOT NULL,
    mcq_json        TEXT    NOT NULL,
    passed          INTEGER NOT NULL,
    critique_json   TEXT,
    question_number INTEGER,
    FOREIGN KEY (run_id) REFERENCES runs(run_id)
);
"""

# Concept map cache — keyed by MD5 of the source file content.
_CREATE_CONCEPT_MAPS = """
CREATE TABLE IF NOT EXISTS concept_maps (
    file_hash         TEXT PRIMARY KEY,
    source_file       TEXT NOT NULL,
    analyzer_model    TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    concept_map_json  TEXT NOT NULL
);
"""

_CREATE_TOPIC_TAGS = """
CREATE TABLE IF NOT EXISTS topic_tags (
    tag        TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);
"""

_CREATE_COURSES = """
CREATE TABLE IF NOT EXISTS courses (
    name       TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);
"""

# Default topic tags seeded on first init
_DEFAULT_TOPIC_TAGS = [
    "LINUX_ROS2_FUNDAMENTALS",
    "ROBOT_MODELLING",
    "ROBOT_MATHEMATICS",
    "SIMULATION",
    "SLAM",
    "NAVIGATION",
    "COMPUTER_VISION",
    "EMBEDDED_SYSTEMS",
]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _connect(db_path: Path) -> sqlite3.Connection:
    """Open a connection with foreign-key enforcement and Row factory."""
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.row_factory = sqlite3.Row
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    """Add any new columns / tables that didn't exist in earlier DB versions."""
    from datetime import datetime, timezone
    now = datetime.now(tz=timezone.utc).isoformat()

    conn.execute(_CREATE_CONCEPT_MAPS)
    conn.execute(_CREATE_TOPIC_TAGS)
    conn.execute(_CREATE_COURSES)

    for col_sql in [
        "ALTER TABLE runs ADD COLUMN generation_number INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE runs ADD COLUMN run_name TEXT",
        "ALTER TABLE runs ADD COLUMN topic_tag TEXT",
        "ALTER TABLE runs ADD COLUMN course_tag TEXT",
        "ALTER TABLE mcqs ADD COLUMN question_number INTEGER",
        "ALTER TABLE runs ADD COLUMN subtopics_json TEXT",
    ]:
        try:
            conn.execute(col_sql)
        except sqlite3.OperationalError:
            pass  # column already exists

    # Seed default topic tags if table is empty
    count = conn.execute("SELECT COUNT(*) FROM topic_tags").fetchone()[0]
    if count == 0:
        conn.executemany(
            "INSERT OR IGNORE INTO topic_tags (tag, created_at) VALUES (?, ?)",
            [(tag, now) for tag in _DEFAULT_TOPIC_TAGS],
        )

    conn.commit()


def md5_of_file(file_path: Path) -> str:
    """Return the MD5 hex digest of *file_path* content."""
    return hashlib.md5(file_path.read_bytes()).hexdigest()


# ---------------------------------------------------------------------------
# Public API — lifecycle
# ---------------------------------------------------------------------------


def init_db(db_path: Path) -> None:
    """
    Create the database file and all tables if they do not already exist.
    Also runs migrations for databases created by older versions of the code.

    Args:
        db_path: Filesystem path to the SQLite database file.
                 Parent directories are created automatically.
    """
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with _connect(db_path) as conn:
        conn.execute(_CREATE_RUNS)
        conn.execute(_CREATE_MCQS)
        _migrate(conn)


# ---------------------------------------------------------------------------
# Public API — concept map cache
# ---------------------------------------------------------------------------


def get_cached_concept_map(
    file_path: Path,
    db_path: Path,
) -> ConceptMap | None:
    """
    Return a cached ConceptMap for *file_path* if one exists and the file
    has not changed since the cache was written.

    The lookup key is the MD5 hash of the file content.  If the file has been
    edited its hash changes and the cache misses, triggering a fresh Analyzer
    call automatically.

    Args:
        file_path: Path to the source Markdown file.
        db_path:   Path to the SQLite database.

    Returns:
        A ConceptMap on a cache hit, or None on a miss.
    """
    if not db_path.exists():
        return None

    file_hash = md5_of_file(file_path)

    with _connect(db_path) as conn:
        row = conn.execute(
            "SELECT concept_map_json FROM concept_maps WHERE file_hash = ?",
            (file_hash,),
        ).fetchone()

    if row is None:
        return None

    return ConceptMap.model_validate_json(row["concept_map_json"])


def save_concept_map_cache(
    file_path: Path,
    concept_map: ConceptMap,
    analyzer_model: str,
    db_path: Path,
) -> None:
    """
    Upsert *concept_map* into the cache, keyed by the MD5 hash of *file_path*.

    If a cache entry already exists for this hash it is replaced (this happens
    when you re-run with a different model — the new result overwrites the old).

    Args:
        file_path:      Path to the source Markdown file.
        concept_map:    The ConceptMap to store.
        analyzer_model: The model name used to generate this map (for audit).
        db_path:        Path to the SQLite database.
    """
    from datetime import datetime, timezone

    init_db(db_path)
    file_hash = md5_of_file(file_path)

    with _connect(db_path) as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO concept_maps
                (file_hash, source_file, analyzer_model, created_at, concept_map_json)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                file_hash,
                str(file_path),
                analyzer_model,
                datetime.now(tz=timezone.utc).isoformat(),
                concept_map.model_dump_json(),
            ),
        )
        conn.commit()


# ---------------------------------------------------------------------------
# Public API — run persistence
# ---------------------------------------------------------------------------


def get_run_count(db_path: Path) -> int:
    """
    Return the number of runs already in the database.
    Used to assign a sequential run number (run_001, run_002, …).
    Returns 0 if the database does not yet exist.
    """
    if not db_path.exists():
        return 0
    with _connect(db_path) as conn:
        row = conn.execute("SELECT COUNT(*) FROM runs").fetchone()
    return row[0] if row else 0


def get_total_accepted_count(db_path: Path) -> int:
    """
    Return the total number of accepted (passed=1) questions stored across
    all previous runs.  Used to assign globally-sequential question numbers:
    if 50 questions already exist, the next batch starts at 51.
    Returns 0 if the database does not exist or has no accepted questions.
    """
    if not db_path.exists():
        return 0
    with _connect(db_path) as conn:
        row = conn.execute("SELECT COUNT(*) FROM mcqs WHERE passed = 1").fetchone()
    return row[0] if row else 0


def log_run(run: PipelineRun, db_path: Path) -> None:
    """Persist *run* to the database."""
    init_db(db_path)

    half = run.total_tokens_used // 2
    total_input  = half
    total_output = run.total_tokens_used - half

    # Derive topic_tag / course_tag from the first accepted MCQ's 4-element tag list:
    # [SUB_TOPIC, BLOOM_LEVEL, IS_PUBLIC?, COURSE_TAG]
    # The course tag is always the last element; the topic tag is always first.
    # We require at least 2 elements so we don't mistake the topic for the course.
    topic_tag: str | None = None
    course_tag: str | None = None
    if run.final_mcqs:
        tags = run.final_mcqs[0].tags or []
        if len(tags) >= 1:
            topic_tag = tags[0]
        # Course tag is the last element only when the list has 3+ elements
        # (i.e. at least topic + bloom + course; IS_PUBLIC may or may not be present).
        if len(tags) >= 3:
            course_tag = tags[-1]

    with _connect(db_path) as conn:
        subtopics_json = json.dumps(run.subtopics) if run.subtopics else None
        conn.execute(
            """
            INSERT OR REPLACE INTO runs
                (run_id, timestamp, input_file, config_json,
                 generated_count, passed_count,
                 total_input_tokens, total_output_tokens, cost_usd,
                 generation_number, run_name, topic_tag, course_tag, subtopics_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run.run_id,
                run.timestamp.isoformat(),
                run.input_file,
                run.config.model_dump_json(),
                run.generated_count,
                run.passed_count,
                total_input,
                total_output,
                run.total_cost_usd,
                run.generation_number,
                getattr(run, "run_name", None),
                topic_tag,
                course_tag,
                subtopics_json,
            ),
        )

        for mcq in run.final_mcqs:
            conn.execute(
                "INSERT INTO mcqs (run_id, mcq_json, passed, critique_json, question_number)"
                " VALUES (?, ?, ?, ?, ?)",
                (run.run_id, mcq.model_dump_json(), 1, None, mcq.question_number),
            )

        for mcq, critique in run.rejected_mcqs:
            conn.execute(
                "INSERT INTO mcqs (run_id, mcq_json, passed, critique_json, question_number)"
                " VALUES (?, ?, ?, ?, ?)",
                (run.run_id, mcq.model_dump_json(), 0, critique.model_dump_json(), None),
            )

        conn.commit()


def get_run(run_id: str, db_path: Path) -> PipelineRun | None:
    """
    Reconstruct and return a PipelineRun by its run_id.
    Returns None if not found.
    """
    if not db_path.exists():
        return None

    with _connect(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM runs WHERE run_id = ?", (run_id,)
        ).fetchone()

        if row is None:
            return None

        mcq_rows = conn.execute(
            "SELECT mcq_json, passed, critique_json FROM mcqs WHERE run_id = ?",
            (run_id,),
        ).fetchall()

    config = MCQConfig.model_validate_json(row["config_json"])
    final_mcqs: list[MCQ] = []
    rejected_mcqs: list[tuple[MCQ, CritiqueResult]] = []

    for mcq_row in mcq_rows:
        mcq = MCQ.model_validate_json(mcq_row["mcq_json"])
        if mcq_row["passed"]:
            final_mcqs.append(mcq)
        else:
            critique = CritiqueResult.model_validate_json(mcq_row["critique_json"])
            rejected_mcqs.append((mcq, critique))

    concept_map = ConceptMap(
        concepts=[], relationships=[], procedures=[],
        code_examples=[], technical_facts=[],
    )

    keys = row.keys()
    subtopics_raw = row["subtopics_json"] if "subtopics_json" in keys else None
    subtopics: list[str] = []
    if subtopics_raw:
        try:
            subtopics = json.loads(subtopics_raw)
        except (json.JSONDecodeError, TypeError):
            subtopics = []

    from datetime import datetime
    return PipelineRun(
        run_id=row["run_id"],
        timestamp=datetime.fromisoformat(row["timestamp"]),
        input_file=row["input_file"],
        config=config,
        concept_map=concept_map,
        generated_count=row["generated_count"],
        passed_count=row["passed_count"],
        final_mcqs=final_mcqs,
        rejected_mcqs=rejected_mcqs,
        total_tokens_used=row["total_input_tokens"] + row["total_output_tokens"],
        total_cost_usd=row["cost_usd"],
        generation_number=row["generation_number"] if "generation_number" in keys else 0,
        run_name=row["run_name"] if "run_name" in keys else None,
        subtopics=subtopics,
    )


def list_recent_runs(db_path: Path, limit: int = 10) -> list[dict[str, Any]]:
    """Return lightweight summary rows for CLI display."""
    if not db_path.exists():
        return []

    with _connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT run_id, timestamp, input_file,
                   generated_count, passed_count,
                   total_input_tokens + total_output_tokens AS total_tokens,
                   cost_usd, run_name, topic_tag, course_tag
            FROM runs
            ORDER BY timestamp DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    return [dict(row) for row in rows]


def get_all_run_summaries(db_path: Path) -> list[dict[str, Any]]:
    """Return all runs ordered by generation_number for the retag command."""
    if not db_path.exists():
        return []
    with _connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT run_id, generation_number, timestamp, input_file,
                   passed_count, run_name, topic_tag, course_tag
            FROM runs
            ORDER BY generation_number ASC
            """,
        ).fetchall()
    return [dict(row) for row in rows]


# ---------------------------------------------------------------------------
# Public API — topic tags & courses
# ---------------------------------------------------------------------------


def list_topic_tags(db_path: Path) -> list[str]:
    """Return all stored topic tag names, ordered alphabetically."""
    if not db_path.exists():
        return list(_DEFAULT_TOPIC_TAGS)
    with _connect(db_path) as conn:
        rows = conn.execute("SELECT tag FROM topic_tags ORDER BY tag").fetchall()
    return [r["tag"] for r in rows]


def add_topic_tag(tag: str, db_path: Path) -> None:
    """Add a new topic tag (no-op if it already exists)."""
    from datetime import datetime, timezone
    init_db(db_path)
    with _connect(db_path) as conn:
        conn.execute(
            "INSERT OR IGNORE INTO topic_tags (tag, created_at) VALUES (?, ?)",
            (tag, datetime.now(tz=timezone.utc).isoformat()),
        )
        conn.commit()


def list_courses(db_path: Path) -> list[str]:
    """Return all stored course names, ordered alphabetically."""
    if not db_path.exists():
        return []
    with _connect(db_path) as conn:
        rows = conn.execute("SELECT name FROM courses ORDER BY name").fetchall()
    return [r["name"] for r in rows]


def add_course(name: str, db_path: Path) -> None:
    """Add a new course name (no-op if it already exists)."""
    from datetime import datetime, timezone
    init_db(db_path)
    with _connect(db_path) as conn:
        conn.execute(
            "INSERT OR IGNORE INTO courses (name, created_at) VALUES (?, ?)",
            (name, datetime.now(tz=timezone.utc).isoformat()),
        )
        conn.commit()


# ---------------------------------------------------------------------------
# Public API — backfill / retag
# ---------------------------------------------------------------------------


def retag_run(
    run_id: str,
    topic_tag: str,
    course_tag: str,
    db_path: Path,
    is_public: bool = True,
    run_name: str | None = None,
) -> int:
    """
    Rewrite tags on every accepted MCQ in *run_id* using the new 4-element
    format [topic_tag, bloom_level, IS_PUBLIC, course_tag].

    Returns the number of MCQ rows updated.
    """
    with _connect(db_path) as conn:
        rows = conn.execute(
            "SELECT id, mcq_json FROM mcqs WHERE run_id = ? AND passed = 1",
            (run_id,),
        ).fetchall()

        updated = 0
        for row in rows:
            mcq = MCQ.model_validate_json(row["mcq_json"])
            bloom = mcq.bloom_level.value.upper()
            tag_list: list[str] = [topic_tag, bloom]
            if is_public:
                tag_list.append("IS_PUBLIC")
            tag_list.append(course_tag)
            mcq.sub_topic = topic_tag
            mcq.tags = tag_list
            conn.execute(
                "UPDATE mcqs SET mcq_json = ? WHERE id = ?",
                (mcq.model_dump_json(), row["id"]),
            )
            updated += 1

        # Update the run record too
        update_cols = ["topic_tag = ?", "course_tag = ?"]
        params: list[Any] = [topic_tag, course_tag]
        if run_name is not None:
            update_cols.append("run_name = ?")
            params.append(run_name)
        params.append(run_id)
        conn.execute(
            f"UPDATE runs SET {', '.join(update_cols)} WHERE run_id = ?",
            params,
        )
        conn.commit()

    return updated
