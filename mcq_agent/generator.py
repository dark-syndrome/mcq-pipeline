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
from .schemas import BloomLevel, ConceptMap, MCQ, MCQConfig

log = structlog.get_logger(__name__)


class MCQList(BaseModel):
    """Thin wrapper so the LLM returns a named object rather than a bare list."""
    mcqs: list[MCQ]


# ---------------------------------------------------------------------------
# Per-Bloom-level generation planning
# ---------------------------------------------------------------------------
#
# The Generator makes one LLM call per *active* Bloom level (a level supported
# by at least one concept), each at that level's configured temperature
# (settings.bloom_temperatures). This consumes the per-Bloom temperature matrix
# faithfully — higher cognitive levels get a higher temperature for more
# creative synthesis. The helpers below are pure (no I/O) so they're unit-testable.

# Canonical Bloom order, foundational → advanced. Used so per-level calls run in a
# stable order and the correct-answer-position guidance stays deterministic.
_BLOOM_ORDER: list[BloomLevel] = [
    BloomLevel.REMEMBER,
    BloomLevel.UNDERSTAND,
    BloomLevel.APPLY,
    BloomLevel.ANALYZE,
    BloomLevel.EVALUATE,
    BloomLevel.CREATE,
]

# Bloom levels for which ordering / code-snippet question hints make sense.
# Recall/comprehension batches (remember, understand) should not be pushed to
# embed code blocks or step-sequencing tasks.
_HIGHER_ORDER_BLOOMS: set[BloomLevel] = {
    BloomLevel.APPLY,
    BloomLevel.ANALYZE,
    BloomLevel.EVALUATE,
    BloomLevel.CREATE,
}

# Per-level directive lines injected into the Generator prompt. Aligned with the
# <difficulty_rubric> in prompts/generator.txt.
_BLOOM_GUIDANCE: dict[BloomLevel, str] = {
    BloomLevel.REMEMBER: (
        "Test direct recall of facts, terms, and definitions stated in the source. "
        "Prefer the definition stem pattern. Maps to EASY difficulty."
    ),
    BloomLevel.UNDERSTAND: (
        "Test comprehension — paraphrase, classify, or explain a concept in the "
        "learner's own terms. Maps to EASY difficulty."
    ),
    BloomLevel.APPLY: (
        "Test use of a concept in a concrete, novel scenario. Prefer the scenario "
        "stem pattern. Maps to MEDIUM difficulty."
    ),
    BloomLevel.ANALYZE: (
        "Test decomposition — compare options, identify causes, or diagnose a fault. "
        "Prefer debugging or comparison stem patterns. Maps to HARD difficulty."
    ),
    BloomLevel.EVALUATE: (
        "Test judgement between trade-offs, where no option is obviously correct "
        "until reasoned through. Maps to EXPERT difficulty."
    ),
    BloomLevel.CREATE: (
        "Test synthesis — designing or combining approaches to satisfy competing "
        "constraints. Maps to EXPERT difficulty."
    ),
}


def _active_bloom_levels(concept_map: ConceptMap) -> list[BloomLevel]:
    """Return the Bloom levels supported by at least one concept, in canonical order."""
    present = {b for c in concept_map.concepts for b in c.supported_bloom_levels}
    return [b for b in _BLOOM_ORDER if b in present]


def _concepts_for_bloom(concept_map: ConceptMap, level: BloomLevel) -> list:
    """Return concepts whose supported_bloom_levels include `level`.

    A concept supporting several levels appears in several slices — this is
    intentional. Cross-level near-duplicates are caught downstream by the
    validators, the critic, and the Supabase similarity gate.
    """
    return [c for c in concept_map.concepts if level in c.supported_bloom_levels]


