// Small colored pill for difficulty / bloom / type metadata (§5.5 cards & table).
// Colors map to the §8.3 palette tokens defined in tailwind.config.js.

const DIFFICULTY_CLASS: Record<string, string> = {
  easy: 'bg-success/15 text-success border-success/30',
  medium: 'bg-primary/15 text-primary border-primary/30',
  hard: 'bg-warning/15 text-warning border-warning/30',
  expert: 'bg-danger/15 text-danger border-danger/30',
}

const TYPE_LABEL: Record<string, string> = {
  single_correct: 'SC',
  ordering: 'Ordering',
  code_snippet: 'Code',
}

export function DifficultyBadge({ value }: { value: string }) {
  const cls =
    DIFFICULTY_CLASS[value] ?? 'bg-border text-muted border-border'
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[11px] font-medium capitalize ${cls}`}
    >
      {value || '—'}
    </span>
  )
}

export function BloomBadge({ value }: { value: string }) {
  return (
    <span className="rounded border border-border bg-bg px-1.5 py-0.5 text-[11px] capitalize text-muted">
      {value || '—'}
    </span>
  )
}

export function TypeBadge({ value }: { value: string }) {
  return (
    <span className="rounded border border-border bg-bg px-1.5 py-0.5 text-[11px] text-muted">
      {TYPE_LABEL[value] ?? (value || '—')}
    </span>
  )
}
