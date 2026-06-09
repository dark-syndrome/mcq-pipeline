import { useState } from 'react'
import type { ExportFormat, ExportOptions, McqRow } from '../types'

// §5.6 — right panel. Exports the selected MCQ set (query rows minus excluded)
// to JSON / DOCX / PDF via the main process.

function Check({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-text">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-primary"
      />
      {label}
    </label>
  )
}

function defaultName(rows: McqRow[], topic: string): string {
  const date = new Date().toISOString().slice(0, 10)
  const diffs = new Set(rows.map((r) => r.difficulty))
  const diff = diffs.size === 1 ? [...diffs][0] : 'mixed'
  const t = (topic || rows[0]?.source_file || 'mcq').replace(/\.[^.]+$/, '')
  return `${t}_${diff}_${rows.length}_${date}`.replace(/[^\w.-]+/g, '_')
}

export default function ExportPanel({ rows }: { rows: McqRow[] }) {
  const [format, setFormat] = useState<ExportFormat>('json')
  const [topic, setTopic] = useState('')
  const [opts, setOpts] = useState({
    includeExplanation: true,
    includeRationale: true,
    answerKey: true,
    explanations: true,
    metadata: true,
    coverPage: false,
  })
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [savedPath, setSavedPath] = useState<string | null>(null)

  const set = (patch: Partial<typeof opts>) =>
    setOpts((o) => ({ ...o, ...patch }))

  const onDownload = async () => {
    if (!rows.length || busy) return
    setBusy(true)
    setToast(null)
    const options: ExportOptions = { format, topic, ...opts }
    try {
      const saved = await window.api.export.run(
        rows,
        options,
        defaultName(rows, topic),
      )
      if (saved) {
        setSavedPath(saved)
        setToast(`Exported ${rows.length} question${rows.length === 1 ? '' : 's'}`)
      }
    } catch (e) {
      setToast(`Export failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="w-[240px] shrink-0 overflow-y-auto border-l border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">Export</h3>

      <label className="mt-3 block text-xs font-medium text-muted">Format</label>
      <div className="mt-1 space-y-1">
        {(['json', 'docx', 'pdf'] as const).map((f) => (
          <label key={f} className="flex items-center gap-2 text-xs">
            <input
              type="radio"
              name="exportFormat"
              checked={format === f}
              onChange={() => setFormat(f)}
              className="accent-primary"
            />
            <span className="uppercase">{f}</span>
          </label>
        ))}
      </div>

      <div className="mt-3 space-y-1.5 border-t border-border pt-3">
        {format === 'json' ? (
          <>
            <Check
              label="Include explanations"
              checked={opts.includeExplanation}
              onChange={(v) => set({ includeExplanation: v })}
            />
            <Check
              label="Include distractor rationale"
              checked={opts.includeRationale}
              onChange={(v) => set({ includeRationale: v })}
            />
          </>
        ) : (
          <>
            <Check
              label="Answer key (separate section)"
              checked={opts.answerKey}
              onChange={(v) => set({ answerKey: v })}
            />
            <Check
              label="Explanations"
              checked={opts.explanations}
              onChange={(v) => set({ explanations: v })}
            />
            <Check
              label="Bloom/difficulty metadata"
              checked={opts.metadata}
              onChange={(v) => set({ metadata: v })}
            />
            <Check
              label="Cover page"
              checked={opts.coverPage}
              onChange={(v) => set({ coverPage: v })}
            />
          </>
        )}
      </div>

      <label className="mt-3 block text-xs font-medium text-muted">
        Topic / filename
      </label>
      <input
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
        placeholder="{topic}_{difficulty}_{count}_{date}"
        className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-1.5 text-xs outline-none focus:border-primary"
      />

      <button
        onClick={onDownload}
        disabled={!rows.length || busy}
        className={`mt-4 w-full rounded-lg px-3 py-2 text-sm font-semibold ${
          rows.length && !busy
            ? 'bg-primary text-white hover:bg-primary/90'
            : 'cursor-not-allowed bg-border text-muted'
        }`}
      >
        {busy ? 'Exporting…' : `Download (${rows.length})`}
      </button>

      {toast && <p className="mt-2 text-xs text-success">{toast}</p>}
      {savedPath && (
        <button
          onClick={() => window.api.file.showInFolder(savedPath)}
          className="mt-1 text-[11px] text-primary hover:underline"
        >
          Show in folder
        </button>
      )}
    </div>
  )
}
