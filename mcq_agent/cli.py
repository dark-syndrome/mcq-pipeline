"""
Module: cli.py  (v0.3)
Typer CLI for the MCQ generation agent.

Changes:
- Shows per-stage model configuration on startup.
- Shows accepted/rejected/source-quality output file paths in summary.
- Displays concept-map cache status.
"""

import json
import sys
from pathlib import Path
from typing import Annotated

import structlog
import typer
from rich.console import Console
from rich.table import Table

from . import pipeline as pipeline_mod
from . import storage
from .config import Settings, load_config, load_dotenv_and_get_api_key
from .llm_client import LLMClient, make_client
from .parser import parse_markdown
from .schemas import Difficulty, MCQConfig, QuestionType
from .source_linter import run_static_linter

app = typer.Typer(
    name="mcq-agent",
    help="Generate high-quality MCQs from Markdown content using an LLM.",
    add_completion=False,
)

console = Console()
err_console = Console(stderr=True)
log = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Interactive tag / course pickers
# ---------------------------------------------------------------------------

def _pick_from_list(items: list[str], noun: str, allow_new: bool = True) -> str:
    """
    Display a numbered list of existing *items* and return the user's pick.
    If *allow_new* is True the user may also type a new name.
    """
    if items:
        console.print(f"\n  Existing {noun}s:")
        for i, item in enumerate(items, 1):
            console.print(f"    [cyan]{i:>2}.[/cyan] {item}")
    else:
        console.print(f"\n  No {noun}s in database yet.")

    if allow_new:
        console.print(f"  [dim]Enter a number to select, or type a new {noun} name:[/dim]")
    else:
        console.print(f"  [dim]Enter a number to select:[/dim]")

    while True:
        raw = input("  > ").strip()
        if not raw:
            continue
        if raw.isdigit():
            idx = int(raw)
            if 1 <= idx <= len(items):
                return items[idx - 1]
            console.print(f"  [red]Number {idx} out of range.[/red]")
            continue
        if allow_new:
            normalised = raw.upper().replace(" ", "_")
            return normalised
        console.print("  [red]Please enter a valid number.[/red]")


def _resolve_topic_tag(
    flag_value: str | None,
    db_path: Path,
    json_events: bool,
    settings_value: str | None,
) -> str:
    """
    Return the topic tag to use for this run.

    Priority: CLI flag → config.yaml → interactive prompt (human mode only).
    In json-events (GUI) mode, falls back to 'UNTAGGED' without prompting.
    """
    if flag_value:
        return flag_value.upper().replace(" ", "_")
    if settings_value:
        return settings_value
    if json_events:
        return "UNTAGGED"

    console.print("\n[bold]Topic Tag[/bold]  (classifies what this document covers)")
    tags = storage.list_topic_tags(db_path)
    chosen = _pick_from_list(tags, "topic tag")

    if chosen not in tags:
        storage.add_topic_tag(chosen, db_path)
        console.print(f"  [green]✓[/green] Added new topic tag: [cyan]{chosen}[/cyan]")
    return chosen


def _resolve_course(
    flag_value: str | None,
    db_path: Path,
    json_events: bool,
    settings_value: str,
) -> str:
    """
    Return the course tag to use for this run.

    Priority: CLI flag → config.yaml → interactive prompt (human mode only).
    """
    if flag_value:
        return flag_value.upper().replace(" ", "_")
    if settings_value and settings_value != "GRIT_ROBOTICS_L1_MAIN":
        return settings_value

    # In json-events mode just use whatever is in settings
    if json_events:
        return settings_value

    console.print(f"\n[bold]Course[/bold]  (default: [cyan]{settings_value}[/cyan])")
    courses = storage.list_courses(db_path)
    if not courses:
        console.print("  [dim]No courses in database yet. Press Enter to use the default.[/dim]")
        raw = input(f"  > [{settings_value}] ").strip()
        chosen = raw.upper().replace(" ", "_") if raw else settings_value
    else:
        console.print(f"  Press Enter to keep default ([cyan]{settings_value}[/cyan]).")
        chosen_raw = _pick_from_list(courses, "course")
        chosen = chosen_raw if chosen_raw else settings_value

    if chosen and chosen not in courses:
        storage.add_course(chosen, db_path)
        console.print(f"  [green]✓[/green] Added new course: [cyan]{chosen}[/cyan]")
    return chosen or settings_value


def _build_client(settings: Settings) -> LLMClient:
    """Build a global client using the base provider/model."""
    api_key = load_dotenv_and_get_api_key(settings.provider)
    return make_client(
        provider=settings.provider.value,
        api_key=api_key,
        default_model=settings.model,
        max_retries=settings.api_max_retries,
        initial_backoff=settings.api_retry_initial_backoff,
        use_headroom=settings.use_headroom,
    )


