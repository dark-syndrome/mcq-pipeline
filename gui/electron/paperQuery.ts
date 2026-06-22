import fs from 'node:fs'
import path from 'node:path'
import * as db from './db'
import { readConfig } from './config'
import { REPO_ROOT } from './paths'

// Question-paper query layer: tries Supabase first, falls back to local SQLite.
// Supabase is used when enable_supabase is true in config.yaml AND both
// SUPABASE_URL + SUPABASE_KEY env vars are present (read from .env if needed).

// ─── .env loader ─────────────────────────────────────────────────────────────

function loadDotEnv(): void {
  const envPath = path.join(REPO_ROOT, '.env')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    // Split only on the FIRST '=' so base64/JWT values (which contain '=') are preserved.
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const key = t.slice(0, eq).trim()
    const raw = t.slice(eq + 1).trim()
    // Strip a single pair of surrounding quotes if present.
    const val = /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw
    if (key && !process.env[key]) process.env[key] = val
  }
}

function supabaseAvailable(): boolean {
  loadDotEnv()
  const cfg = readConfig()
  return !!(cfg?.supabaseEnabled && process.env.SUPABASE_URL && process.env.SUPABASE_KEY)
}

// ─── Shared types (mirrored in src/types.ts) ─────────────────────────────────

export interface PaperFilterOptions {
  generations: { generation_number: number; label: string }[]
  topics: string[]
  subTopics: string[]
  source: 'supabase' | 'sqlite'
}

export interface SubTopicAlloc {
  subTopic: string
  easyCount: number
  mediumCount: number
  hardCount: number
}

export interface PaperQueryParams {
  easyCount: number
  mediumCount: number
  hardCount: number
  generationNumbers?: number[]
  topics?: string[]
  subTopicAllocs?: SubTopicAlloc[]
}

export interface PaperBucket {
  difficulty: string
  requested: number
  got: number
}

export interface PaperRow {
  id: number
  run_id: string
  question_number: number | null
  passed: boolean
  generation_number: number
  input_file: string
  source_file: string
  timestamp: string
  question: string
  options: { label: string; text: string; is_correct: boolean; distractor_rationale: string | null }[]
  explanation: string | null
  source_excerpt: string | null
  source_heading: string
  bloom_level: string
  difficulty: string
  question_type: string
  sub_topic: string | null
  tags: string[]
}

export interface PaperQueryResult {
  rows: PaperRow[]
  buckets: PaperBucket[]
  source: 'supabase' | 'sqlite'
}

// ─── Supabase path ────────────────────────────────────────────────────────────

async function sbClient() {
  const { createClient } = await import('@supabase/supabase-js')
  const ws = await import('ws')
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!, {
    realtime: { transport: ws.default as unknown as typeof WebSocket },
  })
}

async function sbFilterOptions(): Promise<PaperFilterOptions> {
  const sb = await sbClient()

  const [{ data: genData }, { data: topicData }, { data: stData }] = await Promise.all([
    sb.from('runs')
      .select('generation_number, generation_label')
      .order('generation_number', { ascending: false }),
    sb.from('runs')
      .select('source_lesson')
      .not('source_lesson', 'is', null)
      .order('source_lesson'),
    sb.from('mcqs')
      .select('mcq_json')
      .eq('passed', 1)
      .not('mcq_json', 'is', null)
      .limit(2000),
  ])

  const gensSeen = new Set<number>()
  const generations: { generation_number: number; label: string }[] = []
  for (const r of genData ?? []) {
    const n = r.generation_number as number
    if (!gensSeen.has(n)) {
      gensSeen.add(n)
      generations.push({
        generation_number: n,
        label: `Gen #${n}${r.generation_label ? ` · ${r.generation_label}` : ''}`,
      })
    }
  }

  const topicsSeen = new Set<string>()
  const topics: string[] = []
  for (const r of topicData ?? []) {
    const t = r.source_lesson as string
    if (t && !topicsSeen.has(t)) {
      topicsSeen.add(t)
      topics.push(t)
    }
  }

  const subTopicsSeen = new Set<string>()
  const subTopics: string[] = []
  for (const r of stData ?? []) {
    try {
      const m = typeof r.mcq_json === 'string' ? JSON.parse(r.mcq_json) : (r.mcq_json ?? {})
      const st = (m as Record<string, unknown>).sub_topic as string | undefined
      if (st && !subTopicsSeen.has(st)) {
        subTopicsSeen.add(st)
        subTopics.push(st)
      }
    } catch { /* ignore */ }
  }
  subTopics.sort()

  return { generations, topics, subTopics, source: 'supabase' }
}

