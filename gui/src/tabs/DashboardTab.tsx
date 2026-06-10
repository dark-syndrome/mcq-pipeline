import { useEffect, useState } from 'react'
import ChartCard from '../dashboard/ChartCard'
import KpiStrip from '../dashboard/KpiStrip'
import CostPerRunChart from '../dashboard/charts/CostPerRunChart'
import CriticHeatmapChart from '../dashboard/charts/CriticHeatmap'
import CumulativeCostChart from '../dashboard/charts/CumulativeCostChart'
import DifficultyDistributionChart from '../dashboard/charts/DifficultyDistributionChart'
import CostPerQuestionChart from '../dashboard/charts/CostPerQuestionChart'
import QuestionsPerGenerationChart from '../dashboard/charts/QuestionsPerGenerationChart'
import ReframerClassChart from '../dashboard/charts/ReframerClassChart'
import TokenUsageChart from '../dashboard/charts/TokenUsageChart'
import TypeDistributionChart from '../dashboard/charts/TypeDistributionChart'
import ValidatorFailureChart from '../dashboard/charts/ValidatorFailureChart'
import RunHistoryTable from '../dashboard/RunHistoryTable'
import { COLORS } from '../dashboard/palette'
import type {
  CacheHitRate,
  CostPerQuestionPoint,
  CostPoint,
  CriticHeatmap,
  CumulativeCost,
  DashboardKpis,
  DifficultySlice,
  GenerationBar,
  LinterCheckStat,
  ReframerClassSlice,
  RunHistoryRow,
  SourceLinterStats,
  TokenUsageByStage,
  TypeSlice,
  ValidatorFailure,
} from '../types'

const SUBTABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'quality', label: 'Quality' },
  { id: 'cost', label: 'Cost & Tokens' },
  { id: 'history', label: 'Run History' },
] as const

interface DashData {
  // Sub-tab 1 — Overview
  kpis: DashboardKpis
  perGen: GenerationBar[]
  types: TypeSlice[]
  difficulties: DifficultySlice[]
  cost: CostPoint[]
  // Sub-tab 2 — Quality
  heatmap: CriticHeatmap
  validatorFailures: ValidatorFailure[]
  reframerClasses: ReframerClassSlice[]
  linterStats: SourceLinterStats
  // Sub-tab 3 — Cost & Tokens
  cumulativeCost: CumulativeCost
  tokenUsage: TokenUsageByStage
  costPerQuestion: CostPerQuestionPoint[]
  cacheHitRate: CacheHitRate
  // Sub-tab 4 — Run History
  history: RunHistoryRow[]
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
      window.api.db.criticCriteriaHeatmap(10),
      window.api.db.validatorFailureBreakdown(),
      window.api.db.reframerClassBreakdown(),
      window.api.db.sourceLinterStats(),
      window.api.db.cumulativeCost(),
      window.api.db.tokenUsageByStage(15),
      window.api.db.costPerAcceptedQuestion(),
      window.api.db.analyzerCacheHitRate(),
      window.api.db.runHistory(),
    ])
      .then(
        ([
          kpis, perGen, types, difficulties, cost,
          heatmap, validatorFailures, reframerClasses, linterStats,
          cumulativeCost, tokenUsage, costPerQuestion, cacheHitRate,
          history,
        ]) =>
          setData({
            kpis, perGen, types, difficulties, cost,
            heatmap, validatorFailures, reframerClasses, linterStats,
            cumulativeCost, tokenUsage, costPerQuestion, cacheHitRate,
            history,
          }),
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
                onClick={() => setSub(t.id)}
                className={`relative px-4 py-2 text-sm ${
                  sub === t.id ? 'text-text' : 'text-muted hover:text-text'
                }`}
              >
                {t.label}
                {sub === t.id && (
                  <span className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-primary" />
                )}
              </button>
            ))}
          </div>

          {/* ── Sub-Tab 1: Overview ── */}
          {sub === 'overview' && (
            <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <QuestionsPerGenerationChart data={data.perGen} />
              <TypeDistributionChart data={data.types} />
              <CostPerRunChart data={data.cost} />
              <DifficultyDistributionChart data={data.difficulties} />
            </div>
          )}

          {/* ── Sub-Tab 2: Quality ── */}
          {sub === 'quality' && (
            <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <ValidatorFailureChart data={data.validatorFailures} />
              <ReframerClassChart data={data.reframerClasses} />
              <CriticHeatmapChart data={data.heatmap} />
              <LinterStatsTable data={data.linterStats} />
            </div>
          )}

          {/* ── Sub-Tab 3: Cost & Tokens ── */}
          {sub === 'cost' && (
            <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <CumulativeCostChart data={data.cumulativeCost} />
              <CacheHitRateCard data={data.cacheHitRate} />
              <div className="col-span-2">
                <TokenUsageChart data={data.tokenUsage} />
              </div>
              <div className="col-span-2">
                <CostPerQuestionChart data={data.costPerQuestion} />
              </div>
            </div>
          )}

          {/* ── Sub-Tab 4: Run History ── */}
          {sub === 'history' && (
            <div className="mt-6">
              <RunHistoryTable rows={data.history} />
            </div>
          )}
        </>
      )}
    </div>
  )
}

