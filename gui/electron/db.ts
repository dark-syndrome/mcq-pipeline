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

// Parameterized variant — binds user-supplied values via prepared statement
// (never string-interpolated) to avoid SQL injection from filter inputs.
type Param = string | number | null
function rowsToObjectsParams(
  d: Database,
  sql: string,
  params: Param[],
): Record<string, unknown>[] {
  const stmt = d.prepare(sql)
  try {
    stmt.bind(params)
    const out: Record<string, unknown>[] = []
    while (stmt.step()) out.push(stmt.getAsObject())
    return out
  } finally {
    stmt.free()
  }
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

// --- Files tab (§5.1–5.5): graphical query builder over mcqs + runs ---
// All filter fields live in mcqs.mcq_json (queried via json_extract). The
// spec's "Topic" filter maps to runs.input_file here (no topic/tags column in
// this SQLite schema — see docs/BUILD_CHECKLIST.md deviation note).

const DIFFICULTY_ORDER = ['easy', 'medium', 'hard', 'expert'] as const

function basename(p: string): string {
  return String(p).split(/[\\/]/).pop() || String(p)
}

// Distinct values used to populate the filter controls.
export async function filterOptions(): Promise<{
  sourceFiles: { path: string; label: string }[]
  sourceHeadings: string[]
  runs: { run_id: string; generation_number: number; label: string }[]
}> {
  const d = await ensure()
  if (!d) return { sourceFiles: [], sourceHeadings: [], runs: [] }
  const files = rowsToObjects(
    d,
    `SELECT DISTINCT input_file FROM runs WHERE input_file IS NOT NULL ORDER BY input_file`,
  ).map((r) => ({
    path: String(r.input_file),
    label: basename(String(r.input_file)),
  }))
  const headings = rowsToObjects(
    d,
    `SELECT DISTINCT json_extract(mcq_json,'$.source_heading') AS h
       FROM mcqs
      WHERE h IS NOT NULL AND h <> ''
   ORDER BY h`,
  ).map((r) => String(r.h))
  const runs = rowsToObjects(
    d,
    `SELECT run_id, generation_number, input_file
       FROM runs
   ORDER BY generation_number DESC`,
  ).map((r) => ({
    run_id: String(r.run_id),
    generation_number: Number(r.generation_number),
    label: `Gen #${r.generation_number} · ${basename(String(r.input_file))}`,
  }))
  return { sourceFiles: files, sourceHeadings: headings, runs }
}

export interface McqFilter {
  sourceFiles?: string[]
  runIds?: string[]
  difficulties?: string[]
  blooms?: string[]
  types?: string[]
  sourceHeadings?: string[]
  dateFrom?: string
  dateTo?: string
  passedOnly?: boolean
  fetchMode?: 'sequential' | 'random' | 'stratified'
  limit?: number
  ratio?: { easy: number; medium: number; hard: number; expert: number }
}

// Build the shared WHERE clause + bound params from a filter (excluding the
// per-difficulty constraint, which stratified mode adds per bucket).
function buildWhere(f: McqFilter): { clause: string; params: Param[] } {
  const conds: string[] = []
  const params: Param[] = []
  const inList = (expr: string, vals?: string[]) => {
    if (vals && vals.length) {
      conds.push(`${expr} IN (${vals.map(() => '?').join(',')})`)
      params.push(...vals)
    }
  }
  if (f.passedOnly !== false) conds.push('m.passed = 1')
  inList(`json_extract(m.mcq_json,'$.difficulty')`, f.difficulties)
  inList(`json_extract(m.mcq_json,'$.bloom_level')`, f.blooms)
  inList(`json_extract(m.mcq_json,'$.question_type')`, f.types)
  inList(`json_extract(m.mcq_json,'$.source_heading')`, f.sourceHeadings)
  inList('r.input_file', f.sourceFiles)
  inList('m.run_id', f.runIds)
  if (f.dateFrom) {
    conds.push('r.timestamp >= ?')
    params.push(f.dateFrom)
  }
  if (f.dateTo) {
    // inclusive end-of-day
    conds.push('r.timestamp <= ?')
    params.push(`${f.dateTo}T23:59:59`)
  }
  const clause = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  return { clause, params }
}

const SELECT_COLS = `m.id, m.run_id, m.question_number, m.passed,
       m.mcq_json, r.generation_number, r.input_file, r.timestamp`

function orderClause(mode?: string): string {
  if (mode === 'random' || mode === 'stratified') return 'ORDER BY RANDOM()'
  return 'ORDER BY r.generation_number, m.question_number'
}

function parseRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) => {
    let mcq: Record<string, unknown> = {}
    try {
      mcq = JSON.parse(String(r.mcq_json))
    } catch {
      mcq = {}
    }
    return {
      id: Number(r.id),
      run_id: String(r.run_id),
      question_number: r.question_number == null ? null : Number(r.question_number),
      passed: Number(r.passed) === 1,
      generation_number: Number(r.generation_number),
      input_file: String(r.input_file ?? ''),
      source_file: basename(String(r.input_file ?? '')),
      timestamp: String(r.timestamp ?? ''),
      question: String(mcq.question ?? ''),
      options: Array.isArray(mcq.options) ? mcq.options : [],
      explanation: mcq.explanation ?? null,
      source_excerpt: mcq.source_excerpt ?? null,
      source_heading: String(mcq.source_heading ?? ''),
      bloom_level: String(mcq.bloom_level ?? ''),
      difficulty: String(mcq.difficulty ?? ''),
      question_type: String(mcq.question_type ?? ''),
    }
  })
}

