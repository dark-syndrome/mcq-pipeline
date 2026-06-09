import { useState } from 'react'
import type { McqRow, QueryResult } from '../types'
import { BloomBadge, DifficultyBadge, TypeBadge } from './Badge'

interface Props {
  result: QueryResult | null
  loading: boolean
  excluded: Set<number>
  onToggleExclude: (id: number) => void
}

function deficitNote(result: QueryResult): string | null {
  if (!result.buckets) return null
  const short = result.buckets.filter((b) => b.got < b.requested)
  if (!short.length) return null
  return short
    .map((b) => `${b.requested - b.got} unfilled: ${b.difficulty} bucket`)
    .join(', ')
}

function McqCard({
  row,
  excluded,
  onToggle,
}: {
  row: McqRow
  excluded: boolean
  onToggle: () => void
}) {
  return (
    <div
      className={`rounded-lg border bg-surface p-4 ${
        excluded ? 'border-border opacity-50' : 'border-border'
      }`}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={!excluded}
          onChange={onToggle}
          className="mt-1 accent-primary"
          title="Include in export set"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{row.question}</p>
          <ul className="mt-2 space-y-1">
            {row.options.map((o) => (
              <li
                key={o.label}
                className={`flex gap-2 rounded px-2 py-1 text-xs ${
                  o.is_correct
                    ? 'bg-success/10 text-success'
                    : 'text-muted'
                }`}
              >
                <span className="font-semibold">{o.label}.</span>
                <span>{o.text}</span>
                {o.is_correct && <span className="ml-auto">✓</span>}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <DifficultyBadge value={row.difficulty} />
            <BloomBadge value={row.bloom_level} />
            <TypeBadge value={row.question_type} />
            {row.source_heading && (
              <span className="text-[11px] text-muted">
                · {row.source_heading}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function McqTable({
  rows,
  excluded,
  onToggle,
}: {
  rows: McqRow[]
  excluded: Set<number>
  onToggle: (id: number) => void
}) {
  return (
    <table className="w-full text-left text-xs">
      <thead className="text-muted">
        <tr className="border-b border-border">
          <th className="py-2 pr-2"> </th>
          <th className="py-2 pr-2">#</th>
          <th className="py-2 pr-2">Stem</th>
          <th className="py-2 pr-2">Difficulty</th>
          <th className="py-2 pr-2">Bloom</th>
          <th className="py-2 pr-2">Type</th>
          <th className="py-2 pr-2">Source Heading</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.id}
            className={`border-b border-border/50 ${
              excluded.has(r.id) ? 'opacity-50' : ''
            }`}
          >
            <td className="py-2 pr-2">
              <input
                type="checkbox"
                checked={!excluded.has(r.id)}
                onChange={() => onToggle(r.id)}
                className="accent-primary"
              />
            </td>
            <td className="py-2 pr-2 tabular-nums text-muted">
              {r.question_number ?? '—'}
            </td>
            <td className="max-w-[280px] truncate py-2 pr-2" title={r.question}>
              {r.question}
            </td>
            <td className="py-2 pr-2">
              <DifficultyBadge value={r.difficulty} />
            </td>
            <td className="py-2 pr-2 capitalize text-muted">{r.bloom_level}</td>
            <td className="py-2 pr-2 text-muted">{r.question_type}</td>
            <td
              className="max-w-[160px] truncate py-2 pr-2 text-muted"
              title={r.source_heading}
            >
              {r.source_heading || '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// §5.5 — center results preview with Card / Table view modes.
export default function ResultsPreview({
  result,
  loading,
  excluded,
  onToggleExclude,
}: Props) {
  const [view, setView] = useState<'card' | 'table'>('card')
  const rows = result?.rows ?? []
  const selectedCount = rows.filter((r) => !excluded.has(r.id)).length

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <p className="text-xs text-muted">
          {result
            ? `Showing ${rows.length} of ${result.totalMatched} matched · ${selectedCount} selected · ${result.totalBank} in bank`
            : '—'}
          {result && deficitNote(result) && (
            <span className="ml-2 rounded bg-warning/15 px-1.5 py-0.5 text-warning">
              {deficitNote(result)}
            </span>
          )}
        </p>
        <div className="flex gap-1">
          {(['card', 'table'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded-md px-2 py-1 text-xs capitalize ${
                view === v
                  ? 'bg-primary text-white'
                  : 'border border-border text-muted hover:text-text'
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {loading && <p className="text-sm text-muted">Querying…</p>}
        {!loading && rows.length === 0 && (
          <p className="text-sm text-muted">No questions match these filters.</p>
        )}
        {!loading && rows.length > 0 && view === 'card' && (
          <div className="space-y-3">
            {rows.map((r) => (
              <McqCard
                key={r.id}
                row={r}
                excluded={excluded.has(r.id)}
                onToggle={() => onToggleExclude(r.id)}
              />
            ))}
          </div>
        )}
        {!loading && rows.length > 0 && view === 'table' && (
          <McqTable rows={rows} excluded={excluded} onToggle={onToggleExclude} />
        )}
      </div>
    </div>
  )
}
