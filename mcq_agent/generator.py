"""
Module: generator.py  (v0.4)
Stage 2 — MCQ generation.

Changes in v0.4
---------------
_slim_concept_map() now surfaces all v0.4 ConceptMap enrichments:
  - testability_score (Generator prioritises high-scoring concepts)
  - difficulty_range (Generator knows which difficulty is realistic per concept)
  - question_templates (concrete stems from Analyzer — Generator adapts these)
  - confusion_pairs (structured distractor seeds)
  - prerequisite_concepts (helps Generator avoid questions that assume too much)
  - Procedure decision_points and common_failure_modes
  - CodeExample line_annotations and testable_behaviours
  - ThematicClusters (Generator distributes across themes, not just sections)
  - PrerequisiteChains (Generator respects learning order)
"""

import json
import math
from pathlib import Path

import structlog
from pydantic import BaseModel

from .analyzer import load_prompt_template
from .config import Settings
from .llm_client import LLMClient, TokenUsage, make_client
from .parser import ParsedDocument, build_t2_prompt_text
from .schemas import ConceptMap, MCQ, MCQConfig

log = structlog.get_logger(__name__)


class MCQList(BaseModel):
    """Thin wrapper so the LLM returns a named object rather than a bare list."""
    mcqs: list[MCQ]


def _filter_few_shot_examples(
    examples: list[dict],
    concept_map: ConceptMap,
    concept_slice: list | None = None,
) -> list[dict]:
    """Return examples matching the exact Bloom/stem pairs requested."""
    concepts = concept_slice if concept_slice is not None else concept_map.concepts
    target_pairs = {
        (template.bloom_level.value, template.stem_pattern.value)
        for concept in concepts
        for template in concept.question_templates
    }

    return [
        example
        for example in examples
        if (example.get("bloom_level"), example.get("stem_pattern")) in target_pairs
    ]


# ---------------------------------------------------------------------------
# Concept map → compact text  (injected into Generator prompt)
# ---------------------------------------------------------------------------


