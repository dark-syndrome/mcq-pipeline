import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { CumulativeCost } from '../../types'
import ChartCard from '../ChartCard'
import { COLORS, TOOLTIP_STYLE } from '../palette'

export default function CumulativeCostChart({ data }: { data: CumulativeCost }) {
  const { points, slope, intercept } = data
  if (points.length === 0) {
    return (
      <ChartCard title="Cumulative Cost Trend" empty>
        <span />
      </ChartCard>
    )
  }

  // Append 3 forecast points beyond the last run.
  const lastIdx = points.length - 1
  const forecast = [0, 1, 2, 3].map((d) => ({
    generation_number: points[lastIdx].generation_number + d,
    cumulative: undefined as number | undefined,
    forecast: Number((intercept + slope * (lastIdx + d)).toFixed(6)),
  }))
  const chartData = points.map((p, i) => ({
    ...p,
    forecast: Number((intercept + slope * i).toFixed(6)),
  }))
  // splice in extra forecast-only points
  const extra = forecast.slice(1).map((f) => ({
    generation_number: f.generation_number,
    cumulative: undefined,
    forecast: f.forecast,
    run_id: '',
    timestamp: '',
  }))

  return (
    <ChartCard
      title="Cumulative Cost Trend"
      subtitle="Total API spend over time with linear forecast"
    >
      <AreaChart
        data={[...chartData, ...extra]}
        margin={{ top: 8, right: 8, bottom: 0, left: -4 }}
      >
        <defs>
          <linearGradient id="cumGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={COLORS.primary} stopOpacity={0.3} />
            <stop offset="95%" stopColor={COLORS.primary} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={COLORS.border} vertical={false} />
        <XAxis dataKey="generation_number" stroke={COLORS.muted} fontSize={11} tickLine={false} />
        <YAxis
          stroke={COLORS.muted}
          fontSize={11}
          tickLine={false}
          tickFormatter={(v) => `$${Number(v).toFixed(2)}`}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE.contentStyle}
          labelStyle={TOOLTIP_STYLE.labelStyle}
          itemStyle={TOOLTIP_STYLE.itemStyle}
          formatter={(v, name) => [`$${Number(v)?.toFixed(4) ?? '—'}`, String(name) === 'cumulative' ? 'Actual' : 'Forecast']}
        />
        <Area
          type="monotone"
          dataKey="cumulative"
          stroke={COLORS.primary}
          fill="url(#cumGrad)"
          dot={false}
          connectNulls={false}
          name="cumulative"
        />
        <Area
          type="monotone"
          dataKey="forecast"
          stroke={COLORS.muted}
          strokeDasharray="4 3"
          fill="none"
          dot={false}
          connectNulls
          name="forecast"
        />
        {points.length >= 2 && (
          <ReferenceLine
            x={points[lastIdx].generation_number}
            stroke={COLORS.border}
            strokeDasharray="3 3"
          />
        )}
      </AreaChart>
    </ChartCard>
  )
}