def _configure_logging(verbose: bool) -> None:
    import logging
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(level=level)
    structlog.configure(wrapper_class=structlog.make_filtering_bound_logger(level))


# ---------------------------------------------------------------------------
# GUI integration — newline-delimited JSON event stream (--json-events)
# ---------------------------------------------------------------------------
#
# When `--json-events` is passed, the command emits machine-readable NDJSON to
# stdout instead of pretty Rich output, so an Electron/React frontend can drive
# a live pipeline-stage timeline. The schema is documented in the GUI spec §8.2.
# Internal structlog events are translated to the GUI protocol below; everything
# else is dropped so stdout carries ONLY protocol events (one JSON object/line).
#
# CANONICAL EVENT CONTRACT (frozen — keep in sync with docs/GUI_SPEC.md §8.2):
#   run_start         {event, run_id}
#   stage_start       {event, stage, [attempt, need, have]}
#   stage_done        {event, stage, [tokens_in, tokens_out, cost, cache_hit],
#                      <detail: chars|sections|concepts|status|salvaged|still_rejected>}
#   stage_progress    {event, stage:"generate", generated, tokens_in, tokens_out}
#   question_accepted {event, total_accepted, stem, difficulty, bloom_level, salvaged}
#   question_rejected {event, failure_class, issues}
#   run_complete      {event, run_id, run_label, generated, accepted, salvaged,
#                      rejected, requested, cost_usd, cost_breakdown{...}, output_files{...}}
#   error             {event, stage, message, retryable}
# stage ids: parse | linter_l1 | analyze | linter_l2 | generate | reframe
#
# Per-stage cost: the `generate` and `reframe` stages now carry aggregate
# tokens_in/tokens_out/cost on their stage_done events. `critic` has no timeline
# stage of its own — its cost remains in run_complete.cost_breakdown.critic.

# internal structlog event  →  GUI "stage_done" stage id
_STAGE_DONE_MAP = {
    "pipeline_parse_done": "parse",
    "pipeline_linter_done": "linter_l1",
    "pipeline_analyze_done": "analyze",
    "pipeline_density_check_done": "linter_l2",
    "pipeline_generate_stage_done": "generate",
    "pipeline_reframe_done": "reframe",
}
# internal structlog event  →  GUI "stage_start" stage id
_STAGE_START_MAP = {
    "pipeline_generate_attempt": "generate",
    "pipeline_reframe_start": "reframe",
}
_ACCEPTED_EVENTS = {
    "pipeline_mcq_accepted",
    "pipeline_regen_accepted",
    "pipeline_salvaged_accepted",
}


def _emit(event: dict) -> None:
    """Write a single GUI protocol event as one line of JSON to stdout."""
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def _json_event_processor(logger, method_name, event_dict):
    """structlog processor: translate internal events to the GUI protocol."""
    name = event_dict.get("event", "")

    if name == "pipeline_start":
        _emit({"event": "run_start", "run_id": event_dict.get("run_id")})
    elif name in _STAGE_START_MAP:
        payload = {"event": "stage_start", "stage": _STAGE_START_MAP[name]}
        for k in ("attempt", "need", "have"):
            if k in event_dict:
                payload[k] = event_dict[k]
        _emit(payload)
    elif name in _STAGE_DONE_MAP:
        payload = {"event": "stage_done", "stage": _STAGE_DONE_MAP[name]}
        # Per-stage cost transparency (GUI spec §8.2): tokens_in/tokens_out/cost/
        # cache_hit are present on API stages (analyze); omitted on zero-token
        # stages (parse, linter). Remaining keys are stage-specific detail.
        for k in ("tokens_in", "tokens_out", "cost", "cache_hit",
                  "chars", "sections", "concepts", "status",
                  "salvaged", "still_rejected"):
            if k in event_dict:
                payload[k] = event_dict[k]
        _emit(payload)
    elif name == "pipeline_generate_done":
        _emit({"event": "stage_progress", "stage": "generate",
               "generated": event_dict.get("generated"),
               "tokens_in": event_dict.get("tokens_in"),
               "tokens_out": event_dict.get("tokens_out")})
    elif name in _ACCEPTED_EVENTS:
        _emit({
            "event": "question_accepted",
            "total_accepted": event_dict.get("total_accepted"),
            "stem": event_dict.get("stem"),
            "difficulty": event_dict.get("difficulty"),
            "bloom_level": event_dict.get("bloom_level"),
            "salvaged": name == "pipeline_salvaged_accepted",
        })
    elif name == "pipeline_question_rejected":
        _emit({
            "event": "question_rejected",
            "failure_class": event_dict.get("failure_class"),
            "issues": event_dict.get("issues", []),
        })

    raise structlog.DropEvent  # nothing reaches stdout except our emitted events


