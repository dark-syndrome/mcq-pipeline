import fs from 'node:fs'
import path from 'node:path'
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'
import { DB_PATH } from './paths'

// Read-only access to logs/runs.db via sql.js (WASM). The Python pipeline owns
// all writes; the GUI only reads, so an in-memory snapshot is sufficient.
// Replaceable with better-sqlite3 later if interactive perf on a large DB
// demands native bindings (see docs/BUILD_CHECKLIST.md deviation note).

let SQL: SqlJsStatic | null = null
let db: Database | null = null

async function ensure(): Promise<Database | null> {
  if (!SQL) {
    SQL = await initSqlJs({
      locateFile: (file) =>
        path.join(path.dirname(require.resolve('sql.js')), file),
    })
  }
  if (!fs.existsSync(DB_PATH)) return null
  if (!db) db = new SQL.Database(fs.readFileSync(DB_PATH))
  return db
}

// Drop the cached snapshot so the next query re-reads the file from disk
// (call after a pipeline run writes new rows).
export function reload(): void {
  if (db) {
    db.close()
    db = null
  }
}

function rowsToObjects(d: Database, sql: string): Record<string, unknown>[] {
  const res = d.exec(sql)
  if (!res.length) return []
  const { columns, values } = res[0]
  return values.map((row) =>
    Object.fromEntries(row.map((v, i) => [columns[i], v])),
  )
}

export async function rowCounts(): Promise<{
  runs: number
  mcqs: number
  concept_maps: number
}> {
  const d = await ensure()
  if (!d) return { runs: 0, mcqs: 0, concept_maps: 0 }
  const count = (table: string): number => {
    const r = d.exec(`SELECT COUNT(*) FROM ${table}`)
    return r.length ? (r[0].values[0][0] as number) : 0
  }
  return { runs: count('runs'), mcqs: count('mcqs'), concept_maps: count('concept_maps') }
}

export async function recentRuns(limit = 15): Promise<Record<string, unknown>[]> {
  const d = await ensure()
  if (!d) return []
  const n = Math.max(1, Math.floor(Number(limit) || 15))
  return rowsToObjects(
    d,
    `SELECT run_id, generation_number, timestamp, input_file,
            generated_count, passed_count, cost_usd
       FROM runs
   ORDER BY timestamp DESC
      LIMIT ${n}`,
  )
}

export async function lastRun(): Promise<Record<string, unknown> | null> {
  const rows = await recentRuns(1)
  return rows[0] ?? null
}

// --- Dashboard aggregates (§4.1 KPI strip + §4.2 Overview) ---
// All read-only over logs/runs.db. Per-stage cost is NOT persisted (runs holds
// only aggregate cost_usd + total tokens), so the cost chart uses the total.

function scalar(d: Database, sql: string): number {
  const r = d.exec(sql)
  return r.length && r[0].values.length ? Number(r[0].values[0][0] ?? 0) : 0
}

// §4.1 — global totals across all runs. Critic rejection ≈ mcqs that failed
// (passed=0). salvageRate is not persisted per-question, so it's returned null
// and the card renders "—" (documented gap, not fabricated).
export async function dashboardKpis(): Promise<{
  totalQuestions: number
  accepted: number
  rejected: number
  acceptanceRate: number
  rejectionRate: number
  salvageRate: number | null
  totalCost: number
  avgCostPerQuestion: number
}> {
  const d = await ensure()
  if (!d)
    return {
      totalQuestions: 0,
      accepted: 0,
      rejected: 0,
      acceptanceRate: 0,
      rejectionRate: 0,
      salvageRate: null,
      totalCost: 0,
      avgCostPerQuestion: 0,
    }
  const totalQuestions = scalar(d, 'SELECT COUNT(*) FROM mcqs')
  const accepted = scalar(d, 'SELECT COALESCE(SUM(passed),0) FROM mcqs')
  const rejected = totalQuestions - accepted
  const totalCost = scalar(d, 'SELECT COALESCE(SUM(cost_usd),0) FROM runs')
  return {
    totalQuestions,
    accepted,
    rejected,
    acceptanceRate: totalQuestions ? accepted / totalQuestions : 0,
    rejectionRate: totalQuestions ? rejected / totalQuestions : 0,
    salvageRate: null,
    totalCost,
    avgCostPerQuestion: accepted ? totalCost / accepted : 0,
  }
}

// §4.2 chart 1 — accepted vs rejected per run, last `limit` runs by generation.
export async function questionsPerGeneration(
  limit = 15,
): Promise<Record<string, unknown>[]> {
  const d = await ensure()
  if (!d) return []
  const n = Math.max(1, Math.floor(Number(limit) || 15))
  return rowsToObjects(
    d,
    `SELECT generation_number, run_id, timestamp,
            passed_count AS accepted,
            (generated_count - passed_count) AS rejected
       FROM runs
   ORDER BY generation_number DESC
      LIMIT ${n}`,
  ).reverse() // oldest→newest left-to-right on the x-axis
}

// §4.2 chart 2 — question_type distribution across accepted questions.
export async function typeDistribution(): Promise<Record<string, unknown>[]> {
  const d = await ensure()
  if (!d) return []
  return rowsToObjects(
    d,
    `SELECT json_extract(mcq_json,'$.question_type') AS type, COUNT(*) AS count
       FROM mcqs
      WHERE passed = 1
   GROUP BY type
   ORDER BY count DESC`,
  )
}

// §4.2 chart 4 — difficulty distribution across accepted questions.
export async function difficultyDistribution(): Promise<
  Record<string, unknown>[]
> {
  const d = await ensure()
  if (!d) return []
  return rowsToObjects(
    d,
    `SELECT json_extract(mcq_json,'$.difficulty') AS difficulty, COUNT(*) AS count
       FROM mcqs
      WHERE passed = 1
   GROUP BY difficulty
   ORDER BY count DESC`,
  )
}

// §4.2 chart 3 — total cost per run, last `limit` runs (single line; per-stage
// split is not persisted — see header note).
export async function costPerRun(
  limit = 15,
): Promise<Record<string, unknown>[]> {
  const d = await ensure()
  if (!d) return []
  const n = Math.max(1, Math.floor(Number(limit) || 15))
  return rowsToObjects(
    d,
    `SELECT generation_number, run_id, timestamp, cost_usd
       FROM runs
   ORDER BY generation_number DESC
      LIMIT ${n}`,
  ).reverse()
}
