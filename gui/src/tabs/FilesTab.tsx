import { useEffect, useRef, useState } from 'react'
import FilterBuilder from '../files/FilterBuilder'
import ResultsPreview from '../files/ResultsPreview'
import type { FilterOptions, McqFilter, QueryResult } from '../types'

// §5.1 three-panel layout: Filter Builder | Results Preview | Export (Session 8).
export default function FilesTab() {
  const [options, setOptions] = useState<FilterOptions | null>(null)
  const [filter, setFilter] = useState<McqFilter>({ passedOnly: true })
  const [result, setResult] = useState<QueryResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [excluded, setExcluded] = useState<Set<number>>(new Set())
  const debounce = useRef<ReturnType<typeof setTimeout>>()

  // Load filter-control options once.
  useEffect(() => {
    window.api?.db
      .filterOptions()
      .then(setOptions)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  // Debounced query whenever the filter changes.
  useEffect(() => {
    if (!window.api) return
    clearTimeout(debounce.current)
    setLoading(true)
    debounce.current = setTimeout(() => {
      window.api.db
        .queryMcqs(filter)
        .then((r) => {
          setResult(r)
          setError(null)
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false))
    }, 250)
    return () => clearTimeout(debounce.current)
  }, [filter])

  const onChange = (patch: Partial<McqFilter>) =>
    setFilter((f) => ({ ...f, ...patch }))

  const toggleExclude = (id: number) =>
    setExcluded((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="flex h-full flex-col">
      <div className="px-6 py-4">
        <h1 className="text-2xl font-bold">Files</h1>
        <p className="mt-1 text-sm text-muted">
          Graphical query builder over logs/runs.db. No SQL required.
        </p>
        {error && (
          <div className="mt-3 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
            {error}
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 border-t border-border">
        {options ? (
          <FilterBuilder
            options={options}
            filter={filter}
            onChange={onChange}
          />
        ) : (
          <div className="w-[320px] shrink-0 border-r border-border p-4 text-sm text-muted">
            Loading filters…
          </div>
        )}

        <ResultsPreview
          result={result}
          loading={loading}
          excluded={excluded}
          onToggleExclude={toggleExclude}
        />

        {/* Export panel — built in Session 8 (§5.6) */}
        <div className="w-[240px] shrink-0 border-l border-border bg-surface p-4">
          <h3 className="text-sm font-semibold text-muted">Export</h3>
          <div className="mt-3 rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted">
            JSON / DOCX / PDF export and the DB management panel arrive in
            Session 8.
          </div>
          <p className="mt-3 text-[11px] text-muted">
            {result
              ? `${result.rows.filter((r) => !excluded.has(r.id)).length} selected for export`
              : ''}
          </p>
        </div>
      </div>
    </div>
  )
}
