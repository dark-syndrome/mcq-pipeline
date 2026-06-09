import { Check, Circle, Loader2, X } from 'lucide-react'
import { STAGE_DEFS, type StageState } from '../run/runState'

function elapsed(s: StageState, now: number): string {
  if (!s.startedAt) return ''
  const end = s.endedAt ?? now
  return `${((end - s.startedAt) / 1000).toFixed(1)}s`
}

function StatusIcon({ status }: { status: StageState['status'] }) {
  switch (status) {
    case 'done':
      return <Check className="h-4 w-4 text-success" />
    case 'running':
      return <Loader2 className="h-4 w-4 animate-spin text-primary" />
    case 'failed':
      return <X className="h-4 w-4 text-danger" />
    default:
      return <Circle className="h-3.5 w-3.5 text-muted" />
  }
}

// Vertical pipeline-stage timeline (§6.1 Phase 3 / §10.2).
export default function StageTimeline({
  stages,
  now,
}: {
  stages: StageState[]
  now: number
}) {
  const label = (id: string) => STAGE_DEFS.find((s) => s.id === id)?.label ?? id
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <h3 className="mb-4 font-semibold">Pipeline Stages</h3>
      <ol className="space-y-3">
        {stages.map((s) => (
          <li key={s.id} className="flex items-start gap-3">
            <span className="mt-0.5 flex h-5 w-5 items-center justify-center">
              <StatusIcon status={s.status} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span
                  className={`text-sm font-medium ${
                    s.status === 'skipped' ? 'text-muted line-through' : ''
                  }`}
                >
                  {label(s.id)}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted">
                  {elapsed(s, now)}
                </span>
              </div>
              {s.detail && (
                <p className="mt-0.5 truncate text-xs text-muted">{s.detail}</p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
