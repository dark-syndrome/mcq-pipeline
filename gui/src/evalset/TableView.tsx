import { useState } from 'react'
import type { EvalQuestion } from '../types'

type SortCol = 'index' | 'difficulty' | 'bloom_level' | 'rating' | 'confirmed'

export default function TableView({
  questions,
  onSelectQuestion,
}: {
  questions: EvalQuestion[]
  onSelectQuestion: (id: number) => void
}) {
  const [sortCol, setSortCol] = useState<SortCol>('index')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  function handleSort(col: SortCol) {
    if (sortCol === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortCol(col)
      setSortDir('asc')
    }
  }

  const indexed = questions.map((q, i) => ({ ...q, _i: i }))
  const sorted = [...indexed].sort((a, b) => {
    let av: string | number, bv: string | number
    switch (sortCol) {
      case 'index':
        av = a._i
        bv = b._i
        break
      case 'difficulty':
        av = a.difficulty
        bv = b.difficulty
        break
      case 'bloom_level':
        av = a.bloom_level
        bv = b.bloom_level
        break
      case 'rating':
        av = a.annotation.rating
        bv = b.annotation.rating
        break
      default:
        av = String(a.annotation.confirmed ?? '')
        bv = String(b.annotation.confirmed ?? '')
    }
    if (av < bv) return sortDir === 'asc' ? -1 : 1
    if (av > bv) return sortDir === 'asc' ? 1 : -1
    return 0
  })

  const COLS: { key: SortCol; label: string }[] = [
    { key: 'index', label: '#' },
    { key: 'difficulty', label: 'Difficulty' },
    { key: 'bloom_level', label: 'Bloom' },
    { key: 'rating', label: 'Rating' },
    { key: 'confirmed', label: 'Verdict' },
  ]

  const SortIcon = ({ col }: { col: SortCol }) =>
    sortCol !== col ? (
      <span className="ml-1 text-muted/40">↕</span>
    ) : (
      <span className="ml-1 text-primary">{sortDir === 'asc' ? '↑' : '↓'}</span>
    )

  if (questions.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-muted">
        No questions in this eval set.
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div style={{ overflowX: 'auto' }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              {COLS.map((c) => (
                <th
                  key={c.key}
                  className="cursor-pointer select-none whitespace-nowrap px-4 py-2.5 text-left text-xs font-medium text-muted hover:text-text"
                  onClick={() => handleSort(c.key)}
                >
                  {c.label}
                  <SortIcon col={c.key} />
                </th>
              ))}
              <th className="px-4 py-2.5 text-left text-xs font-medium text-muted">Stem</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-muted">Notes</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((q) => (
              <tr key={q.id} className="border-b border-border/50 hover:bg-white/5">
                <td className="px-4 py-2 text-xs text-muted">#{q._i + 1}</td>
                <td className="px-4 py-2 text-xs">{q.difficulty}</td>
                <td className="px-4 py-2 text-xs">{q.bloom_level}</td>
                <td className="px-4 py-2 text-xs">
                  {q.annotation.rating > 0 ? (
                    <span className="text-warning">
                      {'★'.repeat(q.annotation.rating)}
                      <span className="text-muted/40">{'★'.repeat(5 - q.annotation.rating)}</span>
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="px-4 py-2 text-xs">
                  {q.annotation.confirmed === true ? (
                    <span className="text-success">✓ Correct</span>
                  ) : q.annotation.confirmed === false ? (
                    <span className="text-danger">✗ Wrong</span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td
                  className="max-w-xs cursor-pointer truncate px-4 py-2 text-xs hover:text-primary"
                  title={q.question}
                  onClick={() => onSelectQuestion(q.id)}
                >
                  {q.question.length > 80 ? `${q.question.slice(0, 80)}…` : q.question}
                </td>
                <td
                  className="max-w-[120px] truncate px-4 py-2 text-xs text-muted"
                  title={q.annotation.notes}
                >
                  {q.annotation.notes || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
