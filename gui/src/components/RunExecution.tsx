import { useEffect, useReducer, useRef, useState } from 'react'
import StageTimeline from './StageTimeline'
import AcceptedFeed from './AcceptedFeed'
import RejectedFeed from './RejectedFeed'
import CompletionCard from './CompletionCard'
import { initialRunState, runReducer } from '../run/runState'
import { useStore } from '../store'
import type { PipelineEvent, ProcessExitEvent, RunCompleteEvent, StageDoneEvent } from '../types'
import type { RunStartParams } from '../api'

// Phase 3 (§6.1): subscribes to the streamed pipeline events, drives the
// timeline + accepted feed + completion card, and reconciles session cost / DB.
export default function RunExecution({
  params,
  onReset,
}: {
  params: RunStartParams
  onReset: () => void
}) {
  const [state, dispatch] = useReducer(runReducer, undefined, initialRunState)
  const [now, setNow] = useState(Date.now())
  const addSessionCost = useStore((s) => s.addSessionCost)
  const hydrate = useStore((s) => s.hydrate)
  const setActiveTab = useStore((s) => s.setActiveTab)
  const started = useRef(false)

  // Live elapsed ticker for running stages.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const off = window.api.onPipelineEvent((raw) => {
      const ev = raw as PipelineEvent | ProcessExitEvent
      // Session-cost side effects: every stage_done that carries a cost streams
      // in live (analyze, generate, reframe). At completion add only the critic
      // cost — the one stage with no timeline event — so the total equals cost_usd
      // without double-counting the stages already added above.
      if (ev.event === 'stage_done' && typeof (ev as StageDoneEvent).cost === 'number') {
        addSessionCost((ev as StageDoneEvent).cost as number)
      }
      if (ev.event === 'run_complete') {
        const rc = ev as RunCompleteEvent
        addSessionCost(Math.max(0, rc.cost_breakdown.critic))
        void window.api.db.reload().then(() => hydrate())
      }
      dispatch(ev)
    })

    if (!started.current) {
      started.current = true
      window.api.run.start(params).catch((err: unknown) => {
        dispatch({
          event: 'error',
          stage: 'spawn',
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        })
      })
    }
    return off
    // Subscribe + launch exactly once for this execution view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="px-10 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Run</h1>
          <p className="mt-1 text-sm text-muted">
            {state.running
              ? 'Pipeline running…'
              : state.error
                ? 'Run failed'
                : 'Run complete'}
          </p>
        </div>
        {state.running ? (
          <button
            onClick={() => window.api.run.cancel()}
            className="rounded-lg border border-border px-4 py-2 text-sm hover:border-danger hover:text-danger"
          >
            Cancel
          </button>
        ) : (
          <button
            onClick={onReset}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90"
          >
            New run
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-6">
        <StageTimeline stages={state.stages} now={now} />
        <AcceptedFeed items={state.accepted} target={params.count ?? 0} />
      </div>

      {(state.rejected.length > 0 || !state.running) && (
        <div className="mt-6">
          <RejectedFeed items={state.rejected} />
        </div>
      )}

      {state.error && (
        <div className="mt-6 rounded-xl border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          <p className="font-semibold">Pipeline error ({state.error.stage})</p>
          <p className="mt-1 whitespace-pre-wrap">{state.error.message}</p>
        </div>
      )}

      {state.summary && (
        <CompletionCard
          summary={state.summary}
          onSave={(p) => void window.api.file.saveCopy(p)}
          onReveal={(p) => void window.api.file.showInFolder(p)}
          onViewFiles={() => setActiveTab('files')}
        />
      )}
    </div>
  )
}
