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


def _build_client(settings: Settings) -> LLMClient:
    """Build a global client using the base provider/model."""
    api_key = load_dotenv_and_get_api_key(settings.provider)
    return make_client(
        provider=settings.provider.value,
        api_key=api_key,
        default_model=settings.model,
        max_retries=settings.api_max_retries,
        initial_backoff=settings.api_retry_initial_backoff,
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
#   run_complete      {event, run_id, run_label, generated, accepted, salvaged,
#                      rejected, requested, cost_usd, cost_breakdown{...}, output_files{...}}
#   error             {event, stage, message, retryable}
# stage ids: parse | linter_l1 | analyze | linter_l2 | generate | reframe
#
# KNOWN GAP (tracked in docs/BUILD_CHECKLIST.md): the spec's `question_rejected`
# event is not yet emitted, and `generate`/`critic` per-stage cost is only
# reported in aggregate via run_complete.cost_breakdown (not per stage_done).

# internal structlog event  →  GUI "stage_done" stage id
_STAGE_DONE_MAP = {
    "pipeline_parse_done": "parse",
    "pipeline_linter_done": "linter_l1",
    "pipeline_analyze_done": "analyze",
    "pipeline_density_check_done": "linter_l2",
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
        "--topic", "-T",
        help="Human-readable lesson topic label stored in Supabase for filtering "
             "(e.g. 'MQTT Protocol'). Defaults to the filename stem in title case."
    )] = None,
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

        # Show stage routing (suppressed in JSON-events mode — stdout is NDJSON)
        if not json_events:
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
                f"  Topic     : [cyan]{topic}[/cyan]\n"
                f"  Target    : [cyan]{mcq_config.num_questions}[/cyan] accepted questions\n"
            )

        run = pipeline_mod.run_pipeline(
            input_file=input,
            config=mcq_config,
            settings=settings,
            llm_client=client,
            output_dir=output_dir,
            topic=topic,
        )

        # Reconstruct label from run (same formula as pipeline)
        run_number = storage.list_recent_runs(Path(settings.log_db_path), limit=1)
        # Derive label from the output files already written
        import re as _re
        found = list(output_dir.glob(f"*_accepted.json"))
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

if __name__ == "__main__":
    app()
