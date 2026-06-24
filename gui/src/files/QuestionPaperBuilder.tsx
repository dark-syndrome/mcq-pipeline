import { useEffect, useState } from 'react'
import type {
  ExportOptions,
  McqRow,
  PaperBucket,
  PaperFilterOptions,
  PaperHeader,
  PaperQueryParams,
  SubTopicAlloc,
} from '../types'
import { BloomBadge, DifficultyBadge, TypeBadge } from './Badge'

// §5.8 — Question Paper Builder accordion.
// Queries MCQs from Supabase (or SQLite fallback), assembles a question paper
// with configurable sub-topic and difficulty ratios, and exports to DOCX/PDF/XLSX.

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeCounts(
  total: number,
  ePct: number,
  mPct: number,
  hPct: number,
): { easy: number; medium: number; hard: number } {
  const sum = ePct + mPct + hPct || 1
  const raw = [(ePct / sum) * total, (mPct / sum) * total, (hPct / sum) * total]
  const floors = raw.map(Math.floor)
  let rem = total - floors.reduce((a, b) => a + b, 0)
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac)
  for (const { i } of order) {
    if (rem-- <= 0) break
    floors[i]++
  }
  return { easy: floors[0], medium: floors[1], hard: floors[2] }
}

// Distribute `total` questions across sub-topics by their normalized ratios,
// then for each sub-topic split into easy/medium/hard using global difficulty pcts.
function computeSubTopicAllocs(
  total: number,
  selectedSubTopics: string[],
  subTopicRatios: Record<string, number>,
  ePct: number,
  mPct: number,
  hPct: number,
): SubTopicAlloc[] {
  if (!selectedSubTopics.length) return []

  // Normalize ratios so they sum to 100.
  const rawSum = selectedSubTopics.reduce((s, t) => s + (subTopicRatios[t] ?? 0), 0)
  const scale = rawSum > 0 ? 100 / rawSum : 1 / selectedSubTopics.length

  // Compute per-topic question counts (largest-remainder to hit `total` exactly).
  const rawCounts = selectedSubTopics.map((t) => ((subTopicRatios[t] ?? 0) * scale / 100) * total)
  const floors = rawCounts.map(Math.floor)
  let rem = total - floors.reduce((a, b) => a + b, 0)
  const order = rawCounts
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac)
  for (const { i } of order) {
    if (rem-- <= 0) break
    floors[i]++
  }

  return selectedSubTopics.map((t, i) => {
    const topicTotal = floors[i]
    const { easy, medium, hard } = computeCounts(topicTotal, ePct, mPct, hPct)
    return { subTopic: t, easyCount: easy, mediumCount: medium, hardCount: hard }
  })
}

function defaultPaperName(header: PaperHeader, count: number): string {
  const date = new Date().toISOString().slice(0, 10)
  const slug = (header.title || 'exam').replace(/[^\w]+/g, '_')
  return `${slug}_${count}q_${date}`
}

// ─── Small sub-components ────────────────────────────────────────────────────

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="mt-3">
      <label className="block text-xs font-medium">{label}</label>
      {children}
    </div>
  )
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-1.5 text-xs outline-none focus:border-primary"
    />
  )
}

function RatioSlider({
  label,
  pct,
  count,
  color,
  disabled,
  onChange,
}: {
  label: string
  pct: number
  count: number
  color: string
  disabled?: boolean
  onChange?: (v: number) => void
}) {
  return (
    <div>
      <div className="flex justify-between text-xs">
        <span className={color}>{label}</span>
        <span className="text-muted">
          {pct}% → <b>{count}</b> q
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={pct}
        disabled={disabled}
        onChange={(e) => onChange?.(Number(e.target.value))}
        className="mt-1 w-full accent-primary disabled:opacity-40"
      />
    </div>
  )
}