def _configure_json_logging() -> None:
    import logging
    # Route library/stdlib logs to stderr so stdout stays pure NDJSON.
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    structlog.configure(
        processors=[_json_event_processor],
        wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
    )


@app.command()
def generate(
    input: Annotated[Path, typer.Option("--input", "-i", help="Path to source .md file")],
    output_dir: Annotated[
        Path, typer.Option("--output-dir", "-o", help="Directory for output JSON files")
    ] = Path("output"),
    count: Annotated[int | None, typer.Option("--count", "-c")] = None,
    difficulty: Annotated[str | None, typer.Option("--difficulty", "-d")] = None,
    type: Annotated[str | None, typer.Option("--type", "-t")] = None,
    topic: Annotated[str | None, typer.Option(
        "--topic",
        help="Human-readable lesson topic label stored in Supabase for filtering "
             "(e.g. 'MQTT Protocol'). Defaults to the filename stem in title case."
    )] = None,
    topic_tag: Annotated[str | None, typer.Option(
        "--topic-tag", "-T",
        help="Topic tag applied to every question (e.g. LINUX_ROS2_FUNDAMENTALS). "
             "If omitted you will be prompted interactively (or use UNTAGGED in GUI mode).",
    )] = None,
    run_name: Annotated[str | None, typer.Option(
        "--run-name", "-n",
        help="Human-readable name for this generation run (e.g. 'Week 2 Linux basics').",
    )] = None,
    subtopics: Annotated[str | None, typer.Option(
        "--subtopics",
        help="Comma-separated list of subtopic tags for this run "
             "(e.g. 'MQTT_PROTOCOL,GPIO_BASICS,PWM_CONTROL'). "
             "The generator assigns each question to the most appropriate subtopic.",
    )] = None,
    course: Annotated[str | None, typer.Option(
        "--course", "-C",
        help="Course tag (e.g. GRIT_ROBOTICS_L1_MAIN). Defaults to config.yaml value "
             "or prompts interactively.",
    )] = None,
    no_public: Annotated[bool, typer.Option(
        "--no-public",
        help="Mark questions as private (omit IS_PUBLIC from the tag list). "
             "Overrides the is_public setting in config.yaml.",
    )] = False,
    config: Annotated[Path, typer.Option("--config")] = Path("config.yaml"),
    verbose: Annotated[bool, typer.Option("--verbose", "-v")] = False,
    json_events: Annotated[bool, typer.Option(
        "--json-events",
        help="Emit newline-delimited JSON pipeline events to stdout (for the GUI "
             "sidecar) instead of human-readable Rich output.",
    )] = False,
) -> None:
    """
    Run the full MCQ generation pipeline.

    Outputs three files per run:
      <run_id>_accepted.json       — questions that passed all quality gates
      <run_id>_rejected.json       — rejected questions with critique
      <run_id>_source_quality.json — linter + concept-density report
    """
    if json_events:
        _configure_json_logging()
    else:
        _configure_logging(verbose)
    try:
        settings: Settings = load_config(config)

        mcq_kwargs = settings.model_dump(include={
            "num_questions", "difficulty", "question_type", "num_options",
            "include_explanations", "topic_filter", "over_generation_factor",
            "max_regeneration_attempts", "model", "temperature",
        })
        if count is not None:
            mcq_kwargs["num_questions"] = count
        if difficulty is not None:
            mcq_kwargs["difficulty"] = Difficulty(difficulty)
        if type is not None:
            mcq_kwargs["question_type"] = QuestionType(type)

        mcq_config = MCQConfig.model_validate(mcq_kwargs)
        client = _build_client(settings)

        # Derive topic from filename stem if not provided by the operator
        if topic is None:
            topic = input.stem.replace("_", " ").replace("-", " ").title()

        db_path = Path(settings.log_db_path)
        storage.init_db(db_path)

        # Resolve topic tag and course (interactive if not provided as flags)
        resolved_topic_tag = _resolve_topic_tag(
            topic_tag, db_path, json_events, settings.topic_tag
        )
        resolved_course = _resolve_course(
            course, db_path, json_events, settings.course_tag
        )

        # Persist new topic tag / course to DB so they appear in future prompts
        if resolved_topic_tag != "UNTAGGED":
            storage.add_topic_tag(resolved_topic_tag, db_path)
        if resolved_course:
            storage.add_course(resolved_course, db_path)

        # Show stage routing (suppressed in JSON-events mode — stdout is NDJSON)
        if not json_events:
            rn_label = run_name or "[dim](unnamed)[/dim]"
            console.print("\n[bold]MCQ Pipeline — Stage Configuration[/bold]")
            console.print(
                f"  Analyzer  : [cyan]{settings.resolved_analyzer_provider().value}[/cyan] / "
                f"[cyan]{settings.resolved_analyzer_model()}[/cyan]  "
                f"[dim](premium — cached after first run)[/dim]"
            )
            console.print(
                f"  Generator : [cyan]{settings.resolved_generator_provider().value}[/cyan] / "
                f"[cyan]{settings.resolved_generator_model()}[/cyan]"
            )
            console.print(
                f"  Critic    : [cyan]{settings.resolved_critic_provider().value}[/cyan] / "
                f"[cyan]{settings.resolved_critic_model()}[/cyan]"
            )
            console.print(
                f"  Input     : {input}\n"
                f"  Run name  : {rn_label}\n"
                f"  Topic tag : [cyan]{resolved_topic_tag}[/cyan]\n"
                f"  Course    : [cyan]{resolved_course}[/cyan]\n"
                f"  Topic     : [cyan]{topic}[/cyan]\n"
                f"  Target    : [cyan]{mcq_config.num_questions}[/cyan] accepted questions\n"
            )

        # Thread resolved tagging values into settings so pipeline picks them up.
        # --no-public overrides the config.yaml is_public field for this run only.
        settings = settings.model_copy(update={
            "course_tag": resolved_course,
            "is_public": not no_public and settings.is_public,
        })

        subtopic_list = (
            [s.strip().upper().replace(" ", "_") for s in subtopics.split(",") if s.strip()]
            if subtopics else []
        )

        run = pipeline_mod.run_pipeline(
            input_file=input,
            config=mcq_config,
            settings=settings,
            llm_client=client,
            output_dir=output_dir,
            topic=topic,
            topic_tag=resolved_topic_tag,
            run_name=run_name,
            subtopics=subtopic_list or None,
        )

        # Derive the run label from the most recently modified accepted file in
        # output_dir — sorted by mtime so concurrent runs don't pick the wrong file.
        found = sorted(
            output_dir.glob("*_accepted.json"),
            key=lambda p: p.stat().st_mtime,
        )
        run_label = found[-1].stem.replace("_accepted", "") if found else run.run_id[:8]

        accepted_file  = output_dir / f"{run_label}_accepted.json"
        rejected_file  = output_dir / f"{run_label}_rejected.json"
        quality_file   = output_dir / f"{run_label}_source_quality.json"
        config_file    = output_dir / f"{run_label}_run_config.json"

        if json_events:
            _emit({
                "event": "run_complete",
                "run_id": run.run_id,
                "run_label": run_label,
                "generated": run.generated_count,
                "accepted": run.passed_count,
                "salvaged": run.salvaged_count,
                "rejected": len(run.rejected_mcqs),
                "requested": mcq_config.num_questions,
                "cost_usd": round(run.total_cost_usd, 6),
                "cost_breakdown": {
                    "analyzer": round(run.analyzer_cost_usd, 6),
                    "generator": round(run.generator_cost_usd, 6),
                    "critic": round(run.critic_cost_usd, 6),
                    "reframer": round(run.reframe_cost_usd, 6),
                },
                "output_files": {
                    "accepted": str(accepted_file),
                    "rejected": str(rejected_file),
                    "quality": str(quality_file),
                    "run_config": str(config_file),
                },
            })
            return

        console.print(f"[green]Done.[/green]  Run ID: [bold]{run.run_id}[/bold]\n")
        console.print(
            f"  Generated  : {run.generated_count}\n"
            f"  Accepted   : [green]{run.passed_count}[/green]\n"
            f"  Salvaged   : [cyan]{run.salvaged_count}[/cyan]  (reframed from rejected)\n"
            f"  Rejected   : [yellow]{len(run.rejected_mcqs)}[/yellow]\n"
        )

        # Tag summary
        if run.final_mcqs:
            from collections import Counter
            bloom_dist = Counter(m.bloom_level.value for m in run.final_mcqs)
            console.print(f"  Tags applied  : [cyan]{resolved_topic_tag}[/cyan]  ·  "
                          f"[cyan]{resolved_course}[/cyan]  ·  IS_PUBLIC")
            console.print("  Bloom levels  :")
            for level, cnt in sorted(bloom_dist.items()):
                bar = "█" * cnt
                console.print(f"    [cyan]{level:<12}[/cyan] {cnt:>3}  {bar}")
            console.print()
        console.print(
            f"  Cost breakdown:\n"
            f"    Analyzer  : [dim]${run.analyzer_cost_usd:.5f}[/dim]"
            + (" [dim](cached)[/dim]" if run.analyzer_cost_usd == 0.0 else "") + "\n"
            f"    Generator : [dim]${run.generator_cost_usd:.5f}[/dim]\n"
            f"    Critic    : [dim]${run.critic_cost_usd:.5f}[/dim]\n"
            f"    Reframer  : [dim]${run.reframe_cost_usd:.5f}[/dim]\n"
            f"    -------------------------\n"
            f"    Total     : [cyan]${run.total_cost_usd:.5f}[/cyan]\n"
        )
        console.print(
            f"  Output files:\n"
            f"    accepted   → {accepted_file}\n"
            f"    rejected   → {rejected_file}\n"
            f"    quality    → {quality_file}\n"
            f"    run config → [bold]{config_file}[/bold]"
        )

        if run.passed_count < mcq_config.num_questions:
            console.print(
                f"\n[yellow]Note: only {run.passed_count}/{mcq_config.num_questions} "
                f"accepted after exhausting retries.[/yellow]"
            )

    except Exception as exc:
        if json_events:
            _emit({"event": "error", "stage": "pipeline",
                   "message": str(exc), "retryable": False})
            raise typer.Exit(code=1)
        err_console.print(f"\n[bold red]Error:[/bold red] {exc}")
        err_console.print(
            "[dim]Token usage and estimated cost for this failed/partial run "
            "are logged above as [pipeline_partial_cost_report]. "
            "Run with --verbose to see the full breakdown.[/dim]"
        )
        raise typer.Exit(code=1)