def _distribute_deficit(
    deficit: int,
    levels: list[BloomLevel],
    concept_map: ConceptMap,
) -> dict[BloomLevel, int]:
    """Split `deficit` questions across the active Bloom `levels`.

    Even split, with any remainder handed to the levels backed by the most
    concepts (so the extra questions land where the source can sustain them).
    Levels that would receive 0 questions are dropped (happens only when
    deficit < len(levels)). Returns {level: question_count}, each value > 0.
    """
    n = len(levels)
    if n == 0 or deficit <= 0:
        return {}
    base, rem = divmod(deficit, n)
    support = {lvl: len(_concepts_for_bloom(concept_map, lvl)) for lvl in levels}
    # Rank by concept support (desc); ties keep canonical order for determinism.
    ranked = sorted(levels, key=lambda l: (-support[l], _BLOOM_ORDER.index(l)))
    alloc = {lvl: base for lvl in levels}
    for i in range(rem):
        alloc[ranked[i]] += 1
    return {lvl: q for lvl, q in alloc.items() if q > 0}


def _bloom_directive(level: BloomLevel | None) -> str:
    """Build the prompt directive that pins generation to a single Bloom level.

    Returns "" when level is None (flat fallback) so the placeholder renders empty.
    """
    if level is None:
        return ""
    return (
        f"- TARGET COGNITIVE LEVEL (Bloom's): {level.value.upper()}\n"
        f"  Every question in this batch MUST operate at the \"{level.value}\" "
        f"cognitive level. {_BLOOM_GUIDANCE[level]}\n"
        f"  Emit bloom_level: \"{level.value}\" for every question, and match the "
        f"difficulty to the <difficulty_rubric> above."
    )


def _filter_few_shot_examples(
    examples: list[dict],
    concept_map: ConceptMap,
    concept_slice: list | None = None,
    bloom_target: BloomLevel | None = None,
) -> list[dict]:
    """Return examples matching the exact Bloom/stem pairs requested.

    When bloom_target is set, additionally drop any example whose bloom_level is
    not the target level, so a per-level call only sees on-level few-shots.
    """
    concepts = concept_slice if concept_slice is not None else concept_map.concepts
    target_pairs = {
        (template.bloom_level.value, template.stem_pattern.value)
        for concept in concepts
        for template in concept.question_templates
        if bloom_target is None or template.bloom_level == bloom_target
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
    temperature_override: float | None = None,
    bloom_target: BloomLevel | None = None,
) -> tuple[list[MCQ], TokenUsage]:
    """
    Stage 2: generate candidate MCQs.

    If concept_slice is provided, only those concepts are injected into the
    Generator prompt. This enables concept-chunked generation where each call
    focuses on a subset of concepts for better token management.

    temperature_override, when set, replaces settings.temperature for this call —
    used by the per-Bloom-level generation loop to apply each level's configured
    temperature. bloom_target, when set, pins the batch to a single cognitive
    level (injected as a prompt directive and used to filter few-shot examples).
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
            bloom_target=bloom_target,
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
    # Ordering and code-snippet questions are higher-order (apply+) cognitive
    # tasks; suppress those hints for remember/understand per-Bloom batches so the
    # level directive and the type hint don't pull in opposite directions.
    has_code_examples = bool(concept_map.code_examples)
    has_procedures = bool(concept_map.procedures)
    higher_order = bloom_target is None or bloom_target in _HIGHER_ORDER_BLOOMS
    if settings.mixed_question_types:
        parts = [
            "- Question type distribution: mixed",
            "  * ~60% single_correct (standard multiple-choice)",
        ]
        if has_procedures and higher_order:
            parts.append("  * ~20% ordering (step-sequencing for procedures/workflows)")
        if has_code_examples and higher_order:
            parts.append("  * ~20% code-snippet-based (embed a code block in the stem)")
        if len(parts) == 2:
            parts.append("  * Additional single_correct only "
                         "(no suitable procedures or code examples for this level)")
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
        .replace("{bloom_directive}", _bloom_directive(bloom_target))
    )

    effective_temp = (
        temperature_override if temperature_override is not None else settings.temperature
    )

    log.info(
        "generator_start",
        num_requested=config.num_questions,
        num_to_generate=num_to_generate,
        difficulty=config.difficulty.value,
        bloom_target=bloom_target.value if bloom_target else "flat",
        temperature=effective_temp,
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
        temperature=effective_temp,
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
