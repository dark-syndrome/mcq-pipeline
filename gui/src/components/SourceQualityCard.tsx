import { AlertTriangle, CheckCircle2, XCircle, type LucideIcon } from 'lucide-react'
import type { LintReport, LintStatus } from '../types'

const ICON: Record<LintStatus, LucideIcon> = {
  PASS: CheckCircle2,
  WARN: AlertTriangle,
  FAIL: XCircle,
}
const COLOR: Record<LintStatus, string> = {
  PASS: 'text-success',
  WARN: 'text-warning',
  FAIL: 'text-danger',
}
const BADGE: Record<LintStatus, string> = {
  PASS: 'bg-success/15 text-success',
  WARN: 'bg-warning/15 text-warning',
  FAIL: 'bg-danger/15 text-danger',
}

// Source Quality card (§6.1 Phase 1) — traffic-light per Layer-1 check.
export default function SourceQualityCard({ report }: { report: LintReport }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-semibold">Source Quality</h3>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${BADGE[report.overall_status]}`}
        >
          {report.overall_status}
        </span>
      </div>

      <ul className="space-y-2">
        {report.checks.map((c) => {
          const Icon = ICON[c.status]
          return (
            <li key={c.name} className="flex items-start gap-2 text-sm">
              <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${COLOR[c.status]}`} />
              <span>
                <span className="font-medium capitalize">
                  {c.name.replace(/_/g, ' ')}
                </span>
                <span className="text-muted"> — {c.message}</span>
              </span>
            </li>
          )
        })}
      </ul>

      {report.overall_status === 'FAIL' && (
        <div className="mt-4 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          {report.recommendation}
        </div>
      )}
    </div>
  )
}
