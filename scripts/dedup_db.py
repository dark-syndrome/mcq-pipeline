#!/usr/bin/env python
"""
scripts/dedup_db.py

Scan the local SQLite database for near-duplicate accepted questions and
optionally delete the redundant copies.

Algorithm
---------
rapidfuzz.fuzz.token_set_ratio on (question stem + all option texts).  Two
questions scoring >= THRESHOLD are placed in the same cluster via union-find.
Within each cluster, one representative is kept; the rest are removed.

Safety
------
* Dry-run by default — reports what would be removed without changing anything.
* --apply creates a timestamped backup of runs.db before executing deletions.
* Only accepted (passed=1) rows are considered; rejected rows are untouched.
* A Supabase check runs automatically when credentials are available: if Supabase
  shows 0 clusters the note is printed; if it finds duplicates those are reported
  separately and require a second --apply-cloud flag to delete.

Usage
-----
    python scripts/dedup_db.py                       # dry-run, default 95% threshold
    python scripts/dedup_db.py --threshold 90        # stricter scan
    python scripts/dedup_db.py --apply               # backup + delete from local DB
    python scripts/dedup_db.py --apply --apply-cloud # also delete from Supabase
    python scripts/dedup_db.py --db path/to/runs.db  # custom DB path
"""

from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path


def _emit(event: dict) -> None:
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rapidfuzz import fuzz
from rich import box
from rich.console import Console
from rich.table import Table

from mcq_agent.similarity import composite_text

console = Console()

