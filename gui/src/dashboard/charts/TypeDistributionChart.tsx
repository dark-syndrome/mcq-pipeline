import { Cell, Legend, Pie, PieChart, Tooltip } from 'recharts'
import type { TypeSlice } from '../../types'
import { CATEGORICAL, COLORS, TOOLTIP_STYLE } from '../palette'
import ChartCard from '../ChartCard'

const LABELS: Record<string, string> = {
  single_correct: 'Single Correct',
  ordering: 'Ordering',
  code_snippet: 'Code Snippet',
}

// §4.2 chart 2 — question_type distribution across accepted questions (donut).
export default function TypeDistributionChart({ data }: { data: TypeSlice[] }) {
  const total = data.reduce((s, d) => s + d.count, 0)
  const rows = data.map((d) => ({
    ...d,
    label: LABELS[String(d.type)] ?? String(d.type),
  }))
  return (
    <ChartCard
      title="Question Type Distribution"
      subtitle={`${total} accepted questions`}
      empty={total === 0}
    >
      <PieChart>
        <Pie
          data={rows}
          dataKey="count"
          nameKey="label"
          cx="50%"
          cy="50%"
          innerRadius={50}
          outerRadius={85}
          paddingAngle={2}
          stroke={COLORS.bg}
        >
          {rows.map((_, i) => (
            <Cell key={i} fill={CATEGORICAL[i % CATEGORICAL.length]} />
          ))}
        </Pie>
        <Tooltip
          formatter={(v, n) => {
            const c = Number(v)
            return [`${c} (${total ? ((c / total) * 100).toFixed(1) : 0}%)`, n]
          }}
          {...TOOLTIP_STYLE}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    </ChartCard>
  )
}
