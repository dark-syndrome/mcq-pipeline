import { useState, useRef, useEffect } from 'react'
import type { Difficulty, QuestionType } from '../types'

export interface RunConfig {
  count: number
  difficulty: Difficulty
  types: QuestionType[]
  topic: string
  topicTag: string
  runName: string
  subtopics: string[]
  course: string
  isPublic: boolean
}

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard', 'expert']
const TYPES: { id: QuestionType; label: string }[] = [
  { id: 'single_correct', label: 'SC' },
  { id: 'multiple_correct', label: 'Multi' },
  { id: 'ordering', label: 'Ordering' },
]

interface Props {
  config: RunConfig
  onChange: (patch: Partial<RunConfig>) => void
  estimate: { tokens: number; cost: number } | null
  canGenerate: boolean
  onGenerate: () => void
  notice?: string | null
  availableTags?: string[]
  availableCourses?: string[]
  availableSubTopics?: string[]
}

// Combobox: shows a dropdown of existing options but also allows free-text.
function Combobox({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: string
  options: string[]
  placeholder: string
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const filtered = options.filter((o) =>
    o.toLowerCase().includes(value.toLowerCase()),
  )

  return (
    <div ref={ref} className="relative">
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-primary"
      />
      {open && filtered.length > 0 && (
        <ul className="absolute z-50 mt-1 max-h-48 w-full overflow-auto rounded-lg border border-border bg-surface shadow-lg">
          {filtered.map((o) => (
            <li
              key={o}
              onMouseDown={(e) => {
                e.preventDefault()
                onChange(o)
                setOpen(false)
              }}
              className={`cursor-pointer px-3 py-2 text-sm hover:bg-primary/10 ${
                value === o ? 'text-primary' : 'text-text'
              }`}
            >
              {o}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// Chip-style multi-value input for subtopic tags.
function ChipInput({
  values,
  suggestions,
  placeholder,
  onChange,
}: {
  values: string[]
  suggestions: string[]
  placeholder: string
  onChange: (v: string[]) => void
}) {
  const [input, setInput] = useState('')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const normalise = (v: string) => v.trim().toUpperCase().replace(/\s+/g, '_')

  const add = (raw: string) => {
    const tag = normalise(raw)
    if (tag && !values.includes(tag)) onChange([...values, tag])
    setInput('')
    setOpen(false)
  }

  const remove = (tag: string) => onChange(values.filter((v) => v !== tag))

  const filtered = suggestions.filter(
    (s) => s.toLowerCase().includes(input.toLowerCase()) && !values.includes(s),
  )

  return (
    <div ref={ref} className="relative">
      {values.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {values.map((tag) => (
            <span
              key={tag}
              className="flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-mono text-primary"
            >
              {tag}
              <button
                onClick={() => remove(tag)}
                className="ml-0.5 leading-none text-primary/60 hover:text-primary"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-1">
        <input
          value={input}
          onChange={(e) => { setInput(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ',') && input.trim()) {
              e.preventDefault()
              add(input)
            }
          }}
          placeholder={placeholder}
          className="flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-primary"
        />
        <button
          onClick={() => { if (input.trim()) add(input) }}
          className="rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-text"
        >
          Add
        </button>
      </div>
      {open && filtered.length > 0 && (
        <ul className="absolute z-50 mt-1 max-h-40 w-full overflow-auto rounded-lg border border-border bg-surface shadow-lg">
          {filtered.map((s) => (
            <li
              key={s}
              onMouseDown={(e) => { e.preventDefault(); add(s) }}
              className="cursor-pointer px-3 py-2 text-sm text-text hover:bg-primary/10"
            >
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function RunConfigPanel({
  config,
  onChange,
  estimate,
  canGenerate,
  onGenerate,
  notice,
  availableTags = [],
  availableCourses = [],
  availableSubTopics = [],
}: Props) {
  const toggleType = (t: QuestionType) => {
    const next = config.types.includes(t)
      ? config.types.filter((x) => x !== t)
      : [...config.types, t]
    if (next.length) onChange({ types: next })
  }

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <h3 className="mb-4 font-semibold">Run Configuration</h3>

      {/* ── Basic settings ── */}
      <label className="block text-sm text-muted">Number of Questions</label>
      <input
        type="number"
        min={1}
        max={200}
        value={config.count}
        onChange={(e) =>
          onChange({ count: Math.max(1, Math.min(200, Number(e.target.value) || 1)) })
        }
        className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-primary"
      />

      <label className="mt-4 block text-sm text-muted">Difficulty</label>
      <div className="mt-1 flex gap-1">
        {DIFFICULTIES.map((d) => (
          <button
            key={d}
            onClick={() => onChange({ difficulty: d })}
            className={`flex-1 rounded-lg px-2 py-1.5 text-sm capitalize ${
              config.difficulty === d
                ? 'bg-primary text-white'
                : 'border border-border text-muted hover:text-text'
            }`}
          >
            {d}
          </button>
        ))}
      </div>

      <label className="mt-4 block text-sm text-muted">Question Type</label>
      <div className="mt-1 flex gap-1">
        {TYPES.map((t) => (
          <button
            key={t.id}
            onClick={() => toggleType(t.id)}
            className={`flex-1 rounded-lg px-2 py-1.5 text-sm ${
              config.types.includes(t.id)
                ? 'border border-primary bg-primary/15 text-primary'
                : 'border border-border text-muted hover:text-text'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Tagging section ── */}
      <div className="mt-5 border-t border-border pt-4">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
          Tagging
        </p>

        <label className="block text-sm text-muted">Run Name</label>
        <input
          value={config.runName}
          onChange={(e) => onChange({ runName: e.target.value })}
          placeholder="e.g. Week 3 SLAM basics"
          className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-primary"
        />

        <label className="mt-3 block text-sm text-muted">
          Topic Tag
          <span className="ml-1 text-xs text-muted/60">(select or type new)</span>
        </label>
        <Combobox
          value={config.topicTag}
          options={availableTags}
          placeholder="e.g. SLAM"
          onChange={(v) => onChange({ topicTag: v.toUpperCase().replace(/ /g, '_') })}
        />

        <label className="mt-3 block text-sm text-muted">
          Sub-topics
          <span className="ml-1 text-xs text-muted/60">(Enter or comma to add · each question is tagged to the best match)</span>
        </label>
        <div className="mt-1">
          <ChipInput
            values={config.subtopics}
            suggestions={availableSubTopics}
            placeholder="e.g. MQTT_PROTOCOL"
            onChange={(v) => onChange({ subtopics: v })}
          />
        </div>

        <label className="mt-3 block text-sm text-muted">
          Course
          <span className="ml-1 text-xs text-muted/60">(select or type new)</span>
        </label>
        <Combobox
          value={config.course}
          options={availableCourses}
          placeholder="e.g. GRIT_ROBOTICS_L1_MAIN"
          onChange={(v) => onChange({ course: v.toUpperCase().replace(/ /g, '_') })}
        />

        <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm">
          <div
            onClick={() => onChange({ isPublic: !config.isPublic })}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              config.isPublic ? 'bg-primary' : 'bg-border'
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
                config.isPublic ? 'translate-x-[18px]' : 'translate-x-[3px]'
              }`}
            />
          </div>
          <span className="text-muted">
            {config.isPublic ? 'Public (IS_PUBLIC in tags)' : 'Private (IS_PUBLIC omitted)'}
          </span>
        </label>

        {/* Tag preview */}
        {config.topicTag && (
          <div className="mt-3 rounded-lg border border-border bg-bg px-3 py-2">
            <p className="mb-1 text-xs text-muted">
              Tag preview per question
              {config.subtopics.length > 0 && (
                <span className="ml-1 text-primary/80">(sub_topic assigned by LLM)</span>
              )}
            </p>
            <div className="flex flex-wrap gap-1">
              {[
                config.subtopics.length > 0 ? `<one of ${config.subtopics.length} sub-topics>` : config.topicTag,
                '<BLOOM_LEVEL>',
                ...(config.isPublic ? ['IS_PUBLIC'] : []),
                config.course || '…',
              ].map((t, i) => (
                <span
                  key={i}
                  className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-mono text-primary"
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Estimate + Generate ── */}
      <div className="mt-5 rounded-lg border border-border bg-bg p-3 text-sm">
        <p className="text-muted">
          Pre-flight estimate <span className="text-xs">(heuristic)</span>
        </p>
        <p className="mt-1 font-medium">
          {estimate
            ? `~$${estimate.cost.toFixed(3)} · ~${Math.round(estimate.tokens / 1000)}k tokens`
            : '—'}
        </p>
      </div>

      <button
        disabled={!canGenerate}
        onClick={onGenerate}
        className={`mt-5 w-full rounded-lg px-4 py-3 font-semibold transition-colors ${
          canGenerate
            ? 'bg-primary text-white hover:bg-primary/90'
            : 'cursor-not-allowed bg-border text-muted'
        }`}
      >
        Generate {config.count} {config.count === 1 ? 'question' : 'questions'}
      </button>
      {notice && <p className="mt-2 text-center text-xs text-muted">{notice}</p>}
    </div>
  )
}
