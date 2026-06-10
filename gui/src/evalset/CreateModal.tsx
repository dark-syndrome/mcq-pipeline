import { useEffect, useState } from 'react'
import type { BloomLevel, Difficulty, EvalQuestion, EvalSet, McqFilter, McqRow } from '../types'

interface Props {
  onCreated: (set: EvalSet) => void
  onClose: () => void
}

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard', 'expert']
const BLOOMS: BloomLevel[] = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create']

export default function CreateModal({ onCreated, onClose }: Props) {
  const [name, setName] = useState('')
  const [difficulties, setDifficulties] = useState<Difficulty[]>([])
  const [blooms, setBlooms] = useState<BloomLevel[]>([])
  const [sourceFilePath, setSourceFilePath] = useState('')
  const [sourceFiles, setSourceFiles] = useState<{ path: string; label: string }[]>([])
  const [count, setCount] = useState(20)
  const [fetchMode, setFetchMode] = useState<'random' | 'sequential'>('random')
  const [preview, setPreview] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.api?.db.filterOptions().then((opts) => setSourceFiles(opts.sourceFiles))
  }, [])

  // Live preview count
  useEffect(() => {
    if (!window.api) return
    const filter: McqFilter = {
      passedOnly: true,
      difficulties: difficulties.length ? difficulties : undefined,
      blooms: blooms.length ? blooms : undefined,
      sourceFiles: sourceFilePath ? [sourceFilePath] : undefined,
    }
    window.api.db
      .queryMcqs(filter)
      .then((r) => setPreview(r.totalMatched))
      .catch(() => setPreview(null))
  }, [difficulties, blooms, sourceFilePath])

  async function handleCreate() {
    const trimmed = name.trim()
    if (!trimmed || !window.api) return
    setCreating(true)
    setError(null)
    try {
      const filter: McqFilter = {
        passedOnly: true,
        difficulties: difficulties.length ? difficulties : undefined,
        blooms: blooms.length ? blooms : undefined,
        sourceFiles: sourceFilePath ? [sourceFilePath] : undefined,
        limit: count,
        fetchMode,
      }
      const result = await window.api.db.queryMcqs(filter)
      const set: EvalSet = {
        name: trimmed,
        created_at: new Date().toISOString(),
        questions: result.rows.map((q: McqRow) => ({
          ...q,
          annotation: { rating: 0, confirmed: null, notes: '' },
        })) as EvalQuestion[],
      }
      await window.api.evalset.save(set)
      onCreated(set)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }

  function toggleDiff(d: Difficulty) {
    setDifficulties((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d],
    )
  }
  function toggleBloom(b: BloomLevel) {
    setBlooms((prev) => (prev.includes(b) ? prev.filter((x) => x !== b) : [...prev, b]))
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-[500px] rounded-xl border border-border bg-surface p-6 shadow-2xl">
        <h2 className="mb-5 text-base font-semibold">Create Eval Set</h2>

        {/* Name */}
        <label className="mb-4 block">
          <span className="mb-1 block text-xs text-muted">Name</span>
          <input
            autoFocus
            className="w-full rounded border border-border bg-bg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="e.g. mqtt-baseline-v1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
        </label>

        {/* Difficulty */}
        <div className="mb-4">
          <span className="mb-1.5 block text-xs text-muted">
            Difficulty <span className="text-muted/60">(all if none selected)</span>
          </span>
          <div className="flex gap-2">
            {DIFFICULTIES.map((d) => (
              <button
                key={d}
                onClick={() => toggleDiff(d)}
                className={`rounded px-3 py-1 text-xs transition-colors ${
                  difficulties.includes(d)
                    ? 'bg-primary text-white'
                    : 'border border-border text-muted hover:text-text'
                }`}
              >
                {d}
              </button>
            ))}
          </div>
        </div>

        {/* Bloom */}
        <div className="mb-4">
          <span className="mb-1.5 block text-xs text-muted">
            Bloom Level <span className="text-muted/60">(all if none selected)</span>
          </span>
          <div className="flex flex-wrap gap-2">
            {BLOOMS.map((b) => (
              <button
                key={b}
                onClick={() => toggleBloom(b)}
                className={`rounded px-2 py-1 text-xs transition-colors ${
                  blooms.includes(b)
                    ? 'bg-primary text-white'
                    : 'border border-border text-muted hover:text-text'
                }`}
              >
                {b}
              </button>
            ))}
          </div>
        </div>

        {/* Source file */}
        <div className="mb-4">
          <span className="mb-1 block text-xs text-muted">
            Source File <span className="text-muted/60">(all if none selected)</span>
          </span>
          <select
            className="w-full rounded border border-border bg-bg px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-primary"
            value={sourceFilePath}
            onChange={(e) => setSourceFilePath(e.target.value)}
          >
            <option value="">All source files</option>
            {sourceFiles.map((f) => (
              <option key={f.path} value={f.path}>
                {f.label}
              </option>
            ))}
          </select>
        </div>

        {/* Count + fetch mode */}
        <div className="mb-4 flex gap-4">
          <label className="flex-1">
            <span className="mb-1 block text-xs text-muted">Count</span>
            <input
              type="number"
              min={1}
              max={500}
              className="w-full rounded border border-border bg-bg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              value={count}
              onChange={(e) =>
                setCount(Math.max(1, Math.min(500, Number(e.target.value) || 20)))
              }
            />
          </label>
          <div>
            <span className="mb-1 block text-xs text-muted">Fetch Mode</span>
            <div className="flex gap-2">
              {(['random', 'sequential'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setFetchMode(m)}
                  className={`rounded px-3 py-2 text-xs transition-colors ${
                    fetchMode === m
                      ? 'bg-primary text-white'
                      : 'border border-border text-muted hover:text-text'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Match preview */}
        {preview !== null && (
          <p className="mb-4 text-xs text-muted">
            {preview} questions match · will fetch {Math.min(count, preview)}
          </p>
        )}

        {error && <p className="mb-3 text-xs text-danger">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded border border-border px-4 py-2 text-sm text-muted hover:text-text"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!name.trim() || creating}
            className="rounded bg-primary px-4 py-2 text-sm text-white disabled:opacity-50 hover:bg-primary/90"
          >
            {creating ? 'Creating…' : 'Create Eval Set'}
          </button>
        </div>
      </div>
    </div>
  )
}
