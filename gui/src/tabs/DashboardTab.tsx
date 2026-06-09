import { useEffect, useState } from 'react'
import KpiStrip from '../dashboard/KpiStrip'
import CostPerRunChart from '../dashboard/charts/CostPerRunChart'
import DifficultyDistributionChart from '../dashboard/charts/DifficultyDistributionChart'
import QuestionsPerGenerationChart from '../dashboard/charts/QuestionsPerGenerationChart'
import TypeDistributionChart from '../dashboard/charts/TypeDistributionChart'
import type {
  CostPoint,
  DashboardKpis,
  DifficultySlice,
  GenerationBar,
  TypeSlice,
} from '../types'

// Sub-tab row (§4.2). Only Overview is built this session; 2–4 land in Session 9.
const SUBTABS = [
  { id: 'overview', label: 'Overview', enabled: true },
  { id: 'quality', label: 'Quality', enabled: false },
  { id: 'cost', label: 'Cost & Tokens', enabled: false },
  { id: 'history', label: 'Run History', enabled: false },
] as const

interface DashData {
  kpis: DashboardKpis
  perGen: GenerationBar[]
  types: TypeSlice[]
  difficulties: DifficultySlice[]
  cost: CostPoint[]
}

export default function DashboardTab() {
  const [data, setData] = useState<DashData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sub, setSub] = useState<string>('overview')

  useEffect(() => {
    if (!window.api) return
    Promise.all([
      window.api.db.dashboardKpis(),
      window.api.db.questionsPerGeneration(15),
      window.api.db.typeDistribution(),
      window.api.db.difficultyDistribution(),
      window.api.db.costPerRun(15),
    ])
      .then(([kpis, perGen, types, difficulties, cost]) =>
        setData({ kpis, perGen, types, difficulties, cost }),
      )
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  return (
    <div className="px-10 py-8">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <p className="mt-1 text-sm text-muted">
        Operational analytics across all runs. Reads from logs/runs.db.
      </p>

      {error && (
        <div className="mt-6 rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          {error}
        </div>
      )}

      {!error && !data && (
        <div className="mt-8 text-muted">Loading analytics…</div>
      )}

      {data && (
        <>
          <div className="mt-6">
            <KpiStrip kpis={data.kpis} />
          </div>

          {/* §4.2 sub-tab row */}
          <div className="mt-8 flex gap-1 border-b border-border">
            {SUBTABS.map((t) => (
              <button
                key={t.id}
                disabled={!t.enabled}
                onClick={() => t.enabled && setSub(t.id)}
                className={`relative px-4 py-2 text-sm ${
                  sub === t.id
                    ? 'text-text'
                    : t.enabled
                      ? 'text-muted hover:text-text'
                      : 'cursor-not-allowed text-muted/50'
                }`}
                title={t.enabled ? undefined : 'Built in Session 9'}
              >
                {t.label}
                {!t.enabled && (
                  <span className="ml-1 text-[10px] text-muted/60">(Session 9)</span>
                )}
                {sub === t.id && (
                  <span className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-primary" />
                )}
              </button>
            ))}
          </div>

          {/* Sub-Tab 1 — Overview: two-column, four charts */}
          {sub === 'overview' && (
            <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <QuestionsPerGenerationChart data={data.perGen} />
              <TypeDistributionChart data={data.types} />
              <CostPerRunChart data={data.cost} />
              <DifficultyDistributionChart data={data.difficulties} />
            </div>
          )}
        </>
      )}
    </div>
  )
}
