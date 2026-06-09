from mcq_agent.generator import _filter_few_shot_examples
from mcq_agent.schemas import (
    BloomLevel,
    Concept,
    ConceptMap,
    Difficulty,
    QuestionTemplate,
    StemPattern,
)


def _concept(
    name: str,
    bloom_level: BloomLevel,
    stem_pattern: StemPattern,
) -> Concept:
    return Concept(
        name=name,
        definition=f"{name} definition",
        source_heading="Test",
        is_foundational=False,
        supported_bloom_levels=[bloom_level],
        question_templates=[
            QuestionTemplate(
                stem=f"Question about {name}",
                stem_pattern=stem_pattern,
                target_difficulty=Difficulty.HARD,
                bloom_level=bloom_level,
            )
        ],
    )


def _concept_map(concepts: list[Concept]) -> ConceptMap:
    return ConceptMap(
        concepts=concepts,
        relationships=[],
        procedures=[],
        technical_facts=[],
    )


def test_filter_few_shot_examples_uses_exact_template_attributes():
    debugging = {"id": "match", "bloom_level": "analyze", "stem_pattern": "debugging"}
    wrong_bloom = {"id": "bloom", "bloom_level": "apply", "stem_pattern": "debugging"}
    wrong_pattern = {"id": "pattern", "bloom_level": "analyze", "stem_pattern": "scenario"}
    concept = _concept("Failures", BloomLevel.ANALYZE, StemPattern.DEBUGGING)
    concept_map = _concept_map([concept])

    selected = _filter_few_shot_examples(
        [wrong_bloom, debugging, wrong_pattern],
        concept_map,
    )

    assert selected == [debugging]


def test_filter_few_shot_examples_respects_concept_slice():
    debugging = {"id": "debug", "bloom_level": "analyze", "stem_pattern": "debugging"}
    definition = {"id": "definition", "bloom_level": "remember", "stem_pattern": "definition"}
    debug_concept = _concept("Failures", BloomLevel.ANALYZE, StemPattern.DEBUGGING)
    definition_concept = _concept("Terms", BloomLevel.REMEMBER, StemPattern.DEFINITION)
    concept_map = _concept_map([debug_concept, definition_concept])

    selected = _filter_few_shot_examples(
        [debugging, definition],
        concept_map,
        concept_slice=[definition_concept],
    )

    assert selected == [definition]


def test_filter_few_shot_examples_does_not_fallback_to_near_matches():
    concept = _concept("Design", BloomLevel.CREATE, StemPattern.SCENARIO)
    concept_map = _concept_map([concept])

    selected = _filter_few_shot_examples(
        [{"bloom_level": "evaluate", "stem_pattern": "scenario"}],
        concept_map,
    )

    assert selected == []
