import { useEffect, useRef } from 'react'
import { Check } from 'lucide-react'
import type { AcceptedItem } from '../run/runState'

const DIFF_COLOR: Record<string, string> = {
  easy: 'bg-success/15 text-success',
  medium: 'bg-primary/15 text-primary',
  hard: 'bg-warning/15 text-warning',
  expert: 'bg-danger/15 text-danger',
}

// Live accepted-questions feed (§6.1 Phase 3). Auto-scrolls as cards arrive.
export default function AcceptedFeed({
  items,
  target,
}: {
  items: AcceptedItem[]
  target: number
}) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [items.length])

  return (
    <div className="flex max-h-[60vh] flex-col rounded-xl border border-border bg-surface p-5">
      <h3 className="mb-4 shrink-0 font-semibold">
        Accepted{' '}
        <span className="text-muted">
          ({items.length}
          {target ? ` / ${target}` : ''})
        </span>
      </h3>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {items.length === 0 ? (
          <p className="text-sm text-muted">
            Accepted questions will stream in here as the Generator and Critic run.
          </p>
        ) : (
          items.map((q, i) => (
            <div
              key={`${q.n}-${i}`}
              className="flex items-start gap-2 rounded-lg border border-border bg-bg p-3"
            >
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-sm">{q.stem}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                  <span
                    className={`rounded px-1.5 py-0.5 font-medium capitalize ${
                      DIFF_COLOR[q.difficulty] ?? 'bg-border text-muted'
                    }`}
                  >
                    {q.difficulty}
                  </span>
                  <span className="rounded bg-border px-1.5 py-0.5 capitalize text-muted">
                    {q.bloom}
                  </span>
                  {q.salvaged && (
                    <span className="rounded bg-warning/15 px-1.5 py-0.5 text-warning">
                      salvaged
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </div>
  )
}
