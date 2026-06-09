"""
supabase_gate.py

Intermediary between the MCQ pipeline and Supabase storage.

Called automatically after every generation when enable_supabase: true in
config.yaml.  SQLite is written first (authoritative local store); this gate
then decides what reaches Supabase.

Flow
----
1. Fetch all currently accepted questions from Supabase (paginated).
2. Run similarity filter on the new batch:
     cross-Supabase : each new question vs every existing Supabase question
     intra-batch    : each new question vs already-accepted questions in this run
3. Drop questions whose similarity score >= threshold.
4. Get the highest question_number already in Supabase.
5. Re-assign contiguous question_numbers to survivors, starting from max + 1.
6. Push the filtered, renumbered run to Supabase.
7. Return a SyncResult with push statistics.

Design notes
------------
- SQLite keeps ALL accepted questions with local numbering.  Supabase keeps
  only unique questions with gapless global numbering.  The two stores are
  intentionally different — SQLite is the raw log, Supabase is the clean bank.
- If Supabase is unavailable the exception propagates to pipeline.py which
  logs a warning and continues.  No data is lost from SQLite.
- _fetch_all_accepted uses pagination (PAGE=1000) so the question bank can
  grow without hitting PostgREST's default 1 000-row response cap.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

import structlog

from .schemas import MCQ, PipelineRun
from .similarity import DEFAULT_THRESHOLD, filter_questions

log = structlog.get_logger(__name__)

_PAGE = 1000


@dataclass
class SyncResult:
    generation_number: int
    submitted: int           # questions sent to the gate
    pushed: int              # questions that survived similarity check
    filtered: int            # questions dropped as duplicates
    first_question_number: int | None
    last_question_number: int | None
    flagged: list[dict] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Supabase read helpers
# ---------------------------------------------------------------------------

def _fetch_all_accepted(sb) -> list[dict]:
    """
    Return every accepted MCQ dict from Supabase, paginated.
    Each dict is the raw mcq_json JSONB with question_number merged in.
    """
    offset = 0
    results: list[dict] = []
    while True:
        resp = (
            sb.table("mcqs")
            .select("mcq_json, question_number")
            .eq("passed", 1)
            .range(offset, offset + _PAGE - 1)
            .execute()
        )
        rows = resp.data or []
        for row in rows:
            d = row["mcq_json"]
            d["question_number"] = row["question_number"]
            results.append(d)
        if len(rows) < _PAGE:
            break
        offset += _PAGE
    return results


def _max_question_number(existing: list[dict]) -> int:
    """
    Derive the current max question_number from the already-fetched existing
    list.  Avoids a second Supabase round-trip and eliminates the small race
    window that would exist between two separate queries.
    Returns 0 when the bank is empty.
    """
    return max((d.get("question_number") or 0 for d in existing), default=0)


# ---------------------------------------------------------------------------
# Main gate function
# ---------------------------------------------------------------------------

def preview_sync(run: PipelineRun, threshold: int = DEFAULT_THRESHOLD) -> SyncResult:
    """
    Read-only dry run of the similarity gate: fetch existing Supabase questions
    and run the dedup filter, but DO NOT push anything. Returns the same
    SyncResult shape as filter_and_sync (pushed = would-be-pushed count) so the
    GUI can show an accurate "would push N, skip M as duplicates" preview.
    """
    from . import supabase_storage

    sb = supabase_storage._client()
    existing = _fetch_all_accepted(sb)
    candidate_dicts: list[dict] = [
        json.loads(mcq.model_dump_json()) for mcq in run.final_mcqs
    ]
    accepted_dicts, flagged_items = filter_questions(
        candidates=candidate_dicts,
        existing=existing,
        threshold=threshold,
        check_intra=True,
    )
    next_q_num = _max_question_number(existing) + 1
    n_accepted = len(accepted_dicts)
    return SyncResult(
        generation_number=run.generation_number,
        submitted=len(run.final_mcqs),
        pushed=n_accepted,
        filtered=len(flagged_items),
        first_question_number=next_q_num if n_accepted else None,
        last_question_number=(next_q_num + n_accepted - 1) if n_accepted else None,
        flagged=flagged_items,
    )


def filter_and_sync(run: PipelineRun, threshold: int = DEFAULT_THRESHOLD) -> SyncResult:
    """
    Run similarity gate then push the filtered run to Supabase.

    Parameters
    ----------
    run       : the completed PipelineRun (already written to SQLite)
    threshold : similarity score (0–100) above which a question is dropped

    Returns
    -------
    SyncResult with pushed / filtered counts and the Supabase question range.
    """
    from . import supabase_storage

    sb = supabase_storage._client()

    # ── 1. Fetch existing Supabase questions ───────────────────────────────
    existing = _fetch_all_accepted(sb)
    log.info("supabase_gate_loaded_existing", count=len(existing))

    # ── 2. Prepare candidate dicts (parallel list to run.final_mcqs) ───────
    #    We keep the MCQ model list and a dict list in sync so that after
    #    filtering we can map accepted dicts back to their MCQ model instances.
    candidate_dicts: list[dict] = [
        json.loads(mcq.model_dump_json()) for mcq in run.final_mcqs
    ]

    # ── 3. Similarity filter ───────────────────────────────────────────────
    accepted_dicts, flagged_items = filter_questions(
        candidates=candidate_dicts,
        existing=existing,
        threshold=threshold,
        check_intra=True,
    )

    # Map accepted dicts back to MCQ model instances via object identity.
    # filter_questions preserves references — accepted_dicts contains the
    # same dict objects as candidate_dicts (no copies), so id() is stable.
    accepted_ids = {id(d) for d in accepted_dicts}
    accepted_mcqs: list[MCQ] = [
        mcq
        for mcq, d in zip(run.final_mcqs, candidate_dicts)
        if id(d) in accepted_ids
    ]

    log.info(
        "supabase_gate_filter_done",
        submitted=len(run.final_mcqs),
        accepted=len(accepted_mcqs),
        filtered=len(flagged_items),
        threshold=threshold,
    )
    for item in flagged_items:
        log.warning(
            "supabase_gate_duplicate",
            score=f"{item['score']:.1f}",
            source=item["source"],
            question=item["question"].get("question", "")[:100],
        )

    # ── 4. Re-number survivors from Supabase's current max ────────────────
    next_q_num = _max_question_number(existing) + 1
    for i, mcq in enumerate(accepted_mcqs):
        mcq.question_number = next_q_num + i

    first_q = next_q_num if accepted_mcqs else None
    last_q  = (next_q_num + len(accepted_mcqs) - 1) if accepted_mcqs else None

    # ── 5. Build a filtered PipelineRun for Supabase ──────────────────────
    #    rejected_mcqs (LLM-critic failures) are kept as-is.
    #    Only final_mcqs and passed_count reflect the deduplication.
    filtered_run = run.model_copy(update={
        "final_mcqs":  accepted_mcqs,
        "passed_count": len(accepted_mcqs),
    })

    # ── 6. Push to Supabase ───────────────────────────────────────────────
    supabase_storage.log_run_to_supabase(filtered_run)
    log.info(
        "supabase_gate_sync_done",
        generation=run.generation_number,
        pushed=len(accepted_mcqs),
        filtered=len(flagged_items),
        question_range=f"{first_q}–{last_q}" if first_q else "none",
    )

    return SyncResult(
        generation_number=run.generation_number,
        submitted=len(run.final_mcqs),
        pushed=len(accepted_mcqs),
        filtered=len(flagged_items),
        first_question_number=first_q,
        last_question_number=last_q,
        flagged=flagged_items,
    )
