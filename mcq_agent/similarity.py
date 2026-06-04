"""
similarity.py

Shared similarity primitives used by:
  - check_similarity.py   (CLI deduplication tool, run manually)
  - supabase_gate.py      (automated pre-Supabase filter)

Keeping the logic here prevents the two from diverging silently.

Algorithm
---------
rapidfuzz.fuzz.token_set_ratio on a composite string built from the question
stem + all option texts.  token_set_ratio is order-insensitive — it tokenises
both strings, sorts the tokens, then computes ratio on the sorted+unsorted
combinations.  This catches paraphrasing ("Which tool builds X?" vs "What tool
is used to build X?") far better than plain string ratio.  Scores: 0–100.
"""

from __future__ import annotations

from rapidfuzz import fuzz

DEFAULT_THRESHOLD = 80


def composite_text(mcq: dict) -> str:
    """Combine question stem + option texts into a single comparison string."""
    stem = mcq.get("question", "")
    options = " ".join(opt.get("text", "") for opt in mcq.get("options", []))
    return f"{stem} {options}"


def best_match(candidate: dict, pool: list[dict]) -> tuple[float, dict | None]:
    """
    Return (highest_score, most_similar_question) of candidate vs pool.
    Returns (0.0, None) when pool is empty.
    """
    candidate_text = composite_text(candidate)
    top_score = 0.0
    top_q: dict | None = None
    for existing in pool:
        score = fuzz.token_set_ratio(candidate_text, composite_text(existing))
        if score > top_score:
            top_score = score
            top_q = existing
    return top_score, top_q


def filter_questions(
    candidates: list[dict],
    existing: list[dict],
    threshold: int = DEFAULT_THRESHOLD,
    check_intra: bool = True,
) -> tuple[list[dict], list[dict]]:
    """
    Partition *candidates* into accepted and flagged lists.

    Parameters
    ----------
    candidates : questions to evaluate (dict representations of MCQ)
    existing   : reference pool to check against (e.g. questions in the DB)
    threshold  : score >= threshold → flagged as duplicate
    check_intra: also check each candidate against already-accepted candidates
                 in this call (catches duplicates within a single batch)

    Returns
    -------
    accepted     — candidates that passed; same dict objects as in candidates
    flagged_items— list of {question, score, matched_question, source}
                   where source is "existing" or "batch"
    """
    accepted: list[dict] = []
    flagged: list[dict] = []

    for candidate in candidates:
        cross_score, cross_match = best_match(candidate, existing)

        intra_score, intra_match = 0.0, None
        if check_intra and accepted:
            intra_score, intra_match = best_match(candidate, accepted)

        if cross_score >= intra_score:
            top_score, top_match, source = cross_score, cross_match, "existing"
        else:
            top_score, top_match, source = intra_score, intra_match, "batch"

        if top_score >= threshold:
            flagged.append({
                "question":         candidate,
                "score":            top_score,
                "matched_question": top_match,
                "source":           source,
            })
        else:
            accepted.append(candidate)

    return accepted, flagged
