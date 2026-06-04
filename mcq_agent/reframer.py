"""
Module: reframer.py
Salvage pipeline for rejected MCQs.

Instead of discarding rejected questions, this module attempts targeted fixes
based on the specific failure reason. Each failure type gets the minimum
intervention needed — no full regeneration, no wasted tokens.

Failure class taxonomy
----------------------
CLASS A — Validator: length_parity
  The correct answer is >30% longer than the median distractor.
  Fix: expand the short distractors to match the correct answer length.
  LLM call: YES (small — sends 4 options + issue, asks to rebalance)
  Model: critic model (cheap/fast is fine)

CLASS B — Validator: source_excerpt
  The source_excerpt fuzzy-match score is < threshold.
  Fix: re-ground the question by finding the correct excerpt from the document.
  LLM call: YES (sends question + source section, asks for verbatim excerpt)
  Model: critic model

CLASS C — Critic: weak/implausible distractor
  One or more distractors are obvious or not grounded in source.
  Fix: replace the named bad distractor(s) with better alternatives using
       confusion_pairs from the concept map.
  LLM call: YES (targeted — sends the MCQ + critique issues + confusion_pairs)
  Model: critic model

CLASS D — Critic: unsourced claim in correct answer or explanation
  The correct answer or explanation contains claims not in the source.
  Fix: trim the correct answer and explanation to what the source supports.
  LLM call: YES (sends MCQ + critique + relevant source section)
  Model: critic model

CLASS E — Validator: multiple concurrent failures
  Both source_excerpt AND length_parity fail together.
  Fix: run CLASS B first (re-ground), then CLASS A (rebalance lengths).
  Two sequential LLM calls.

Questions that fail validator checks other than source_excerpt or length_parity
(e.g. option count, uniqueness) are not reframed — these indicate structural
problems that require full regeneration and are left in the rejected pool.

Output
------
Reframed questions that pass all validators AND the critic are added to
final_mcqs. Questions that still fail after reframing stay in rejected_mcqs
with an updated critique noting the reframe attempt.

The reframe attempt is tracked in a new `reframe_attempted` flag in the output
so the human reviewer can distinguish original rejections from failed salvage.
"""

from __future__ import annotations

import structlog
from pydantic import BaseModel

from .config import Settings
from .llm_client import LLMClient, TokenUsage, make_client
from .parser import ParsedDocument
from .schemas import ConceptMap, CritiqueResult, MCQ
from .validators import run_all_validators

log = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Failure class detection
# ---------------------------------------------------------------------------

_REFRAMEABLE_VALIDATOR_ISSUES = {"length_parity", "source_excerpt"}
_NON_REFRAMEABLE_VALIDATOR_ISSUES = {
    "uniqueness", "option_count", "distractor_rationales",
    "bloom_difficulty", "source_phrase_overlap",
}


def classify_rejection(
    mcq: MCQ,
    critique: CritiqueResult,
) -> tuple[str, list[str]]:
    """
    Classify a rejection into a reframe class.

    Returns (class_label, reframeable_issues) where class_label is one of:
      "A"  — length_parity only
      "B"  — source_excerpt only
      "C"  — critic: distractor quality
      "D"  — critic: unsourced claim
      "E"  — source_excerpt + length_parity combined
      "SKIP" — not reframeable (structural failure or unknown)

    reframeable_issues is the list of issues that will be targeted.
    """
    was_dropped_before_critique = "Dropped before critique" in critique.independent_reasoning

    if was_dropped_before_critique:
        # Validator-only rejection
        issues = critique.issues
        has_excerpt = any("source_excerpt" in i for i in issues)
        has_parity = any("length" in i.lower() or "parity" in i.lower() for i in issues)
        has_non_reframeable = any(
            any(k in i.lower() for k in _NON_REFRAMEABLE_VALIDATOR_ISSUES)
            for i in issues
        )

        if has_non_reframeable:
            return "SKIP", []
        if has_excerpt and has_parity:
            return "E", issues
        if has_excerpt:
            return "B", issues
        if has_parity:
            return "A", issues
        return "SKIP", []

    else:
        # Critic rejection — check which criteria failed
        issues = critique.issues
        has_distractor_issue = (
            not critique.distractors_plausible
            or any("distractor" in i.lower() or "implausible" in i.lower() for i in issues)
        )
        has_sourcing_issue = any(
            "unsourced" in i.lower()
            or "not present in" in i.lower()
            or "not in the source" in i.lower()
            or "not explicitly supported" in i.lower()
            for i in issues
        )

        if has_distractor_issue and not has_sourcing_issue:
            return "C", issues
        if has_sourcing_issue and not has_distractor_issue:
            return "D", issues
        if has_distractor_issue and has_sourcing_issue:
            # Both — fix sourcing first (class D), then distractors (class C)
            return "D", issues  # pipeline will re-run C if D fix doesn't fully resolve
        return "SKIP", []


