import { Cell, Pie, PieChart, Tooltip } from 'recharts'
import type { ReframerClassSlice } from '../../types'
import ChartCard from '../ChartCard'
import { CATEGORICAL, COLORS, TOOLTIP_STYLE } from '../palette'

const CLASS_LABEL: Record<string, string> = {
  A: 'A · Length parity',
  B: 'B · Source excerpt',
  C: 'C · Weak distractor',
  D: 'D · Unsourced claim',
  E: 'E · Excerpt + parity',
  SKIP: 'SKIP · Structural',
}

export default function ReframerClassChart({ data }: { data: ReframerClassSlice[] }) {
  const labeled = data.map((d) => ({ ...d, name: CLASS_LABEL[d.class] ?? d.class }))
  return (
    <ChartCard
      title="Reframer Intervention by Class"
      subtitle="Failure class breakdown — derived from issue text"
      empty={data.length === 0}
    >
      <PieChart>
        <Pie
          data={labeled}
          dataKey="count"
          nameKey="name"
          cx="50%"
          cy="50%"
          innerRadius={55}
          outerRadius={95}
          paddingAngle={2}
          label={({ name, percent }) =>
            Number(percent) > 0.04 ? `${name} (${(Number(percent) * 100).toFixed(0)}%)` : ''
          }
          labelLine={false}
          fontSize={11}
        >
          {labeled.map((_, i) => (
            <Cell key={i} fill={CATEGORICAL[i % CATEGORICAL.length]} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={TOOLTIP_STYLE.contentStyle}
          labelStyle={TOOLTIP_STYLE.labelStyle}
          itemStyle={TOOLTIP_STYLE.itemStyle}
          formatter={(v) => [`${Number(v)} questions`, 'Count']}
        />
      </PieChart>
    </ChartCard>
  )
}