@app.command()
def lint(
    input: Annotated[Path, typer.Option("--input", "-i", help="Path to source .md file")],
    config: Annotated[Path, typer.Option("--config")] = Path("config.yaml"),
    json_output: Annotated[bool, typer.Option(
        "--json", help="Emit the Layer-1 SourceQualityReport as JSON to stdout "
                       "(for the GUI Run-tab source-quality card)."
    )] = False,
) -> None:
    """
    Run the Layer-1 static source linter only — no API calls, no cost.

    Checks word count, section count, thin sections, code blocks, and term
    density against the linter_* thresholds in config.yaml.
    """
    try:
        settings = load_config(config)
        document = parse_markdown(input)
        report = run_static_linter(document, settings, str(input), run_id="lint")

        if json_output:
            sys.stdout.write(json.dumps(report.to_dict()))
            sys.stdout.flush()
            return

        color = {"PASS": "green", "WARN": "yellow", "FAIL": "red"}
        console.print(
            f"\n[bold]Source Quality — {input.name}[/bold]  →  "
            f"[{color.get(report.overall_status, 'white')}]{report.overall_status}[/]"
        )
        for c in report.checks:
            console.print(f"  [{color.get(c.status, 'white')}]{c.status}[/] {c.name}: {c.message}")
        console.print(f"\n[dim]{report.recommendation}[/dim]")
    except Exception as exc:
        if json_output:
            sys.stdout.write(json.dumps({"error": str(exc)}))
            sys.stdout.flush()
            raise typer.Exit(code=1)
        err_console.print(f"[bold red]Error:[/bold red] {exc}")
        raise typer.Exit(code=1)