// --- Inline sub-components (file-scoped, not exported) ---

function LinterStatsTable({ data }: { data: SourceLinterStats }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold">Source Linter Stats</h3>
        <p className="mt-0.5 text-xs text-muted">
          {data.reports === 0
            ? 'No quality reports — requires output/*_source_quality.json'
            : `${data.reports} run${data.reports !== 1 ? 's' : ''} with source quality reports`}
        </p>
      </div>
      {data.perCheck.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-sm text-muted">
          No data yet.
        </div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border">
              <th className="py-2 text-left font-medium text-muted">Check</th>
              <th className="py-2 text-right font-medium" style={{ color: COLORS.success }}>
                PASS
              </th>
              <th className="py-2 text-right font-medium" style={{ color: COLORS.warning }}>
                WARN
              </th>
              <th className="py-2 text-right font-medium" style={{ color: COLORS.danger }}>
                FAIL
              </th>
            </tr>
          </thead>
          <tbody>
            {data.perCheck.map((r: LinterCheckStat) => (
              <tr key={r.name} className="border-b border-border/50">
                <td className="py-1.5 font-mono">{r.name}</td>
                <td
                  className="py-1.5 text-right"
                  style={{ color: r.PASS ? COLORS.success : COLORS.muted }}
                >
                  {r.PASS || '—'}
                </td>
                <td
                  className="py-1.5 text-right"
                  style={{ color: r.WARN ? COLORS.warning : COLORS.muted }}
                >
                  {r.WARN || '—'}
                </td>
                <td
                  className="py-1.5 text-right"
                  style={{ color: r.FAIL ? COLORS.danger : COLORS.muted }}
                >
                  {r.FAIL || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function CacheHitRateCard({ data }: { data: CacheHitRate }) {
  const pct = data.rate != null ? data.rate * 100 : null
  const rateColor =
    pct === null ? COLORS.muted
    : pct === 100 ? COLORS.success
    : pct > 50 ? COLORS.warning
    : COLORS.danger

  return (
    <div className="flex flex-col rounded-xl border border-border bg-surface p-4">
      <div className="mb-1">
        <h3 className="text-sm font-semibold">Analyzer Cache Hit Rate</h3>
        <p className="mt-0.5 text-xs text-muted">
          {data.total === 0
            ? 'No output files — requires output/*_run_config.json'
            : `${data.total} run${data.total !== 1 ? 's' : ''} with output files · target: 100%`}
        </p>
      </div>
      {data.total === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">
          No data yet.
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 pt-4">
          <div className="text-5xl font-bold" style={{ color: rateColor }}>
            {pct != null ? `${pct.toFixed(0)}%` : '—'}
          </div>
          <p className="text-xs text-muted">
            {data.hits} / {data.total} runs used the concept-map cache
          </p>
          <div className="h-2 w-full max-w-xs overflow-hidden rounded-full bg-border">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${pct ?? 0}%`,
                background: rateColor,
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
