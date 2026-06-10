import { CartesianGrid, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts'
import type { CostPerQuestionPoint } from '../../types'
import ChartCard from '../ChartCard'
import { COLORS, TOOLTIP_STYLE } from '../palette'

function CustomTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: { payload: CostPerQuestionPoint }[]
}) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div style={TOOLTIP_STYLE.contentStyle}>
      <div style={{ color: COLORS.muted }}>Gen #{d.generation_number}</div>
      <div style={{ color: COLORS.text }}>Requested: {d.requested}</div>
      <div style={{ color: COLORS.success }}>Accepted: {d.accepted}</div>
      <div style={{ color: COLORS.primary }}>${d.costPerQuestion.toFixed(5)} / question</div>
    </div>
  )
}

export default function CostPerQuestionChart({ data }: { data: CostPerQuestionPoint[] }) {
  return (
    <ChartCard
      title="Cost per Accepted Question"
      subtitle="Each point is a run · X = questions requested · Y = $/question"
      empty={data.length === 0}
    >
      <ScatterChart margin={{ top: 8, right: 8, bottom: 0, left: -4 }}>
        <CartesianGrid stroke={COLORS.border} />
        <XAxis
          dataKey="requested"
          type="number"
          name="Requested"
          stroke={COLORS.muted}
          fontSize={11}
          tickLine={false}
          label={{ value: 'questions requested', position: 'insideBottom', offset: -2, fontSize: 10, fill: COLORS.muted }}
        />
        <YAxis
          dataKey="costPerQuestion"
          type="number"
          name="$/question"
          stroke={COLORS.muted}
          fontSize={11}
          tickLine={false}
          tickFormatter={(v) => `$${Number(v).toFixed(4)}`}
        />
        <Tooltip content={<CustomTooltip />} cursor={{ strokeDasharray: '3 3' }} />
        <Scatter data={data} fill={COLORS.primary} opacity={0.85} />
      </ScatterChart>
    </ChartCard>
  )
}