@app.command(name="config-dump")
def config_dump(
    config: Annotated[Path, typer.Option("--config")] = Path("config.yaml"),
    defaults: Annotated[bool, typer.Option(
        "--defaults", help="Dump pipeline defaults instead of the file's values."
    )] = False,
) -> None:
    """
    Print the fully-resolved Settings as JSON (for the GUI Model tab).

    With --defaults, dumps the pipeline's built-in defaults (used by the Model
    tab's "Reset to Defaults") rather than the values in config.yaml.
    """
    try:
        settings = Settings() if defaults else load_config(config)
        sys.stdout.write(json.dumps(settings.model_dump(mode="json")))
        sys.stdout.flush()
    except Exception as exc:
        sys.stdout.write(json.dumps({"error": str(exc)}))
        sys.stdout.flush()
        raise typer.Exit(code=1)


@app.command(name="list-runs")
def list_runs(
    limit: Annotated[int, typer.Option("--limit", "-n")] = 10,
    config: Annotated[Path, typer.Option("--config")] = Path("config.yaml"),
) -> None:
    """Show a table of recent pipeline runs."""
    try:
        settings = load_config(config)
        db_path = Path(settings.log_db_path)
        rows = storage.list_recent_runs(db_path, limit=limit)

        if not rows:
            console.print("[yellow]No runs found.[/yellow]")
            return

        table = Table(title="Recent Runs", show_lines=True)
        table.add_column("Run ID", style="cyan", no_wrap=True)
        table.add_column("Timestamp")
        table.add_column("Input File")
        table.add_column("Accepted / Generated")
        table.add_column("Cost (USD)", justify="right")

        for row in rows:
            table.add_row(
                str(row["run_id"])[:8],
                str(row["timestamp"])[:19],
                str(row["input_file"]),
                f"{row['passed_count']} / {row['generated_count']}",
                f"${row['cost_usd']:.5f}",
            )
        console.print(table)

    except Exception as exc:
        err_console.print(f"[bold red]Error:[/bold red] {exc}")
        raise typer.Exit(code=1)


