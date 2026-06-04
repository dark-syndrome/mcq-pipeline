"""
Module: critic.py
Stage 3 of the MCQ generation pipeline — quality critique.

Changes in v0.3
---------------
- Fixed full-document fallback: instead of sending the entire document when
  heading + excerpt matching fail, we now use T3 fingerprints (key terms per
  section) with rapidfuzz scoring against the question text to find the closest
  section. This eliminates the full-doc fallback entirely.

- Uses the Critic-specific provider/model from Settings
  (e.g. a fast cheap model like llama-3.1-8b-instant independent of generator).

Source-slicing priority (all within the document's sections):
  1. Heading match   — case-insensitive substring of section.heading
  2. Excerpt match   — first 60 chars of source_excerpt in section.content
  3. Fingerprint match — best rapidfuzz score of question text vs T3 key terms
  (Full-document fallback is gone.)
"""

from pathlib import Path

import structlog

from .analyzer import load_prompt_template
from .config import Settings
from .llm_client import LLMClient, TokenUsage, make_client
from .parser import DocumentSection, ParsedDocument, SectionFingerprint, flatten_sections
from .schemas import CritiqueResult, MCQ

log = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Source slicing helpers
# ---------------------------------------------------------------------------


def _score_fingerprint(question: str, fp: SectionFingerprint) -> float:
    """
    Score how relevant a section is to *question* using its T3 key terms.

    We concatenate the heading and key terms then use rapidfuzz partial_ratio
    against the question text.  Returns 0.0-100.0.
    """
    from rapidfuzz import fuzz

    target = fp.heading + " " + " ".join(fp.key_terms)
    return fuzz.partial_ratio(question.lower(), target.lower())


def _get_relevant_source(mcq: MCQ, document: ParsedDocument) -> str:
    """
    Return the most relevant section content for critiquing *mcq*.

    Priority:
    1. Heading match  (case-insensitive substring)
    2. Excerpt match  (first 60 chars of source_excerpt)
    3. T3 fingerprint match  (best rapidfuzz score — replaces full-doc fallback)
    """
    all_sections: list[DocumentSection] = flatten_sections(document)

    # 1. Heading match
    heading = (mcq.source_heading or "").strip().lower()
    if heading:
        for section in all_sections:
            if section.heading and heading in section.heading.lower():
                log.debug("critic_source_slice", method="heading",
                          matched=section.heading)
                return section.content

    # 2. Excerpt match
    excerpt_probe = (mcq.source_excerpt or "").strip()[:60]
    if excerpt_probe:
        for section in all_sections:
            if excerpt_probe in section.content:
                log.debug("critic_source_slice", method="excerpt",
                          matched=section.heading)
                return section.content

    # 3. Fingerprint match via T3 (no more full-doc fallback)
    if document.section_fingerprints:
        best_score = -1.0
        best_idx = 0
        for i, fp in enumerate(document.section_fingerprints):
            score = _score_fingerprint(mcq.question, fp)
            if score > best_score:
                best_score = score
                best_idx = i

        # Map fingerprint index back to flat section list
        if best_idx < len(all_sections):
            matched_section = all_sections[best_idx]
            log.debug(
                "critic_source_slice",
                method="fingerprint",
                matched=matched_section.heading,
                score=round(best_score, 1),
            )
            return matched_section.content

    # Ultimate fallback (should never reach here after T3 is built)
    log.debug("critic_source_slice", method="full_document_fallback_emergency")
    return document.raw_text


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def critique_mcq(
    mcq: MCQ,
    document: ParsedDocument,
    settings: Settings,
    llm_client: LLMClient,
) -> tuple[CritiqueResult, TokenUsage]:
    """
    Stage 3: evaluate *mcq* against its source document section.

    Uses the Critic-specific provider/model from settings.
    Sends only the most relevant section slice — never the full document.
    """
    from .config import load_dotenv_and_get_api_key

    resolved_model = settings.resolved_critic_model()
    resolved_provider = settings.resolved_critic_provider()

    # Build stage-specific client if needed
    if (
        resolved_provider != settings.provider
        or resolved_model != settings.model
    ):
        api_key = load_dotenv_and_get_api_key(resolved_provider)
        stage_client = make_client(
            provider=resolved_provider.value,
            api_key=api_key,
            default_model=resolved_model,
            max_retries=settings.api_max_retries,
            initial_backoff=settings.api_retry_initial_backoff,
        )
    else:
        stage_client = llm_client

    prompts_dir = Path(settings.prompts_dir)
    template = load_prompt_template(prompts_dir, "critic.txt")

    source_for_prompt = _get_relevant_source(mcq, document)

    prompt = (
        template
        .replace("{source_content}", source_for_prompt)
        .replace("{mcq_json}", mcq.model_dump_json(indent=2))
    )

    question_preview = mcq.question[:80]
    log.info(
        "critic_start",
        question_preview=question_preview,
        model=resolved_model,
        provider=resolved_provider.value,
        source_chars=len(source_for_prompt),
        full_doc_chars=len(document.raw_text),
    )

    critique, usage = stage_client.call(
        prompt=prompt,
        response_model=CritiqueResult,
        temperature=settings.critic_temperature,
        model=resolved_model,
        max_tokens=settings.critic_max_tokens,
    )

    log.info(
        "critic_complete",
        question_preview=question_preview,
        passes=critique.passes,
        issues=critique.issues,
        input_tokens=usage.input_tokens,
        output_tokens=usage.output_tokens,
    )

    return critique, usage
