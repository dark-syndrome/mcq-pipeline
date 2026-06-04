"""
supabase_storage.py

Mirrors the SQLite storage layer for Supabase (PostgreSQL).
Activated by setting enable_supabase: true in config.yaml after adding
SUPABASE_URL and SUPABASE_KEY to your .env file.

The Supabase schema must be created first — run supabase_schema.sql in the
Supabase dashboard SQL editor before enabling this module.

All operations are best-effort: a Supabase failure logs a warning but does
NOT abort the pipeline.  SQLite remains the authoritative local store.

Schema v2 changes
-----------------
runs  : + generation_label (YYYYMMDD-HHMM), + topic, + source_lesson
mcqs  : + difficulty, bloom_level, question_type, stem_pattern,
          source_heading (promoted from mcq_json for indexed filtering)
        + quality_score  (100.0 for accepted; % of 12 criteria for rejected)
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from .schemas import ConceptMap, CritiqueResult, PipelineRun


def _client():
    """Return an authenticated Supabase client, reading credentials from env."""
    try:
        from supabase import create_client
    except ImportError as exc:
        raise ImportError(
            "supabase package is not installed. Run: pip install supabase"
        ) from exc

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_KEY", "").strip()
    if not url or not key:
        raise EnvironmentError(
            "SUPABASE_URL and SUPABASE_KEY must be set in .env to use Supabase sync."
        )
    return create_client(url, key)


# ---------------------------------------------------------------------------
# Quality score helper
# ---------------------------------------------------------------------------

_QUALITY_CRITERIA = [
    "matches_marked_answer",
    "source_grounded",
    "uniquely_correct",
    "distractors_plausible",
    "matches_difficulty",
    "on_topic",
    "clear_wording",
    "self_contained",
    "stem_quality",
    "stem_economy",
    "length_parity",
    "source_phrase_independence",
]


def _quality_score(critique: CritiqueResult | None, passed: bool) -> float | None:
    """
    Compute a 0-100 quality score from a CritiqueResult.

    Accepted questions (passed=True) score 100 — they cleared all gates.
    Rejected questions score (true criteria / 12) * 100.
    Returns None when there is no critique to score against.
    """
    if passed:
        return 100.0
    if critique is None:
        return None
    score = sum(getattr(critique, field, False) for field in _QUALITY_CRITERIA)
    return round(score / len(_QUALITY_CRITERIA) * 100, 1)


# ---------------------------------------------------------------------------
# Run persistence
# ---------------------------------------------------------------------------

def log_run_to_supabase(run: PipelineRun) -> None:
    """
    Insert a completed pipeline run and its MCQs into Supabase.

    Idempotency: if the run_id already exists in the runs table the entire
    call is skipped — re-running the migration will not create duplicate rows.

    v2: populates generation_label, topic, source_lesson on the run row, and
    difficulty, bloom_level, question_type, stem_pattern, source_heading,
    quality_score on every MCQ row.  The mcq_json blob is unchanged.
    """
    sb = _client()

    # Idempotency guard — skip if this run was already pushed
    existing = sb.table("runs").select("run_id").eq("run_id", run.run_id).execute()
    if existing.data:
        return

    generation_label = run.timestamp.strftime("%Y%m%d-%H%M")
    source_lesson = Path(run.input_file).stem

    half = run.total_tokens_used // 2
    sb.table("runs").insert({
        "run_id":               run.run_id,
        "timestamp":            run.timestamp.isoformat(),
        "input_file":           run.input_file,
        "config_json":          json.loads(run.config.model_dump_json()),
        "generated_count":      run.generated_count,
        "passed_count":         run.passed_count,
        "total_input_tokens":   half,
        "total_output_tokens":  run.total_tokens_used - half,
        "cost_usd":             run.total_cost_usd,
        "generation_number":    run.generation_number,
        # v2 navigation columns
        "generation_label":     generation_label,
        "topic":                run.topic,
        "source_lesson":        source_lesson,
    }).execute()

    accepted_rows = [
        {
            "run_id":          run.run_id,
            "mcq_json":        json.loads(mcq.model_dump_json()),
            "passed":          1,
            "critique_json":   None,
            "question_number": mcq.question_number,
            # v2 promoted + computed columns
            "difficulty":      mcq.difficulty.value,
            "bloom_level":     mcq.bloom_level.value,
            "question_type":   mcq.question_type.value,
            "stem_pattern":    mcq.stem_pattern.value,
            "source_heading":  mcq.source_heading,
            "quality_score":   100.0,
        }
        for mcq in run.final_mcqs
    ]
    if accepted_rows:
        sb.table("mcqs").insert(accepted_rows).execute()

    rejected_rows = [
        {
            "run_id":          run.run_id,
            "mcq_json":        json.loads(mcq.model_dump_json()),
            "passed":          0,
            "critique_json":   json.loads(critique.model_dump_json()),
            "question_number": None,
            # v2 promoted + computed columns
            "difficulty":      mcq.difficulty.value,
            "bloom_level":     mcq.bloom_level.value,
            "question_type":   mcq.question_type.value,
            "stem_pattern":    mcq.stem_pattern.value,
            "source_heading":  mcq.source_heading,
            "quality_score":   _quality_score(critique, passed=False),
        }
        for mcq, critique in run.rejected_mcqs
    ]
    if rejected_rows:
        sb.table("mcqs").insert(rejected_rows).execute()


# ---------------------------------------------------------------------------
# Concept-map cache
# ---------------------------------------------------------------------------

def get_cached_concept_map(
    file_path: Path,
    file_hash: str,
) -> ConceptMap | None:
    """Return a cached ConceptMap from Supabase, or None on miss."""
    try:
        sb = _client()
        result = (
            sb.table("concept_maps")
            .select("concept_map_json")
            .eq("file_hash", file_hash)
            .maybe_single()
            .execute()
        )
        if result.data is None:
            return None
        return ConceptMap.model_validate(result.data["concept_map_json"])
    except Exception:  # noqa: BLE001
        return None


def save_concept_map_cache(
    file_path: Path,
    file_hash: str,
    concept_map: ConceptMap,
    analyzer_model: str,
) -> None:
    """Upsert a ConceptMap into the Supabase concept-map cache."""
    from datetime import datetime, timezone
    sb = _client()
    sb.table("concept_maps").upsert({
        "file_hash":         file_hash,
        "source_file":       str(file_path),
        "analyzer_model":    analyzer_model,
        "created_at":        datetime.now(tz=timezone.utc).isoformat(),
        "concept_map_json":  json.loads(concept_map.model_dump_json()),
    }).execute()
