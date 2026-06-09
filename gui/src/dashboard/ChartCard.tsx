import type { ReactNode } from 'react'
import { ResponsiveContainer } from 'recharts'

// Titled card wrapping a single chart in a fixed-height ResponsiveContainer.
// Recharts requires a sized parent, so the container height is set here.
export default function ChartCard({
  title,
  subtitle,
  height = 240,
  empty,
  children,
}: {
  title: string
  subtitle?: string
  height?: number
  empty?: boolean
  children: ReactNode
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
      </div>
      {empty ? (
        <div
          className="flex items-center justify-center text-sm text-muted"
          style={{ height }}
        >
          No data yet.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          {children as React.ReactElement}
        </ResponsiveContainer>
      )}
    </div>
  )
}