# ---------------------------------------------------------------------------
# Reframe prompts
# ---------------------------------------------------------------------------

_PROMPT_A_LENGTH_PARITY = """\
You are fixing a rejected MCQ. The ONLY problem is that the correct answer option
is significantly longer than the distractors. Expand the distractor options so all
four options are approximately the same length. Do NOT change the correct answer text,
the question stem, the explanation, or any other field.

<mcq>
{mcq_json}
</mcq>

<issue>
{issue}
</issue>

Rules:
- Keep the same factual content for each distractor — only expand the wording
- Each distractor should reach approximately the same word count as the correct answer
- Maintain the same distractor_rationale for each option (you may lightly edit for coherence)
- Return the complete fixed MCQ object with all fields intact
"""

_PROMPT_B_SOURCE_EXCERPT = """\
You are fixing a rejected MCQ. The ONLY problem is that the source_excerpt field
does not match any passage in the source document closely enough. Find the exact
verbatim passage in the source that best supports the correct answer, and update
source_excerpt with that verbatim text.

<mcq>
{mcq_json}
</mcq>

<source_section>
{source_section}
</source_section>

<issue>
{issue}
</issue>

Rules:
- The source_excerpt MUST be copied verbatim from source_section — do not paraphrase
- Choose the shortest passage that unambiguously supports the correct answer
- Update source_heading if the passage comes from a different heading than currently listed
- Do NOT change the question, options, explanation, or any other field
- Return the complete fixed MCQ object with all fields intact
"""

_PROMPT_C_DISTRACTOR = """\
You are fixing a rejected MCQ. The critic identified one or more distractors as
implausible, too obvious, or not grounded in the source material.

<mcq>
{mcq_json}
</mcq>

<critique_issues>
{issues}
</critique_issues>

<suggested_fix>
{suggested_fix}
</suggested_fix>

<source_section>
{source_section}
</source_section>

<confusion_pairs>
{confusion_pairs}
</confusion_pairs>

Rules:
- If <suggested_fix> is not empty, treat it as a strong hint — follow its direction
  for which distractor to replace and what kind of replacement to use
- Replace ONLY the distractor(s) explicitly named in the critique_issues
- Use the confusion_pairs above as your primary source for replacement distractors
- Each new distractor must be plausible to a learner with partial knowledge
- Each new distractor must be grounded in the source content (not invented)
- Update distractor_rationale to explain the specific confusion the new distractor exploits
- Do NOT change the correct answer, the question stem, the explanation, or the source_excerpt
- Match the word count of the new distractor to the correct answer (length parity)
- Return the complete fixed MCQ object with all fields intact
"""

_PROMPT_D_UNSOURCED = """\
You are fixing a rejected MCQ. The critic found that the correct answer option
or the explanation contains claims not explicitly supported by the source content.

<mcq>
{mcq_json}
</mcq>

<critique_issues>
{issues}
</critique_issues>

<suggested_fix>
{suggested_fix}
</suggested_fix>

<source_section>
{source_section}
</source_section>

Rules:
- If <suggested_fix> is not empty, treat it as a strong hint for how to rewrite
- Trim or rewrite the correct answer option text so it only contains claims
  explicitly present in source_section. Do not add new claims.
- Trim or rewrite the explanation to match — remove any phrase not found in
  or directly inferable from source_section.
- Do NOT change the question stem, the distractors, or the source_excerpt
- If trimming the correct answer changes its length significantly, also trim
  the distractor options proportionally to maintain length parity
- Return the complete fixed MCQ object with all fields intact
"""


# ---------------------------------------------------------------------------
# Per-class fix functions
# ---------------------------------------------------------------------------

def _get_stage_client(settings: Settings, llm_client: LLMClient) -> LLMClient:
    """Return a stage-specific client for the reframer (uses critic model)."""
    from .config import load_dotenv_and_get_api_key
    resolved_provider = settings.resolved_critic_provider()
    resolved_model = settings.resolved_critic_model()
    if resolved_provider != settings.provider or resolved_model != settings.model:
        api_key = load_dotenv_and_get_api_key(resolved_provider)
        return make_client(
            provider=resolved_provider.value,
            api_key=api_key,
            default_model=resolved_model,
            max_retries=settings.api_max_retries,
            initial_backoff=settings.api_retry_initial_backoff,
        )
    return llm_client


def _relevant_source(mcq: MCQ, document: ParsedDocument) -> str:
    """Return the most relevant source section for this MCQ (reuse critic logic)."""
    from .critic import _get_relevant_source
    return _get_relevant_source(mcq, document)