@app.command(name="show-run")
def show_run(
    run_id: Annotated[str, typer.Argument(help="Run UUID to display")],
    config: Annotated[Path, typer.Option("--config")] = Path("config.yaml"),
) -> None:
    """Display full details of a single pipeline run."""
    try:
        settings = load_config(config)
        db_path = Path(settings.log_db_path)
        run = storage.get_run(run_id, db_path)

        if run is None:
            err_console.print(f"[bold red]Run not found:[/bold red] {run_id}")
            raise typer.Exit(code=1)

        console.print(f"\n[bold]Run:[/bold] {run.run_id}")
        console.print(f"  Timestamp   : {run.timestamp.isoformat()}")
        console.print(f"  Input file  : {run.input_file}")
        console.print(f"  Difficulty  : {run.config.difficulty.value}")
        console.print(f"  Generated   : {run.generated_count}")
        console.print(f"  Accepted    : {run.passed_count}")
        console.print(f"  Salvaged    : {run.salvaged_count}  (reframed from rejected)")
        console.print(f"  Rejected    : {len(run.rejected_mcqs)}")
        console.print(f"  Total tokens: {run.total_tokens_used:,}")
        console.print(f"  Cost breakdown:")
        console.print(f"    Analyzer  : ${run.analyzer_cost_usd:.5f}" + (" (cached)" if run.analyzer_cost_usd == 0.0 else ""))
        console.print(f"    Generator : ${run.generator_cost_usd:.5f}")
        console.print(f"    Critic    : ${run.critic_cost_usd:.5f}")
        console.print(f"    Reframer  : ${run.reframe_cost_usd:.5f}")
        console.print(f"    Total     : ${run.total_cost_usd:.5f}")

        if run.final_mcqs:
            console.print(f"\n[green bold]Accepted MCQs ({len(run.final_mcqs)})[/green bold]")
            for idx, mcq in enumerate(run.final_mcqs, start=1):
                console.print(f"\n  [bold]{idx}.[/bold] {mcq.question}")
                for opt in mcq.options:
                    marker = "[green]✓[/green]" if opt.is_correct else " "
                    console.print(f"     {marker} {opt.label}. {opt.text}")

        if run.rejected_mcqs:
            console.print(f"\n[yellow bold]Rejected MCQs ({len(run.rejected_mcqs)})[/yellow bold]")
            for idx, (mcq, critique) in enumerate(run.rejected_mcqs, start=1):
                console.print(f"\n  [bold]{idx}.[/bold] {mcq.question}")
                for issue in critique.issues:
                    console.print(f"     [red]✗[/red] {issue}")

    except typer.Exit:
        raise
    except Exception as exc:
        err_console.print(f"[bold red]Error:[/bold red] {exc}")
        raise typer.Exit(code=1)


