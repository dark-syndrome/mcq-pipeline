"""Offline unit tests for the per-Bloom-level generation planning helpers
(generator.py) and the reframer failure-class taxonomy reused by the
question_rejected event (pipeline.py / cli.py)."""

from mcq_agent.generator import (
    _active_bloom_levels,
    _bloom_directive,
    _concepts_for_bloom,
    _distribute_deficit,
)
from mcq_agent.schemas import (
    BloomLevel,
    Concept,
    ConceptMap,
)


def _concept(name: str, blooms: list[BloomLevel]) -> Concept:
    return Concept(
        name=name,
        definition=f"definition of {name}",
        source_heading="H",
        is_foundational=False,
        supported_bloom_levels=blooms,
    )


def _map(concepts: list[Concept]) -> ConceptMap:
    return ConceptMap(
        concepts=concepts,
        relationships=[],
        procedures=[],
        technical_facts=[],
    )


def test_active_bloom_levels_union_in_canonical_order():
    cm = _map([
        _concept("a", [BloomLevel.APPLY, BloomLevel.REMEMBER]),
        _concept("b", [BloomLevel.ANALYZE]),
        _concept("c", [BloomLevel.REMEMBER]),
    ])
    # Deduplicated union, returned foundational → advanced.
    assert _active_bloom_levels(cm) == [
        BloomLevel.REMEMBER,
        BloomLevel.APPLY,
        BloomLevel.ANALYZE,
    ]


def test_active_bloom_levels_empty_when_no_levels():
    cm = _map([_concept("a", [])])
    assert _active_bloom_levels(cm) == []


def test_concepts_for_bloom_filters_by_support():
    a = _concept("a", [BloomLevel.APPLY, BloomLevel.REMEMBER])
    b = _concept("b", [BloomLevel.ANALYZE])
    cm = _map([a, b])
    assert _concepts_for_bloom(cm, BloomLevel.APPLY) == [a]
    assert _concepts_for_bloom(cm, BloomLevel.ANALYZE) == [b]
    assert _concepts_for_bloom(cm, BloomLevel.CREATE) == []


def test_distribute_deficit_even_split():
    cm = _map([_concept("a", [BloomLevel.REMEMBER, BloomLevel.APPLY])])
    levels = [BloomLevel.REMEMBER, BloomLevel.APPLY]
    alloc = _distribute_deficit(6, levels, cm)
    assert alloc == {BloomLevel.REMEMBER: 3, BloomLevel.APPLY: 3}
    assert sum(alloc.values()) == 6


def test_distribute_deficit_remainder_goes_to_highest_support():
    # remember backed by 2 concepts, apply by 1 → remainder favours remember.
    cm = _map([
        _concept("a", [BloomLevel.REMEMBER]),
        _concept("b", [BloomLevel.REMEMBER, BloomLevel.APPLY]),
    ])
    levels = [BloomLevel.REMEMBER, BloomLevel.APPLY]
    alloc = _distribute_deficit(5, levels, cm)  # base 2 each, rem 1
    assert alloc[BloomLevel.REMEMBER] == 3
    assert alloc[BloomLevel.APPLY] == 2
    assert sum(alloc.values()) == 5


def test_distribute_deficit_tiny_deficit_drops_zero_levels():
    cm = _map([
        _concept("a", [BloomLevel.REMEMBER]),
        _concept("b", [BloomLevel.APPLY]),
        _concept("c", [BloomLevel.ANALYZE]),
    ])
    levels = [BloomLevel.REMEMBER, BloomLevel.APPLY, BloomLevel.ANALYZE]
    alloc = _distribute_deficit(2, levels, cm)  # base 0, rem 2 → only 2 levels
    assert sum(alloc.values()) == 2
    assert all(q > 0 for q in alloc.values())
    assert len(alloc) == 2


def test_distribute_deficit_empty_inputs():
    cm = _map([])
    assert _distribute_deficit(5, [], cm) == {}
    assert _distribute_deficit(0, [BloomLevel.REMEMBER], cm) == {}


def test_bloom_directive_none_is_empty():
    assert _bloom_directive(None) == ""


def test_bloom_directive_names_level_and_value():
    d = _bloom_directive(BloomLevel.ANALYZE)
    assert "ANALYZE" in d
    assert 'bloom_level: "analyze"' in d