def _fix_length_parity(
    mcq: MCQ,
    issues: list[str],
    settings: Settings,
    client: LLMClient,
) -> tuple[MCQ | None, TokenUsage]:
    prompt = _PROMPT_A_LENGTH_PARITY.format(
        mcq_json=mcq.model_dump_json(indent=2),
        issue="\n".join(issues),
    )
    try:
        fixed, usage = client.call(
            prompt=prompt,
            response_model=MCQ,
            temperature=0.3,
            model=settings.resolved_critic_model(),
            max_tokens=2000,
        )
        return fixed, usage
    except Exception as exc:
        log.warning("reframe_fix_a_error", error=str(exc))
        return None, TokenUsage(input_tokens=0, output_tokens=0, model="error")


def _fix_source_excerpt(
    mcq: MCQ,
    issues: list[str],
    source_section: str,
    settings: Settings,
    client: LLMClient,
) -> tuple[MCQ | None, TokenUsage]:
    prompt = _PROMPT_B_SOURCE_EXCERPT.format(
        mcq_json=mcq.model_dump_json(indent=2),
        source_section=source_section,
        issue="\n".join(issues),
    )
    try:
        fixed, usage = client.call(
            prompt=prompt,
            response_model=MCQ,
            temperature=0.2,
            model=settings.resolved_critic_model(),
            max_tokens=2000,
        )
        return fixed, usage
    except Exception as exc:
        log.warning("reframe_fix_b_error", error=str(exc))
        return None, TokenUsage(input_tokens=0, output_tokens=0, model="error")


def _format_confusion_pairs(concept_map: ConceptMap, mcq: MCQ) -> str:
    """Find confusion pairs from concepts related to this MCQ's topic."""
    lines: list[str] = []
    question_lower = mcq.question.lower()
    for concept in concept_map.concepts:
        if concept.name.lower() in question_lower or any(
            opt.text.lower().find(concept.name.lower()) >= 0 for opt in mcq.options
        ):
            for cp in concept.confusion_pairs:
                lines.append(
                    f"- confuse '{concept.name}' with '{cp.confused_with}': {cp.why_confused}"
                )
    if not lines:
        # fallback: include all confusion pairs
        for concept in concept_map.concepts:
            for cp in concept.confusion_pairs:
                lines.append(
                    f"- confuse '{concept.name}' with '{cp.confused_with}': {cp.why_confused}"
                )
    return "\n".join(lines) if lines else "No confusion pairs available."


def _fix_distractor(
    mcq: MCQ,
    issues: list[str],
    source_section: str,
    concept_map: ConceptMap,
    settings: Settings,
    client: LLMClient,
    suggested_fix: str = "",
) -> tuple[MCQ | None, TokenUsage]:
    confusion_text = _format_confusion_pairs(concept_map, mcq)
    prompt = _PROMPT_C_DISTRACTOR.format(
        mcq_json=mcq.model_dump_json(indent=2),
        issues="\n".join(f"- {i}" for i in issues),
        suggested_fix=suggested_fix or "No specific fix suggested.",
        source_section=source_section,
        confusion_pairs=confusion_text,
    )
    try:
        fixed, usage = client.call(
            prompt=prompt,
            response_model=MCQ,
            temperature=0.5,
            model=settings.resolved_critic_model(),
            max_tokens=2000,
        )
        return fixed, usage
    except Exception as exc:
        log.warning("reframe_fix_c_error", error=str(exc))
        return None, TokenUsage(input_tokens=0, output_tokens=0, model="error")


def _fix_unsourced_claim(
    mcq: MCQ,
    issues: list[str],
    source_section: str,
    settings: Settings,
    client: LLMClient,
    suggested_fix: str = "",
) -> tuple[MCQ | None, TokenUsage]:
    prompt = _PROMPT_D_UNSOURCED.format(
        mcq_json=mcq.model_dump_json(indent=2),
        issues="\n".join(f"- {i}" for i in issues),
        suggested_fix=suggested_fix or "No specific fix suggested.",
        source_section=source_section,
    )
    try:
        fixed, usage = client.call(
            prompt=prompt,
            response_model=MCQ,
            temperature=0.2,
            model=settings.resolved_critic_model(),
            max_tokens=2000,
        )
        return fixed, usage
    except Exception as exc:
        log.warning("reframe_fix_d_error", error=str(exc))
        return None, TokenUsage(input_tokens=0, output_tokens=0, model="error")


# ---------------------------------------------------------------------------
# Main reframe orchestrator
# ---------------------------------------------------------------------------