def _slim_concept_map(concept_map: ConceptMap, concept_slice: list | None = None) -> str:
    """
    Produce a compact but information-dense representation of the ConceptMap.

    If concept_slice is provided (a list of Concept objects), only those
    concepts are rendered in the CONCEPTS section. All other sections
    (procedures, facts, code examples, clusters, chains) are always included
    because they provide context relevant to any concept group.
    """
    lines: list[str] = []

    # Use the provided slice or all concepts sorted by testability
    concepts_to_render = concept_slice if concept_slice is not None else concept_map.concepts
    sorted_concepts = sorted(
        concepts_to_render,
        key=lambda c: c.testability_score,
        reverse=True,
    )

    lines.append("=== CONCEPTS (sorted by testability, highest first) ===")
    for c in sorted_concepts:
        defn = c.definition[:150].rstrip()
        if len(c.definition) > 150:
            defn += "…"

        bloom_str = ", ".join(b.value for b in c.supported_bloom_levels)
        lines.append(
            f"\n[{c.testability_score}/5] {c.name}"
            f"  [difficulty: {c.difficulty_range.min_difficulty.value}–{c.difficulty_range.max_difficulty.value}]"
            f"  [bloom: {bloom_str}]"
            + (" [FOUNDATIONAL]" if c.is_foundational else "")
        )
        lines.append(f"  definition: {defn}")

        if c.prerequisite_concepts:
            lines.append(f"  prerequisites: {', '.join(c.prerequisite_concepts)}")

        if c.confusion_pairs:
            for cp in c.confusion_pairs:
                lines.append(f"  ⚡ confuse with '{cp.confused_with}': {cp.why_confused}")

        if c.common_misconceptions:
            for m in c.common_misconceptions[:2]:
                lines.append(f"  ✗ misconception: {m}")

        if c.question_templates:
            lines.append("  📝 question templates:")
            for qt in c.question_templates:
                lines.append(
                    f"    [{qt.stem_pattern.value} | {qt.target_difficulty.value} | "
                    f"{qt.bloom_level.value}] {qt.stem}"
                )

    # ------------------------------------------------------------------
    # Procedures
    # ------------------------------------------------------------------
    if concept_map.procedures:
        lines.append("\n=== PROCEDURES ===")
        for p in concept_map.procedures:
            lines.append(f"\n{p.name} ({len(p.steps)} steps) [§ {p.source_heading}]")
            for i, step in enumerate(p.steps, 1):
                lines.append(f"  {i}. {step}")
            if p.decision_points:
                lines.append("  branching logic:")
                for dp in p.decision_points:
                    lines.append(f"    IF {dp.condition}")
                    lines.append(f"      → TRUE:  {dp.true_branch}")
                    lines.append(f"      → FALSE: {dp.false_branch}")
            if p.common_failure_modes:
                lines.append("  failure modes (use for debugging questions):")
                for fm in p.common_failure_modes:
                    lines.append(f"    ⚠ {fm}")

    # ------------------------------------------------------------------
    # Technical facts
    # ------------------------------------------------------------------
    if concept_map.technical_facts:
        lines.append("\n=== TECHNICAL FACTS ===")
        for fact in concept_map.technical_facts:
            lines.append(f"  • {fact.fact[:120]}  [§ {fact.source_heading}]")

    # ------------------------------------------------------------------
    # Code examples
    # ------------------------------------------------------------------
    if concept_map.code_examples:
        lines.append("\n=== CODE EXAMPLES ===")
        for ce in concept_map.code_examples:
            lines.append(f"\n{ce.description}  [§ {ce.source_heading}]")
            lines.append(f"  purpose: {ce.purpose}")
            if ce.testable_behaviours:
                lines.append("  testable behaviours:")
                for tb in ce.testable_behaviours:
                    lines.append(f"    → {tb}")
            if ce.line_annotations:
                lines.append("  key lines:")
                for la in ce.line_annotations:
                    lines.append(f"    line {la.line_range}: {la.description}")

    # ------------------------------------------------------------------
    # Thematic clusters
    # ------------------------------------------------------------------
    if concept_map.thematic_clusters:
        lines.append("\n=== THEMATIC CLUSTERS (distribute questions across these) ===")
        for tc in concept_map.thematic_clusters:
            lines.append(f"  [{tc.theme}]: {', '.join(tc.concept_names)}")
            lines.append(f"    rationale: {tc.rationale}")

    # ------------------------------------------------------------------
    # Prerequisite chains
    # ------------------------------------------------------------------
    if concept_map.prerequisite_chains:
        lines.append("\n=== PREREQUISITE CHAINS (foundational → advanced) ===")
        for chain in concept_map.prerequisite_chains:
            lines.append("  " + " → ".join(chain))

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def generate_mcqs(
    document: ParsedDocument,
    concept_map: ConceptMap,
    config: MCQConfig,
    settings: Settings,
    llm_client: LLMClient,
    concept_slice: list | None = None,
) -> tuple[list[MCQ], TokenUsage]:
    """
    Stage 2: generate candidate MCQs.

    If concept_slice is provided, only those concepts are injected into the
    Generator prompt. This enables concept-chunked generation where each call
    focuses on a subset of concepts for better token management.
    """
    from .config import load_dotenv_and_get_api_key

    resolved_model = settings.resolved_generator_model()
    resolved_provider = settings.resolved_generator_provider()

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
        log.info("generator_using_stage_client",
                 provider=resolved_provider.value, model=resolved_model)
    else:
        stage_client = llm_client

    prompts_dir = Path(settings.prompts_dir)
    template = load_prompt_template(prompts_dir, "generator.txt")

    few_shot_path = Path(settings.few_shot_examples_file)
    if few_shot_path.exists():
        with few_shot_path.open(encoding="utf-8") as fh:
            few_shot_data = json.load(fh)
        filtered_few_shot_data = _filter_few_shot_examples(
            few_shot_data,
            concept_map,
            concept_slice=concept_slice,
        )
        few_shot_str = json.dumps(filtered_few_shot_data, indent=2)
        log.info(
            "generator_few_shot_filter",
            pool_size=len(few_shot_data),
            selected_size=len(filtered_few_shot_data),
        )
    else:
        few_shot_str = "[]"

    num_to_generate = min(
        config.num_questions,
        settings.batch_size,
    )
    topic_filter_str = (
        str(config.topic_filter) if config.topic_filter is not None else "no filter"
    )

    t2_text = build_t2_prompt_text(document)
    original_len = len(document.raw_text)
    t2_len = len(t2_text)
    log.info(
        "generator_t2_compression",
        original_chars=original_len,
        t2_chars=t2_len,
        reduction_pct=round((1 - t2_len / max(original_len, 1)) * 100, 1),
    )

    concept_map_text = _slim_concept_map(concept_map, concept_slice=concept_slice)

    # Build the mixed-types hint injected into the <configuration> block.
    has_code_examples = bool(concept_map.code_examples)
    has_procedures = bool(concept_map.procedures)
    if settings.mixed_question_types:
        parts = [
            "- Question type distribution: mixed",
            "  * ~60% single_correct (standard multiple-choice)",
        ]
        if has_procedures:
            parts.append("  * ~20% ordering (step-sequencing for procedures/workflows)")
        if has_code_examples:
            parts.append("  * ~20% code-snippet-based (embed a code block in the stem)")
        if not has_procedures and not has_code_examples:
            parts.append("  * Additional single_correct only (no procedures or code examples found)")
        mixed_types_hint = "\n".join(parts)
    else:
        mixed_types_hint = ""

    prompt = (
        template
        .replace("{source_content}", t2_text)
        .replace("{concept_map}", concept_map_text)
        .replace("{num_questions}", str(config.num_questions))
        .replace("{difficulty}", config.difficulty.value)
        .replace("{question_type}", config.question_type.value)
        .replace("{num_options}", str(config.num_options))
        .replace("{topic_filter}", topic_filter_str)
        .replace("{few_shot_examples}", few_shot_str)
        .replace("{num_questions_to_generate}", str(num_to_generate))
        .replace("{mixed_types_hint}", mixed_types_hint)
    )

    log.info(
        "generator_start",
        num_requested=config.num_questions,
        num_to_generate=num_to_generate,
        difficulty=config.difficulty.value,
        model=resolved_model,
        provider=resolved_provider.value,
        concept_slice_size=len(concept_slice) if concept_slice else len(concept_map.concepts),
        total_concepts=len(concept_map.concepts),
        high_testability=sum(1 for c in (concept_slice or concept_map.concepts) if c.testability_score >= 4),
        mixed_question_types=settings.mixed_question_types,
        has_code_examples=has_code_examples,
        has_procedures=has_procedures,
    )

    mcq_list, usage = stage_client.call(
        prompt=prompt,
        response_model=MCQList,
        temperature=settings.temperature,
        model=resolved_model,
        max_tokens=settings.max_tokens,
    )

    log.info(
        "generator_complete",
        num_generated=len(mcq_list.mcqs),
        input_tokens=usage.input_tokens,
        output_tokens=usage.output_tokens,
    )

    return mcq_list.mcqs, usage
