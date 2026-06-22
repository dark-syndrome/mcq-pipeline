"""
Module: schemas.py  (v0.4)
All Pydantic v2 models used across the MCQ agent.

ConceptMap enrichments in v0.4
------------------------------
Concept:
  + difficulty_range      — min/max recommended difficulty for questions on this concept
  + testability_score     — 1-5 rating of how well this concept generates MCQs
  + question_templates    — 1-3 concrete question stems the Generator can use or adapt
  + prerequisite_concepts — names of concepts that must be understood first
  + confusion_pairs       — structured (confused_with, why_confused) pairs for distractors

Procedure:
  + decision_points       — branching conditions / if-then logic in the workflow
  + common_failure_modes  — things that go wrong and why (seeds debugging questions)



ConceptMap:
  + thematic_clusters     — groups of concept names that share a cross-section theme
  + prerequisite_chains   — ordered lists of concept names from foundational to advanced
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Annotated

from pydantic import BaseModel, Field, field_validator, model_validator


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class BloomLevel(str, Enum):
    REMEMBER  = "remember"
    UNDERSTAND = "understand"
    APPLY     = "apply"
    ANALYZE   = "analyze"
    EVALUATE  = "evaluate"
    CREATE    = "create"


class Difficulty(str, Enum):
    EASY   = "easy"
    MEDIUM = "medium"
    HARD   = "hard"
    EXPERT = "expert"


class QuestionType(str, Enum):
    SINGLE_CORRECT   = "single_correct"
    MULTIPLE_CORRECT = "multiple_correct"
    ORDERING         = "ordering"


class StemPattern(str, Enum):
    DEFINITION  = "definition"
    SCENARIO    = "scenario"
    DEBUGGING   = "debugging"
    COMPARISON  = "comparison"
    PROCEDURE   = "procedure"


# ---------------------------------------------------------------------------
# Configuration Model
# ---------------------------------------------------------------------------


class MCQConfig(BaseModel):
    num_questions: int = Field(ge=1, le=500)
    difficulty: Difficulty
    question_type: QuestionType
    num_options: int = Field(default=4, ge=3, le=6)
    include_explanations: bool = True
    topic_filter: list[str] | None = None
    over_generation_factor: float = Field(default=1.5, ge=1.0, le=3.0)
    max_regeneration_attempts: int = Field(default=1, ge=0, le=3)
    model: str = "google/gemini-2.5-flash"
    temperature: float = Field(default=0.7, ge=0.0, le=1.0)


# ---------------------------------------------------------------------------
# Concept Map — enriched (Stage 1 output)
# ---------------------------------------------------------------------------


class DifficultyRange(BaseModel):
    """
    Recommended difficulty band for questions on a given concept.
    min_difficulty is the easiest question type the concept warrants;
    max_difficulty is the highest cognitive level it can realistically support.
    """
    min_difficulty: Difficulty = Difficulty.EASY
    max_difficulty: Difficulty = Difficulty.HARD


class ConfusionPair(BaseModel):
    """
    A specific concept or term that learners commonly mix up with this concept,
    and a brief explanation of why the confusion occurs.
    Used to seed high-quality plausible distractors in the Generator.
    """
    confused_with: str   # name of the other concept or term
    why_confused: str    # concise explanation of the confusion source


class QuestionTemplate(BaseModel):
    """
    A concrete question stem or scenario seed the Generator can use or adapt.
    Provided by the Analyzer because it has the full document context to
    identify the most naturally testable angle for each concept.
    """
    stem: str            # e.g. "A sensor needs to send telemetry every 30s with..."
    stem_pattern: StemPattern
    target_difficulty: Difficulty
    bloom_level: BloomLevel


class Concept(BaseModel):
    """
    A distinct technical concept extracted from the source document.

    New in v0.4:
      difficulty_range      — bounding difficulty for MCQs on this concept
      testability_score     — 1 (trivial recall) to 5 (rich scenario potential)
      question_templates    — 1-3 concrete question seeds from the Analyzer
      prerequisite_concepts — concept names that must be understood first
      confusion_pairs       — structured (confused_with, why) pairs for distractors
    """
    name: str
    definition: str
    source_heading: str
    is_foundational: bool
    supported_bloom_levels: list[BloomLevel]
    common_misconceptions: list[str] = []

    # --- v0.4 enrichments ---
    difficulty_range: DifficultyRange = Field(default_factory=DifficultyRange)
    testability_score: Annotated[int, Field(ge=1, le=5)] = 3
    question_templates: list[QuestionTemplate] = []
    prerequisite_concepts: list[str] = []
    confusion_pairs: list[ConfusionPair] = []


class DecisionPoint(BaseModel):
    """A branching condition within a procedure step."""
    condition: str     # e.g. "if ACK not received within timeout"
    true_branch: str   # what to do when condition is true
    false_branch: str  # what to do when condition is false


class Procedure(BaseModel):
    """
    A step-by-step workflow or algorithm.

    New in v0.4:
      decision_points    — if-then branching logic within the procedure
      common_failure_modes — things that go wrong and why (seed debugging questions)
    """
    name: str
    steps: list[str]
    source_heading: str

    # --- v0.4 enrichments ---
    decision_points: list[DecisionPoint] = []
    common_failure_modes: list[str] = []


class LineAnnotation(BaseModel):
    """Maps a range of lines in a code example to what they do."""
    line_range: str    # e.g. "3-7" or "12"
    description: str   # what this line/block does and why it matters


class CodeExample(BaseModel):
    """
    A code snippet from the source document.
    line_annotations — per-line/block descriptions for targeted questions
    testable_behaviours — discrete observable outcomes this code demonstrates
    """
    description: str
    code: str
    purpose: str
    source_heading: str
    line_annotations: list[LineAnnotation] = []
    testable_behaviours: list[str] = []


class TechnicalFact(BaseModel):
    fact: str
    source_heading: str


class ConceptRelationship(BaseModel):
    from_concept: str
    to_concept: str
    relationship_type: str  # e.g. "is_a", "enables", "requires", "contrasts_with"


class ThematicCluster(BaseModel):
    """
    A group of concept names that share a cross-section theme.
    Helps the Generator distribute questions thematically rather than
    clustering by document section.
    """
    theme: str             # e.g. "power management", "wireless protocols"
    concept_names: list[str]
    rationale: str         # why these concepts belong together


class ConceptMap(BaseModel):
    """
    Full structured knowledge extracted from the source document.

    New in v0.4:
      thematic_clusters    — cross-section concept groupings for topic diversity
      prerequisite_chains  — ordered sequences from foundational to advanced
    """
    concepts: list[Concept]
    relationships: list[ConceptRelationship]
    procedures: list[Procedure]
    code_examples: list[CodeExample] = []
    technical_facts: list[TechnicalFact]

    # --- v0.4 enrichments ---
    thematic_clusters: list[ThematicCluster] = []
    prerequisite_chains: list[list[str]] = []   # each inner list is a chain, foundational→advanced


# ---------------------------------------------------------------------------
# MCQ Models (Stage 2 output)
# ---------------------------------------------------------------------------


class Option(BaseModel):
    label: str
    text: str
    is_correct: bool
    distractor_rationale: str | None = None

    @field_validator("distractor_rationale", mode="before")
    @classmethod
    def _coerce_none(cls, v):
        if v == "":
            return None
        return v


class MCQ(BaseModel):
    question: str
    options: list[Option]
    explanation: str
    source_excerpt: str
    source_heading: str
    bloom_level: BloomLevel
    difficulty: Difficulty
    question_type: QuestionType
    stem_pattern: StemPattern = StemPattern.DEFINITION  # default for old DB rows missing this field
    correct_order: list[str] | None = None  # deprecated; kept for backward compat only
    ordering_statements: list[str] | None = None  # numbered steps for ORDERING questions
    question_number: int | None = None
    generation_number: int | None = None
    sub_topic: str | None = None  # module-level tag; kept for GUI/DB backward compat
    tags: list[str] = []          # full tag list: [MODULE, DIFFICULTY, IS_PUBLIC, COURSE_TAG]

    @field_validator("bloom_level", mode="before")
    @classmethod
    def _coerce_stem_pattern_into_bloom(cls, v):
        """
        Models frequently leak the ``stem_pattern`` value (e.g. "debugging")
        into the ``bloom_level`` field, since both describe the question. Map
        those known stem-pattern names onto their cognitive Bloom level rather
        than rejecting the whole batch. The mapping mirrors the few-shot data,
        where debugging questions are tagged at the "analyze" level.
        """
        if isinstance(v, str):
            stem_to_bloom = {
                "debugging": BloomLevel.ANALYZE,
                "comparison": BloomLevel.ANALYZE,
                "scenario": BloomLevel.APPLY,
                "procedure": BloomLevel.APPLY,
                "definition": BloomLevel.REMEMBER,
            }
            normalized = v.strip().lower()
            valid = {level.value for level in BloomLevel}
            if normalized not in valid and normalized in stem_to_bloom:
                return stem_to_bloom[normalized]
        return v

    @field_validator("options")
    @classmethod
    def validate_options(cls, v: list[Option]) -> list[Option]:
        for opt in v:
            if not opt.is_correct and not opt.distractor_rationale:
                raise ValueError(
                    f"Distractor option '{opt.label}' must have a distractor_rationale."
                )
        return v

    @model_validator(mode="after")
    def validate_question_type_constraints(self) -> "MCQ":
        qt = self.question_type
        opts = self.options

        if qt == QuestionType.ORDERING:
            if not self.ordering_statements:
                raise ValueError(
                    "ORDERING questions require ordering_statements (the numbered steps list)."
                )
            correct_count = sum(1 for o in opts if o.is_correct)
            if correct_count != 1:
                raise ValueError(
                    f"ORDERING questions must have exactly 1 correct option "
                    f"(the correct sequence), found {correct_count}."
                )
            if self.correct_order is not None:
                raise ValueError(
                    "correct_order must be null in the new ORDERING format; "
                    "mark the correct sequence option with is_correct: true instead."
                )
        else:
            if not any(opt.is_correct for opt in opts):
                raise ValueError("At least one option must be marked as correct.")
            if self.correct_order is not None:
                raise ValueError("correct_order must be None for non-ORDERING questions.")

        return self


# ---------------------------------------------------------------------------
# Critique Models (Stage 3 output)
# ---------------------------------------------------------------------------


class CritiqueResult(BaseModel):
    independent_answer: str
    independent_reasoning: str
    matches_marked_answer: bool
    source_grounded: bool
    source_grounding_quote: str | None
    uniquely_correct: bool
    distractors_plausible: bool
    matches_difficulty: bool
    on_topic: bool
    clear_wording: bool
    self_contained: bool
    stem_quality: bool
    stem_economy: bool
    length_parity: bool
    source_phrase_independence: bool
    passes: bool
    issues: list[str]
    suggested_fix: str | None = None


# ---------------------------------------------------------------------------
# Pipeline Output
# ---------------------------------------------------------------------------


class PipelineRun(BaseModel):
    run_id: str
    timestamp: datetime
    input_file: str
    config: MCQConfig
    concept_map: ConceptMap
    generated_count: int
    passed_count: int
    final_mcqs: list[MCQ]
    rejected_mcqs: list[tuple[MCQ, CritiqueResult]]
    total_tokens_used: int
    total_cost_usd: float
    # Per-stage cost breakdown (added v0.4)
    analyzer_cost_usd: float = 0.0
    generator_cost_usd: float = 0.0
    critic_cost_usd: float = 0.0
    reframe_cost_usd: float = 0.0
    salvaged_count: int = 0
    generation_number: int = 0
    topic: str | None = None  # lesson topic label set at CLI time; used for Supabase navigation
    run_name: str | None = None  # human-readable name for the run, set at CLI time
    subtopics: list[str] = []   # ordered list of subtopic tags used for this run
