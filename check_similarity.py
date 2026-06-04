#!/usr/bin/env python3
"""
check_similarity.py

Detects near-duplicate MCQ questions before they are committed to the database.

Checks each question in a generated JSON file against:
  1. All accepted questions already stored in logs/runs.db  (cross-run duplicates)
  2. Other questions in the same input batch               (intra-batch duplicates)

Questions whose similarity score meets or exceeds --threshold are flagged and
excluded from the cleaned output file.

Usage
-----
  python check_similarity.py output/my_lesson_accepted.json
  python check_similarity.py output/my_lesson_accepted.json --threshold 75
  python check_similarity.py output/my_lesson_accepted.json --db logs/runs.db --output clean.json
  python check_similarity.py output/my_lesson_accepted.json --no-intra-check --report-only

Similarity method
-----------------
rapidfuzz.fuzz.token_set_ratio is used on a composite text built from the
question stem + all option texts.  token_set_ratio is order-insensitive and
handles paraphrasing better than simple ratio; it scores 0-100.

Default threshold: 80  (i.e. questions sharing ≥80% token overlap are flagged)
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

from rapidfuzz import fuzz
from rich.console import Console
from rich.table import Table
from rich import box

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_DB_PATH = Path("logs/runs.db")
DEFAULT_THRESHOLD = 80

console = Console()


# ---------------------------------------------------------------------------
# I/O helpers
# ---------------------------------------------------------------------------

def load_new_questions(json_path: Path) -> list[dict]:
    with json_path.open(encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        console.print(f"[red]Error:[/] {json_path} must contain a JSON array of questions.")
        sys.exit(1)
    return data


def load_db_questions(db_path: Path) -> list[dict]:
    """Return all accepted (passed=1) questions from the SQLite database."""
    if not db_path.exists():
        console.print(f"[yellow]Warning:[/] Database not found at {db_path}. Skipping cross-run check.")
        return []
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute("SELECT mcq_json FROM mcqs WHERE passed = 1").fetchall()
    except sqlite3.OperationalError:
        console.print("[yellow]Warning:[/] Could not query mcqs table. Skipping cross-run check.")
        return []
    finally:
        conn.close()
    return [json.loads(row[0]) for row in rows]


def save_questions(questions: list[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(questions, f, indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Similarity core
# ---------------------------------------------------------------------------

def _composite_text(mcq: dict) -> str:
    """
    Build a single string for comparison from the question stem and all option
    texts.  Including options catches cases where two stems are phrased
    differently but test the same fact with identical distractors.
    """
    stem = mcq.get("question", "")
    option_texts = " ".join(
        opt.get("text", "") for opt in mcq.get("options", [])
    )
    return f"{stem} {option_texts}"


def best_match(
    candidate: dict,
    pool: list[dict],
) -> tuple[float, dict | None]:
    """Return (highest_score, matching_question) of *candidate* against *pool*."""
    candidate_text = _composite_text(candidate)
    best_score = 0.0
    best_q = None
    for existing in pool:
        score = fuzz.token_set_ratio(candidate_text, _composite_text(existing))
        if score > best_score:
            best_score = score
            best_q = existing
    return best_score, best_q


# ---------------------------------------------------------------------------
# Main logic
# ---------------------------------------------------------------------------

def run_check(
    input_json: Path,
    db_path: Path,
    threshold: int,
    output: Path | None,
    check_intra: bool,
    report_only: bool,
) -> tuple[list[dict], list[dict]]:
    """
    Returns (accepted_questions, flagged_items).

    flagged_items is a list of dicts:
      {question, score, matched_question, source ("database"|"batch")}
    """
    new_questions = load_new_questions(input_json)
    db_questions = load_db_questions(db_path)

    accepted: list[dict] = []
    flagged: list[dict] = []

    for mcq in new_questions:
        db_score, db_match = best_match(mcq, db_questions)

        # Intra-batch check runs against questions already accepted in this pass
        intra_score, intra_match = 0.0, None
        if check_intra and accepted:
            intra_score, intra_match = best_match(mcq, accepted)

        if db_score >= intra_score:
            top_score, top_match, source = db_score, db_match, "database"
        else:
            top_score, top_match, source = intra_score, intra_match, "batch"

        if top_score >= threshold:
            flagged.append({
                "question": mcq,
                "score": top_score,
                "matched_question": top_match,
                "source": source,
            })
        else:
            accepted.append(mcq)

    # -----------------------------------------------------------------------
    # Report
    # -----------------------------------------------------------------------
    console.rule("[bold]Similarity Check Report")
    summary = Table(box=box.SIMPLE, show_header=False)
    summary.add_column(style="dim")
    summary.add_column()
    summary.add_row("Input file", str(input_json))
    summary.add_row("Database", str(db_path))
    summary.add_row("DB questions loaded", str(len(db_questions)))
    summary.add_row("Threshold", f"{threshold}%")
    summary.add_row("Input questions", str(len(new_questions)))
    summary.add_row("[green]Accepted[/]", str(len(accepted)))
    summary.add_row("[red]Flagged[/]", str(len(flagged)))
    console.print(summary)

    if flagged:
        console.rule("[bold red]Flagged Questions")
        for i, item in enumerate(flagged, 1):
            q_text = item["question"].get("question", "")
            m_text = item["matched_question"].get("question", "") if item["matched_question"] else "N/A"
            console.print(
                f"[bold]{i}.[/] [red]{item['score']:.1f}%[/] similarity "
                f"(vs [italic]{item['source']}[/])"
            )
            console.print(f"   [yellow]New :[/] {q_text[:120]}")
            console.print(f"   [blue]Match:[/] {m_text[:120]}")
            console.print()

    # -----------------------------------------------------------------------
    # Save output
    # -----------------------------------------------------------------------
    if not report_only:
        if output is None:
            output = input_json.parent / (input_json.stem + "_deduped.json")
        save_questions(accepted, output)
        console.print(f"[green]Cleaned questions saved to:[/] {output}")
    else:
        console.print("[dim]--report-only: no output file written.[/]")

    return accepted, flagged


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Check generated MCQ questions for similarity against the database.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "input_json",
        type=Path,
        help="Path to the generated questions JSON file (array of MCQ objects).",
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=DEFAULT_DB_PATH,
        metavar="PATH",
        help=f"SQLite database path (default: {DEFAULT_DB_PATH}).",
    )
    parser.add_argument(
        "--threshold",
        type=int,
        default=DEFAULT_THRESHOLD,
        metavar="N",
        help=f"Flag questions with similarity >= N%% (default: {DEFAULT_THRESHOLD}).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        metavar="PATH",
        help="Output JSON path for cleaned questions (default: <input>_deduped.json).",
    )
    parser.add_argument(
        "--no-intra-check",
        action="store_true",
        help="Skip within-batch duplicate detection.",
    )
    parser.add_argument(
        "--report-only",
        action="store_true",
        help="Print the report but do not write any output file.",
    )
    args = parser.parse_args()

    accepted, flagged = run_check(
        input_json=args.input_json,
        db_path=args.db,
        threshold=args.threshold,
        output=args.output,
        check_intra=not args.no_intra_check,
        report_only=args.report_only,
    )

    # Exit with non-zero code if any duplicates were found (useful in CI)
    if flagged:
        sys.exit(1)


if __name__ == "__main__":
    main()
