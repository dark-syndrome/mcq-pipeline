import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { DifficultySlice } from '../../types'
import { COLORS, DIFFICULTY_COLOR, TOOLTIP_STYLE } from '../palette'
import ChartCard from '../ChartCard'

const ORDER = ['easy', 'medium', 'hard', 'expert']

// §4.2 chart 4 — difficulty distribution (horizontal bars) with count + %.
export default function DifficultyDistributionChart({
  data,
}: {
  data: DifficultySlice[]
}) {
  const total = data.reduce((s, d) => s + d.count, 0)
  const rows = [...data].sort(
    (a, b) => ORDER.indexOf(String(a.difficulty)) - ORDER.indexOf(String(b.difficulty)),
  )
  return (
    <ChartCard
      title="Difficulty Distribution"
      subtitle={`${total} accepted questions`}
      empty={total === 0}
    >
      <BarChart
        layout="vertical"
        data={rows}
        margin={{ top: 4, right: 48, bottom: 4, left: 8 }}
      >
        <XAxis type="number" hide allowDecimals={false} />
        <YAxis
          type="category"
          dataKey="difficulty"
          stroke={COLORS.muted}
          fontSize={12}
          tickLine={false}
          axisLine={false}
          width={64}
        />
        <Tooltip
          formatter={(v) => {
            const c = Number(v)
            return [`${c} (${total ? ((c / total) * 100).toFixed(1) : 0}%)`, 'Count']
          }}
          cursor={{ fill: COLORS.border, opacity: 0.3 }}
          {...TOOLTIP_STYLE}
        />
        <Bar dataKey="count" radius={[0, 4, 4, 0]}>
          {rows.map((d, i) => (
            <Cell
              key={i}
              fill={DIFFICULTY_COLOR[String(d.difficulty)] ?? COLORS.primary}
            />
          ))}
          <LabelList
            dataKey="count"
            position="right"
            fill={COLORS.text}
            fontSize={11}
            formatter={(v) => {
              const c = Number(v)
              return `${c} (${total ? ((c / total) * 100).toFixed(0) : 0}%)`
            }}
          />
        </Bar>
      </BarChart>
    </ChartCard>
  )
}
