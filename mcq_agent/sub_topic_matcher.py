"""
Module: sub_topic_matcher.py
Builds the 4-element tag list for each generated MCQ.

Tag format:
    [TOPIC_TAG, BLOOM_LEVEL, IS_PUBLIC, COURSE_TAG]

e.g.  ["LINUX_ROS2_FUNDAMENTALS", "APPLY", "IS_PUBLIC", "GRIT_ROBOTICS_L1_MAIN"]

TOPIC_TAG  — explicitly supplied at generation time (no auto-classification)
BLOOM_LEVEL — derived from the MCQ's bloom_level field (REMEMBER … CREATE)
IS_PUBLIC   — present when is_public=True (default)
COURSE_TAG  — explicitly supplied at generation time

The ROBOTICS_MODULES constant below is kept as reference / seed data for the
topic_tags table in SQLite.  It is NOT used for automatic classification.
"""

from __future__ import annotations

from .schemas import MCQ

# ---------------------------------------------------------------------------
# Reference: the 8 GRIT Robotics L1 module tags (seeded into the DB on init)
# ---------------------------------------------------------------------------

ROBOTICS_MODULES: list[str] = [
    "LINUX_ROS2_FUNDAMENTALS",
    "ROBOT_MODELLING",
    "ROBOT_MATHEMATICS",
    "SIMULATION",
    "SLAM",
    "NAVIGATION",
    "COMPUTER_VISION",
    "EMBEDDED_SYSTEMS",
]

MODULE_BY_NUMBER: dict[int, str] = {i + 1: tag for i, tag in enumerate(ROBOTICS_MODULES)}


def resolve_module_override(value: str) -> str:
    """Accept 1-8 (module number) or a tag name and return the canonical tag."""
    if value.isdigit():
        n = int(value)
        if n not in MODULE_BY_NUMBER:
            raise ValueError(f"Module number {n} is out of range (1–{len(MODULE_BY_NUMBER)}).")
        return MODULE_BY_NUMBER[n]
    return value.strip().upper().replace(" ", "_")


def assign_tags(
    mcqs: list[MCQ],
    topic_tag: str,
    is_public: bool = True,
    course_tag: str = "GRIT_ROBOTICS_L1_MAIN",
    subtopics: list[str] | None = None,
) -> None:
    """
    Assign the tag list to every MCQ in *mcqs*.

    Tag order: [SUB_TOPIC, BLOOM_LEVEL, IS_PUBLIC, COURSE_TAG]

    When *subtopics* is provided (multi-subtopic run), the generator will have
    already set each MCQ's ``sub_topic`` to the most appropriate value from
    the list. This function respects that assignment if it's valid, and falls
    back to *topic_tag* otherwise.

    Args:
        mcqs:       Questions to tag (mutated in place).
        topic_tag:  Run-level fallback tag (used when subtopics is empty or
                    the LLM assigned an invalid value).
        is_public:  When True, "IS_PUBLIC" is included in the tag list.
        course_tag: The course tag (e.g. "GRIT_ROBOTICS_L1_MAIN").
        subtopics:  Ordered list of valid subtopic tags for this run.
                    When present, each MCQ's sub_topic is validated against
                    this set; invalid values fall back to topic_tag.
    """
    valid_set: set[str] = set(subtopics) if subtopics else set()
    for mcq in mcqs:
        bloom = mcq.bloom_level.value.upper()
        # Respect the LLM-assigned sub_topic when it's from the valid list.
        if valid_set and mcq.sub_topic in valid_set:
            effective = mcq.sub_topic
        else:
            effective = topic_tag
        tag_list: list[str] = [effective, bloom]
        if is_public:
            tag_list.append("IS_PUBLIC")
        tag_list.append(course_tag)
        mcq.sub_topic = effective
        mcq.tags = tag_list


# ---------------------------------------------------------------------------
# Legacy shim — keeps old call-sites that pass a Path working
# ---------------------------------------------------------------------------

def assign_sub_topics(mcqs: list[MCQ], sub_topics_path: object) -> None:  # noqa: ANN001
    """Backward-compatible no-op. Use assign_tags() directly instead."""
    pass
