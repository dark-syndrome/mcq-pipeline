"""
pipeline.py — Orchestrates the full MCQ generation pipeline (v0.3).

Flow
----
0. Parse the .md file into a ParsedDocument (T1 + T2 + T3 in one pass).
1. Run Layer 1 static linter — abort if FAIL (or WARN with linter_fail_on_warn).
2. Check SQLite concept-map cache keyed by MD5 of the source file.
   Cache hit  → zero Analyzer tokens spent.
   Cache miss → call Analyzer (premium model), save to cache.
3. Run Layer 2 concept-density check — may abort if FAIL.
4. Write source quality report to output/<label>_source_quality.json.
5. Generator uses T2 (section summaries) — not the full document.
6. Validators (free, rule-based).
7. Critic uses T3 fingerprint-based source slicing — no full-doc fallback.
8. Guarantee-n retry loop: keep running Generator+Critic until
   accepted >= num_questions OR guarantee_n_retries exhausted.
9. Aggregate per-stage token usage and cost separately.
10. Write output/<label>_accepted.json, output/<label>_rejected.json,
    output/<label>_run_config.json.
11. Log to SQLite.

Per-stage cost tracking
-----------------------
Each stage (analyzer, generator, critic) has its own Pricing config so cost
reports show how much each stage actually spent.
"""

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

import structlog

from . import analyzer as analyzer_mod
from . import critic as critic_mod
from . import generator as generator_mod
from . import storage
from .config import Settings
from .llm_client import LLMClient, TokenUsage, _NULL_USAGE
from .parser import ParsedDocument, parse_markdown
from .schemas import CritiqueResult, MCQ, MCQConfig, PipelineRun
from .source_linter import run_concept_density_check, run_static_linter
from .reframer import reframe_rejected
from .validators import run_all_validators

log = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Regeneration helper
# ---------------------------------------------------------------------------

_REGEN_PROMPT = """\
The following MCQ was rejected by the quality critic. Generate ONE
replacement question on the same topic that addresses the critique feedback.

<original_mcq>
{mcq_json}
</original_mcq>

<critique_issues>
{issues}
</critique_issues>

<suggested_fix>
{suggested_fix}
</suggested_fix>

<source_content>
{source_content}
</source_content>

Return a single MCQ object that fixes the identified problems. Keep the same
topic, difficulty level ({difficulty}), question type ({question_type}), and
stem pattern ({stem_pattern}).

Produce exactly {num_options} options labelled A, B, C, … in order.
"""


def _regenerate_single_mcq(
    failed_mcq: MCQ,
    critique: CritiqueResult,
    document: ParsedDocument,
    config: MCQConfig,
    settings: Settings,
    llm_client: LLMClient,
) -> tuple[MCQ | None, TokenUsage | None]:
    from .generator import MCQList
    from .parser import build_t2_prompt_text

    issues_text = "\n".join(f"- {i}" for i in critique.issues) or "(none listed)"
    suggested_fix = critique.suggested_fix or "No specific fix suggested."

    # Use T2 for regen too — not the full document
    t2_text = build_t2_prompt_text(document)

    prompt = _REGEN_PROMPT.format(
        mcq_json=failed_mcq.model_dump_json(indent=2),
        issues=issues_text,
        suggested_fix=suggested_fix,
        source_content=t2_text,
        difficulty=config.difficulty.value,
        question_type=config.question_type.value,
        stem_pattern=failed_mcq.stem_pattern.value,
        num_options=config.num_options,
    )

    try:
        mcq_list, usage = llm_client.call(
            prompt=prompt,
            response_model=MCQList,
            temperature=settings.temperature,
            model=settings.resolved_generator_model(),
            max_tokens=settings.max_tokens,
        )
        if mcq_list.mcqs:
            return mcq_list.mcqs[0], usage
    except Exception as exc:
        log.warning("regeneration_llm_error", error=str(exc))

    return None, None


# ---------------------------------------------------------------------------
# Batch processing helper
# ---------------------------------------------------------------------------

