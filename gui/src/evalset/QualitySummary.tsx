import type { EvalQuestion } from '../types'

export default function QualitySummary({ questions }: { questions: EvalQuestion[] }) {
  const annotated = questions.filter((q) => q.annotation.confirmed !== null)
  const confirmed = questions.filter((q) => q.annotation.confirmed === true)
  const flagged = questions.filter((q) => q.annotation.confirmed === false)
  const rated = questions.filter((q) => q.annotation.rating > 0)
  const avgRating = rated.length
    ? rated.reduce((s, q) => s + q.annotation.rating, 0) / rated.length
    : null

  const falsePositiveRate = annotated.length ? (flagged.length / annotated.length) * 100 : null

  // Breakdown of flagged questions by dimension (for actionable guidance)
  const byDiff = groupCount(flagged, (q) => q.difficulty)
  const byBloom = groupCount(flagged, (q) => q.bloom_level)

  const topFlaggedBloom =
    Object.entries(byBloom).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <h3 className="mb-4 text-sm font-semibold">Quality Summary</h3>

      {/* KPI row */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total in Set" value={questions.length} />
        <StatCard
          label="Annotated"
          value={`${annotated.length} / ${questions.length}`}
          hint={`${questions.length - annotated.length} unannotated`}
        />
        <StatCard
          label="Critic False Positives"
          value={
            flagged.length > 0
              ? `${flagged.length} (${falsePositiveRate?.toFixed(0)}%)`
              : '0'
          }
          color={flagged.length > 0 ? 'danger' : 'success'}
          hint="Accepted by Critic · flagged Wrong by reviewer"
        />
        <StatCard
          label="Avg Quality Rating"
          value={avgRating != null ? `${avgRating.toFixed(1)} / 5` : '—'}
          hint={rated.length ? `${rated.length} rated · ${confirmed.length} confirmed correct` : 'No ratings yet'}
        />
      </div>

      {/* Breakdown (only when there are false positives) */}
      {flagged.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-3">
          <BreakdownTable title="Flagged by Difficulty" data={byDiff} />
          <BreakdownTable title="Flagged by Bloom Level" data={byBloom} />
        </div>
      )}

      {/* Recommendation */}
      {falsePositiveRate !== null && (
        <div
          className={`rounded border p-3 text-xs ${
            falsePositiveRate === 0
              ? 'border-success/30 bg-success/10 text-success'
              : falsePositiveRate < 15
                ? 'border-warning/30 bg-warning/10 text-warning'
                : 'border-danger/30 bg-danger/10 text-danger'
          }`}
        >
          {falsePositiveRate === 0
            ? '✓ No false positives — Critic correctly accepted all annotated questions.'
            : falsePositiveRate < 15
              ? `ℹ Critic false positive rate is low (${falsePositiveRate.toFixed(0)}%).${topFlaggedBloom ? ` Consider reviewing ${topFlaggedBloom} Bloom-level Critic criteria.` : ''}`
              : `⚠ Critic false positive rate is ${falsePositiveRate.toFixed(0)}%. Consider tightening${topFlaggedBloom ? ` ${topFlaggedBloom} Bloom-level` : ''} Critic criteria or reducing source_grounding_threshold.`}
        </div>
      )}
    </div>
  )
}

function groupCount<T>(items: T[], key: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    const k = key(item)
    acc[k] = (acc[k] ?? 0) + 1
    return acc
  }, {})
}

function StatCard({
  label,
  value,
  color,
  hint,
}: {
  label: string
  value: string | number
  color?: 'success' | 'danger'
  hint?: string
}) {
  return (
    <div className="rounded border border-border bg-bg px-3 py-2">
      <div className="text-[10px] text-muted">{label}</div>
      <div
        className={`mt-0.5 text-sm font-semibold ${
          color === 'success'
            ? 'text-success'
            : color === 'danger'
              ? 'text-danger'
              : 'text-text'
        }`}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[10px] text-muted">{hint}</div>}
    </div>
  )
}

function BreakdownTable({
  title,
  data,
}: {
  title: string
  data: Record<string, number>
}) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) return null
  return (
    <div>
      <p className="mb-1.5 text-xs text-muted">{title}</p>
      <div className="space-y-1">
        {entries.map(([k, n]) => (
          <div key={k} className="flex justify-between text-xs">
            <span>{k}</span>
            <span className="text-danger">{n}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
