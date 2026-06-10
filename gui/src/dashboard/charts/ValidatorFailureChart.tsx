import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts'
import type { ValidatorFailure } from '../../types'
import ChartCard from '../ChartCard'
import { COLORS, TOOLTIP_STYLE } from '../palette'

export default function ValidatorFailureChart({ data }: { data: ValidatorFailure[] }) {
  return (
    <ChartCard
      title="Validator Failure Breakdown"
      subtitle="Issue occurrences across all rejected questions"
      empty={data.length === 0}
    >
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 80 }}>
        <CartesianGrid stroke={COLORS.border} horizontal={false} />
        <XAxis type="number" stroke={COLORS.muted} fontSize={11} tickLine={false} allowDecimals={false} />
        <YAxis
          dataKey="validator"
          type="category"
          stroke={COLORS.muted}
          fontSize={11}
          tickLine={false}
          width={80}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE.contentStyle}
          labelStyle={TOOLTIP_STYLE.labelStyle}
          itemStyle={TOOLTIP_STYLE.itemStyle}
          cursor={{ fill: COLORS.border, opacity: 0.3 }}
        />
        <Bar dataKey="count" fill={COLORS.danger} name="Failures" radius={[0, 3, 3, 0]} />
      </BarChart>
    </ChartCard>
  )
}
