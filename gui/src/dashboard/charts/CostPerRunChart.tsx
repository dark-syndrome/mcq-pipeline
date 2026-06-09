import {
  CartesianGrid,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { CostPoint } from '../../types'
import { COLORS, TOOLTIP_STYLE } from '../palette'
import ChartCard from '../ChartCard'

// §4.2 chart 3 — total USD cost per run. Per-stage (analyzer/generator/critic)
// split is NOT persisted in the DB, so this is a single total-cost line; the
// subtitle documents that. Live per-stage breakdown is only on run_complete.
export default function CostPerRunChart({ data }: { data: CostPoint[] }) {
  return (
    <ChartCard
      title="Cost Per Run"
      subtitle={`Total USD · last ${data.length} runs (per-stage split not persisted)`}
      empty={data.length === 0}
    >
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
        <CartesianGrid stroke={COLORS.border} vertical={false} />
        <XAxis
          dataKey="generation_number"
          stroke={COLORS.muted}
          fontSize={11}
          tickLine={false}
        />
        <YAxis
          stroke={COLORS.muted}
          fontSize={11}
          tickLine={false}
          tickFormatter={(v: number) => `$${v.toFixed(2)}`}
          width={56}
        />
        <Tooltip
          formatter={(v) => [`$${Number(v).toFixed(4)}`, 'Cost']}
          labelFormatter={(l) => `Gen #${l}`}
          {...TOOLTIP_STYLE}
        />
        <Line
          type="monotone"
          dataKey="cost_usd"
          stroke={COLORS.warning}
          strokeWidth={2}
          dot={{ r: 3, fill: COLORS.warning }}
          name="Total cost"
        />
      </LineChart>
    </ChartCard>
  )
}