DEFAULT_DB = Path("logs/runs.db")
DEFAULT_THRESHOLD = 95


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_items(db_path: Path) -> list[dict]:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT m.id, m.run_id, m.mcq_json, r.generation_number, r.run_name
        FROM   mcqs m JOIN runs r ON m.run_id = r.run_id
        WHERE  m.passed = 1
        ORDER  BY r.generation_number, m.id
    """).fetchall()
    conn.close()
    items = []
    for r in rows:
        mcq = json.loads(r["mcq_json"])
        items.append({
            "id":       r["id"],
            "gen":      r["generation_number"],
            "run_name": r["run_name"],
            "text":     composite_text(mcq),
            "stem":     mcq.get("question", ""),
        })
    return items


def _build_clusters(items: list[dict], threshold: int) -> dict[int, list[dict]]:
    parent = {it["id"]: it["id"] for it in items}

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        parent[find(a)] = find(b)

    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            if fuzz.token_set_ratio(items[i]["text"], items[j]["text"]) >= threshold:
                union(items[i]["id"], items[j]["id"])

    clusters: dict[int, list[dict]] = {}
    for it in items:
        clusters.setdefault(find(it["id"]), []).append(it)
    return {k: v for k, v in clusters.items() if len(v) > 1}


def _plan_deletions(
    dup_clusters: dict[int, list[dict]],
    keep_latest: bool = True,
) -> tuple[list[int], list[dict]]:
    """Return (ids_to_drop, keep_items)."""
    drop_ids: list[int] = []
    keep_items: list[dict] = []
    for members in dup_clusters.values():
        members_sorted = sorted(members, key=lambda m: (m["gen"], m["id"]))
        if keep_latest:
            keep = members_sorted[-1]
            drop = members_sorted[:-1]
        else:
            keep = members_sorted[0]
            drop = members_sorted[1:]
        keep_items.append(keep)
        drop_ids.extend(d["id"] for d in drop)
    return drop_ids, keep_items


# ---------------------------------------------------------------------------
# Supabase helpers
# ---------------------------------------------------------------------------

def _dedup_supabase(threshold: int, apply: bool) -> None:
    try:
        from dotenv import load_dotenv
        load_dotenv()
        from mcq_agent.supabase_storage import _client  # type: ignore
        sb = _client()
    except Exception as exc:
        console.print(f"[yellow]Supabase unavailable:[/] {exc}")
        return

    console.rule("[bold]Supabase dedup")
    mcq_rows = sb.table("mcqs").select("id,run_id,mcq_json").eq("passed", 1).execute().data
    runs_rows = sb.table("runs").select("run_id,generation_number").execute().data
    gen_by_run = {r["run_id"]: r["generation_number"] for r in runs_rows}

    items = []
    for row in mcq_rows:
        mcq = row["mcq_json"] if isinstance(row["mcq_json"], dict) else json.loads(row["mcq_json"])
        items.append({
            "id":  row["id"],
            "gen": gen_by_run.get(row["run_id"], 0),
            "run_id": row["run_id"],
            "text": composite_text(mcq),
            "stem": mcq.get("question", ""),
        })
    items.sort(key=lambda x: (x["gen"], x["id"]))
    console.print(f"Supabase accepted questions: {len(items)}")

    dup_clusters = _build_clusters(items, threshold)
    drop_ids, _ = _plan_deletions(dup_clusters, keep_latest=True)

    console.print(f"Clusters: {len(dup_clusters)}  |  Would drop: {len(drop_ids)}")
    if not drop_ids:
        console.print("[green]Supabase is already clean — nothing to remove.[/]")
        return

    if apply:
        for i in range(0, len(drop_ids), 50):
            sb.table("mcqs").delete().in_("id", drop_ids[i : i + 50]).execute()
        console.print(f"[green]Deleted {len(drop_ids)} duplicate rows from Supabase.[/]")
    else:
        console.print("[dim]Pass --apply --apply-cloud to delete from Supabase.[/]")


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def _print_report(
    items: list[dict],
    dup_clusters: dict[int, list[dict]],
    drop_ids: list[int],
    threshold: int,
    db_path: Path,
) -> None:
    console.rule("[bold]Duplicate Report")

    summary = Table(box=box.SIMPLE, show_header=False)
    summary.add_column(style="dim", width=28)
    summary.add_column()
    summary.add_row("Database", str(db_path))
    summary.add_row("Threshold", f"{threshold}%")
    summary.add_row("Accepted questions", str(len(items)))
    summary.add_row("Duplicate clusters", str(len(dup_clusters)))
    summary.add_row("[red]Would remove[/]", str(len(drop_ids)))
    summary.add_row("[green]Would keep[/]", str(len(items) - len(drop_ids)))
    console.print(summary)

    for members in sorted(dup_clusters.values(), key=lambda v: -len(v)):
        members_sorted = sorted(members, key=lambda m: (m["gen"], m["id"]))
        keep = members_sorted[-1]
        drop = members_sorted[:-1]
        console.print(f"[bold]Cluster ({len(members)})[/]  KEEP id={keep['id']} gen={keep['gen']} [{keep['run_name']}]")
        console.print(f"  [green]{keep['stem'][:100]}[/]")
        for d in drop:
            console.print(f"  [red]drop[/] id={d['id']} gen={d['gen']} [{d['run_name']}]: {d['stem'][:80]}")
        console.print()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def _run_json(args: argparse.Namespace) -> None:
    """JSON-events mode used by the Electron GUI."""
    db_path: Path = args.db
    if not db_path.exists():
        _emit({"event": "dedup_error", "message": f"Database not found: {db_path}"})
        sys.exit(1)

    try:
        items = _load_items(db_path)
        _emit({"event": "dedup_start", "total": len(items), "threshold": args.threshold})

        dup_clusters = _build_clusters(items, args.threshold)
        drop_ids, _ = _plan_deletions(dup_clusters, keep_latest=True)

        cluster_details = []
        for members in dup_clusters.values():
            members_sorted = sorted(members, key=lambda m: (m["gen"], m["id"]))
            keep = members_sorted[-1]
            drop = members_sorted[:-1]
            cluster_details.append({
                "keep_id": keep["id"],
                "keep_stem": keep["stem"][:120],
                "drop_count": len(drop),
                "drop_ids": [d["id"] for d in drop],
            })

        _emit({
            "event": "dedup_scan_done",
            "total": len(items),
            "clusters": len(dup_clusters),
            "would_drop": len(drop_ids),
            "cluster_details": cluster_details,
        })

        if args.apply and drop_ids:
            ts = datetime.now(tz=timezone.utc).strftime("%Y%m%d-%H%M%S")
            backup = db_path.with_name(f"{db_path.stem}.bak-predupe-{ts}")
            shutil.copy2(db_path, backup)
            conn = sqlite3.connect(db_path)
            qmarks = ",".join("?" * len(drop_ids))
            deleted = conn.execute(
                f"DELETE FROM mcqs WHERE id IN ({qmarks})", drop_ids
            ).rowcount
            conn.commit()
            conn.close()
            _emit({
                "event": "dedup_apply_done",
                "deleted": deleted,
                "backup": str(backup),
            })

        if args.include_supabase or args.apply_cloud:
            try:
                from dotenv import load_dotenv
                load_dotenv()
                from mcq_agent.supabase_storage import _client  # type: ignore
                sb = _client()
                mcq_rows = (
                    sb.table("mcqs").select("id,run_id,mcq_json").eq("passed", 1).execute().data
                )
                runs_rows = sb.table("runs").select("run_id,generation_number").execute().data
                gen_by_run = {r["run_id"]: r["generation_number"] for r in runs_rows}
                sb_items = []
                for row in mcq_rows:
                    mcq = (
                        row["mcq_json"]
                        if isinstance(row["mcq_json"], dict)
                        else json.loads(row["mcq_json"])
                    )
                    sb_items.append({
                        "id": row["id"],
                        "gen": gen_by_run.get(row["run_id"], 0),
                        "text": composite_text(mcq),
                        "stem": mcq.get("question", ""),
                    })
                sb_clusters = _build_clusters(sb_items, args.threshold)
                sb_drop, _ = _plan_deletions(sb_clusters, keep_latest=True)
                deleted_cloud = 0
                if args.apply_cloud and sb_drop:
                    for i in range(0, len(sb_drop), 50):
                        sb.table("mcqs").delete().in_("id", sb_drop[i: i + 50]).execute()
                    deleted_cloud = len(sb_drop)
                _emit({
                    "event": "dedup_supabase_done",
                    "total": len(sb_items),
                    "clusters": len(sb_clusters),
                    "would_drop": len(sb_drop),
                    "deleted": deleted_cloud,
                })
            except Exception as exc:
                _emit({"event": "dedup_supabase_error", "message": str(exc)})

    except Exception as exc:
        _emit({"event": "dedup_error", "message": str(exc)})
        sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Detect and remove near-duplicate MCQs from runs.db.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, metavar="PATH",
                        help=f"SQLite DB path (default: {DEFAULT_DB})")
    parser.add_argument("--threshold", type=int, default=DEFAULT_THRESHOLD, metavar="N",
                        help=f"Similarity %% at or above which to flag (default: {DEFAULT_THRESHOLD})")
    parser.add_argument("--apply", action="store_true",
                        help="Back up runs.db then delete duplicates from local DB")
    parser.add_argument("--apply-cloud", action="store_true",
                        help="Also delete duplicates from Supabase (requires --apply)")
    parser.add_argument("--include-supabase", action="store_true",
                        help="Scan Supabase for duplicates (dry-run, no deletion)")
    parser.add_argument("--json-events", action="store_true",
                        help="Emit NDJSON events to stdout (for the Electron GUI)")
    args = parser.parse_args()

    if args.apply_cloud and not args.apply:
        console.print("[red]--apply-cloud requires --apply[/]")
        sys.exit(1)

    if args.json_events:
        _run_json(args)
        return

    db_path = args.db
    if not db_path.exists():
        console.print(f"[red]Database not found:[/] {db_path}")
        sys.exit(1)

    items = _load_items(db_path)
    console.print(f"Loaded {len(items)} accepted questions from {db_path}")

    console.print("Running similarity scan… (this may take a moment for large banks)")
    dup_clusters = _build_clusters(items, args.threshold)
    drop_ids, _ = _plan_deletions(dup_clusters, keep_latest=True)

    _print_report(items, dup_clusters, drop_ids, args.threshold, db_path)

    if not drop_ids:
        console.print("[green]No duplicates found — database is clean.[/]")
    elif not args.apply:
        console.print("[dim]Dry run complete. Pass --apply to delete from local DB.[/]")
    else:
        # Backup
        ts = datetime.now(tz=timezone.utc).strftime("%Y%m%d-%H%M%S")
        backup = db_path.with_name(f"{db_path.stem}.bak-predupe-{ts}")
        shutil.copy2(db_path, backup)
        console.print(f"Backed up to [bold]{backup}[/]")

        # Delete
        conn = sqlite3.connect(db_path)
        qmarks = ",".join("?" * len(drop_ids))
        deleted = conn.execute(f"DELETE FROM mcqs WHERE id IN ({qmarks})", drop_ids).rowcount
        conn.commit()
        conn.close()
        console.print(f"[green]Deleted {deleted} duplicate rows from local DB.[/]")

    # Supabase
    _dedup_supabase(args.threshold, apply=args.apply_cloud)


if __name__ == "__main__":
    main()
