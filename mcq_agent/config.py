"""
Module: config.py
Loads application configuration from config.yaml and environment variables.

Per-stage model overrides
--------------------------
Each pipeline stage (analyzer, generator, critic) can use a different
provider + model. This is controlled by six new optional fields:

    analyzer_provider / analyzer_model
    generator_provider / generator_model
    critic_provider    / critic_model

If any of these is None it falls back to the global ``provider`` / ``model``.
This lets you run a premium model (Opus) for the once-cached Analyzer while
keeping a fast cheap model (Llama 8B) for the per-MCQ Critic.

SQLite concept-map cache
------------------------
The Analyzer result is cached in SQLite keyed by MD5 of the source file.
See storage.py for the full explanation.
"""

from enum import Enum
from pathlib import Path

import yaml
from dotenv import load_dotenv
from pydantic import BaseModel, ConfigDict, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from .schemas import Difficulty, QuestionType


class Provider(str, Enum):
    ANTHROPIC  = "anthropic"
    GROQ       = "groq"
    OPENROUTER = "openrouter"


class Pricing(BaseModel):
    model_config = ConfigDict(extra="forbid")
    input_per_million_tokens: float = 0.59
    output_per_million_tokens: float = 0.79


class BloomTemperatures(BaseModel):
    """Per-Bloom-level generation temperature (GUI spec §3.4 / Open Item #5).

    Defines the schema the Model tab binds to. Defaults follow the spec matrix
    (lower = more constrained recall, higher = more creative synthesis).
    """
    model_config = ConfigDict(extra="forbid")
    remember: float = Field(default=0.5, ge=0.0, le=1.0)
    understand: float = Field(default=0.6, ge=0.0, le=1.0)
    apply: float = Field(default=0.7, ge=0.0, le=1.0)
    analyze: float = Field(default=0.7, ge=0.0, le=1.0)
    evaluate: float = Field(default=0.8, ge=0.0, le=1.0)
    create: float = Field(default=0.9, ge=0.0, le=1.0)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="forbid")

    # -- Global provider / model (fallback for any stage without an override) --
    provider: Provider = Provider.GROQ
    model: str = "llama-3.3-70b-versatile"

    # -- Per-stage overrides (None = use global above) -------------------------
    analyzer_provider: Provider | None = None
    analyzer_model: str | None = None

    generator_provider: Provider | None = None
    generator_model: str | None = None

    critic_provider: Provider | None = None
    critic_model: str | None = None

    # -- Question generation --------------------------------------------------
    num_questions: int = Field(default=10, ge=1, le=500)
    difficulty: Difficulty = Difficulty.MEDIUM
    question_type: QuestionType = QuestionType.SINGLE_CORRECT
    num_options: int = Field(default=4, ge=3, le=6)
    include_explanations: bool = True
    topic_filter: list[str] | None = None
    over_generation_factor: float = Field(default=1.5, ge=1.0, le=3.0)
    max_regeneration_attempts: int = Field(default=1, ge=0, le=3)

    # -- Quality control ------------------------------------------------------
    source_grounding_threshold: float = Field(default=0.85, ge=0.0, le=1.0)

    # -- Temperatures ---------------------------------------------------------
    temperature: float = Field(default=0.7, ge=0.0, le=1.0)
    critic_temperature: float = Field(default=0.2, ge=0.0, le=1.0)
    analyzer_temperature: float = Field(default=0.2, ge=0.0, le=1.0)

    # Per-Bloom-level generation temperature (Model tab §3.4), consumed by the
    # Generator when enable_per_bloom_generation is True.
    bloom_temperatures: BloomTemperatures = Field(default_factory=BloomTemperatures)

    # When True, the Generator makes one call per active Bloom level (each at its
    # bloom_temperatures value). When False (default), it makes a single batched
    # call at the flat `temperature` — the original, cheaper behaviour. Toggle for
    # A/B testing the cost/quality trade-off (scripts/ab_bloom_tokens.py).
    enable_per_bloom_generation: bool = False

    # -- Token budgets --------------------------------------------------------
    max_tokens: int = Field(default=16000, ge=1)
    critic_max_tokens: int = Field(default=4000, ge=1)
    analyzer_max_tokens: int = Field(default=6000, ge=1)

    # -- Guarantee-n ----------------------------------------------------------
    guarantee_n_retries: int = Field(default=5, ge=0, le=20)
    # Number of questions to generate per concept-batch call.
    # The pipeline divides concepts into groups and runs one Generator call
    # per group, each targeting batch_size questions.
    # Keep at 15 — fits comfortably within 16k output token budget.
    batch_size: int = Field(default=15, ge=5, le=50)
    # Deprecated — superseded by batch_size. Kept for backwards compat.
    max_candidates_per_call: int = Field(default=20, ge=5, le=200)

    # -- Source linter thresholds ---------------------------------------------
    linter_min_words: int = Field(default=300, ge=0)
    linter_min_sections: int = Field(default=2, ge=0)
    linter_min_words_per_section: int = Field(default=50, ge=0)
    linter_min_concept_density: float = Field(default=0.3, ge=0.0)
    linter_fail_on_warn: bool = False

    # -- Retry / rate-limit ---------------------------------------------------
    api_max_retries: int = Field(default=3, ge=0)
    api_retry_initial_backoff: float = Field(default=2.0, ge=0.0)

    # -- Pricing (per stage) --------------------------------------------------
    pricing: Pricing = Field(default_factory=Pricing)           # analyzer
    generator_pricing: Pricing = Field(default_factory=Pricing) # generator
    critic_pricing: Pricing = Field(default_factory=Pricing)    # critic

    # -- Question type mix ----------------------------------------------------
    # When True: generator produces a mix of single_correct, ordering, and
    # code-snippet-based questions instead of a single uniform type.
    # Ordering questions cover step-sequencing (procedures, workflows).
    # Code-snippet questions embed a code block in the question stem.
    # The primary question_type in MCQConfig becomes the majority type (~60%).
    mixed_question_types: bool = False

    # -- Token compression (Headroom) -----------------------------------------
    # Compresses LLM input tokens before every API call.  Highest impact on
    # Generator calls (ConceptMap JSON + T2 prose, re-sent every retry).
    # Gracefully degrades to no-op if headroom-ai is not installed.
    use_headroom: bool = True

    # -- Tagging --------------------------------------------------------------
    # Topic tag applied to every question in a run.  When None the CLI will
    # prompt interactively (or fallback to "UNTAGGED" in non-interactive mode).
    topic_tag: str | None = None
    # Fixed tags added to every question's tag list.
    is_public: bool = True
    course_tag: str = "GRIT_ROBOTICS_L1_MAIN"

    # -- Cloud storage (Supabase) ---------------------------------------------
    # Set to true after configuring SUPABASE_URL and SUPABASE_KEY in .env
    enable_supabase: bool = False
    # Similarity score (0–100) above which a question is dropped by the gate.
    # Lower = stricter deduplication.  Matches the CLI tool's default.
    supabase_similarity_threshold: int = 80

    # -- Output ---------------------------------------------------------------
    output_format: str = "json"
    include_rejected_in_output: bool = False

    # -- Logging --------------------------------------------------------------
    log_level: str = "INFO"
    log_db_path: str = "logs/runs.db"

    # -- Paths ----------------------------------------------------------------
    prompts_dir: str = "mcq_agent/prompts"
    few_shot_examples_file: str = "mcq_agent/prompts/few_shot_examples.json"

    # -----------------------------------------------------------------------
    # Stage resolution helpers
    # -----------------------------------------------------------------------

    def resolved_analyzer_provider(self) -> Provider:
        return self.analyzer_provider or self.provider

    def resolved_analyzer_model(self) -> str:
        return self.analyzer_model or self.model

    def resolved_generator_provider(self) -> Provider:
        return self.generator_provider or self.provider

    def resolved_generator_model(self) -> str:
        return self.generator_model or self.model

    def resolved_critic_provider(self) -> Provider:
        return self.critic_provider or self.provider

    def resolved_critic_model(self) -> str:
        return self.critic_model or self.model