// Per-sub-topic ratio row: label on left, percentage input + derived question count on right.
function SubTopicRatioRow({
  label,
  pct,
  topicTotal,
  onChange,
}: {
  label: string
  pct: number
  topicTotal: number
  onChange: (v: number) => void
}) {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="min-w-0 flex-1 truncate text-xs" title={label}>
        {label}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <input
          type="number"
          min={0}
          max={100}
          value={pct}
          onChange={(e) => onChange(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
          className="w-14 rounded border border-border bg-bg px-1.5 py-0.5 text-right text-xs outline-none focus:border-primary"
        />
        <span className="text-[11px] text-muted">%</span>
        <span className="w-10 text-right text-[11px] text-muted">
          → <b>{topicTotal}</b>q
        </span>
      </div>
    </div>
  )
}

// ─── Preview: card and table ─────────────────────────────────────────────────

// Ordering questions store their numbered steps in `ordering_statements`; the
// `question` text alone is unanswerable, so inline the steps for display.
function orderingStem(row: McqRow): string {
  const stmts = row.ordering_statements
  if (
    row.question_type !== 'ordering' ||
    !Array.isArray(stmts) ||
    stmts.length === 0
  ) {
    return row.question
  }
  if (stmts.every((s) => row.question.includes(s))) return row.question
  return `${row.question}\n\n${stmts.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
}

function PaperCardView({
  rows,
  excluded,
  onToggle,
}: {
  rows: McqRow[]
  excluded: Set<number>
  onToggle: (id: number) => void
}) {
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <div
          key={r.id}
          className={`rounded-lg border border-border bg-surface p-4 ${
            excluded.has(r.id) ? 'opacity-50' : ''
          }`}
        >
          <div className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={!excluded.has(r.id)}
              onChange={() => onToggle(r.id)}
              className="mt-1 accent-primary"
              title="Include in paper"
            />
            <div className="min-w-0 flex-1">
              <p className="whitespace-pre-line text-sm font-medium">
                {orderingStem(r)}
              </p>
              <ul className="mt-2 space-y-1">
                {r.options.map((o) => (
                  <li
                    key={o.label}
                    className={`flex gap-2 rounded px-2 py-1 text-xs ${
                      o.is_correct ? 'bg-success/10 text-success' : 'text-muted'
                    }`}
                  >
                    <span className="font-semibold">{o.label}.</span>
                    <span>{o.text}</span>
                    {o.is_correct && <span className="ml-auto">✓</span>}
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <DifficultyBadge value={r.difficulty} />
                <BloomBadge value={r.bloom_level} />
                <TypeBadge value={r.question_type} />
                {r.sub_topic && (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                    {r.sub_topic}
                  </span>
                )}
                {r.source_heading && (
                  <span className="text-[11px] text-muted">· {r.source_heading}</span>
                )}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function PaperTableView({
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
          <th className="py-2 pr-2">Sub-topic</th>
          <th className="py-2 pr-2">Difficulty</th>
          <th className="py-2 pr-2">Bloom</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
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
            <td className="py-2 pr-2 tabular-nums text-muted">{i + 1}</td>
            <td className="max-w-[280px] truncate py-2 pr-2" title={r.question}>
              {r.question}
            </td>
            <td className="max-w-[140px] truncate py-2 pr-2 text-muted" title={r.sub_topic ?? ''}>
              {r.sub_topic || '—'}
            </td>
            <td className="py-2 pr-2">
              <DifficultyBadge value={r.difficulty} />
            </td>
            <td className="py-2 pr-2 capitalize text-muted">{r.bloom_level}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function QuestionPaperBuilder() {
  const [open, setOpen] = useState(false)

  // Source filters
  const [filterOpts, setFilterOpts] = useState<PaperFilterOptions | null>(null)
  const [selectedGens, setSelectedGens] = useState<number[]>([])
  const [selectedTopics, setSelectedTopics] = useState<string[]>([])

  // Sub-topic selection + per-topic ratios
  const [selectedSubTopics, setSelectedSubTopics] = useState<string[]>([])
  const [subTopicRatios, setSubTopicRatios] = useState<Record<string, number>>({})

  // Paper config — difficulty ratio
  const [totalQ, setTotalQ] = useState(20)
  const [easyPct, setEasyPct] = useState(35)
  const [medPct, setMedPct] = useState(45)
  const hardPct = Math.max(0, 100 - easyPct - medPct)

  // Exam header
  const [header, setHeader] = useState<PaperHeader>({ title: 'MCQ Examination' })

  // Export
  const [exportFmt, setExportFmt] = useState<'docx' | 'pdf' | 'xlsx'>('docx')
  const [answerKey, setAnswerKey] = useState(true)
  const [showExplanations, setShowExplanations] = useState(false)
  const [showMetadata, setShowMetadata] = useState(false)

  // Results
  const [rows, setRows] = useState<McqRow[]>([])
  const [excluded, setExcluded] = useState<Set<number>>(new Set())
  const [buckets, setBuckets] = useState<PaperBucket[] | null>(null)
  const [querySource, setQuerySource] = useState<string | null>(null)
  const [view, setView] = useState<'card' | 'table'>('card')

  // UI state
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [savedPath, setSavedPath] = useState<string | null>(null)

  // Load filter options once on first open
  useEffect(() => {
    if (!open || filterOpts !== null) return
    window.api?.paper
      .filterOptions()
      .then(setFilterOpts)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      )
  }, [open, filterOpts])

  // When a sub-topic is first selected, give it an equal default share.
  const initSubTopicRatio = (topic: string, currentSelected: string[]) => {
    const newCount = currentSelected.length + 1
    setSubTopicRatios((prev) => {
      const next = { ...prev }
      // Scale existing ratios down to make room, then add the new one.
      const total = Object.values(next).reduce((s, v) => s + v, 0)
      if (total === 0 || currentSelected.length === 0) {
        next[topic] = 100
      } else {
        const share = Math.round(100 / newCount)
        const remainder = 100 - share * newCount
        // Give equal shares; adjust last one for rounding.
        currentSelected.forEach((t, i) => {
          next[t] = share + (i === currentSelected.length - 1 ? remainder : 0)
        })
        next[topic] = share
      }
      return next
    })
  }

  const toggleSubTopic = (t: string) => {
    if (selectedSubTopics.includes(t)) {
      setSelectedSubTopics((s) => s.filter((x) => x !== t))
      setSubTopicRatios((prev) => {
        const next = { ...prev }
        delete next[t]
        // Re-normalize remaining ratios to 100%.
        const rem = Object.values(next).reduce((s, v) => s + v, 0)
        if (rem > 0 && rem !== 100) {
          const scale = 100 / rem
          Object.keys(next).forEach((k) => {
            next[k] = Math.round(next[k] * scale)
          })
        }
        return next
      })
    } else {
      initSubTopicRatio(t, selectedSubTopics)
      setSelectedSubTopics((s) => [...s, t])
    }
  }

  const updateSubTopicRatio = (topic: string, val: number) => {
    setSubTopicRatios((prev) => ({ ...prev, [topic]: val }))
  }

  // Select every available sub-topic at once and give each an equal default share.
  const selectAllSubTopics = () => {
    const all = filterOpts?.subTopics ?? []
    if (all.length === 0) return
    setSelectedSubTopics(all)
    const share = Math.floor(100 / all.length)
    const remainder = 100 - share * all.length
    const ratios: Record<string, number> = {}
    all.forEach((t, i) => {
      ratios[t] = share + (i === all.length - 1 ? remainder : 0)
    })
    setSubTopicRatios(ratios)
  }

  // Compute sub-topic allocations for the query.
  const subTopicAllocs =
    selectedSubTopics.length > 0
      ? computeSubTopicAllocs(totalQ, selectedSubTopics, subTopicRatios, easyPct, medPct, hardPct)
      : undefined

  const counts = subTopicAllocs
    ? {
        easy: subTopicAllocs.reduce((s, a) => s + a.easyCount, 0),
        medium: subTopicAllocs.reduce((s, a) => s + a.mediumCount, 0),
        hard: subTopicAllocs.reduce((s, a) => s + a.hardCount, 0),
      }
    : computeCounts(totalQ, easyPct, medPct, hardPct)

  const onEasySlider = (v: number) => setEasyPct(Math.min(v, 100 - medPct))
  const onMedSlider = (v: number) => setMedPct(Math.min(v, 100 - easyPct))

  const toggleGen = (n: number) =>
    setSelectedGens((s) =>
      s.includes(n) ? s.filter((x) => x !== n) : [...s, n],
    )
  const toggleTopic = (t: string) =>
    setSelectedTopics((s) =>
      s.includes(t) ? s.filter((x) => x !== t) : [...s, t],
    )
  const toggleExclude = (id: number) =>
    setExcluded((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // Total ratio for the sub-topic ratio section (for validation hint).
  const subTopicRatioSum = selectedSubTopics.reduce((s, t) => s + (subTopicRatios[t] ?? 0), 0)

  const onFetch = async () => {
    if (loading) return
    setLoading(true)
    setError(null)
    const params: PaperQueryParams = {
      easyCount: counts.easy,
      mediumCount: counts.medium,
      hardCount: counts.hard,
      generationNumbers: selectedGens.length ? selectedGens : undefined,
      topics: selectedTopics.length ? selectedTopics : undefined,
      subTopicAllocs: subTopicAllocs?.length ? subTopicAllocs : undefined,
    }
    try {
      const result = await window.api.paper.queryMcqs(params)
      setRows(result.rows)
      setExcluded(new Set())
      setBuckets(result.buckets)
      setQuerySource(result.source)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const selectedRows = rows.filter((r) => !excluded.has(r.id))

  const onExport = async () => {
    if (!selectedRows.length || exporting) return
    setExporting(true)
    setToast(null)
    setSavedPath(null)
    const opts: ExportOptions = {
      format: exportFmt,
      answerKey,
      explanations: showExplanations,
      metadata: showMetadata,
      paperHeader: header,
    }
    try {
      const saved = await window.api.export.run(
        selectedRows,
        opts,
        defaultPaperName(header, selectedRows.length),
      )
      if (saved) {
        setSavedPath(saved)
        setToast(`Exported ${selectedRows.length} question${selectedRows.length === 1 ? '' : 's'}`)
      }
    } catch (e) {
      setToast(`Export failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="border-t border-border">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-6 py-3 text-sm font-semibold hover:bg-surface"
      >
        <span>Question Paper Builder</span>
        <span className="text-muted">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="px-6 pb-6">
          {error && (
            <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {/* ── Column 1: Source Filters + Sub-topics + Paper Config ── */}
            <div className="space-y-4">
              {/* Source Filters */}
              <div className="rounded-lg border border-border bg-surface p-4">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Source
                  {filterOpts && (
                    <span className="ml-2 text-[10px] normal-case text-primary">
                      ({filterOpts.source})
                    </span>
                  )}
                </h4>

                {!filterOpts ? (
                  <p className="mt-2 text-xs text-muted">Loading…</p>
                ) : (
                  <>
                    <p className="mt-3 text-xs font-medium">Generations</p>
                    <div className="mt-1 max-h-24 space-y-0.5 overflow-y-auto">
                      {filterOpts.generations.length === 0 ? (
                        <p className="text-xs text-muted">None found</p>
                      ) : (
                        filterOpts.generations.map((g) => (
                          <label
                            key={g.generation_number}
                            className="flex items-center gap-2 text-xs"
                          >
                            <input
                              type="checkbox"
                              checked={selectedGens.includes(g.generation_number)}
                              onChange={() => toggleGen(g.generation_number)}
                              className="accent-primary"
                            />
                            {g.label}
                          </label>
                        ))
                      )}
                    </div>

                    <p className="mt-3 text-xs font-medium">Topics</p>
                    <div className="mt-1 max-h-24 space-y-0.5 overflow-y-auto">
                      {filterOpts.topics.length === 0 ? (
                        <p className="text-xs text-muted">None found</p>
                      ) : (
                        filterOpts.topics.map((t) => (
                          <label
                            key={t}
                            className="flex items-center gap-2 text-xs"
                          >
                            <input
                              type="checkbox"
                              checked={selectedTopics.includes(t)}
                              onChange={() => toggleTopic(t)}
                              className="accent-primary"
                            />
                            {t}
                          </label>
                        ))
                      )}
                    </div>

                    {(selectedGens.length > 0 || selectedTopics.length > 0) && (
                      <button
                        onClick={() => {
                          setSelectedGens([])
                          setSelectedTopics([])
                        }}
                        className="mt-2 text-[11px] text-primary hover:underline"
                      >
                        Clear filters
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* Sub-topic Selection */}
              <div className="rounded-lg border border-border bg-surface p-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
                    Sub-topics
                    {filterOpts && filterOpts.subTopics.length > 0 && (
                      <span className="ml-1.5 normal-case text-[10px] text-muted/70">
                        ({selectedSubTopics.length}/{filterOpts.subTopics.length})
                      </span>
                    )}
                  </h4>
                  {filterOpts && filterOpts.subTopics.length > 0 && (
                    <button
                      onClick={
                        selectedSubTopics.length === filterOpts.subTopics.length
                          ? () => {
                              setSelectedSubTopics([])
                              setSubTopicRatios({})
                            }
                          : selectAllSubTopics
                      }
                      className="text-[11px] text-primary hover:underline"
                    >
                      {selectedSubTopics.length === filterOpts.subTopics.length
                        ? 'Clear all'
                        : 'Select all'}
                    </button>
                  )}
                </div>

                {!filterOpts ? (
                  <p className="mt-2 text-xs text-muted">Loading…</p>
                ) : filterOpts.subTopics.length === 0 ? (
                  <p className="mt-2 text-xs text-muted">
                    No topics found — add a Topic Tag in the Run tab or run the pipeline first.
                  </p>
                ) : (
                  <>
                    <p className="mt-1 text-[11px] text-muted">
                      Select sub-topics to include, then set the question ratio for each.
                    </p>
                    <div className="mt-2 max-h-56 space-y-0.5 overflow-y-auto pr-1">
                      {filterOpts.subTopics.map((t) => (
                        <label key={t} className="flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={selectedSubTopics.includes(t)}
                            onChange={() => toggleSubTopic(t)}
                            className="accent-primary"
                          />
                          {t}
                        </label>
                      ))}
                    </div>

                    {selectedSubTopics.length > 0 && (
                      <>
                        <div className="mt-3 border-t border-border pt-2">
                          <div className="flex items-center justify-between">
                            <p className="text-xs font-medium">Ratio per Sub-topic</p>
                            <span
                              className={`text-[11px] ${
                                Math.abs(subTopicRatioSum - 100) <= 2
                                  ? 'text-success'
                                  : 'text-warning'
                              }`}
                            >
                              {subTopicRatioSum}% total
                            </span>
                          </div>
                          <div className="mt-1 space-y-0.5">
                            {selectedSubTopics.map((t, i) => {
                              const alloc = subTopicAllocs?.find((a) => a.subTopic === t)
                              const topicTotal = alloc
                                ? alloc.easyCount + alloc.mediumCount + alloc.hardCount
                                : 0
                              return (
                                <SubTopicRatioRow
                                  key={t}
                                  label={t}
                                  pct={subTopicRatios[t] ?? 0}
                                  topicTotal={topicTotal}
                                  onChange={(v) => updateSubTopicRatio(t, v)}
                                />
                              )
                            })}
                          </div>
                          <p className="mt-1 text-[11px] text-muted">
                            Ratios are normalized automatically.
                          </p>
                        </div>
                        <button
                          onClick={() => {
                            setSelectedSubTopics([])
                            setSubTopicRatios({})
                          }}
                          className="mt-2 text-[11px] text-primary hover:underline"
                        >
                          Clear sub-topics
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>

              {/* Paper Config */}
              <div className="rounded-lg border border-border bg-surface p-4">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Paper Configuration
                </h4>

                <Field label="Total Questions">
                  <input
                    type="number"
                    value={totalQ}
                    min={1}
                    max={200}
                    onChange={(e) =>
                      setTotalQ(Math.max(1, parseInt(e.target.value) || 1))
                    }
                    className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-1.5 text-xs outline-none focus:border-primary"
                  />
                </Field>

                <div className="mt-3">
                  <p className="text-xs font-medium">
                    Difficulty Ratio
                    {selectedSubTopics.length > 0 && (
                      <span className="ml-1.5 text-[11px] font-normal text-muted">
                        (applied across all sub-topics)
                      </span>
                    )}
                  </p>
                  <div className="mt-2 space-y-3">
                    <RatioSlider
                      label="Easy"
                      pct={easyPct}
                      count={counts.easy}
                      color="text-success"
                      onChange={onEasySlider}
                    />
                    <RatioSlider
                      label="Medium"
                      pct={medPct}
                      count={counts.medium}
                      color="text-warning"
                      onChange={onMedSlider}
                    />
                    <RatioSlider
                      label="Hard / Expert"
                      pct={hardPct}
                      count={counts.hard}
                      color="text-danger"
                      disabled
                    />
                  </div>
                  <p className="mt-1 text-[11px] text-muted">
                    Hard/Expert fills the remaining %.
                  </p>
                </div>

                <button
                  onClick={onFetch}
                  disabled={loading}
                  className={`mt-4 w-full rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                    !loading
                      ? 'bg-primary text-white hover:bg-primary/90'
                      : 'cursor-not-allowed bg-border text-muted'
                  }`}
                >
                  {loading ? 'Fetching…' : 'Fetch Questions'}
                </button>
              </div>
            </div>

            {/* ── Column 2: Exam Header ── */}
            <div className="rounded-lg border border-border bg-surface p-4">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
                Exam Header
              </h4>

              <Field label="Institution">
                <TextInput
                  value={header.institution ?? ''}
                  onChange={(v) => setHeader((h) => ({ ...h, institution: v }))}
                  placeholder="e.g. NxtWave Institute of Technology"
                />
              </Field>

              <Field label="Exam Title">
                <TextInput
                  value={header.title}
                  onChange={(v) => setHeader((h) => ({ ...h, title: v }))}
                  placeholder="MCQ Examination"
                />
              </Field>

              <Field label="Subject">
                <TextInput
                  value={header.subject ?? ''}
                  onChange={(v) => setHeader((h) => ({ ...h, subject: v }))}
                  placeholder="e.g. JavaScript Fundamentals"
                />
              </Field>

              <Field label="Date">
                <TextInput
                  type="date"
                  value={header.date ?? ''}
                  onChange={(v) => setHeader((h) => ({ ...h, date: v }))}
                />
              </Field>

              <Field label="Duration">
                <TextInput
                  value={header.duration ?? ''}
                  onChange={(v) => setHeader((h) => ({ ...h, duration: v }))}
                  placeholder="e.g. 1 hour"
                />
              </Field>

              <Field label="Max Marks">
                <input
                  type="number"
                  value={header.maxMarks ?? ''}
                  min={1}
                  onChange={(e) =>
                    setHeader((h) => ({
                      ...h,
                      maxMarks: e.target.value ? Number(e.target.value) : undefined,
                    }))
                  }
                  placeholder="e.g. 100"
                  className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-1.5 text-xs outline-none focus:border-primary"
                />
              </Field>

              <Field label="Instructions">
                <textarea
                  value={header.instructions ?? ''}
                  onChange={(e) =>
                    setHeader((h) => ({ ...h, instructions: e.target.value }))
                  }
                  placeholder="All questions carry equal marks. No negative marking."
                  rows={5}
                  className="mt-1 w-full resize-none rounded-lg border border-border bg-bg px-2 py-1.5 text-xs outline-none focus:border-primary"
                />
              </Field>
            </div>

            {/* ── Column 3: Export ── */}
            <div className="rounded-lg border border-border bg-surface p-4">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
                Export
              </h4>

              <p className="mt-3 text-xs font-medium">Format</p>
              <div className="mt-1 space-y-1">
                {([
                  ['docx', 'DOCX'],
                  ['pdf', 'PDF'],
                  ['xlsx', 'XLSX (S.No / Options / Key / SUB TOPIC / Difficulty / pool)'],
                ] as const).map(([f, label]) => (
                  <label key={f} className="flex items-center gap-2 text-xs">
                    <input
                      type="radio"
                      name="paperExportFormat"
                      checked={exportFmt === f}
                      onChange={() => setExportFmt(f)}
                      className="accent-primary"
                    />
                    {label}
                  </label>
                ))}
              </div>

              {exportFmt !== 'xlsx' && (
                <div className="mt-3 space-y-1.5 border-t border-border pt-3">
                  <label className="flex items-center gap-2 text-xs text-text">
                    <input
                      type="checkbox"
                      checked={answerKey}
                      onChange={(e) => setAnswerKey(e.target.checked)}
                      className="accent-primary"
                    />
                    Answer key (separate section)
                  </label>
                  <label className="flex items-center gap-2 text-xs text-text">
                    <input
                      type="checkbox"
                      checked={showExplanations}
                      onChange={(e) => setShowExplanations(e.target.checked)}
                      className="accent-primary"
                    />
                    Explanations
                  </label>
                  <label className="flex items-center gap-2 text-xs text-text">
                    <input
                      type="checkbox"
                      checked={showMetadata}
                      onChange={(e) => setShowMetadata(e.target.checked)}
                      className="accent-primary"
                    />
                    Bloom / difficulty metadata
                  </label>
                </div>
              )}
              {exportFmt === 'xlsx' && (
                <p className="mt-3 border-t border-border pt-3 text-[11px] text-muted">
                  Columns: S.No · question content · Option A–D · Explanation ·
                  Key · SUB TOPIC · Difficulty · pool · Image(if any)
                </p>
              )}

              {/* Bucket summary */}
              {buckets && (
                <div className="mt-4 rounded-lg border border-border bg-bg p-3">
                  <p className="text-[11px] font-semibold text-muted">
                    Last fetch{querySource ? ` · ${querySource}` : ''}
                  </p>
                  {buckets.map((b) => (
                    <p
                      key={b.difficulty}
                      className={`mt-0.5 text-[11px] ${
                        b.got < b.requested ? 'text-warning' : 'text-success'
                      }`}
                    >
                      {b.difficulty}: {b.got}/{b.requested}
                      {b.got < b.requested
                        ? ` (${b.requested - b.got} unavailable)`
                        : ''}
                    </p>
                  ))}
                </div>
              )}

              <button
                onClick={onExport}
                disabled={!selectedRows.length || exporting}
                className={`mt-4 w-full rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                  selectedRows.length && !exporting
                    ? 'bg-primary text-white hover:bg-primary/90'
                    : 'cursor-not-allowed bg-border text-muted'
                }`}
              >
                {exporting
                  ? 'Exporting…'
                  : selectedRows.length
                  ? `Export ${selectedRows.length} question${selectedRows.length === 1 ? '' : 's'}`
                  : 'Export'}
              </button>

              {toast && (
                <p
                  className={`mt-2 text-xs ${
                    toast.startsWith('Export failed') ? 'text-danger' : 'text-success'
                  }`}
                >
                  {toast}
                </p>
              )}
              {savedPath && (
                <button
                  onClick={() => window.api.file.showInFolder(savedPath)}
                  className="mt-1 text-[11px] text-primary hover:underline"
                >
                  Show in folder
                </button>
              )}
            </div>
          </div>

          {/* ── Full-width preview ── */}
          {rows.length > 0 && (
            <div className="mt-6">
              <div className="flex items-center justify-between border-b border-border pb-2">
                <p className="text-xs text-muted">
                  {selectedRows.length} of {rows.length} selected
                  {buckets &&
                    buckets.some((b) => b.got < b.requested) && (
                      <span className="ml-2 rounded bg-warning/15 px-1.5 py-0.5 text-warning">
                        some buckets short
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

              <div className="mt-3 overflow-y-auto" style={{ maxHeight: '60vh' }}>
                {view === 'card' ? (
                  <PaperCardView
                    rows={rows}
                    excluded={excluded}
                    onToggle={toggleExclude}
                  />
                ) : (
                  <PaperTableView
                    rows={rows}
                    excluded={excluded}
                    onToggle={toggleExclude}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