def _make_synthetic_critique(reason: str, failures: list[str]) -> CritiqueResult:
    return CritiqueResult(
        independent_answer="",
        independent_reasoning=reason,
        matches_marked_answer=False,
        source_grounded=False,
        source_grounding_quote=None,
        uniquely_correct=False,
        distractors_plausible=False,
        matches_difficulty=False,
        on_topic=False,
        clear_wording=False,
        self_contained=False,
        stem_quality=False,
        stem_economy=False,
        length_parity=False,
        source_phrase_independence=False,
        passes=False,
        issues=failures,
        suggested_fix=None,
    )


def _process_batch(
    candidates: list[MCQ],
    document: ParsedDocument,
    config: MCQConfig,
    settings: Settings,
    llm_client: LLMClient,
    final_mcqs: list[MCQ],
    rejected_mcqs: list[tuple[MCQ, CritiqueResult]],
    critic_usages: list[TokenUsage],
    gen_usages: list[TokenUsage],
) -> int:
    all_failed_validation = 0

    for mcq in candidates:
        if len(final_mcqs) >= config.num_questions:
            break

        val_passed, val_failures = run_all_validators(mcq, document, config, settings)
        if not val_passed:
            log.info("pipeline_validator_fail", reasons=val_failures)
            all_failed_validation += 1
            rejected_mcqs.append((mcq, _make_synthetic_critique(
                "Dropped before critique: failed validators.", val_failures
            )))
            continue

        critique, crit_usage = critic_mod.critique_mcq(mcq, document, settings, llm_client)
        critic_usages.append(crit_usage)

        if critique.passes:
            final_mcqs.append(mcq)
            log.info("pipeline_mcq_accepted", total_accepted=len(final_mcqs),
                     stem=mcq.question[:100], difficulty=mcq.difficulty.value,
                     bloom_level=mcq.bloom_level.value)
            continue

        if config.max_regeneration_attempts > 0:
            new_mcq, regen_usage = _regenerate_single_mcq(
                mcq, critique, document, config, settings, llm_client
            )
            if regen_usage:
                gen_usages.append(regen_usage)

            if new_mcq is not None:
                reval_passed, reval_failures = run_all_validators(
                    new_mcq, document, config, settings
                )
                if reval_passed:
                    re_critique, re_crit_usage = critic_mod.critique_mcq(
                        new_mcq, document, settings, llm_client
                    )
                    critic_usages.append(re_crit_usage)
                    if re_critique.passes:
                        final_mcqs.append(new_mcq)
                        log.info("pipeline_regen_accepted", total_accepted=len(final_mcqs),
                                 stem=new_mcq.question[:100], difficulty=new_mcq.difficulty.value,
                                 bloom_level=new_mcq.bloom_level.value)
                        continue
                    rejected_mcqs.append((new_mcq, re_critique))
                    continue
                rejected_mcqs.append((new_mcq, _make_synthetic_critique(
                    "Regenerated MCQ dropped: failed validators.", reval_failures
                )))
                continue

        rejected_mcqs.append((mcq, critique))
        log.info("pipeline_mcq_rejected")

    return all_failed_validation


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

def _make_run_label(run_number: int, config) -> str:
    """
    Build a human-readable label for output filenames.
    Format: run_001_medium_10q
    """
    return f"run_{run_number:03d}_{config.difficulty.value}_{config.num_questions}q"


