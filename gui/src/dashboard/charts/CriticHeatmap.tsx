import type { CriticHeatmap } from '../../types'
import { COLORS } from '../palette'

// Pass rate 0–1 → HSL color (0° = red, 120° = green)
function prColor(r: number): string {
  return `hsl(${Math.round(r * 120)}, 65%, 38%)`
}

export default function CriticHeatmapChart({ data }: { data: CriticHeatmap }) {
  const { criteria, runs, cells } = data

  const cellMap = new Map<string, { passRate: number; n: number }>()
  for (const c of cells) {
    cellMap.set(`${c.criterion}::${c.run_id}`, { passRate: c.passRate, n: c.n })
  }

  return (
    <div className="col-span-2 rounded-xl border border-border bg-surface p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold">Critic Criteria Heatmap</h3>
        <p className="mt-0.5 text-xs text-muted">
          Pass rate per criterion · last {runs.length} run{runs.length !== 1 ? 's' : ''} ·
          green = high pass rate
        </p>
      </div>
      {criteria.length === 0 || runs.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-sm text-muted">
          No critique data yet — rejected questions populate this grid.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{ borderCollapse: 'separate', borderSpacing: '3px 3px', fontSize: 11 }}
          >
            <thead>
              <tr>
                <th
                  style={{
                    textAlign: 'left',
                    padding: '0 12px 6px 0',
                    color: COLORS.muted,
                    fontWeight: 500,
                    minWidth: 180,
                    whiteSpace: 'nowrap',
                  }}
                >
                  Criterion
                </th>
                {runs.map((r) => (
                  <th
                    key={r.run_id}
                    style={{
                      textAlign: 'center',
                      padding: '0 0 6px',
                      color: COLORS.muted,
                      fontWeight: 500,
                      minWidth: 38,
                      width: 38,
                      fontSize: 10,
                    }}
                  >
                    #{r.generation_number}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {criteria.map((c) => (
                <tr key={c}>
                  <td
                    style={{
                      padding: '2px 12px 2px 0',
                      color: COLORS.text,
                      fontFamily: 'monospace',
                      fontSize: 11,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {c}
                  </td>
                  {runs.map((r) => {
                    const cell = cellMap.get(`${c}::${r.run_id}`)
                    const rate = cell?.passRate ?? 0
                    return (
                      <td
                        key={r.run_id}
                        title={
                          cell
                            ? `${c}: ${(rate * 100).toFixed(0)}% pass (${cell.n} questions)`
                            : 'No data'
                        }
                        style={{
                          width: 38,
                          height: 24,
                          background: cell ? prColor(rate) : COLORS.border,
                          borderRadius: 3,
                          textAlign: 'center',
                          verticalAlign: 'middle',
                          cursor: 'default',
                          color: COLORS.text,
                          fontSize: 9,
                          fontWeight: 600,
                        }}
                      >
                        {cell ? `${(rate * 100).toFixed(0)}%` : '—'}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
