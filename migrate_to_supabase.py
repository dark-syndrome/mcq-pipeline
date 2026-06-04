#!/usr/bin/env python3
"""
migrate_to_supabase.py

Push locally accepted questions (from logs/runs.db) to Supabase,
running each run through the similarity gate to deduplicate as they land.

Usage
-----
  # Migrate only the most recent run
  python migrate_to_supabase.py --latest

  # Migrate a specific run by ID
  python migrate_to_supabase.py --run-id 9836b531-4a9d-4d62-8615-3c682c5c124e

  # Migrate all runs (oldest-first)
  python migrate_to_supabase.py

  # Preview without writing anything
  python migrate_to_supabase.py --latest --dry-run

Options
-------
  --latest           Only migrate the most recent run
  --run-id UUID      Only migrate the run with this ID
  --db PATH          SQLite database (default: logs/runs.db)
  --threshold N      Similarity threshold 0-100 (default: from config.yaml)
  --dry-run          Report what would be pushed without writing to Supabase
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from dotenv import load_dotenv
from rich import box
from rich.console import Console
from rich.table import Table

load_dotenv()

from mcq_agent.config import load_config
from mcq_agent.storage import get_run, list_recent_runs
from mcq_agent.supabase_gate import SyncResult, filter_and_sync

console = Console()
DEFAULT_DB = Path("logs/runs.db")


def _select_runs(db_path: Path, latest: bool, run_id: str | None) -> list[dict]:
    """Return the subset of run summaries to migrate, oldest-first."""
    if run_id:
        # Single specific run — look it up directly
        all_summaries = list_recent_runs(db_path, limit=10_000)
        match = [s for s in all_summaries if s["run_id"] == run_id]
        if not match:
            console.print(f"[red]Error:[/] run_id {run_id!r} not found in {db_path}")
            sys.exit(1)
        return match

    # newest-first from DB → reverse for oldest-first processing
    summaries = list(reversed(list_recent_runs(db_path, limit=10_000)))

    if latest:
        # list_recent_runs DESC → last element after reverse is the newest
        return [summaries[-1]] if summaries else []

    return summaries


def migrate(
    db_path: Path,
    threshold: int,
    dry_run: bool,
    latest: bool,
    run_id: str | None,
) -> None:
    if not db_path.exists():
        console.print(f"[red]Error:[/] Database not found at {db_path}")
        sys.exit(1)

    summaries = _select_runs(db_path, latest=latest, run_id=run_id)
    if not summaries:
        console.print("[yellow]No runs found in database.[/]")
        return

    scope = "latest run" if latest else (f"run {run_id[:8]}" if run_id else f"{len(summaries)} run(s)")
    console.rule("[bold]Supabase Migration")
    console.print(f"Migrating [bold]{scope}[/] from {db_path} | threshold [bold]{threshold}%[/]\n")

    if dry_run:
        console.print("[yellow]DRY RUN — nothing will be written to Supabase.[/]\n")

    results: list[tuple[str, SyncResult | None, str]] = []

    for summary in summaries:
        run = get_run(summary["run_id"], db_path)
        if run is None:
            results.append((summary["run_id"], None, "could not load from SQLite"))
            continue

        label = f"gen {run.generation_number:03d} | {Path(run.input_file).name}"
        console.print(f"[dim]  {label}  ({len(run.final_mcqs)} accepted questions)[/]")

        if dry_run:
            results.append((label, None, f"{len(run.final_mcqs)} questions — skipped (dry run)"))
            continue

        try:
            result = filter_and_sync(run, threshold=threshold)
            results.append((label, result, "ok"))
        except Exception as exc:  # noqa: BLE001
            results.append((label, None, f"FAILED: {exc}"))

    # ── Summary table ──────────────────────────────────────────────────────
    console.rule("[bold]Migration Summary")
    tbl = Table(box=box.SIMPLE)
    tbl.add_column("Run",       style="dim", no_wrap=True)
    tbl.add_column("Submitted", justify="right")
    tbl.add_column("Pushed",    justify="right", style="green")
    tbl.add_column("Filtered",  justify="right", style="yellow")
    tbl.add_column("Q# range",  justify="left")
    tbl.add_column("Status")

    total_pushed = total_filtered = 0

    for label, result, status in results:
        if result is None:
            tbl.add_row(label, "-", "-", "-", "-", status)
        else:
            q_range = (
                f"{result.first_question_number}-{result.last_question_number}"
                if result.first_question_number else "none"
            )
            tbl.add_row(
                label,
                str(result.submitted),
                str(result.pushed),
                str(result.filtered),
                q_range,
                "[green]ok[/]",
            )
            total_pushed   += result.pushed
            total_filtered += result.filtered

    console.print(tbl)
    console.print(
        f"\nPushed to Supabase : [green]{total_pushed}[/]\n"
        f"Filtered (dupes)   : [yellow]{total_filtered}[/]"
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Migrate locally generated MCQs from SQLite to Supabase.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--latest",    action="store_true",
                        help="Only migrate the most recent run")
    parser.add_argument("--run-id",    default=None, metavar="UUID",
                        help="Only migrate this specific run ID")
    parser.add_argument("--db",        type=Path, default=DEFAULT_DB, metavar="PATH")
    parser.add_argument("--threshold", type=int,  default=None, metavar="N",
                        help="Similarity threshold 0-100 (default: from config.yaml)")
    parser.add_argument("--dry-run",   action="store_true",
                        help="Report without writing to Supabase")
    args = parser.parse_args()

    if args.latest and args.run_id:
        console.print("[red]Error:[/] --latest and --run-id are mutually exclusive.")
        sys.exit(1)

    settings  = load_config()
    threshold = args.threshold if args.threshold is not None else settings.supabase_similarity_threshold

    migrate(
        db_path=args.db,
        threshold=threshold,
        dry_run=args.dry_run,
        latest=args.latest,
        run_id=args.run_id,
    )


if __name__ == "__main__":
    main()