def _checkpoint_accepted(
    final_mcqs: list[MCQ],
    label: str,
    output_dir: Path,
) -> None:
    """
    Write accepted questions to disk immediately after each batch.

    This is a safety checkpoint — if the pipeline crashes mid-run, the
    last written checkpoint file contains all questions accepted so far.
    The final _write_output_files() call at the end overwrites this with
    the complete set and applies the difficulty label suffix.

    File: output/<label>_accepted.json  (overwritten on each checkpoint)
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"{label}_accepted.json"
    records = []
    for m in final_mcqs:
        record = json.loads(m.model_dump_json())
        record["question"] = f"{record['question']} ({record['difficulty'].capitalize()})"
        records.append(record)
    path.write_text(json.dumps(records, indent=2), encoding="utf-8")


def _write_output_files(
    label: str,
    final_mcqs: list[MCQ],
    rejected_mcqs: list[tuple[MCQ, CritiqueResult]],
    output_dir: Path,
) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)

    accepted_path = output_dir / f"{label}_accepted.json"
    accepted_records = []
    for m in final_mcqs:
        record = json.loads(m.model_dump_json())
        record["question"] = f"{record['question']} ({record['difficulty'].capitalize()})"
        accepted_records.append(record)
    accepted_path.write_text(json.dumps(accepted_records, indent=2), encoding="utf-8")

    rejected_path = output_dir / f"{label}_rejected.json"
    rejected_data = [
        {"mcq": json.loads(m.model_dump_json()), "critique": json.loads(c.model_dump_json())}
        for m, c in rejected_mcqs
    ]
    rejected_path.write_text(json.dumps(rejected_data, indent=2), encoding="utf-8")

    return accepted_path, rejected_path


def _write_run_config(
    label: str,
    run: "PipelineRun",
    settings,
    salvaged_details: list[dict],
    token_breakdown: dict,
    output_dir: Path,
) -> Path:
    """
    Write a human-readable configuration + cost report for the run.
    File: output/<label>_run_config.json
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    analyzer_cached = (run.analyzer_cost_usd == 0.0)

    config_doc = {
        "run_label": label,
        "run_id": run.run_id,
        "timestamp": run.timestamp.isoformat(),
        "input_file": run.input_file,

        "configuration": {
            "difficulty": run.config.difficulty.value,
            "question_type": run.config.question_type.value,
            "num_questions_requested": run.config.num_questions,
            "num_options": run.config.num_options,
            "over_generation_factor": run.config.over_generation_factor,
            "max_regeneration_attempts": run.config.max_regeneration_attempts,
            "guarantee_n_retries": settings.guarantee_n_retries,
            "source_grounding_threshold": settings.source_grounding_threshold,
        },

        "models": {
            "analyzer": {
                "provider": settings.resolved_analyzer_provider().value,
                "model": settings.resolved_analyzer_model(),
                "note": "cached — no API call made" if analyzer_cached else "fresh LLM call",
            },
            "generator": {
                "provider": settings.resolved_generator_provider().value,
                "model": settings.resolved_generator_model(),
            },
            "critic": {
                "provider": settings.resolved_critic_provider().value,
                "model": settings.resolved_critic_model(),
            },
            "reframer": {
                "provider": settings.resolved_critic_provider().value,
                "model": settings.resolved_critic_model(),
                "note": "uses critic model for all targeted fix calls",
            },
        },

        "question_counts": {
            "generated": run.generated_count,
            "accepted_original": run.passed_count - run.salvaged_count,
            "salvaged_via_reframe": run.salvaged_count,
            "total_accepted": run.passed_count,
            "rejected_final": len(run.rejected_mcqs),
        },

        "tokens": {
            "analyzer":  {"input": token_breakdown["a_in"],  "output": token_breakdown["a_out"],
                          "note": "0 = concept map loaded from cache"},
            "generator": {"input": token_breakdown["g_in"],  "output": token_breakdown["g_out"]},
            "critic":    {"input": token_breakdown["c_in"],  "output": token_breakdown["c_out"]},
            "reframer":  {"input": token_breakdown["r_in"],  "output": token_breakdown["r_out"]},
            "total":     token_breakdown["a_in"] + token_breakdown["a_out"] +
                         token_breakdown["g_in"] + token_breakdown["g_out"] +
                         token_breakdown["c_in"] + token_breakdown["c_out"] +
                         token_breakdown["r_in"] + token_breakdown["r_out"],
        },

        "cost_usd": {
            "analyzer":  round(run.analyzer_cost_usd, 6),
            "generator": round(run.generator_cost_usd, 6),
            "critic":    round(run.critic_cost_usd, 6),
            "reframer":  round(run.reframe_cost_usd, 6),
            "total":     round(run.total_cost_usd, 6),
        },

        "salvaged_questions": salvaged_details,

        "output_files": {
            "accepted":       f"{label}_accepted.json",
            "rejected":       f"{label}_rejected.json",
            "source_quality": f"{label}_source_quality.json",
            "run_config":     f"{label}_run_config.json",
        },
    }

    path = output_dir / f"{label}_run_config.json"
    path.write_text(json.dumps(config_doc, indent=2), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------



def _log_partial_cost(
    run_id: str,
    analyzer_usages: list,
    gen_usages: list,
    critic_usages: list,
    reframe_usages: list,
    settings,
    stage: str,
    final_mcqs: list,
    rejected_mcqs: list,
    total_generated: int,
) -> None:
    """
    Log token usage and estimated cost for a partial or failed run.
    Called from any early-exit path so the user always sees what was spent.
    """
    def _sum(usages):
        return sum(u.input_tokens for u in usages), sum(u.output_tokens for u in usages)

    a_in, a_out = _sum(analyzer_usages)
    g_in, g_out = _sum(gen_usages)
    c_in, c_out = _sum(critic_usages)
    r_in, r_out = _sum(reframe_usages)

    analyzer_cost = LLMClient.estimate_cost(
        TokenUsage(input_tokens=a_in, output_tokens=a_out, model=""),
        settings.pricing.input_per_million_tokens,
        settings.pricing.output_per_million_tokens,
    )
    generator_cost = LLMClient.estimate_cost(
        TokenUsage(input_tokens=g_in, output_tokens=g_out, model=""),
        settings.generator_pricing.input_per_million_tokens,
        settings.generator_pricing.output_per_million_tokens,
    )
    critic_cost = LLMClient.estimate_cost(
        TokenUsage(input_tokens=c_in, output_tokens=c_out, model=""),
        settings.critic_pricing.input_per_million_tokens,
        settings.critic_pricing.output_per_million_tokens,
    )
    reframe_cost = LLMClient.estimate_cost(
        TokenUsage(input_tokens=r_in, output_tokens=r_out, model=""),
        settings.critic_pricing.input_per_million_tokens,
        settings.critic_pricing.output_per_million_tokens,
    )
    total_cost = analyzer_cost + generator_cost + critic_cost + reframe_cost
    total_tokens = (a_in + a_out) + (g_in + g_out) + (c_in + c_out) + (r_in + r_out)

    log.warning(
        "pipeline_partial_cost_report",
        run_id=run_id,
        failed_at_stage=stage,
        total_generated=total_generated,
        accepted=len(final_mcqs),
        rejected=len(rejected_mcqs),
        total_tokens=total_tokens,
        analyzer_tokens=a_in + a_out,
        generator_tokens=g_in + g_out,
        critic_tokens=c_in + c_out,
        reframe_tokens=r_in + r_out,
        analyzer_cost_usd=round(analyzer_cost, 6),
        generator_cost_usd=round(generator_cost, 6),
        critic_cost_usd=round(critic_cost, 6),
        reframe_cost_usd=round(reframe_cost, 6),
        total_cost_usd=round(total_cost, 6),
    )

def run_pipeline(
    input_file: Path,
    config: MCQConfig,
    settings: Settings,
    llm_client: LLMClient,
    output_dir: Path | None = None,
    topic: str | None = None,
) -> PipelineRun:
    run_id = str(uuid.uuid4())
    started_at = datetime.now(tz=timezone.utc)

    if output_dir is None:
        output_dir = Path("output")

    db_path = Path(settings.log_db_path)

    # Sequential run number for human-readable filenames
    storage.init_db(db_path)
    run_number = storage.get_run_count(db_path) + 1
    run_label = _make_run_label(run_number, config)

    # Per-stage usage accumulators
    analyzer_usages: list[TokenUsage] = []
    gen_usages: list[TokenUsage] = []
    critic_usages: list[TokenUsage] = []
    reframe_usages: list[TokenUsage] = []

    final_mcqs: list[MCQ] = []
    rejected_mcqs: list[tuple[MCQ, CritiqueResult]] = []
    total_generated = 0
    salvaged_count = 0
    salvaged_details: list[dict] = []  # records each salvaged question for run_config

    log.info("pipeline_start", run_id=run_id, input_file=str(input_file))

    # ------------------------------------------------------------------
    # Stage 0 — Parse (builds T1 + T2 + T3 in one pass)
    # ------------------------------------------------------------------
    document: ParsedDocument = parse_markdown(input_file)
    log.info("pipeline_parse_done", chars=len(document.raw_text),
             sections=len(document.section_summaries))

    # ------------------------------------------------------------------
    # Layer 1 — Static linter
    # ------------------------------------------------------------------
    linter_report = run_static_linter(document, settings, str(input_file), run_id)
    log.info("pipeline_linter_done", status=linter_report.overall_status)

    if linter_report.overall_status == "FAIL":
        linter_report.write(output_dir, run_label)
        _log_partial_cost(
            run_id=run_id,
            analyzer_usages=analyzer_usages,
            gen_usages=gen_usages,
            critic_usages=critic_usages,
            reframe_usages=reframe_usages,
            settings=settings,
            stage="linter_layer1_fail",
            final_mcqs=final_mcqs,
            rejected_mcqs=rejected_mcqs,
            total_generated=total_generated,
        )
        raise ValueError(
            f"Source quality gate FAILED. "
            f"See {output_dir}/{run_label}_source_quality.json for details.\n"
            + "\n".join(
                f"  [{c.status}] {c.name}: {c.message}"
                for c in linter_report.checks if c.status != "PASS"
            )
        )

    # ------------------------------------------------------------------
    # Stage 1 — Analyze (with concept-map cache)
    # ------------------------------------------------------------------
    concept_map, analyze_usage = analyzer_mod.analyze_content(
        document=document,
        settings=settings,
        llm_client=llm_client,
        input_file=input_file,
        db_path=db_path,
    )
    analyzer_usages.append(analyze_usage)
    _analyze_cost = (
        (analyze_usage.input_tokens / 1_000_000) * settings.pricing.input_per_million_tokens
        + (analyze_usage.output_tokens / 1_000_000) * settings.pricing.output_per_million_tokens
    )
    log.info(
        "pipeline_analyze_done",
        concepts=len(concept_map.concepts),
        cache_hit=(analyze_usage.model == "cache"),
        tokens_in=analyze_usage.input_tokens,
        tokens_out=analyze_usage.output_tokens,
        cost=round(_analyze_cost, 6),
    )

    # ------------------------------------------------------------------
    # Layer 2 — Concept density check (post-Analyzer, zero tokens)
    # ------------------------------------------------------------------
    linter_report = run_concept_density_check(concept_map, document, settings, linter_report)
    linter_report.write(output_dir, run_label)
    log.info("pipeline_density_check_done", status=linter_report.overall_status)

    if linter_report.overall_status == "FAIL":
        _log_partial_cost(
            run_id=run_id,
            analyzer_usages=analyzer_usages,
            gen_usages=gen_usages,
            critic_usages=critic_usages,
            reframe_usages=reframe_usages,
            settings=settings,
            stage="linter_layer2_concept_density_fail",
            final_mcqs=final_mcqs,
            rejected_mcqs=rejected_mcqs,
            total_generated=total_generated,
        )
        raise ValueError(
            f"Post-analyzer concept density FAILED. "
            f"See {output_dir}/{run_label}_source_quality.json for details."
        )

    # ------------------------------------------------------------------
    # Stages 2+3 — Generate → Validate → Critique (with retry loop)
    # ------------------------------------------------------------------
    max_retries = settings.guarantee_n_retries
    attempt = 0

    while len(final_mcqs) < config.num_questions:
        deficit = config.num_questions - len(final_mcqs)
        retry_config = config.model_copy(update={"num_questions": deficit})

        log.info("pipeline_generate_attempt", attempt=attempt + 1,
                 need=deficit, have=len(final_mcqs))

        candidates, gen_usage = generator_mod.generate_mcqs(
            document, concept_map, retry_config, settings, llm_client
        )
        gen_usages.append(gen_usage)
        batch_count = len(candidates)
        total_generated += batch_count
        log.info("pipeline_generate_done", generated=batch_count,
                 tokens_in=gen_usage.input_tokens, tokens_out=gen_usage.output_tokens)

        all_failed = _process_batch(
            candidates=candidates,
            document=document,
            config=retry_config,
            settings=settings,
            llm_client=llm_client,
            final_mcqs=final_mcqs,
            rejected_mcqs=rejected_mcqs,
            critic_usages=critic_usages,
            gen_usages=gen_usages,
        )

        # ── Checkpoint: flush accepted questions to disk after every batch ──
        # This ensures accepted questions are never lost if the pipeline
        # crashes during a later generation or critic call.
        if final_mcqs:
            _checkpoint_accepted(final_mcqs, run_label, output_dir)
            log.info(
                "pipeline_checkpoint_written",
                accepted_so_far=len(final_mcqs),
                file=f"{run_label}_accepted.json",
            )

        if attempt == 0 and batch_count > 0 and all_failed == batch_count:
            _log_partial_cost(
                run_id=run_id,
                analyzer_usages=analyzer_usages,
                gen_usages=gen_usages,
                critic_usages=critic_usages,
                reframe_usages=reframe_usages,
                settings=settings,
                stage="generator_first_pass_all_failed_validation",
                final_mcqs=final_mcqs,
                rejected_mcqs=rejected_mcqs,
                total_generated=total_generated,
            )
            log.warning(
                "pipeline_first_pass_all_failed",
                hint="All questions failed the source_excerpt validator. "
                     "Try lowering source_grounding_threshold in config.yaml "
                     "(current value checked against document T2 summaries). "
                     "Continuing with retry loop — reframer may recover some."
            )

        attempt += 1
        if attempt > max_retries:
            if len(final_mcqs) < config.num_questions:
                log.warning("pipeline_guarantee_exhausted",
                            requested=config.num_questions,
                            produced=len(final_mcqs),
                            retries_used=attempt - 1)
            break

    # ------------------------------------------------------------------
    # Stage 4 — Reframe rejected MCQs (targeted fixes, not full regen)
    # Runs after all generation retries are exhausted. Attempts to salvage
    # rejected questions with the minimum LLM intervention per failure class.
    # Salvaged questions are appended to final_mcqs.
    # ------------------------------------------------------------------
    if rejected_mcqs:
        log.info("pipeline_reframe_start", candidates=len(rejected_mcqs))
        salvaged, still_rejected, reframe_usage_list = reframe_rejected(
            rejected_mcqs=rejected_mcqs,
            document=document,
            concept_map=concept_map,
            config=config,
            settings=settings,
            llm_client=llm_client,
        )
        reframe_usages.extend(reframe_usage_list)
        final_mcqs.extend(salvaged)
        rejected_mcqs = still_rejected
        salvaged_count = len(salvaged)
        # Record details of each salvaged question for run_config
        for mcq in salvaged:
            salvaged_details.append({
                "question": mcq.question[:120],
                "difficulty": mcq.difficulty.value,
                "stem_pattern": mcq.stem_pattern.value,
                "bloom_level": mcq.bloom_level.value,
            })
            # Surface each salvaged question to the live feed (GUI --json-events).
            log.info("pipeline_salvaged_accepted", stem=mcq.question[:100],
                     difficulty=mcq.difficulty.value, bloom_level=mcq.bloom_level.value)
        log.info(
            "pipeline_reframe_done",
            salvaged=len(salvaged),
            still_rejected=len(still_rejected),
        )

    # ------------------------------------------------------------------
    # Per-stage cost accounting
    # ------------------------------------------------------------------
    def _sum_usage(usages: list[TokenUsage]) -> tuple[int, int]:
        return (sum(u.input_tokens for u in usages),
                sum(u.output_tokens for u in usages))

    a_in, a_out = _sum_usage(analyzer_usages)
    g_in, g_out = _sum_usage(gen_usages)
    c_in, c_out = _sum_usage(critic_usages)

    analyzer_cost = LLMClient.estimate_cost(
        TokenUsage(input_tokens=a_in, output_tokens=a_out, model=""),
        settings.pricing.input_per_million_tokens,
        settings.pricing.output_per_million_tokens,
    )
    generator_cost = LLMClient.estimate_cost(
        TokenUsage(input_tokens=g_in, output_tokens=g_out, model=""),
        settings.generator_pricing.input_per_million_tokens,
        settings.generator_pricing.output_per_million_tokens,
    )
    critic_cost = LLMClient.estimate_cost(
        TokenUsage(input_tokens=c_in, output_tokens=c_out, model=""),
        settings.critic_pricing.input_per_million_tokens,
        settings.critic_pricing.output_per_million_tokens,
    )
    r_in, r_out = _sum_usage(reframe_usages)
    reframe_cost = LLMClient.estimate_cost(
        TokenUsage(input_tokens=r_in, output_tokens=r_out, model=""),
        settings.critic_pricing.input_per_million_tokens,
        settings.critic_pricing.output_per_million_tokens,
    )
    total_cost = analyzer_cost + generator_cost + critic_cost + reframe_cost
    total_tokens = (a_in + a_out) + (g_in + g_out) + (c_in + c_out) + (r_in + r_out)

    log.info(
        "pipeline_complete",
        run_id=run_id,
        total_generated=total_generated,
        passed=len(final_mcqs),
        rejected=len(rejected_mcqs),
        total_tokens=total_tokens,
        analyzer_cost_usd=round(analyzer_cost, 6),
        generator_cost_usd=round(generator_cost, 6),
        critic_cost_usd=round(critic_cost, 6),
        reframe_cost_usd=round(reframe_cost, 6),
        total_cost_usd=round(total_cost, 6),
    )

    # ------------------------------------------------------------------
    # Assign globally-sequential question and generation numbers
    # run_number is already computed at the top of this function.
    # get_total_accepted_count reads the DB *before* this run is logged,
    # so it reflects all previously accepted questions from prior runs.
    # ------------------------------------------------------------------
    next_question_number = storage.get_total_accepted_count(db_path) + 1
    for i, mcq in enumerate(final_mcqs):
        mcq.generation_number = run_number
        mcq.question_number = next_question_number + i

    # ------------------------------------------------------------------
    # Write output files
    # ------------------------------------------------------------------
    token_breakdown = {
        "a_in": a_in, "a_out": a_out,
        "g_in": g_in, "g_out": g_out,
        "c_in": c_in, "c_out": c_out,
        "r_in": r_in, "r_out": r_out,
    }

    accepted_path, rejected_path = _write_output_files(
        run_label, final_mcqs, rejected_mcqs, output_dir
    )

    # Assemble PipelineRun first so _write_run_config can read its fields
    pipeline_run = PipelineRun(
        run_id=run_id,
        timestamp=started_at,
        input_file=str(input_file),
        config=config,
        concept_map=concept_map,
        generated_count=total_generated,
        passed_count=len(final_mcqs),
        final_mcqs=final_mcqs,
        rejected_mcqs=rejected_mcqs,
        total_tokens_used=total_tokens,
        total_cost_usd=total_cost,
        analyzer_cost_usd=round(analyzer_cost, 6),
        generator_cost_usd=round(generator_cost, 6),
        critic_cost_usd=round(critic_cost, 6),
        reframe_cost_usd=round(reframe_cost, 6),
        salvaged_count=salvaged_count,
        generation_number=run_number,
        topic=topic,
    )

    config_path = _write_run_config(
        label=run_label,
        run=pipeline_run,
        settings=settings,
        salvaged_details=salvaged_details,
        token_breakdown=token_breakdown,
        output_dir=output_dir,
    )

    log.info(
        "pipeline_output_written",
        accepted=str(accepted_path),
        rejected=str(rejected_path),
        run_config=str(config_path),
    )

    # ------------------------------------------------------------------
    # Persist to SQLite
    # ------------------------------------------------------------------
    storage.log_run(pipeline_run, db_path)

    # ------------------------------------------------------------------
    # Sync to Supabase via similarity gate (if enabled)
    # The gate deduplicates against existing Supabase questions and
    # re-assigns contiguous question_numbers before inserting.
    # ------------------------------------------------------------------
    if settings.enable_supabase:
        try:
            from . import supabase_gate
            result = supabase_gate.filter_and_sync(
                pipeline_run,
                threshold=settings.supabase_similarity_threshold,
            )
            log.info(
                "supabase_sync_done",
                run_id=run_id,
                generation=result.generation_number,
                pushed=result.pushed,
                filtered=result.filtered,
                question_range=(
                    f"{result.first_question_number}–{result.last_question_number}"
                    if result.first_question_number else "none"
                ),
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("supabase_sync_failed", error=str(exc))

    return pipeline_run