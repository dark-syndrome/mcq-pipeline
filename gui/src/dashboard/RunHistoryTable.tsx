import { useEffect, useState } from 'react'
import type { McqRow, RunHistoryRow } from '../types'

type SortCol = keyof Pick<
  RunHistoryRow,
  'generation_number' | 'timestamp' | 'source_file' | 'generated_count' | 'passed_count' | 'cost_usd'
>

export default function RunHistoryTable({ rows }: { rows: RunHistoryRow[] }) {
  const [sortCol, setSortCol] = useState<SortCol>('generation_number')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [filter, setFilter] = useState('')
  const [inspecting, setInspecting] = useState<RunHistoryRow | null>(null)

  function handleSort(col: SortCol) {
    if (sortCol === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortCol(col)
      setSortDir('desc')
    }
  }

  const filtered = rows.filter(
    (r) =>
      !filter ||
      r.source_file.toLowerCase().includes(filter.toLowerCase()) ||
      r.run_id.toLowerCase().includes(filter.toLowerCase()),
  )

  const sorted = [...filtered].sort((a, b) => {
    const av = a[sortCol],
      bv = b[sortCol]
    if (av < bv) return sortDir === 'asc' ? -1 : 1
    if (av > bv) return sortDir === 'asc' ? 1 : -1
    return 0
  })

  async function handleExport(row: RunHistoryRow) {
    if (!window.api) return
    const result = await window.api.db.queryMcqs({
      runIds: [row.run_id],
      passedOnly: true,
      fetchMode: 'sequential',
    })
    const name = `gen_${String(row.generation_number).padStart(3, '0')}_${row.source_file.replace(/\.[^.]+$/, '')}_accepted`
    await window.api.export.run(result.rows, { format: 'json' }, name)
  }

  const COLS: { key: SortCol; label: string; render: (r: RunHistoryRow) => string | number }[] = [
    { key: 'generation_number', label: 'Gen#', render: (r) => `#${r.generation_number}` },
    {
      key: 'timestamp',
      label: 'Timestamp',
      render: (r) => r.timestamp.replace('T', ' ').slice(0, 16),
    },
    { key: 'source_file', label: 'Source File', render: (r) => r.source_file },
    { key: 'generated_count', label: 'Generated', render: (r) => r.generated_count },
    { key: 'passed_count', label: 'Accepted', render: (r) => r.passed_count },
    {
      key: 'cost_usd',
      label: 'Cost',
      render: (r) => `$${r.cost_usd.toFixed(4)}`,
    },
  ]

  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Run History</h3>
          <p className="mt-0.5 text-xs text-muted">{rows.length} total runs</p>
        </div>
        <input
          className="h-8 w-60 rounded border border-border bg-bg px-3 text-xs text-text placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-primary"
          placeholder="Filter by source file or run ID…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {sorted.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-sm text-muted">
          No runs found.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                {COLS.map((c) => (
                  <th
                    key={c.key}
                    className="cursor-pointer select-none px-3 py-2 text-left text-xs font-medium text-muted hover:text-text"
                    onClick={() => handleSort(c.key)}
                  >
                    {c.label}
                    <span className="ml-1">
                      {sortCol === c.key ? (
                        <span className="text-primary">{sortDir === 'asc' ? '↑' : '↓'}</span>
                      ) : (
                        <span className="text-muted/40">↕</span>
                      )}
                    </span>
                  </th>
                ))}
                <th className="px-3 py-2 text-left text-xs font-medium text-muted">
                  Rejected
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.run_id} className="border-b border-border/50 hover:bg-white/5">
                  {COLS.map((c) => (
                    <td key={c.key} className="px-3 py-2 text-xs">
                      {c.render(r)}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-xs text-danger">{r.rejected_count}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-3">
                      <button
                        className="text-xs text-primary hover:underline"
                        onClick={() => setInspecting(r)}
                      >
                        Inspect
                      </button>
                      <button
                        className="text-xs text-muted hover:text-text hover:underline"
                        onClick={() => handleExport(r)}
                      >
                        ↓ Export
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {inspecting && (
        <InspectDrawer row={inspecting} onClose={() => setInspecting(null)} />
      )}
    </div>
  )
}

// --- Inspect drawer ---

function InspectDrawer({ row, onClose }: { row: RunHistoryRow; onClose: () => void }) {
  const [mcqs, setMcqs] = useState<McqRow[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!window.api) return
    window.api.db
      .queryMcqs({ runIds: [row.run_id], passedOnly: true, fetchMode: 'sequential', limit: 50 })
      .then((r) => setMcqs(r.rows))
      .catch(() => setMcqs([]))
      .finally(() => setLoading(false))
  }, [row.run_id])

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-end"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="h-full w-[480px] overflow-auto bg-surface shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-surface px-6 py-4">
          <div>
            <h2 className="text-sm font-semibold">
              Run #{row.generation_number} — {row.source_file}
            </h2>
            <p className="mt-0.5 font-mono text-[10px] text-muted">{row.run_id}</p>
          </div>
          <button
            className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-white/10 hover:text-text"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="space-y-4 px-6 py-4">
          {/* Stats grid */}
          <div className="grid grid-cols-3 gap-2">
            {[
              ['Timestamp', row.timestamp.replace('T', ' ').slice(0, 16)],
              ['Generated', row.generated_count],
              ['Accepted', row.passed_count],
              ['Rejected', row.rejected_count],
              ['Cost', `$${row.cost_usd.toFixed(5)}`],
              ['Source File', row.source_file],
            ].map(([label, value]) => (
              <div key={label} className="rounded border border-border bg-bg px-3 py-2">
                <div className="text-[10px] text-muted">{label}</div>
                <div className="mt-0.5 truncate text-xs font-medium" title={String(value)}>
                  {value}
                </div>
              </div>
            ))}
          </div>

          {/* Accepted questions */}
          <div>
            <h3 className="mb-2 text-xs font-semibold text-muted">
              ACCEPTED QUESTIONS
              {mcqs
                ? ` (${mcqs.length}${mcqs.length === 50 ? '+' : ''})`
                : ''}
            </h3>
            {loading && (
              <div className="text-xs text-muted">Loading questions…</div>
            )}
            {mcqs?.length === 0 && !loading && (
              <div className="text-xs text-muted">No accepted questions found.</div>
            )}
            {mcqs?.map((q, i) => (
              <div key={q.id} className="mb-3 rounded border border-border bg-bg p-3">
                <div className="mb-1.5 flex flex-wrap gap-1.5">
                  <span className="text-[10px] text-muted">#{i + 1}</span>
                  <span className="rounded bg-primary/20 px-1.5 py-0.5 text-[10px] text-primary">
                    {q.bloom_level}
                  </span>
                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted">
                    {q.difficulty}
                  </span>
                  {q.question_type !== 'single_correct' && (
                    <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted">
                      {q.question_type}
                    </span>
                  )}
                </div>
                <p className="text-xs leading-relaxed">{q.question}</p>
                <ul className="mt-2 space-y-0.5">
                  {(q.options as { label?: string; text?: string; is_correct?: boolean }[]).map(
                    (o, j) => (
                      <li
                        key={j}
                        className={`text-[11px] ${o.is_correct ? 'font-medium text-success' : 'text-muted'}`}
                      >
                        {o.label ?? String.fromCharCode(65 + j)}. {o.text}
                      </li>
                    ),
                  )}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
