import type { DashboardKpis } from '../types'

// §4.1 — horizontal strip of six global metric cards.
function Card({
  label,
  value,
  hint,
  accent,
}: {
  label: string
  value: string
  hint?: string
  accent?: string
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div
        className="mt-2 text-2xl font-bold"
        style={accent ? { color: accent } : undefined}
        title={hint}
      >
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  )
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`
const usd = (n: number) => `$${n.toFixed(n < 0.1 ? 4 : 2)}`

export default function KpiStrip({ kpis }: { kpis: DashboardKpis }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <Card label="Total Questions in Bank" value={String(kpis.totalQuestions)} />
      <Card
        label="Overall Acceptance Rate"
        value={pct(kpis.acceptanceRate)}
        accent="#10b981"
        hint={`${kpis.accepted} accepted`}
      />
      <Card
        label="Critic Rejection Rate"
        value={pct(kpis.rejectionRate)}
        accent="#ef4444"
        hint={`${kpis.rejected} rejected`}
      />
      <Card
        label="Reframer Salvage Rate"
        value={kpis.salvageRate === null ? '—' : pct(kpis.salvageRate)}
        hint={kpis.salvageRate === null ? 'not persisted in DB' : undefined}
      />
      <Card
        label="Total API Cost (All Runs)"
        value={usd(kpis.totalCost)}
        accent="#f59e0b"
      />
      <Card label="Avg Cost Per Question" value={usd(kpis.avgCostPerQuestion)} />
    </div>
  )
}
