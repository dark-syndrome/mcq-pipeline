import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from './paths'

// Reads the pipeline's per-run output JSON files (output/<label>_run_config.json
// and <label>_source_quality.json). These hold data the SQLite `runs` table does
// NOT persist faithfully: real per-stage token splits (the DB stores only a
// synthetic 50/50 input/output split of the total) and the Layer-1 linter checks.
//
// Coverage caveat (surfaced in the UI): only runs whose output files are still on
// disk contribute. Older runs whose files were cleaned up are absent — the views
// note this rather than implying full coverage.

const OUTPUT_DIR = path.join(REPO_ROOT, 'output')

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}

function listOutputs(suffix: string): string[] {
  if (!fs.existsSync(OUTPUT_DIR)) return []
  return fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => f.endsWith(suffix))
    .map((f) => path.join(OUTPUT_DIR, f))
}

export interface StageTokens {
  run_label: string
  generation_number: number | null
  analyzer_in: number
  analyzer_out: number
  generator_in: number
  generator_out: number
  critic_in: number
  critic_out: number
  reframer_in: number
  reframer_out: number
}

// Token Usage by Stage (§4.2) — real per-stage input/output from run_config.json.
export function tokenUsageByStage(limit = 15): {
  rows: StageTokens[]
  coverage: { withFiles: number }
} {
  const rows: StageTokens[] = []
  for (const file of listOutputs('_run_config.json')) {
    const cfg = readJson(file)
    if (!cfg) continue
    const tokens = cfg.tokens as Record<string, { input?: number; output?: number }> | undefined
    if (!tokens) continue
    const g = (k: string, side: 'input' | 'output') => Number(tokens[k]?.[side] ?? 0)
    rows.push({
      run_label: String(cfg.run_label ?? path.basename(file)),
      generation_number: cfg.generation_number != null ? Number(cfg.generation_number) : null,
      analyzer_in: g('analyzer', 'input'),
      analyzer_out: g('analyzer', 'output'),
      generator_in: g('generator', 'input'),
      generator_out: g('generator', 'output'),
      critic_in: g('critic', 'input'),
      critic_out: g('critic', 'output'),
      reframer_in: g('reframer', 'input'),
      reframer_out: g('reframer', 'output'),
    })
  }
  rows.sort((a, b) => (a.generation_number ?? 0) - (b.generation_number ?? 0))
  const n = Math.max(1, Math.floor(Number(limit) || 15))
  return { rows: rows.slice(-n), coverage: { withFiles: rows.length } }
}

// Analyzer Cache Hit Rate (§4.2 stat card). run_config records whether the
// analyzer call was cached via models.analyzer.note ("cached — no API call made")
// or a zero analyzer-token count. Returns hits/total over runs with output files.
export function analyzerCacheHitRate(): { hits: number; total: number; rate: number | null } {
  let hits = 0
  let total = 0
  for (const file of listOutputs('_run_config.json')) {
    const cfg = readJson(file)
    if (!cfg) continue
    total += 1
    const models = cfg.models as Record<string, { note?: string }> | undefined
    const note = String(models?.analyzer?.note ?? '').toLowerCase()
    const tokens = cfg.tokens as Record<string, { input?: number; output?: number }> | undefined
    const analyzerTokens = Number(tokens?.analyzer?.input ?? 0) + Number(tokens?.analyzer?.output ?? 0)
    if (note.includes('cache') || analyzerTokens === 0) hits += 1
  }
  return { hits, total, rate: total ? hits / total : null }
}

// Source Linter Stats (§4.2 table) — per source-quality report: overall status +
// per-check PASS/WARN/FAIL. Aggregated across all *_source_quality.json files.
export function sourceLinterStats(): {
  perCheck: { name: string; PASS: number; WARN: number; FAIL: number }[]
  reports: number
} {
  const tally = new Map<string, { PASS: number; WARN: number; FAIL: number }>()
  let reports = 0
  for (const file of listOutputs('_source_quality.json')) {
    const rep = readJson(file)
    if (!rep) continue
    reports += 1
    const checks = Array.isArray(rep.checks) ? (rep.checks as Record<string, unknown>[]) : []
    for (const c of checks) {
      const name = String(c.name ?? 'unknown')
      const status = String(c.status ?? '') as 'PASS' | 'WARN' | 'FAIL'
      const cur = tally.get(name) ?? { PASS: 0, WARN: 0, FAIL: 0 }
      if (status === 'PASS' || status === 'WARN' || status === 'FAIL') cur[status] += 1
      tally.set(name, cur)
    }
  }
  const perCheck = [...tally.entries()].map(([name, v]) => ({ name, ...v }))
  return { perCheck, reports }
}
