"""
Module: analyzer.py
Stage 1 of the MCQ generation pipeline — content analysis.

Changes in v0.3
---------------
- Uses the Analyzer-specific provider/model from Settings (can be a different
  premium model like Claude Opus, independent of generator/critic).
- Checks the SQLite concept-map cache BEFORE calling the LLM. If the source
  file has not changed (same MD5 hash) the cached ConceptMap is returned and
  zero API tokens are spent.
- Saves the result to cache after every fresh LLM call.
"""

from pathlib import Path

import structlog

from .config import Settings
from .llm_client import LLMClient, TokenUsage, make_client, _NULL_USAGE
from .parser import ParsedDocument
from .schemas import ConceptMap

log = structlog.get_logger(__name__)


def load_prompt_template(prompts_dir: Path, filename: str) -> str:
    path = prompts_dir / filename
    if not path.exists():
        raise FileNotFoundError(f"Prompt template not found: {path}")
    return path.read_text(encoding="utf-8")


def analyze_content(
    document: ParsedDocument,
    settings: Settings,
    llm_client: LLMClient,   # kept for API compatibility; may be unused on cache hit
    input_file: Path | None = None,
    db_path: Path | None = None,
) -> tuple[ConceptMap, TokenUsage]:
    """
    Stage 1: extract a ConceptMap from *document*.

    Cache behaviour:
      - If *input_file* and *db_path* are provided, attempt a cache lookup
        before calling the LLM.  On a hit, return the cached map with zero
        token usage.
      - On a miss (or if cache args are omitted), call the LLM with the
        Analyzer-specific model from settings, then save the result.

    The Analyzer always uses settings.resolved_analyzer_model() which can be
    a premium model (e.g. claude-opus-4-6) independent of the generator/critic.
    """
    from .config import load_dotenv_and_get_api_key
    from . import storage

    resolved_model = settings.resolved_analyzer_model()
    resolved_provider = settings.resolved_analyzer_provider()

    # ------------------------------------------------------------------
    # Cache lookup
    # ------------------------------------------------------------------
    if input_file is not None and db_path is not None:
        cached = storage.get_cached_concept_map(input_file, db_path)
        if cached is not None:
            log.info(
                "analyzer_cache_hit",
                input_file=str(input_file),
                model=resolved_model,
            )
            return cached, _NULL_USAGE

    log.info(
        "analyzer_cache_miss",
        input_file=str(input_file) if input_file else "unknown",
    )

    # ------------------------------------------------------------------
    # Build a stage-specific client if the analyzer uses a different
    # provider/model than the global client passed in.
    # ------------------------------------------------------------------
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
        log.info(
            "analyzer_using_stage_client",
            provider=resolved_provider.value,
            model=resolved_model,
        )
    else:
        stage_client = llm_client

    # ------------------------------------------------------------------
    # Build prompt and call LLM
    # ------------------------------------------------------------------
    prompts_dir = Path(settings.prompts_dir)
    template = load_prompt_template(prompts_dir, "analyzer.txt")
    prompt = template.replace("{source_content}", document.raw_text)

    log.info(
        "analyzer_start",
        document_chars=len(document.raw_text),
        model=resolved_model,
        provider=resolved_provider.value,
    )

    concept_map, usage = stage_client.call(
        prompt=prompt,
        response_model=ConceptMap,
        temperature=settings.analyzer_temperature,
        model=resolved_model,
        max_tokens=settings.analyzer_max_tokens,
    )

    log.info(
        "analyzer_complete",
        concept_count=len(concept_map.concepts),
        relationship_count=len(concept_map.relationships),
        input_tokens=usage.input_tokens,
        output_tokens=usage.output_tokens,
    )

    # ------------------------------------------------------------------
    # Save to cache
    # ------------------------------------------------------------------
    if input_file is not None and db_path is not None:
        storage.save_concept_map_cache(
            file_path=input_file,
            concept_map=concept_map,
            analyzer_model=resolved_model,
            db_path=db_path,
        )
        log.info("analyzer_cache_saved", input_file=str(input_file))

    return concept_map, usage
