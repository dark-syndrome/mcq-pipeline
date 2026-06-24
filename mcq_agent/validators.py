"""
Module: validators.py
Pure-Python validation checks executed after LLM output and before the critic.

Each individual validator returns ``(passes: bool, reason: str | None)`` so
failures carry a human-readable explanation.  :func:`run_all_validators`
orchestrates all checks and aggregates their results.

New in optimised build
----------------------
- validate_bloom_difficulty_alignment  — bloom_level consistent with difficulty
- validate_length_parity               — correct answer not >30% longer than median distractor
- validate_source_phrase_overlap       — correct answer doesn't echo source_excerpt phrases
- shuffle_correct_answer_positions     — post-generation utility to remove B/C position bias
"""

import random
import re
import statistics

from .config import Settings
from .parser import ParsedDocument
from .schemas import BloomLevel, Difficulty, MCQ, MCQConfig, QuestionType


# ---------------------------------------------------------------------------
# Individual validators
# ---------------------------------------------------------------------------


def validate_source_grounding(
    mcq: MCQ,
    document: ParsedDocument,
    threshold: float = 0.85,
) -> tuple[bool, str | None]:
    """
    Check that ``mcq.source_excerpt`` is present in the source document via
    fuzzy matching.

    Uses ``rapidfuzz.fuzz.partial_ratio`` so minor whitespace or punctuation
    differences are tolerated.
    """
    from rapidfuzz import fuzz  # local import to keep top-level imports clean

    score = fuzz.partial_ratio(mcq.source_excerpt, document.raw_text) / 100.0
    if score >= threshold:
        return True, None
    return (
        False,
        f"source_excerpt not found in document (best match: {score:.2f})",
    )


def validate_uniqueness(
    mcq: MCQ,
    question_type: QuestionType,
) -> tuple[bool, str | None]:
    """
    Check that the number of correct options is consistent with *question_type*.

    - ``SINGLE_CORRECT``:   exactly one option must have ``is_correct=True``.
    - ``MULTIPLE_CORRECT``: at least two but not all options must be correct.
    - ``ORDERING``:         exactly one option (the correct sequence) is correct;
                            ``ordering_statements`` must be present. Structural
                            integrity of the sequences is checked separately by
                            :func:`validate_ordering_structure`.
    """
    correct_count = sum(1 for opt in mcq.options if opt.is_correct)
    total = len(mcq.options)

    if question_type == QuestionType.ORDERING:
        if not mcq.ordering_statements:
            return False, "ORDERING question is missing ordering_statements"
        if correct_count != 1:
            return (
                False,
                f"ORDERING question must have exactly 1 correct option "
                f"(the correct sequence), found {correct_count}",
            )
        return True, None

    if question_type == QuestionType.SINGLE_CORRECT:
        if correct_count == 1:
            return True, None
        return (
            False,
            f"SINGLE_CORRECT question must have exactly 1 correct option, "
            f"found {correct_count}",
        )

    # MULTIPLE_CORRECT
    if correct_count < 2:
        return (
            False,
            f"MULTIPLE_CORRECT question must have at least 2 correct options, "
            f"found {correct_count}",
        )
    if correct_count == total:
        return False, "MULTIPLE_CORRECT question has all options marked correct"
    return True, None


# ---------------------------------------------------------------------------
# Ordering structural integrity
# ---------------------------------------------------------------------------


_SEQUENCE_TOKEN_RE = re.compile(r"\d+")


def _parse_sequence(text: str) -> list[int] | None:
    """
    Extract the ordered list of step numbers from an ORDERING option.

    Options look like ``"3 → 1 → 4 → 2"`` (the arrow may be →, ->, or any
    separator). Returns the integers in the order they appear, or ``None`` if
    the option contains no digits at all (i.e. it is not a sequence option).
    """
    nums = [int(m) for m in _SEQUENCE_TOKEN_RE.findall(text)]
    return nums or None


