import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { GenerationBar } from '../../types'
import { COLORS, TOOLTIP_STYLE } from '../palette'
import ChartCard from '../ChartCard'

// §4.2 chart 1 — accepted vs rejected stacked per generation. Tooltip surfaces
// the run_id + timestamp for the hovered bar.
function CustomTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: { payload: GenerationBar }[]
}) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div style={TOOLTIP_STYLE.contentStyle}>
      <div style={{ color: COLORS.muted }}>
        Gen #{d.generation_number} · {d.timestamp}
      </div>
      <div style={{ color: COLORS.muted, fontSize: 11 }}>{d.run_id}</div>
      <div style={{ color: COLORS.success }}>Accepted: {d.accepted}</div>
      <div style={{ color: COLORS.danger }}>Rejected: {d.rejected}</div>
    </div>
  )
}

export default function QuestionsPerGenerationChart({
  data,
}: {
  data: GenerationBar[]
}) {
  return (
    <ChartCard
      title="Questions Per Generation"
      subtitle={`Accepted vs rejected · last ${data.length} runs`}
      empty={data.length === 0}
    >
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
        <CartesianGrid stroke={COLORS.border} vertical={false} />
        <XAxis
          dataKey="generation_number"
          stroke={COLORS.muted}
          fontSize={11}
          tickLine={false}
        />
        <YAxis stroke={COLORS.muted} fontSize={11} tickLine={false} allowDecimals={false} />
        <Tooltip content={<CustomTooltip />} cursor={{ fill: COLORS.border, opacity: 0.3 }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="accepted" stackId="q" fill={COLORS.success} name="Accepted" />
        <Bar dataKey="rejected" stackId="q" fill={COLORS.danger} name="Rejected" />
      </BarChart>
    </ChartCard>
  )
}