class ReframeResult(BaseModel):
    """Result of a single reframe attempt."""
    original_mcq: MCQ
    original_critique: CritiqueResult
    reframe_class: str
    fixed_mcq: MCQ | None = None
    final_critique: CritiqueResult | None = None
    accepted: bool = False
    skip_reason: str = ""
    usages: list[TokenUsage] = []


def reframe_rejected(
    rejected_mcqs: list[tuple[MCQ, CritiqueResult]],
    document: ParsedDocument,
    concept_map: ConceptMap,
    config,          # MCQConfig
    settings: Settings,
    llm_client: LLMClient,
) -> tuple[list[MCQ], list[tuple[MCQ, CritiqueResult]], list[TokenUsage]]:
    """
    Attempt to salvage rejected MCQs via targeted fixes.

    Returns:
        salvaged      — MCQs that passed after reframing (add to final_mcqs)
        still_rejected — MCQs that still failed after reframe attempt
        usages         — all TokenUsage records from reframe LLM calls
    """
    from . import critic as critic_mod

    salvaged: list[MCQ] = []
    still_rejected: list[tuple[MCQ, CritiqueResult]] = []
    all_usages: list[TokenUsage] = []

    stage_client = _get_stage_client(settings, llm_client)

    for mcq, critique in rejected_mcqs:
        reframe_class, issues = classify_rejection(mcq, critique)

        if reframe_class == "SKIP":
            log.info("reframe_skip", question=mcq.question[:60], reason="non-reframeable failure")
            still_rejected.append((mcq, critique))
            continue

        log.info("reframe_attempt", question=mcq.question[:60], reframe_class=reframe_class)
        source_section = _relevant_source(mcq, document)
        fixed_mcq: MCQ | None = None

        # --- CLASS A: length parity only ---
        if reframe_class == "A":
            fixed_mcq, usage = _fix_length_parity(mcq, issues, settings, stage_client)
            all_usages.append(usage)

        # --- CLASS B: source excerpt only ---
        elif reframe_class == "B":
            fixed_mcq, usage = _fix_source_excerpt(mcq, issues, source_section, settings, stage_client)
            all_usages.append(usage)

        # --- CLASS C: distractor quality ---
        elif reframe_class == "C":
            fixed_mcq, usage = _fix_distractor(
                mcq, issues, source_section, concept_map, settings, stage_client,
                suggested_fix=critique.suggested_fix or "",
            )
            all_usages.append(usage)

        # --- CLASS D: unsourced claim ---
        elif reframe_class == "D":
            fixed_mcq, usage = _fix_unsourced_claim(
                mcq, issues, source_section, settings, stage_client,
                suggested_fix=critique.suggested_fix or "",
            )
            all_usages.append(usage)

        # --- CLASS E: excerpt + parity combined ---
        elif reframe_class == "E":
            # Fix excerpt first, then parity
            fixed_mcq, usage_b = _fix_source_excerpt(mcq, issues, source_section, settings, stage_client)
            all_usages.append(usage_b)
            if fixed_mcq is not None:
                parity_issues = [i for i in issues if "length" in i.lower() or "parity" in i.lower()]
                if parity_issues:
                    fixed_mcq, usage_a = _fix_length_parity(fixed_mcq, parity_issues, settings, stage_client)
                    all_usages.append(usage_a)

        if fixed_mcq is None:
            log.warning("reframe_fix_returned_none", reframe_class=reframe_class)
            still_rejected.append((mcq, critique))
            continue

        # --- Validate the fix ---
        val_passed, val_failures = run_all_validators(fixed_mcq, document, config, settings)
        if not val_passed:
            log.info("reframe_validator_fail", reasons=val_failures)
            # Build a synthetic critique to record the failure
            from .pipeline import _make_synthetic_critique
            still_rejected.append((fixed_mcq, _make_synthetic_critique(
                f"Reframe ({reframe_class}) attempted but failed validators.", val_failures
            )))
            continue

        # --- Run critic on the fixed MCQ ---
        re_critique, crit_usage = critic_mod.critique_mcq(fixed_mcq, document, settings, llm_client)
        all_usages.append(crit_usage)

        if re_critique.passes:
            log.info("reframe_accepted", reframe_class=reframe_class, question=fixed_mcq.question[:60])
            salvaged.append(fixed_mcq)
        else:
            log.info("reframe_critic_fail", reframe_class=reframe_class, issues=re_critique.issues)
            still_rejected.append((fixed_mcq, re_critique))

    log.info(
        "reframe_complete",
        attempted=len(rejected_mcqs),
        salvaged=len(salvaged),
        still_rejected=len(still_rejected),
        reframe_tokens=sum(u.input_tokens + u.output_tokens for u in all_usages),
    )

    return salvaged, still_rejected, all_usages