def validate_ordering_structure(mcq: MCQ) -> tuple[bool, str | None]:
    """
    Structural integrity checks for ORDERING questions.

    This is the deterministic guarantee that an ORDERING question is actually
    answerable once exported — the failure mode where the numbered steps are
    missing and only bare sequences (``3 → 1 → 4 → 2``) survive.

    Checks (non-ORDERING questions pass trivially):
    - ``ordering_statements`` is present and every statement is non-trivial.
    - Each option encodes a sequence that is a permutation of ``1..N`` where
      ``N == len(ordering_statements)`` — no missing, extra, duplicate, or
      out-of-range step numbers.
    """
    if mcq.question_type != QuestionType.ORDERING:
        return True, None

    statements = mcq.ordering_statements or []
    if not statements:
        return (
            False,
            "ORDERING question is missing ordering_statements (the numbered steps); "
            "the exported question would be unanswerable",
        )

    blank = [i + 1 for i, s in enumerate(statements) if not (s or "").strip()]
    if blank:
        return (
            False,
            f"ordering_statements contains blank step(s) at position(s): {blank}",
        )

    n = len(statements)
    expected = set(range(1, n + 1))

    for opt in mcq.options:
        seq = _parse_sequence(opt.text)
        if not seq:
            return (
                False,
                f"ORDERING option '{opt.label}' does not contain a step sequence "
                f"(expected something like '1 → 2 → 3 → ...'): {opt.text!r}",
            )
        if len(seq) != n:
            return (
                False,
                f"ORDERING option '{opt.label}' lists {len(seq)} steps but there "
                f"are {n} ordering_statements; every option must order all steps",
            )
        if set(seq) != expected:
            return (
                False,
                f"ORDERING option '{opt.label}' sequence {seq} is not a valid "
                f"permutation of steps 1..{n} (duplicate or out-of-range step numbers)",
            )

    return True, None


def validate_option_count(
    mcq: MCQ,
    expected: int,
) -> tuple[bool, str | None]:
    """Check that the MCQ has exactly *expected* options."""
    actual = len(mcq.options)
    if actual == expected:
        return True, None
    return (
        False,
        f"expected {expected} options, found {actual}",
    )


def validate_distractor_rationales(mcq: MCQ) -> tuple[bool, str | None]:
    """
    Check that every incorrect option has a non-empty ``distractor_rationale``.

    For ORDERING questions, the three incorrect sequence options (is_correct=False)
    each need a distractor_rationale explaining why a learner might choose that order.
    """
    missing = [
        opt.label
        for opt in mcq.options
        if not opt.is_correct and not (opt.distractor_rationale or "").strip()
    ]
    if not missing:
        return True, None
    labels = ", ".join(missing)
    return (
        False,
        f"distractor_rationale missing or empty for option(s): {labels}",
    )


def validate_bloom_difficulty_alignment(
    mcq: MCQ,
) -> tuple[bool, str | None]:
    """
    Check that the MCQ's bloom_level is consistent with its difficulty.

    Allowed mappings (deliberately permissive to avoid over-rejection):
        EASY   → remember, understand, apply
                 (a simple scenario question is still 'apply' at Bloom's
                  even when the cognitive demand is low)
        MEDIUM → understand, apply, analyze
        HARD   → apply, analyze, evaluate
        EXPERT → analyze, evaluate, create
    """
    expected: dict[Difficulty, set[BloomLevel]] = {
        Difficulty.EASY:   {BloomLevel.REMEMBER, BloomLevel.UNDERSTAND, BloomLevel.APPLY},
        Difficulty.MEDIUM: {BloomLevel.UNDERSTAND, BloomLevel.APPLY, BloomLevel.ANALYZE},
        Difficulty.HARD:   {BloomLevel.APPLY, BloomLevel.ANALYZE, BloomLevel.EVALUATE},
        Difficulty.EXPERT: {BloomLevel.ANALYZE, BloomLevel.EVALUATE, BloomLevel.CREATE},
    }
    allowed = expected.get(mcq.difficulty, set())
    if mcq.bloom_level not in allowed:
        return (
            False,
            f"bloom_level '{mcq.bloom_level.value}' is inconsistent with "
            f"difficulty '{mcq.difficulty.value}' "
            f"(expected one of: {[b.value for b in allowed]})",
        )
    return True, None


def validate_length_parity(
    mcq: MCQ,
    max_ratio: float = 1.30,
) -> tuple[bool, str | None]:
    """
    Check that the correct answer option is not more than *max_ratio* times
    the median word count of the distractors.

    A ratio above 1.30 (30% longer) is a test-wiseness cue — students learn
    to pick the longest option.

    Args:
        mcq:       The MCQ to check.
        max_ratio: Maximum allowed ratio of correct-option length to median
                   distractor length. Default 1.30.

    Returns:
        ``(True, None)`` on success or ``(False, reason)`` on failure.
    """
    correct_opts = [opt for opt in mcq.options if opt.is_correct]
    distractor_opts = [opt for opt in mcq.options if not opt.is_correct]

    if not correct_opts or not distractor_opts:
        return True, None  # can't check — other validators will catch this

    correct_len = max(len(opt.text.split()) for opt in correct_opts)
    distractor_lens = [len(opt.text.split()) for opt in distractor_opts]
    median_distractor = statistics.median(distractor_lens)

    if median_distractor == 0:
        return True, None

    ratio = correct_len / median_distractor
    if ratio <= max_ratio:
        return True, None

    return (
        False,
        f"correct answer ({correct_len} words) is {ratio:.2f}x the median "
        f"distractor length ({median_distractor:.0f} words); max allowed "
        f"ratio is {max_ratio:.2f}. Expand distractors or trim correct answer.",
    )


