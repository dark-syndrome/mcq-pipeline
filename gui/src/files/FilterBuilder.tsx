import type {
  BloomLevel,
  Difficulty,
  FetchMode,
  FilterOptions,
  McqFilter,
  QuestionType,
} from '../types'
import RatioSliders, { EQUAL_RATIO } from './RatioSliders'

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard', 'expert']
const BLOOMS: BloomLevel[] = [
  'remember',
  'understand',
  'apply',
  'analyze',
  'evaluate',
  'create',
]
const TYPES: { id: QuestionType; label: string }[] = [
  { id: 'single_correct', label: 'SC' },
  { id: 'multiple_correct', label: 'Multi' },
  { id: 'ordering', label: 'Ordering' },
]
const FETCH_MODES: { id: FetchMode; label: string; hint: string }[] = [
  { id: 'sequential', label: 'Sequential', hint: 'ordered by question number' },
  { id: 'random', label: 'Random', hint: 'reshuffled each fetch' },
  { id: 'stratified', label: 'Stratified', hint: 'random within ratio buckets' },
]

// Generic multi-select badge toggle (reuses the RunConfigPanel idiom).
function Toggles<T extends string>({
  label,
  options,
  selected,
  onToggle,
  display,
}: {
  label: string
  options: T[] | { id: T; label: string }[]
  selected: T[]
  onToggle: (v: T) => void
  display?: (v: T) => string
}) {
  const opts = options.map((o) =>
    typeof o === 'string' ? { id: o, label: display?.(o) ?? o } : o,
  )
  return (
    <div>
      <label className="block text-xs font-medium text-muted">{label}</label>
      <div className="mt-1 flex flex-wrap gap-1">
        {opts.map((o) => (
          <button
            key={o.id}
            onClick={() => onToggle(o.id)}
            className={`rounded-md px-2 py-1 text-xs capitalize ${
              selected.includes(o.id)
                ? 'border border-primary bg-primary/15 text-primary'
                : 'border border-border text-muted hover:text-text'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

interface Props {
  options: FilterOptions
  filter: McqFilter
  onChange: (patch: Partial<McqFilter>) => void
}

// §5.2 — left filter-builder panel. Emits patches into the parent's filter
// state; the parent debounces the query.
export default function FilterBuilder({ options, filter, onChange }: Props) {
  const toggleIn = <T extends string>(
    key: keyof McqFilter,
    value: T,
  ) => {
    const cur = (filter[key] as T[] | undefined) ?? []
    const next = cur.includes(value)
      ? cur.filter((x) => x !== value)
      : [...cur, value]
    onChange({ [key]: next } as Partial<McqFilter>)
  }

  const showRatio = filter.fetchMode === 'stratified' && !!filter.limit

  return (
    <div className="w-[320px] shrink-0 space-y-4 overflow-y-auto border-r border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">Filter Builder</h3>

      {/* Source File (spec's "Topic" → input_file in this schema) */}
      <div>
        <label className="block text-xs font-medium text-muted">
          Source File
        </label>
        <div className="mt-1 flex flex-wrap gap-1">
          {options.sourceFiles.length === 0 && (
            <span className="text-[11px] text-muted">No files yet.</span>
          )}
          {options.sourceFiles.map((f) => {
            const on = (filter.sourceFiles ?? []).includes(f.path)
            return (
              <button
                key={f.path}
                title={f.path}
                onClick={() => toggleIn('sourceFiles', f.path)}
                className={`max-w-full truncate rounded-md px-2 py-1 text-xs ${
                  on
                    ? 'border border-primary bg-primary/15 text-primary'
                    : 'border border-border text-muted hover:text-text'
                }`}
              >
                {f.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Run */}
      <div>
        <label className="block text-xs font-medium text-muted">Run</label>
        <select
          value={(filter.runIds ?? [])[0] ?? ''}
          onChange={(e) =>
            onChange({ runIds: e.target.value ? [e.target.value] : [] })
          }
          className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-1.5 text-xs outline-none focus:border-primary"
        >
          <option value="">All runs</option>
          {options.runs.map((r) => (
            <option key={r.run_id} value={r.run_id}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      <Toggles
        label="Difficulty"
        options={DIFFICULTIES}
        selected={filter.difficulties ?? []}
        onToggle={(v) => toggleIn('difficulties', v)}
      />
      <Toggles
        label="Bloom Level"
        options={BLOOMS}
        selected={filter.blooms ?? []}
        onToggle={(v) => toggleIn('blooms', v)}
      />
      <Toggles
        label="Question Type"
        options={TYPES}
        selected={filter.types ?? []}
        onToggle={(v) => toggleIn('types', v)}
      />

      {/* Source Heading */}
      <div>
        <label className="block text-xs font-medium text-muted">
          Source Heading
        </label>
        <select
          value={(filter.sourceHeadings ?? [])[0] ?? ''}
          onChange={(e) =>
            onChange({
              sourceHeadings: e.target.value ? [e.target.value] : [],
            })
          }
          className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-1.5 text-xs outline-none focus:border-primary"
        >
          <option value="">Any heading</option>
          {options.sourceHeadings.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
      </div>

      {/* Date range */}
      <div>
        <label className="block text-xs font-medium text-muted">
          Date Range
        </label>
        <div className="mt-1 flex items-center gap-1">
          <input
            type="date"
            value={filter.dateFrom ?? ''}
            onChange={(e) => onChange({ dateFrom: e.target.value || undefined })}
            className="w-full rounded-lg border border-border bg-bg px-2 py-1.5 text-xs outline-none focus:border-primary"
          />
          <span className="text-xs text-muted">–</span>
          <input
            type="date"
            value={filter.dateTo ?? ''}
            onChange={(e) => onChange({ dateTo: e.target.value || undefined })}
            className="w-full rounded-lg border border-border bg-bg px-2 py-1.5 text-xs outline-none focus:border-primary"
          />
        </div>
      </div>

      {/* Passed only */}
      <label className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted">Passed Only</span>
        <button
          onClick={() => onChange({ passedOnly: filter.passedOnly === false })}
          className={`relative h-5 w-9 rounded-full transition-colors ${
            filter.passedOnly !== false ? 'bg-primary' : 'bg-border'
          }`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
              filter.passedOnly !== false ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </label>

      {/* Count + fetch mode (§5.4) */}
      <div className="border-t border-border pt-3">
        <label className="block text-xs font-medium text-muted">
          Count (optional)
        </label>
        <input
          type="number"
          min={1}
          placeholder="all matched"
          value={filter.limit ?? ''}
          onChange={(e) =>
            onChange({
              limit: e.target.value ? Math.max(1, Number(e.target.value)) : undefined,
            })
          }
          className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-1.5 text-xs outline-none focus:border-primary"
        />
        <div className="mt-2 space-y-1">
          {FETCH_MODES.map((m) => (
            <label key={m.id} className="flex items-center gap-2 text-xs">
              <input
                type="radio"
                name="fetchMode"
                checked={(filter.fetchMode ?? 'sequential') === m.id}
                onChange={() =>
                  onChange({
                    fetchMode: m.id,
                    ratio:
                      m.id === 'stratified'
                        ? (filter.ratio ?? EQUAL_RATIO)
                        : filter.ratio,
                  })
                }
                className="accent-primary"
              />
              <span className="text-text">{m.label}</span>
              <span className="text-[11px] text-muted">— {m.hint}</span>
            </label>
          ))}
        </div>
      </div>

      {showRatio && (
        <div className="border-t border-border pt-3">
          <RatioSliders
            ratio={filter.ratio ?? EQUAL_RATIO}
            onChange={(r) => onChange({ ratio: r })}
          />
        </div>
      )}
    </div>
  )
}