@app.command(name="push-supabase")
def push_supabase(
    run_id: Annotated[str | None, typer.Option(
        "--run-id", help="Run UUID to push. Defaults to the most recent run."
    )] = None,
    dry_run: Annotated[bool, typer.Option(
        "--dry-run", help="Compute the dedup preview without writing to Supabase."
    )] = False,
    config: Annotated[Path, typer.Option("--config")] = Path("config.yaml"),
    json_events: Annotated[bool, typer.Option(
        "--json-events", help="Emit NDJSON events to stdout (for the GUI)."
    )] = False,
) -> None:
    """
    Push a run's accepted MCQs to Supabase through the similarity dedup gate.

    Reuses the same `supabase_gate` used by the live pipeline, so dedup behaviour
    is identical. With --dry-run, runs the read-only preview (fetch + filter) and
    reports how many questions would be pushed vs skipped as duplicates, without
    writing anything. Drives the Files-tab "Push to Supabase" panel (GUI §5.7).
    """
    from . import supabase_gate

    def emit_or_print(payload: dict) -> None:
        if json_events:
            _emit(payload)

    try:
        settings = load_config(config)

        if not settings.enable_supabase:
            msg = "Supabase is disabled (enable_supabase: false in config.yaml)."
            if json_events:
                _emit({"event": "push_done", "ok": False, "disabled": True, "message": msg})
            else:
                console.print(f"[yellow]{msg}[/yellow]")
            raise typer.Exit(code=0)

        db_path = Path(settings.log_db_path)

        # Resolve the run: explicit --run-id, else the most recent.
        if run_id is None:
            recent = storage.list_recent_runs(db_path, limit=1)
            if not recent:
                raise RuntimeError("No runs found in the database.")
            run_id = str(recent[0]["run_id"])

        run = storage.get_run(run_id, db_path)
        if run is None:
            raise RuntimeError(f"Run not found: {run_id}")

        threshold = settings.supabase_similarity_threshold
        emit_or_print({
            "event": "push_start",
            "run_id": run.run_id,
            "dry_run": dry_run,
            "submitted": len(run.final_mcqs),
            "threshold": threshold,
        })

        if dry_run:
            result = supabase_gate.preview_sync(run, threshold=threshold)
        else:
            result = supabase_gate.filter_and_sync(run, threshold=threshold)

        # Compact the flagged duplicates for the GUI preview.
        skipped = [
            {
                "question": str(item["question"].get("question", ""))[:160],
                "score": round(float(item["score"]), 1),
                "source": item.get("source", ""),
            }
            for item in result.flagged
        ]

        if json_events:
            _emit({
                "event": "push_preview" if dry_run else "push_pushed",
                "would_push": result.pushed,
                "would_skip": skipped,
                "submitted": result.submitted,
                "filtered": result.filtered,
            })
            _emit({
                "event": "push_done",
                "ok": True,
                "dry_run": dry_run,
                "pushed": result.pushed,
                "filtered": result.filtered,
                "first_question_number": result.first_question_number,
                "last_question_number": result.last_question_number,
            })
        else:
            verb = "Would push" if dry_run else "Pushed"
            console.print(
                f"[green]{verb}[/green] {result.pushed} question(s); "
                f"{result.filtered} skipped as duplicates "
                f"(threshold {threshold})."
            )
            if dry_run and skipped:
                console.print("\n[yellow]Duplicates that would be skipped:[/yellow]")
                for s in skipped:
                    console.print(f"  [{s['score']}] ({s['source']}) {s['question']}")

    except typer.Exit:
        raise
    except Exception as exc:
        if json_events:
            _emit({"event": "push_done", "ok": False, "message": str(exc)})
        else:
            err_console.print(f"[bold red]Error:[/bold red] {exc}")
        raise typer.Exit(code=1)

@app.command(name="list-tags")
def list_tags(
    config: Annotated[Path, typer.Option("--config")] = Path("config.yaml"),
) -> None:
    """List all topic tags stored in the database."""
    try:
        settings = load_config(config)
        db_path = Path(settings.log_db_path)
        storage.init_db(db_path)
        tags = storage.list_topic_tags(db_path)
        if not tags:
            console.print("[yellow]No topic tags found.[/yellow]")
            return
        console.print("\n[bold]Topic Tags[/bold]")
        for i, tag in enumerate(tags, 1):
            console.print(f"  [cyan]{i:>2}.[/cyan] {tag}")
    except Exception as exc:
        err_console.print(f"[bold red]Error:[/bold red] {exc}")
        raise typer.Exit(code=1)


@app.command(name="list-courses")
def list_courses_cmd(
    config: Annotated[Path, typer.Option("--config")] = Path("config.yaml"),
) -> None:
    """List all course names stored in the database."""
    try:
        settings = load_config(config)
        db_path = Path(settings.log_db_path)
        storage.init_db(db_path)
        courses = storage.list_courses(db_path)
        if not courses:
            console.print("[yellow]No courses found.[/yellow]")
            return
        console.print("\n[bold]Courses[/bold]")
        for i, name in enumerate(courses, 1):
            console.print(f"  [cyan]{i:>2}.[/cyan] {name}")
    except Exception as exc:
        err_console.print(f"[bold red]Error:[/bold red] {exc}")
        raise typer.Exit(code=1)


