import { XCircle } from 'lucide-react'
import type { RejectedItem } from '../run/runState'

// Human-readable label for the reframer failure-class taxonomy (A–E / SKIP).
const CLASS_LABEL: Record<string, string> = {
  A: 'Length parity',
  B: 'Source excerpt',
  C: 'Weak distractor',
  D: 'Unsourced claim',
  E: 'Excerpt + parity',
  SKIP: 'Structural',
}

// Final rejections feed (§8.2 question_rejected). Populates as the run completes —
// these are the questions left rejected after the reframer's salvage attempt.
export default function RejectedFeed({ items }: { items: RejectedItem[] }) {
  return (
    <div className="flex max-h-[60vh] flex-col rounded-xl border border-border bg-surface p-5">
      <h3 className="mb-4 shrink-0 font-semibold">
        Rejected <span className="text-muted">({items.length})</span>
      </h3>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {items.length === 0 ? (
          <p className="text-sm text-muted">
            Questions that fail the critic and can't be salvaged appear here.
          </p>
        ) : (
          items.map((q, i) => (
            <div
              key={i}
              className="flex items-start gap-2 rounded-lg border border-border bg-bg p-3"
            >
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="rounded bg-danger/15 px-1.5 py-0.5 font-medium text-danger">
                    {CLASS_LABEL[q.failureClass] ?? q.failureClass}
                  </span>
                </div>
                {q.issues.length > 0 && (
                  <ul className="mt-1.5 list-inside list-disc text-xs text-muted">
                    {q.issues.slice(0, 3).map((issue, j) => (
                      <li key={j} className="line-clamp-1">
                        {issue}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
