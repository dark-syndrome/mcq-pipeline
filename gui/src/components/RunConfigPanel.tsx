import type { Difficulty, QuestionType } from '../types'

export interface RunConfig {
  count: number
  difficulty: Difficulty
  types: QuestionType[]
  topic: string
}

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard', 'expert']
const TYPES: { id: QuestionType; label: string }[] = [
  { id: 'single_correct', label: 'SC' },
  { id: 'ordering', label: 'Ordering' },
  { id: 'code_snippet', label: 'Code' },
]

interface Props {
  config: RunConfig
  onChange: (patch: Partial<RunConfig>) => void
  estimate: { tokens: number; cost: number } | null
  canGenerate: boolean
  onGenerate: () => void
  notice?: string | null
}

// Phase 2 run configuration (§6.1). These override config.yaml for this run only.
export default function RunConfigPanel({
  config,
  onChange,
  estimate,
  canGenerate,
  onGenerate,
  notice,
}: Props) {
  const toggleType = (t: QuestionType) => {
    const next = config.types.includes(t)
      ? config.types.filter((x) => x !== t)
      : [...config.types, t]
    if (next.length) onChange({ types: next }) // keep at least one selected
  }

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <h3 className="mb-4 font-semibold">Run Configuration</h3>

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

      <label className="mt-4 block text-sm text-muted">Topic Label</label>
      <input
        value={config.topic}
        onChange={(e) => onChange({ topic: e.target.value })}
        placeholder="e.g. MQTT Protocol"
        className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-primary"
      />

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