@app.command(name="retag")
def retag(
    run_id: Annotated[str | None, typer.Option(
        "--run-id", help="Retag a specific run by ID. Omit to retag all runs interactively."
    )] = None,
    topic_tag: Annotated[str | None, typer.Option("--topic-tag", "-T")] = None,
    course: Annotated[str | None, typer.Option("--course", "-C")] = None,
    run_name: Annotated[str | None, typer.Option("--run-name", "-n")] = None,
    all_runs: Annotated[bool, typer.Option(
        "--all", help="Retag ALL runs with the same topic-tag and course (non-interactive)."
    )] = False,
    config: Annotated[Path, typer.Option("--config")] = Path("config.yaml"),
) -> None:
    """
    Backfill tags on existing questions in the database.

    Without --all, walks each run interactively so you can assign different
    topic tags per run.  With --all, applies a single topic-tag + course to
    every run (requires --topic-tag and --course).
    """
    try:
        settings = load_config(config)
        db_path = Path(settings.log_db_path)
        storage.init_db(db_path)

        default_course = settings.course_tag

        if all_runs:
            # Non-interactive bulk retag
            if not topic_tag or not course:
                err_console.print(
                    "[bold red]Error:[/bold red] --all requires both --topic-tag and --course."
                )
                raise typer.Exit(code=1)
            resolved_tag = topic_tag.upper().replace(" ", "_")
            resolved_course = course.upper().replace(" ", "_")
            runs = storage.get_all_run_summaries(db_path)
            total = 0
            for r in runs:
                n = storage.retag_run(
                    r["run_id"], resolved_tag, resolved_course, db_path,
                    is_public=settings.is_public,
                    run_name=run_name,
                )
                console.print(
                    f"  Run #{r['generation_number']:>3} ({r['run_id'][:8]}) "
                    f"— {n} questions retagged → [cyan]{resolved_tag}[/cyan]"
                )
                total += n
            console.print(f"\n[green]Done.[/green]  {total} questions retagged across {len(runs)} runs.")
            return

        # Interactive per-run retag
        if run_id:
            run_summaries = [r for r in storage.get_all_run_summaries(db_path) if r["run_id"] == run_id]
            if not run_summaries:
                err_console.print(f"[bold red]Run not found:[/bold red] {run_id}")
                raise typer.Exit(code=1)
        else:
            run_summaries = storage.get_all_run_summaries(db_path)

        if not run_summaries:
            console.print("[yellow]No runs found in database.[/yellow]")
            return

        # Show run table
        table = Table(title="Runs to Retag", show_lines=True)
        table.add_column("#", style="cyan", no_wrap=True)
        table.add_column("Gen", style="dim")
        table.add_column("Input file")
        table.add_column("Qs")
        table.add_column("Current topic")
        table.add_column("Current course")
        table.add_column("Run name")
        for i, r in enumerate(run_summaries, 1):
            from pathlib import PurePosixPath
            fname = PurePosixPath(r["input_file"]).name if r["input_file"] else "?"
            table.add_row(
                str(i),
                str(r["generation_number"]),
                fname,
                str(r["passed_count"]),
                r["topic_tag"] or "[dim]—[/dim]",
                r["course_tag"] or "[dim]—[/dim]",
                r["run_name"] or "[dim]—[/dim]",
            )
        console.print(table)

        existing_tags = storage.list_topic_tags(db_path)
        existing_courses = storage.list_courses(db_path)
        total_updated = 0

        for i, r in enumerate(run_summaries, 1):
            from pathlib import PurePosixPath
            fname = PurePosixPath(r["input_file"]).name if r["input_file"] else "?"
            console.print(
                f"\n[bold]Run #{r['generation_number']}[/bold]  "
                f"({r['run_id'][:8]})  ·  {fname}  ·  {r['passed_count']} questions"
            )

            # Topic tag for this run
            if topic_tag:
                chosen_tag = topic_tag.upper().replace(" ", "_")
            else:
                console.print("[bold]  Topic tag:[/bold]")
                chosen_tag = _pick_from_list(existing_tags, "topic tag")
                if chosen_tag not in existing_tags:
                    storage.add_topic_tag(chosen_tag, db_path)
                    existing_tags.append(chosen_tag)
                    existing_tags.sort()
                    console.print(f"  [green]✓[/green] Added: [cyan]{chosen_tag}[/cyan]")

            # Course for this run
            if course:
                chosen_course = course.upper().replace(" ", "_")
            else:
                console.print(f"[bold]  Course[/bold]  (default: [cyan]{default_course}[/cyan]):")
                raw = input(f"  Enter number / name [Enter={default_course}]: ").strip()
                if not raw:
                    chosen_course = default_course
                elif raw.isdigit() and 1 <= int(raw) <= len(existing_courses):
                    chosen_course = existing_courses[int(raw) - 1]
                else:
                    chosen_course = raw.upper().replace(" ", "_")
                if chosen_course not in existing_courses:
                    storage.add_course(chosen_course, db_path)
                    existing_courses.append(chosen_course)
                    existing_courses.sort()

            # Run name
            if run_name:
                chosen_name: str | None = run_name
            else:
                current = r["run_name"] or ""
                raw_name = input(f"  Run name [Enter to keep '{current}']: ").strip()
                chosen_name = raw_name if raw_name else (current or None)

            n = storage.retag_run(
                r["run_id"], chosen_tag, chosen_course, db_path,
                is_public=settings.is_public,
                run_name=chosen_name,
            )
            console.print(
                f"  [green]✓[/green]  {n} questions retagged → "
                f"[cyan]{chosen_tag}[/cyan] / [cyan]{chosen_course}[/cyan]"
            )
            total_updated += n

        console.print(f"\n[green]Done.[/green]  {total_updated} questions updated.")

    except typer.Exit:
        raise
    except Exception as exc:
        err_console.print(f"[bold red]Error:[/bold red] {exc}")
        raise typer.Exit(code=1)


if __name__ == "__main__":
    app()
