"""Tests for the deterministic validators in mcq_agent.validators.

Focus: the ORDERING structural-integrity checks and the tightened
MULTIPLE_CORRECT uniqueness rule — the two gaps that let an incomplete
ordering question through to the database.
"""

import pytest

from mcq_agent.schemas import (
    BloomLevel,
    Difficulty,
    MCQ,
    Option,
    QuestionType,
    StemPattern,
)
from mcq_agent.validators import (
    validate_ordering_structure,
    validate_uniqueness,
)


def _ordering_mcq(option_texts, statements, correct_index=0) -> MCQ:
    """Build an ORDERING MCQ from raw option sequence strings."""
    options = []
    for i, text in enumerate(option_texts):
        is_correct = i == correct_index
        options.append(
            Option(
                label="ABCD"[i],
                text=text,
                is_correct=is_correct,
                distractor_rationale=None if is_correct else "Plausible mistake.",
            )
        )
    return MCQ(
        question=(
            "The following steps are listed out of order:\n\n"
            + "\n".join(f"{i + 1}. {s}" for i, s in enumerate(statements))
            + "\n\nWhich sequence is correct?"
        ),
        options=options,
        explanation="The correct order follows from the source.",
        source_excerpt="Steps must be performed in this order.",
        source_heading="Procedures",
        bloom_level=BloomLevel.APPLY,
        difficulty=Difficulty.MEDIUM,
        question_type=QuestionType.ORDERING,
        stem_pattern=StemPattern.PROCEDURE,
        ordering_statements=statements,
    )


def _multiple_correct_mcq(correct_flags) -> MCQ:
    options = []
    for i, is_correct in enumerate(correct_flags):
        options.append(
            Option(
                label="ABCD"[i],
                text=f"Option {i}",
                is_correct=is_correct,
                distractor_rationale=None if is_correct else "Tempting but wrong.",
            )
        )
    return MCQ(
        question="Which of the following statements are true about the system?",
        options=options,
        explanation="Multiple statements hold.",
        source_excerpt="Several properties are true.",
        source_heading="Properties",
        bloom_level=BloomLevel.ANALYZE,
        difficulty=Difficulty.MEDIUM,
        question_type=QuestionType.MULTIPLE_CORRECT,
        stem_pattern=StemPattern.SCENARIO,
    )


STATEMENTS = ["Do A", "Do B", "Do C", "Do D"]


def test_valid_ordering_passes():
    mcq = _ordering_mcq(
        ["3 → 1 → 4 → 2", "1 → 2 → 3 → 4", "2 → 1 → 4 → 3", "4 → 3 → 2 → 1"],
        STATEMENTS,
    )
    passes, reason = validate_ordering_structure(mcq)
    assert passes, reason


def test_missing_ordering_statements_fails():
    mcq = _ordering_mcq(
        ["3 → 1 → 4 → 2", "1 → 2 → 3 → 4", "2 → 1 → 4 → 3", "4 → 3 → 2 → 1"],
        STATEMENTS,
    )
    # Simulate the real failure: structured steps absent.
    mcq.ordering_statements = None
    passes, reason = validate_ordering_structure(mcq)
    assert not passes
    assert "ordering_statements" in reason


def test_blank_statement_fails():
    mcq = _ordering_mcq(
        ["3 → 1 → 4 → 2", "1 → 2 → 3 → 4", "2 → 1 → 4 → 3", "4 → 3 → 2 → 1"],
        ["Do A", "   ", "Do C", "Do D"],
    )
    passes, reason = validate_ordering_structure(mcq)
    assert not passes
    assert "blank" in reason


def test_option_with_wrong_step_count_fails():
    mcq = _ordering_mcq(
        ["3 → 1 → 4", "1 → 2 → 3 → 4", "2 → 1 → 4 → 3", "4 → 3 → 2 → 1"],
        STATEMENTS,
    )
    passes, reason = validate_ordering_structure(mcq)
    assert not passes
    assert "steps" in reason


def test_option_out_of_range_step_fails():
    mcq = _ordering_mcq(
        ["3 → 1 → 5 → 2", "1 → 2 → 3 → 4", "2 → 1 → 4 → 3", "4 → 3 → 2 → 1"],
        STATEMENTS,
    )
    passes, reason = validate_ordering_structure(mcq)
    assert not passes
    assert "permutation" in reason


def test_option_with_no_sequence_fails():
    mcq = _ordering_mcq(
        ["first do A then B", "1 → 2 → 3 → 4", "2 → 1 → 4 → 3", "4 → 3 → 2 → 1"],
        STATEMENTS,
    )
    passes, reason = validate_ordering_structure(mcq)
    assert not passes
    assert "sequence" in reason


def test_non_ordering_passes_trivially():
    mcq = _multiple_correct_mcq([True, True, False, False])
    assert validate_ordering_structure(mcq) == (True, None)


def test_multiple_correct_requires_two_correct():
    mcq = _multiple_correct_mcq([True, False, False, False])
    passes, reason = validate_uniqueness(mcq, QuestionType.MULTIPLE_CORRECT)
    assert not passes
    assert "at least 2" in reason


def test_multiple_correct_two_correct_passes():
    mcq = _multiple_correct_mcq([True, True, False, False])
    passes, reason = validate_uniqueness(mcq, QuestionType.MULTIPLE_CORRECT)
    assert passes, reason


def test_multiple_correct_all_correct_fails():
    mcq = _multiple_correct_mcq([True, True, True, True])
    passes, reason = validate_uniqueness(mcq, QuestionType.MULTIPLE_CORRECT)
    assert not passes
    assert "all options" in reason