async function sbQueryPaper(params: PaperQueryParams): Promise<PaperQueryResult> {
  const sb = await sbClient()

  // Resolve run_ids matching the generation/topic filters.
  let runIds: string[] | null = null
  const hasRunFilter = params.generationNumbers?.length || params.topics?.length
  if (hasRunFilter) {
    let q = sb.from('runs').select('run_id, generation_number')
    if (params.generationNumbers?.length)
      q = q.in('generation_number', params.generationNumbers)
    if (params.topics?.length)
      q = q.in('source_lesson', params.topics)
    const { data: runData } = await q
    runIds = (runData ?? []).map((r) => r.run_id as string)
    if (runIds.length === 0) {
      return {
        rows: [],
        buckets: [
          { difficulty: 'easy', requested: params.easyCount, got: 0 },
          { difficulty: 'medium', requested: params.mediumCount, got: 0 },
          { difficulty: 'hard/expert', requested: params.hardCount, got: 0 },
        ],
        source: 'supabase',
      }
    }
  }

  const POOL = 200

  function parsePaperRow(row: Record<string, unknown>): PaperRow {
    const m = (row.mcq_json ?? {}) as Record<string, unknown>
    return {
      id: typeof row.id === 'number' ? row.id : 0,
      run_id: String(row.run_id ?? ''),
      question_number: row.question_number as number | null,
      passed: true,
      generation_number: 0,
      input_file: '',
      source_file: '',
      timestamp: '',
      question: String(m.question ?? ''),
      options: Array.isArray(m.options) ? (m.options as PaperRow['options']) : [],
      explanation: (m.explanation as string) ?? null,
      source_excerpt: (m.source_excerpt as string) ?? null,
      source_heading: String(m.source_heading ?? ''),
      bloom_level: String(m.bloom_level ?? ''),
      difficulty: String(m.difficulty ?? row.difficulty ?? ''),
      question_type: String(m.question_type ?? ''),
      sub_topic: (m.sub_topic as string) ?? null,
      tags: Array.isArray(m.tags) ? (m.tags as string[]) : [],
    }
  }

  async function fetchBucket(
    diffs: string[],
    need: number,
    subTopic?: string,
  ): Promise<PaperRow[]> {
    if (need <= 0) return []
    let q = sb
      .from('mcqs')
      .select('id, run_id, question_number, mcq_json, difficulty')
      .eq('passed', 1)
      .in('difficulty', diffs)
      .limit(POOL)
    if (runIds) q = q.in('run_id', runIds)
    const { data } = await q
    if (!data?.length) return []
    let pool = [...data].sort(() => Math.random() - 0.5)
    // Filter by sub_topic client-side (no PostgREST json path filter available on all setups)
    if (subTopic) {
      pool = pool.filter((row) => {
        try {
          const m = typeof row.mcq_json === 'string'
            ? JSON.parse(row.mcq_json as string)
            : (row.mcq_json ?? {})
          return (m as Record<string, unknown>).sub_topic === subTopic
        } catch { return false }
      })
    }
    return pool.slice(0, need).map(parsePaperRow)
  }

  // Sub-topic allocation mode: fetch per-sub-topic-per-difficulty bucket.
  if (params.subTopicAllocs?.length) {
    const allRows: PaperRow[] = []
    const buckets: PaperBucket[] = []
    const easyCounts: Record<string, number> = {}
    const medCounts: Record<string, number> = {}
    const hardCounts: Record<string, number> = {}

    await Promise.all(
      params.subTopicAllocs.map(async (alloc) => {
        const [eR, mR, hR] = await Promise.all([
          fetchBucket(['easy'], alloc.easyCount, alloc.subTopic),
          fetchBucket(['medium'], alloc.mediumCount, alloc.subTopic),
          fetchBucket(['hard', 'expert'], alloc.hardCount, alloc.subTopic),
        ])
        allRows.push(...eR, ...mR, ...hR)
        easyCounts[alloc.subTopic] = eR.length
        medCounts[alloc.subTopic] = mR.length
        hardCounts[alloc.subTopic] = hR.length
      }),
    )

    const totalE = Object.values(easyCounts).reduce((a, b) => a + b, 0)
    const totalM = Object.values(medCounts).reduce((a, b) => a + b, 0)
    const totalH = Object.values(hardCounts).reduce((a, b) => a + b, 0)
    buckets.push(
      { difficulty: 'easy', requested: params.easyCount, got: totalE },
      { difficulty: 'medium', requested: params.mediumCount, got: totalM },
      { difficulty: 'hard/expert', requested: params.hardCount, got: totalH },
    )

    return {
      rows: allRows.sort(() => Math.random() - 0.5),
      buckets,
      source: 'supabase',
    }
  }

  const [easyRows, mediumRows, hardRows] = await Promise.all([
    fetchBucket(['easy'], params.easyCount),
    fetchBucket(['medium'], params.mediumCount),
    fetchBucket(['hard', 'expert'], params.hardCount),
  ])

  const rows = [...easyRows, ...mediumRows, ...hardRows].sort(() => Math.random() - 0.5)

  return {
    rows,
    buckets: [
      { difficulty: 'easy', requested: params.easyCount, got: easyRows.length },
      { difficulty: 'medium', requested: params.mediumCount, got: mediumRows.length },
      { difficulty: 'hard/expert', requested: params.hardCount, got: hardRows.length },
    ],
    source: 'supabase',
  }
}

