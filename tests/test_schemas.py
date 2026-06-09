import pytest

from mcq_agent.schemas import (
    BloomLevel,
    Difficulty,
    MCQ,
    Option,
    QuestionType,
    StemPattern,
)


def _mcq(bloom_level: str) -> MCQ:
    return MCQ(
        question="A node fails to start. What is the most likely cause?",
        options=[
            Option(label="A", text="Correct cause", is_correct=True),
            Option(
                label="B",
                text="Wrong cause",
                is_correct=False,
                distractor_rationale="Tempting but unrelated.",
            ),
        ],
        explanation="Because the environment was not sourced.",
        source_excerpt="You forgot to source the setup file.",
        source_heading="Beginner Confusions",
        bloom_level=bloom_level,
        difficulty=Difficulty.HARD,
        question_type=QuestionType.SINGLE_CORRECT,
        stem_pattern=StemPattern.DEBUGGING,
    )


@pytest.mark.parametrize(
    "leaked, expected",
    [
        ("debugging", BloomLevel.ANALYZE),
        ("comparison", BloomLevel.ANALYZE),
        ("scenario", BloomLevel.APPLY),
        ("procedure", BloomLevel.APPLY),
        ("definition", BloomLevel.REMEMBER),
        ("Debugging", BloomLevel.ANALYZE),
    ],
)
def test_stem_pattern_leaked_into_bloom_is_coerced(leaked, expected):
    assert _mcq(leaked).bloom_level == expected


def test_valid_bloom_level_is_untouched():
    assert _mcq("apply").bloom_level == BloomLevel.APPLY


def test_unknown_bloom_level_still_rejected():
    with pytest.raises(ValueError):
        _mcq("nonsense")