# ---------------------------------------------------------------------------
# Provider → env var mapping
# ---------------------------------------------------------------------------

_PROVIDER_KEY_ENV: dict[Provider, tuple[str, str]] = {
    Provider.ANTHROPIC:  ("ANTHROPIC_API_KEY",  "sk-ant-"),
    Provider.GROQ:       ("GROQ_API_KEY",        "gsk_"),
    Provider.OPENROUTER: ("OPENROUTER_API_KEY",  "sk-or-"),
}


def load_config(config_path: Path = Path("config.yaml")) -> Settings:
    if not config_path.exists():
        raise FileNotFoundError(f"Configuration file not found: {config_path}")
    with config_path.open("r", encoding="utf-8") as fh:
        raw: dict = yaml.safe_load(fh) or {}
    return Settings.model_validate(raw)


def load_dotenv_and_get_api_key(
    provider: Provider,
    env_path: Path = Path(".env"),
) -> str:
    load_dotenv(dotenv_path=env_path)
    import os
    env_var, expected_prefix = _PROVIDER_KEY_ENV[provider]
    api_key = os.environ.get(env_var, "").strip()
    if not api_key:
        raise EnvironmentError(
            f"{env_var} is not set. "
            f"Add it to .env (expected prefix: {expected_prefix!r})."
        )
    return api_key