// Compute per-bucket LIMITs from a ratio summing to ~100 and a total count.
// Largest remainder method so the parts add up to `total` exactly.
function ratioBuckets(
  total: number,
  ratio: { easy: number; medium: number; hard: number; expert: number },
): { difficulty: string; requested: number }[] {
  const keys = DIFFICULTY_ORDER
  const raw = keys.map((k) => ((ratio[k] || 0) / 100) * total)
  const floors = raw.map((x) => Math.floor(x))
  let remainder = total - floors.reduce((a, b) => a + b, 0)
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac)
  for (const { i } of order) {
    if (remainder <= 0) break
    floors[i]++
    remainder--
  }
  return keys.map((k, i) => ({ difficulty: k, requested: floors[i] }))
}

export interface QueryResult {
  rows: Record<string, unknown>[]
  totalMatched: number
  totalBank: number
  buckets: { difficulty: string; requested: number; got: number }[] | null
}

export async function queryMcqs(filter: McqFilter = {}): Promise<QueryResult> {
  const d = await ensure()
  if (!d)
    return { rows: [], totalMatched: 0, totalBank: 0, buckets: null }

  const totalBank = scalar(d, 'SELECT COUNT(*) FROM mcqs')
  const { clause, params } = buildWhere(filter)
  const from = `FROM mcqs m JOIN runs r ON m.run_id = r.run_id ${clause}`

  // Count of everything matching the filters (before any LIMIT / ratio).
  const totalMatched = Number(
    rowsToObjectsParams(d, `SELECT COUNT(*) AS c ${from}`, params)[0]?.c ?? 0,
  )

  // Stratified + ratio: one capped subquery per difficulty bucket.
  if (
    filter.fetchMode === 'stratified' &&
    filter.ratio &&
    filter.limit &&
    filter.limit > 0
  ) {
    const buckets = ratioBuckets(filter.limit, filter.ratio)
    const collected: Record<string, unknown>[] = []
    const report: { difficulty: string; requested: number; got: number }[] = []
    for (const b of buckets) {
      if (b.requested <= 0) {
        report.push({ ...b, got: 0 })
        continue
      }
      const bw = buildWhere({ ...filter, difficulties: [b.difficulty] })
      const rows = rowsToObjectsParams(
        d,
        `SELECT ${SELECT_COLS} FROM mcqs m JOIN runs r ON m.run_id = r.run_id
           ${bw.clause} ORDER BY RANDOM() LIMIT ?`,
        [...bw.params, b.requested],
      )
      collected.push(...rows)
      report.push({ ...b, got: rows.length })
    }
    return {
      rows: parseRows(collected),
      totalMatched,
      totalBank,
      buckets: report,
    }
  }

  // Sequential / random (optionally limited).
  const limitSql =
    filter.limit && filter.limit > 0 ? `LIMIT ${Math.floor(filter.limit)}` : ''
  const rows = rowsToObjectsParams(
    d,
    `SELECT ${SELECT_COLS} ${from} ${orderClause(filter.fetchMode)} ${limitSql}`,
    params,
  )
  return { rows: parseRows(rows), totalMatched, totalBank, buckets: null }
}

// --- DB management panel (§5.7) ---

// SQLite status: path, size, row counts, and concept-map cache contents.
export async function dbStatus(): Promise<{
  exists: boolean
  path: string
  sizeBytes: number
  counts: { runs: number; mcqs: number; concept_maps: number }
  conceptMaps: { source_file: string; created_at: string }[]
}> {
  const counts = await rowCounts()
  const exists = fs.existsSync(DB_PATH)
  const sizeBytes = exists ? fs.statSync(DB_PATH).size : 0
  const d = await ensure()
  const conceptMaps = d
    ? rowsToObjects(
        d,
        `SELECT source_file, created_at FROM concept_maps ORDER BY created_at DESC`,
      ).map((r) => ({
        source_file: String(r.source_file ?? ''),
        created_at: String(r.created_at ?? ''),
      }))
    : []
  return { exists, path: DB_PATH, sizeBytes, counts, conceptMaps }
}

// Integrity + orphan check for the DB Health Check (§5.7).
export async function dbHealth(): Promise<{
  ok: boolean
  integrity: string
  orphanedMcqs: number
}> {
  const d = await ensure()
  if (!d) return { ok: false, integrity: 'database not found', orphanedMcqs: 0 }
  const integrityRow = d.exec('PRAGMA integrity_check')
  const integrity = integrityRow.length
    ? String(integrityRow[0].values[0][0])
    : 'unknown'
  const orphanedMcqs = scalar(
    d,
    `SELECT COUNT(*) FROM mcqs m
      WHERE NOT EXISTS (SELECT 1 FROM runs r WHERE r.run_id = m.run_id)`,
  )
  return { ok: integrity === 'ok' && orphanedMcqs === 0, integrity, orphanedMcqs }
}

// Clear the concept-map cache (§5.7) — the ONLY GUI-side DB write, gated by a
// confirm in the UI. sql.js works on an in-memory snapshot, so the modified DB
// must be exported back to disk; then drop the snapshot so reads re-read it.
export async function clearConceptCache(): Promise<{ cleared: number }> {
  const d = await ensure()
  if (!d) return { cleared: 0 }
  const before = scalar(d, 'SELECT COUNT(*) FROM concept_maps')
  d.run('DELETE FROM concept_maps')
  fs.writeFileSync(DB_PATH, Buffer.from(d.export()))
  reload()
  return { cleared: before }
}