// ─── SQLite fallback ──────────────────────────────────────────────────────────

function basename(p: string): string {
  return String(p).split(/[\\/]/).pop() || String(p)
}

async function sqliteFilterOptions(): Promise<PaperFilterOptions> {
  const [opts, subTopics] = await Promise.all([
    db.filterOptions(),
    db.distinctSubTopics(),
  ])
  return {
    generations: opts.runs.map((r) => ({
      generation_number: r.generation_number,
      label: r.label,
    })),
    topics: [
      ...new Set(opts.sourceFiles.map((f) => f.label.replace(/\.[^.]+$/, ''))),
    ],
    subTopics,
    source: 'sqlite',
  }
}

async function sqliteQueryPaper(params: PaperQueryParams): Promise<PaperQueryResult> {
  const opts = await db.filterOptions()

  const runIds =
    params.generationNumbers?.length
      ? opts.runs
          .filter((r) => params.generationNumbers!.includes(r.generation_number))
          .map((r) => r.run_id)
      : undefined

  const sourceFiles =
    params.topics?.length
      ? opts.sourceFiles
          .filter((f) => params.topics!.includes(f.label.replace(/\.[^.]+$/, '')))
          .map((f) => f.path)
      : undefined

  function toPaperRow(r: Record<string, unknown>, fallbackId: number): PaperRow {
    return {
      id: typeof r.id === 'number' ? r.id : fallbackId,
      run_id: String(r.run_id ?? ''),
      question_number: (r.question_number as number | null) ?? null,
      passed: Boolean(r.passed),
      generation_number: Number(r.generation_number) || 0,
      input_file: String(r.input_file ?? ''),
      source_file: basename(String(r.input_file ?? '')),
      timestamp: String(r.timestamp ?? ''),
      question: String(r.question ?? ''),
      options: Array.isArray(r.options) ? (r.options as PaperRow['options']) : [],
      explanation: (r.explanation as string) ?? null,
      source_excerpt: (r.source_excerpt as string) ?? null,
      source_heading: String(r.source_heading ?? ''),
      bloom_level: String(r.bloom_level ?? ''),
      difficulty: String(r.difficulty ?? ''),
      question_type: String(r.question_type ?? ''),
      sub_topic: (r.sub_topic as string) ?? null,
      tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
    }
  }

  async function fetchBucket(difficulties: string[], need: number, subTopics?: string[]) {
    if (need <= 0) return { rows: [] as Record<string, unknown>[], got: 0 }
    const r = await db.queryMcqs({
      passedOnly: true,
      difficulties,
      runIds,
      sourceFiles,
      subTopics,
      fetchMode: 'random',
      limit: need,
    })
    return { rows: r.rows, got: r.rows.length }
  }

  // Sub-topic allocation mode: fetch per-sub-topic-per-difficulty.
  if (params.subTopicAllocs?.length) {
    let idx = 0
    const allRows: PaperRow[] = []
    let totalEReq = 0, totalMReq = 0, totalHReq = 0
    let totalEGot = 0, totalMGot = 0, totalHGot = 0

    for (const alloc of params.subTopicAllocs) {
      totalEReq += alloc.easyCount
      totalMReq += alloc.mediumCount
      totalHReq += alloc.hardCount

      const [easy, medium, hard] = await Promise.all([
        fetchBucket(['easy'], alloc.easyCount, [alloc.subTopic]),
        fetchBucket(['medium'], alloc.mediumCount, [alloc.subTopic]),
        fetchBucket(['hard', 'expert'], alloc.hardCount, [alloc.subTopic]),
      ])
      totalEGot += easy.got
      totalMGot += medium.got
      totalHGot += hard.got
      allRows.push(
        ...easy.rows.map((r) => toPaperRow(r, idx++)),
        ...medium.rows.map((r) => toPaperRow(r, idx++)),
        ...hard.rows.map((r) => toPaperRow(r, idx++)),
      )
    }

    return {
      rows: allRows.sort(() => Math.random() - 0.5),
      buckets: [
        { difficulty: 'easy', requested: totalEReq, got: totalEGot },
        { difficulty: 'medium', requested: totalMReq, got: totalMGot },
        { difficulty: 'hard/expert', requested: totalHReq, got: totalHGot },
      ],
      source: 'sqlite',
    }
  }

  const [easy, medium, hard] = await Promise.all([
    fetchBucket(['easy'], params.easyCount),
    fetchBucket(['medium'], params.mediumCount),
    fetchBucket(['hard', 'expert'], params.hardCount),
  ])

  let idx = 0
  const allRows = [
    ...easy.rows.map((r) => toPaperRow(r, idx++)),
    ...medium.rows.map((r) => toPaperRow(r, idx++)),
    ...hard.rows.map((r) => toPaperRow(r, idx++)),
  ].sort(() => Math.random() - 0.5)

  return {
    rows: allRows,
    buckets: [
      { difficulty: 'easy', requested: params.easyCount, got: easy.got },
      { difficulty: 'medium', requested: params.mediumCount, got: medium.got },
      { difficulty: 'hard/expert', requested: params.hardCount, got: hard.got },
    ],
    source: 'sqlite',
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getPaperFilterOptions(): Promise<PaperFilterOptions> {
  if (supabaseAvailable()) {
    try {
      return await sbFilterOptions()
    } catch (e) {
      console.warn('[paper] Supabase filter options failed, falling back to SQLite:', e)
    }
  }
  return sqliteFilterOptions()
}

export async function queryPaperMcqs(params: PaperQueryParams): Promise<PaperQueryResult> {
  if (supabaseAvailable()) {
    try {
      return await sbQueryPaper(params)
    } catch (e) {
      console.warn('[paper] Supabase query failed, falling back to SQLite:', e)
    }
  }
  return sqliteQueryPaper(params)
}
