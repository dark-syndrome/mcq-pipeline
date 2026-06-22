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
    `SELECT run_id, generation_number, input_file, run_name
       FROM runs
   ORDER BY generation_number DESC`,
  ).map((r) => ({
    run_id: String(r.run_id),
    generation_number: Number(r.generation_number),
    label: r.run_name
      ? String(r.run_name)
      : `Gen #${r.generation_number} · ${basename(String(r.input_file))}`,
  }))
  return { sourceFiles: files, sourceHeadings: headings, runs }
}

export async function distinctSubTopics(): Promise<string[]> {
  const d = await ensure()
  if (!d) return []
  return rowsToObjects(
    d,
    `SELECT DISTINCT json_extract(mcq_json,'$.sub_topic') AS st
       FROM mcqs
      WHERE passed = 1 AND st IS NOT NULL AND st <> ''
   ORDER BY st`,
  ).map((r) => String(r.st))
}

// Authoritative full mcq_json keyed by row id — used to recover fields the eval
// set JSON doesn't carry (notably stem_pattern) when promoting to few-shot.
export async function mcqJsonByIds(
  ids: number[],
): Promise<Record<number, Record<string, unknown>>> {
  const d = await ensure()
  if (!d || ids.length === 0) return {}
  const rows = rowsToObjectsParams(
    d,
    `SELECT id, mcq_json FROM mcqs WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids,
  )
  const out: Record<number, Record<string, unknown>> = {}
  for (const r of rows) {
    try {
      out[Number(r.id)] = JSON.parse(String(r.mcq_json))
    } catch {
      /* skip unparseable */
    }
  }
  return out
}

export interface McqFilter {
  sourceFiles?: string[]
  runIds?: string[]
  difficulties?: string[]
  blooms?: string[]
  types?: string[]
  sourceHeadings?: string[]
  subTopics?: string[]
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
  inList(`json_extract(m.mcq_json,'$.sub_topic')`, f.subTopics)
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
      sub_topic: (mcq.sub_topic as string) ?? null,
      tags: Array.isArray(mcq.tags) ? (mcq.tags as string[]) : [],
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

// --- Dashboard sub-tab 2: Quality (§4.2) ---
// Critique data is only stored for REJECTED mcqs (passed=1 rows have NULL
// critique_json — they passed every criterion by definition). Older runs stored
// 8 boolean criteria; newer runs store more. We discover the criteria present in
// the data rather than hard-coding the spec's 13, so the views stay truthful to
// whatever the DB actually holds.

// Boolean keys in CritiqueResult that represent pass/fail criteria (not the
// `passes` summary, not text/answer fields). Discovered from the stored JSON.
const _CRITIQUE_NON_CRITERIA = new Set([
  'passes', 'issues', 'suggested_fix', 'independent_answer',
  'independent_reasoning', 'source_grounding_quote',
])

function _critiqueRows(d: Database): { run: string; passed: number; crit: Record<string, unknown> | null }[] {
  return rowsToObjects(
    d,
    `SELECT m.run_id AS run, m.passed AS passed, m.critique_json AS cj,
            r.generation_number AS gen
       FROM mcqs m JOIN runs r ON m.run_id = r.run_id
   ORDER BY r.generation_number`,
  ).map((r) => {
    let crit: Record<string, unknown> | null = null
    if (r.cj != null) {
      try {
        crit = JSON.parse(String(r.cj))
      } catch {
        crit = null
      }
    }
    return { run: String(r.run), passed: Number(r.passed), crit }
  })
}

// Critic Criteria Heatmap (§4.2): rows = criteria, columns = last N runs by
// generation, cell = pass rate. An accepted (passed=1) mcq counts as a pass for
// every criterion; a rejected mcq contributes its stored boolean per criterion.
export async function criticCriteriaHeatmap(limit = 10): Promise<{
  criteria: string[]
  runs: { run_id: string; generation_number: number }[]
  cells: { criterion: string; run_id: string; passRate: number; n: number }[]
}> {
  const d = await ensure()
  if (!d) return { criteria: [], runs: [], cells: [] }
  const n = Math.max(1, Math.floor(Number(limit) || 10))
  const runRows = rowsToObjects(
    d,
    `SELECT run_id, generation_number FROM runs ORDER BY generation_number DESC LIMIT ${n}`,
  )
    .map((r) => ({ run_id: String(r.run_id), generation_number: Number(r.generation_number) }))
    .reverse()
  const runSet = new Map(runRows.map((r) => [r.run_id, r]))

  // Discover criteria from any stored critique.
  const criteria = new Set<string>()
  const all = _critiqueRows(d)
  for (const row of all) {
    if (row.crit) {
      for (const [k, v] of Object.entries(row.crit)) {
        if (typeof v === 'boolean' && !_CRITIQUE_NON_CRITERIA.has(k)) criteria.add(k)
      }
    }
  }
  const critList = [...criteria].sort()

  // Tally pass/total per (criterion, run).
  const agg = new Map<string, { pass: number; total: number }>()
  const key = (c: string, run: string) => `${c}::${run}`
  for (const row of all) {
    if (!runSet.has(row.run)) continue
    for (const c of critList) {
      const k = key(c, row.run)
      const cur = agg.get(k) ?? { pass: 0, total: 0 }
      cur.total += 1
      // accepted → pass on all; rejected → use stored boolean (missing = fail)
      if (row.passed === 1 || row.crit?.[c] === true) cur.pass += 1
      agg.set(k, cur)
    }
  }
  const cells = []
  for (const c of critList) {
    for (const r of runRows) {
      const cur = agg.get(key(c, r.run_id)) ?? { pass: 0, total: 0 }
      cells.push({
        criterion: c,
        run_id: r.run_id,
        passRate: cur.total ? cur.pass / cur.total : 0,
        n: cur.total,
      })
    }
  }
  return { criteria: critList, runs: runRows, cells }
}

// Validator Failure Breakdown (§4.2): tally how often each failure keyword
// appears across rejected critiques' `issues`. Keyword buckets mirror the
// validator/critic taxonomy in mcq_agent (source_excerpt, length_parity, etc.).
const _FAILURE_BUCKETS: { label: string; match: RegExp }[] = [
  { label: 'source_excerpt', match: /source_excerpt|not found in document/i },
  { label: 'length_parity', match: /length|parity/i },
  { label: 'uniqueness', match: /unique/i },
  { label: 'option_count', match: /option count|number of options/i },
  { label: 'distractor', match: /distractor|implausible/i },
  { label: 'unsourced', match: /unsourced|not present in|not in the source|not explicitly supported/i },
  { label: 'bloom_difficulty', match: /bloom|difficulty/i },
  { label: 'source_phrase', match: /phrase overlap|verbatim|source_phrase/i },
  { label: 'clarity', match: /clear|ambiguous|wording/i },
]
export async function validatorFailureBreakdown(): Promise<
  { validator: string; count: number }[]
> {
  const d = await ensure()
  if (!d) return []
  const counts = new Map<string, number>()
  let other = 0
  for (const row of _critiqueRows(d)) {
    const issues = Array.isArray(row.crit?.issues) ? (row.crit!.issues as unknown[]) : []
    for (const issue of issues) {
      const text = String(issue)
      const bucket = _FAILURE_BUCKETS.find((b) => b.match.test(text))
      if (bucket) counts.set(bucket.label, (counts.get(bucket.label) ?? 0) + 1)
      else other += 1
    }
  }
  const out = [...counts.entries()].map(([validator, count]) => ({ validator, count }))
  if (other) out.push({ validator: 'other', count: other })
  return out.sort((a, b) => b.count - a.count)
}

// Reframer Intervention by Class (§4.2): reconstructs the A–E/SKIP class for
// each rejected mcq. This is a faithful JS port of
// mcq_agent/reframer.py:classify_rejection — keep the two in sync if that logic
// changes. (The class is computed at emit-time in Python and not persisted.)
export async function reframerClassBreakdown(): Promise<
  { class: string; count: number }[]
> {
  const d = await ensure()
  if (!d) return []
  const NON_REFRAMEABLE = ['uniqueness', 'option_count', 'distractor_rationales', 'bloom_difficulty', 'source_phrase_overlap']
  const counts = new Map<string, number>()
  const bump = (c: string) => counts.set(c, (counts.get(c) ?? 0) + 1)

  for (const row of _critiqueRows(d)) {
    if (row.passed === 1 || !row.crit) continue
    const crit = row.crit
    const issues = (Array.isArray(crit.issues) ? crit.issues : []).map((i) => String(i))
    const reasoning = String(crit.independent_reasoning ?? '')
    const droppedBeforeCritique = reasoning.includes('Dropped before critique')

    if (droppedBeforeCritique) {
      const hasExcerpt = issues.some((i) => i.includes('source_excerpt'))
      const hasParity = issues.some((i) => /length|parity/i.test(i))
      const hasNonReframeable = issues.some((i) =>
        NON_REFRAMEABLE.some((k) => i.toLowerCase().includes(k)),
      )
      if (hasNonReframeable) bump('SKIP')
      else if (hasExcerpt && hasParity) bump('E')
      else if (hasExcerpt) bump('B')
      else if (hasParity) bump('A')
      else bump('SKIP')
    } else {
      const hasDistractor =
        crit.distractors_plausible === false ||
        issues.some((i) => /distractor|implausible/i.test(i))
      const hasSourcing = issues.some((i) =>
        /unsourced|not present in|not in the source|not explicitly supported/i.test(i),
      )
      if (hasDistractor && !hasSourcing) bump('C')
      else if (hasSourcing && !hasDistractor) bump('D')
      else if (hasDistractor && hasSourcing) bump('D')
      else bump('SKIP')
    }
  }
  const order = ['A', 'B', 'C', 'D', 'E', 'SKIP']
  return [...counts.entries()]
    .map(([cls, count]) => ({ class: cls, count }))
    .sort((a, b) => order.indexOf(a.class) - order.indexOf(b.class))
}

// --- Dashboard sub-tab 3: Cost & Tokens (§4.2) ---

// Cumulative Cost Trend (§4.2): running total of cost over time, oldest→newest,
// plus a simple linear-regression forecast slope (USD per run) the chart extends.
export async function cumulativeCost(): Promise<{
  points: { generation_number: number; run_id: string; timestamp: string; cumulative: number }[]
  slope: number
  intercept: number
}> {
  const d = await ensure()
  if (!d) return { points: [], slope: 0, intercept: 0 }
  const rows = rowsToObjects(
    d,
    `SELECT generation_number, run_id, timestamp, cost_usd
       FROM runs ORDER BY generation_number`,
  )
  let cum = 0
  const points = rows.map((r, i) => {
    cum += Number(r.cost_usd) || 0
    return {
      generation_number: Number(r.generation_number),
      run_id: String(r.run_id),
      timestamp: String(r.timestamp),
      cumulative: Number(cum.toFixed(6)),
      _x: i,
    }
  })
  // Least-squares fit of cumulative vs index for a forecast line.
  const nPts = points.length
  let slope = 0
  let intercept = 0
  if (nPts >= 2) {
    const sx = points.reduce((a, p) => a + p._x, 0)
    const sy = points.reduce((a, p) => a + p.cumulative, 0)
    const sxx = points.reduce((a, p) => a + p._x * p._x, 0)
    const sxy = points.reduce((a, p) => a + p._x * p.cumulative, 0)
    const denom = nPts * sxx - sx * sx
    if (denom !== 0) {
      slope = (nPts * sxy - sx * sy) / denom
      intercept = (sy - slope * sx) / nPts
    }
  }
  return {
    points: points.map(({ _x, ...p }) => p),
    slope: Number(slope.toFixed(6)),
    intercept: Number(intercept.toFixed(6)),
  }
}

// Cost per Accepted Question (§4.2 scatter): one point per run. num_questions is
// read from the run's stored config_json; y = cost_usd / accepted.
export async function costPerAcceptedQuestion(): Promise<
  { run_id: string; generation_number: number; requested: number; accepted: number; costPerQuestion: number }[]
> {
  const d = await ensure()
  if (!d) return []
  return rowsToObjects(
    d,
    `SELECT run_id, generation_number, config_json, passed_count, cost_usd FROM runs ORDER BY generation_number`,
  ).map((r) => {
    let requested = 0
    try {
      requested = Number(JSON.parse(String(r.config_json)).num_questions) || 0
    } catch {
      requested = 0
    }
    const accepted = Number(r.passed_count) || 0
    return {
      run_id: String(r.run_id),
      generation_number: Number(r.generation_number),
      requested,
      accepted,
      costPerQuestion: accepted ? Number((Number(r.cost_usd) / accepted).toFixed(6)) : 0,
    }
  })
}

// --- Dashboard sub-tab 4: Run History (§4.2) ---

// Full sortable run list. input_file is reduced to a basename for display.
export async function runHistory(): Promise<
  Record<string, unknown>[]
> {
  const d = await ensure()
  if (!d) return []
  return rowsToObjects(
    d,
    `SELECT run_id, generation_number, timestamp, input_file,
            generated_count, passed_count, cost_usd
       FROM runs ORDER BY generation_number DESC`,
  ).map((r) => ({
    run_id: String(r.run_id),
    generation_number: Number(r.generation_number),
    timestamp: String(r.timestamp ?? ''),
    input_file: String(r.input_file ?? ''),
    source_file: basename(String(r.input_file ?? '')),
    generated_count: Number(r.generated_count) || 0,
    passed_count: Number(r.passed_count) || 0,
    rejected_count: (Number(r.generated_count) || 0) - (Number(r.passed_count) || 0),
    cost_usd: Number(r.cost_usd) || 0,
  }))
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

// --- Tagging catalog (topic_tags / courses tables) ---

export async function listTopicTags(): Promise<string[]> {
  const d = await ensure()
  if (!d) return []
  try {
    return rowsToObjects(d, 'SELECT tag FROM topic_tags ORDER BY tag').map(
      (r) => String(r.tag),
    )
  } catch {
    return [] // table absent in old DB — migration will create it on next Python run
  }
}

export async function listCourses(): Promise<string[]> {
  const d = await ensure()
  if (!d) return []
  try {
    return rowsToObjects(d, 'SELECT name FROM courses ORDER BY name').map(
      (r) => String(r.name),
    )
  } catch {
    return []
  }
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
  // Reload first so the snapshot reflects any rows written by recent pipeline runs;
  // without this, exporting the stale snapshot back to disk would destroy them.
  reload()
  const d = await ensure()
  if (!d) return { cleared: 0 }
  const before = scalar(d, 'SELECT COUNT(*) FROM concept_maps')
  d.run('DELETE FROM concept_maps')
  fs.writeFileSync(DB_PATH, Buffer.from(d.export()))
  reload()
  return { cleared: before }
}
