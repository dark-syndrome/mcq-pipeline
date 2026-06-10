import { Bar, BarChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from 'recharts'
import type { TokenUsageByStage } from '../../types'
import ChartCard from '../ChartCard'
import { COLORS, TOOLTIP_STYLE } from '../palette'

const STAGE_COLORS: Record<string, string> = {
  analyzer: COLORS.primary,
  generator: COLORS.success,
  critic: COLORS.warning,
  reframer: '#a855f7',
}

export default function TokenUsageChart({ data }: { data: TokenUsageByStage }) {
  const { rows, coverage } = data
  const chartRows = rows.map((r) => ({
    label: r.run_label,
    analyzer: r.analyzer_in + r.analyzer_out,
    generator: r.generator_in + r.generator_out,
    critic: r.critic_in + r.critic_out,
    reframer: r.reframer_in + r.reframer_out,
  }))
  return (
    <ChartCard
      title="Token Usage by Stage"
      subtitle={
        coverage.withFiles === 0
          ? 'No output files found — requires output/*_run_config.json'
          : `${coverage.withFiles} run${coverage.withFiles !== 1 ? 's' : ''} with output files (real per-stage split)`
      }
      empty={rows.length === 0}
    >
      <BarChart data={chartRows} margin={{ top: 8, right: 8, bottom: 30, left: 0 }}>
        <CartesianGrid stroke={COLORS.border} vertical={false} />
        <XAxis
          dataKey="label"
          stroke={COLORS.muted}
          fontSize={10}
          tickLine={false}
          angle={-35}
          textAnchor="end"
          interval={0}
        />
        <YAxis stroke={COLORS.muted} fontSize={11} tickLine={false} allowDecimals={false} />
        <Tooltip
          contentStyle={TOOLTIP_STYLE.contentStyle}
          labelStyle={TOOLTIP_STYLE.labelStyle}
          itemStyle={TOOLTIP_STYLE.itemStyle}
          formatter={(v) => [Number(v).toLocaleString(), '']}
        />
        <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
        {(['analyzer', 'generator', 'critic', 'reframer'] as const).map((s) => (
          <Bar key={s} dataKey={s} stackId="tok" fill={STAGE_COLORS[s]} name={s} />
        ))}
      </BarChart>
    </ChartCard>
  )
}
