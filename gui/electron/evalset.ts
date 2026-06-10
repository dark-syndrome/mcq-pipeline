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