def validate_source_phrase_overlap(
    mcq: MCQ,
    ngram_size: int = 5,
) -> tuple[bool, str | None]:
    """
    Check that the correct answer does not reproduce *ngram_size*-word n-grams
    verbatim from ``mcq.source_excerpt``.

    A match means the student can answer by phrase-matching rather than
    understanding — defeating the purpose of the question.

    Args:
        mcq:        The MCQ to check.
        ngram_size: Minimum consecutive word sequence to flag as a match.
                    Default 5.
    """
    excerpt_words = mcq.source_excerpt.lower().split()
    excerpt_ngrams: set[tuple[str, ...]] = {
        tuple(excerpt_words[i : i + ngram_size])
        for i in range(len(excerpt_words) - ngram_size + 1)
    }

    for opt in mcq.options:
        if not opt.is_correct:
            continue
        opt_words = opt.text.lower().split()
        for i in range(len(opt_words) - ngram_size + 1):
            ngram = tuple(opt_words[i : i + ngram_size])
            if ngram in excerpt_ngrams:
                phrase = " ".join(ngram)
                return (
                    False,
                    f"correct answer reproduces a {ngram_size}-gram from "
                    f"source_excerpt: '{phrase}'. Paraphrase the correct answer.",
                )

    return True, None


# ---------------------------------------------------------------------------
# Post-generation utility
# ---------------------------------------------------------------------------


def shuffle_correct_answer_positions(mcqs: list[MCQ]) -> list[MCQ]:
    """
    Redistribute the correct answer across positions A/B/C/D to remove LLM
    position bias (tendency to place the correct answer at B or C).

    For each MCQ, randomly reorder the options list while preserving all field
    values. Labels (A, B, C, D) are reassigned in order after shuffling.

    ORDERING questions are shuffled like any other type: the correct sequence
    option moves to a random position and labels are reassigned.

    Args:
        mcqs: List of MCQs to shuffle in-place.

    Returns:
        The same list with shuffled option positions.
    """
    label_sequence = list("ABCDEFGHIJKLMNOPQRSTUVWXYZ")

    shuffled_mcqs: list[MCQ] = []
    for mcq in mcqs:
        options_copy = list(mcq.options)
        random.shuffle(options_copy)

        new_options = []
        for idx, opt in enumerate(options_copy):
            new_opt = opt.model_copy(update={"label": label_sequence[idx]})
            new_options.append(new_opt)

        shuffled_mcqs.append(mcq.model_copy(update={"options": new_options}))

    return shuffled_mcqs


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


def run_all_validators(
    mcq: MCQ,
    document: ParsedDocument,
    config: MCQConfig,
    settings: Settings,
) -> tuple[bool, list[str]]:
    """
    Run all validators against *mcq* and aggregate the results.

    All validators are always executed (no short-circuit) so the caller gets
    the full picture of failures — useful for debugging and prompt tuning.

    Validators run (in order):
    1. source_grounding        — excerpt fuzzy-matched against document
    2. uniqueness              — correct option count matches question_type
    3. ordering_structure      — ordering steps present + options are valid permutations
    4. option_count            — matches configured num_options
    5. distractor_rationales   — all distractors have rationale text
    6. bloom_difficulty        — bloom level consistent with difficulty
    7. length_parity           — correct answer not >30% longer than distractors
    8. source_phrase_overlap   — correct answer doesn't echo source_excerpt

    Args:
        mcq:      The MCQ to validate.
        document: The parsed source document.
        config:   Run-specific MCQ configuration (expected option count, type).
        settings: Application settings (source grounding threshold).

    Returns:
        ``(all_passed, failure_reasons)`` where *failure_reasons* is an empty
        list when *all_passed* is ``True``.
    """
    failures: list[str] = []

    checks: list[tuple[bool, str | None]] = [
        validate_source_grounding(mcq, document, settings.source_grounding_threshold),
        # Use the MCQ's own declared question_type so ordering questions can coexist
        # with single_correct questions in the same mixed-type run.
        validate_uniqueness(mcq, mcq.question_type),
        validate_ordering_structure(mcq),
        validate_option_count(mcq, config.num_options),
        validate_distractor_rationales(mcq),
        validate_bloom_difficulty_alignment(mcq),
        validate_length_parity(mcq),
        validate_source_phrase_overlap(mcq),
    ]

    for passes, reason in checks:
        if not passes and reason:
            failures.append(reason)

    return len(failures) == 0, failures