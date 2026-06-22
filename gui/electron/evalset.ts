import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from './paths'

// Eval sets are stored as JSON files under <repo>/eval-sets/.
// The GUI reads AND writes these (annotation data is not pipeline-owned).

const EVAL_DIR = path.join(REPO_ROOT, 'eval-sets')

function ensureDir(): void {
  if (!fs.existsSync(EVAL_DIR)) fs.mkdirSync(EVAL_DIR, { recursive: true })
}

function safeName(name: string): string {
  // Strip filesystem-unsafe chars; keep alphanumerics, spaces, dashes, underscores, dots.
  return name.replace(/[/\\?%*:|"<>]/g, '_').trim() || 'eval-set'
}

function setPath(name: string): string {
  return path.join(EVAL_DIR, `${safeName(name)}.json`)
}

// ---- Types (mirrored in src/types.ts for the renderer) ----

export interface EvalAnnotation {
  rating: number // 1–5; 0 = unrated
  confirmed: boolean | null // true=correct, false=flagged wrong, null=unset
  notes: string
}

export interface EvalQuestion {
  id: number
  run_id: string
  question_number: number | null
  generation_number: number
  source_file: string
  question: string
  options: unknown[]
  explanation: string | null
  source_excerpt: string | null
  source_heading: string
  bloom_level: string
  difficulty: string
  question_type: string
  sub_topic?: string | null
  tags?: string[]
  passed: boolean
  annotation: EvalAnnotation
}

export interface EvalSet {
  name: string
  created_at: string
  questions: EvalQuestion[]
}

export interface EvalSetMeta {
  name: string
  created_at: string
  count: number
  annotated: number
}

function countAnnotated(questions: EvalQuestion[]): number {
  return questions.filter(
    (q) =>
      q.annotation.rating > 0 ||
      q.annotation.confirmed !== null ||
      q.annotation.notes.trim() !== '',
  ).length
}

export function listEvalSets(): EvalSetMeta[] {
  ensureDir()
  const metas: EvalSetMeta[] = []
  try {
    for (const file of fs.readdirSync(EVAL_DIR).filter((f) => f.endsWith('.json'))) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, file), 'utf-8')) as EvalSet
        metas.push({
          name: raw.name,
          created_at: raw.created_at ?? '',
          count: raw.questions?.length ?? 0,
          annotated: countAnnotated(raw.questions ?? []),
        })
      } catch {
        // skip corrupt files
      }
    }
  } catch {
    // eval-sets dir unreadable
  }
  return metas.sort((a, b) => b.created_at.localeCompare(a.created_at))
}

export function loadEvalSet(name: string): EvalSet | null {
  const p = setPath(name)
  if (!fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as EvalSet
  } catch {
    return null
  }
}

export function saveEvalSet(set: EvalSet): void {
  ensureDir()
  fs.writeFileSync(setPath(set.name), JSON.stringify(set, null, 2), 'utf-8')
}

export function deleteEvalSet(name: string): void {
  const p = setPath(name)
  if (fs.existsSync(p)) fs.unlinkSync(p)
}

// ---- Promote top-rated questions into the generator's few-shot pool ----

const FEW_SHOT_PATH = path.join(
  REPO_ROOT,
  'mcq_agent',
  'prompts',
  'few_shot_examples.json',
)

// The generator only selects few-shot examples by their (bloom_level,
// stem_pattern) pair, so every promoted entry must carry a valid stem_pattern.
const VALID_STEMS = new Set([
  'definition',
  'scenario',
  'debugging',
  'comparison',
  'procedure',
])
// Fallback when the source has no stem_pattern (e.g. an imported eval set whose
// ids aren't in the local DB). Maps a Bloom level to a sensible default stem.
const STEM_BY_BLOOM: Record<string, string> = {
  remember: 'definition',
  understand: 'definition',
  apply: 'scenario',
  analyze: 'debugging',
  evaluate: 'comparison',
  create: 'scenario',
}

function normQuestion(s: unknown): string {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function buildFewShotEntry(
  q: EvalQuestion,
  src: Record<string, unknown> | undefined,
): Record<string, unknown> {
  // Prefer the authoritative DB mcq_json when available, else the eval fields.
  const qrec = q as unknown as Record<string, unknown>
  const pick = <T,>(key: string, fallback: T): T =>
    src && src[key] != null ? (src[key] as T) : ((qrec[key] as T) ?? fallback)

  const bloom = String(pick('bloom_level', q.bloom_level || '')).toLowerCase()
  const rawStem = src?.stem_pattern
  const stem =
    typeof rawStem === 'string' && VALID_STEMS.has(rawStem)
      ? rawStem
      : STEM_BY_BLOOM[bloom] ?? 'scenario'

  const entry: Record<string, unknown> = {
    _comment: `Promoted from eval set — rating ${q.annotation.rating}/5, confirmed correct`,
    stem_pattern: stem,
    question: pick('question', q.question),
    options: pick('options', q.options),
    explanation: pick('explanation', q.explanation),
    source_excerpt: pick('source_excerpt', q.source_excerpt),
    source_heading: pick('source_heading', q.source_heading),
    bloom_level: bloom,
    difficulty: pick('difficulty', q.difficulty),
    question_type: pick('question_type', q.question_type),
  }
  const ordering = src?.ordering_statements ?? qrec.ordering_statements
  if (Array.isArray(ordering) && ordering.length) entry.ordering_statements = ordering
  return entry
}

// Append the eligible (confirmed-correct, rating >= minRating) questions to
// few_shot_examples.json, skipping duplicates. dbJsonById supplies the
// authoritative source fields (stem_pattern). The existing file is backed up
// first; the write is append-only so curated examples are preserved.
export function promoteToFewShot(
  questions: EvalQuestion[],
  dbJsonById: Record<number, Record<string, unknown>>,
  minRating: number,
): { added: number; skipped: number; eligible: number; path: string } {
  const eligible = questions.filter(
    (q) => q.annotation.confirmed === true && q.annotation.rating >= minRating,
  )

  let existing: Record<string, unknown>[] = []
  if (fs.existsSync(FEW_SHOT_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(FEW_SHOT_PATH, 'utf-8'))
      if (Array.isArray(parsed)) existing = parsed
    } catch {
      existing = []
    }
  }

  const seen = new Set(existing.map((e) => normQuestion(e.question)))
  let added = 0
  let skipped = 0
  for (const q of eligible) {
    const key = normQuestion(q.question)
    if (seen.has(key)) {
      skipped++
      continue
    }
    seen.add(key)
    existing.push(buildFewShotEntry(q, dbJsonById[q.id]))
    added++
  }

  if (added > 0) {
    if (fs.existsSync(FEW_SHOT_PATH)) {
      fs.copyFileSync(FEW_SHOT_PATH, `${FEW_SHOT_PATH}.bak`)
    }
    fs.writeFileSync(FEW_SHOT_PATH, JSON.stringify(existing, null, 2), 'utf-8')
  }

  return { added, skipped, eligible: eligible.length, path: FEW_SHOT_PATH }
}
