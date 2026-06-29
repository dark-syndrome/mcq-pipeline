import type {
  PipelineEvent,
  ProcessExitEvent,
  RunCompleteEvent,
  StageDoneEvent,
  StageId,
} from '../types'

// The 6 pipeline stages shown in the Phase-3 timeline (§6.1), in order.
export const STAGE_DEFS: { id: StageId; label: string }[] = [
  { id: 'parse', label: 'Parse' },
  { id: 'linter_l1', label: 'Linter (Layer 1)' },
  { id: 'analyze', label: 'Analyze' },
  { id: 'linter_l2', label: 'Linter (Layer 2)' },
  { id: 'generate', label: 'Generate' },
  { id: 'reframe', label: 'Reframe' },
]

export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface StageState {
  id: StageId
  status: StageStatus
  detail: string
  startedAt?: number
  endedAt?: number
}

export interface AcceptedItem {
  n: number
  stem: string
  difficulty: string
  bloom: string
  salvaged: boolean
}

export interface RejectedItem {
  failureClass: string
  issues: string[]
}

export interface RunState {
  runId: string | null
  running: boolean
  stages: StageState[]
  generated: number
  accepted: AcceptedItem[]
  rejected: RejectedItem[]
  summary: RunCompleteEvent | null
  error: { stage: string; message: string } | null
  analyzeCost: number
}

export function initialRunState(): RunState {
  return {
    runId: null,
    running: true,
    stages: STAGE_DEFS.map((s) => ({ id: s.id, status: 'pending', detail: '' })),
    generated: 0,
    accepted: [],
    rejected: [],
    summary: null,
    error: null,
    analyzeCost: 0,
  }
}

const idx = (id: StageId) => STAGE_DEFS.findIndex((s) => s.id === id)

function stageDoneDetail(ev: StageDoneEvent): string {
  switch (ev.stage) {
    case 'parse':
      return `${ev.chars ?? '?'} chars · ${ev.sections ?? '?'} sections`
    case 'linter_l1':
      return ev.status ? `${ev.status}` : 'Static checks complete'
    case 'analyze':
      if (ev.cache_hit) return 'Cache HIT — 0 tokens'
      return (
        `${ev.tokens_in ?? 0} in · ${ev.tokens_out ?? 0} out` +
        (typeof ev.cost === 'number' ? ` · $${ev.cost.toFixed(3)}` : '') +
        (ev.concepts != null ? ` · ${ev.concepts} concepts` : '')
      )
    case 'linter_l2':
      return `Density check: ${ev.status ?? 'done'}`
    case 'generate':
      return (
        `${ev.tokens_in ?? 0} in · ${ev.tokens_out ?? 0} out` +
        (typeof ev.cost === 'number' ? ` · $${ev.cost.toFixed(3)}` : '')
      )
    case 'reframe':
      return (
        `Salvaged ${ev.salvaged ?? 0}` +
        (ev.still_rejected != null ? ` · ${ev.still_rejected} still rejected` : '')
      )
    default:
      return ''
  }
}

// Pure reducer over the pipeline event stream.
export function runReducer(
  state: RunState,
  ev: PipelineEvent | ProcessExitEvent,
): RunState {
  const stages = state.stages.map((s) => ({ ...s }))

  // Mark every still-running stage before index i as done (stages like parse /
  // analyze don't emit stage_done before the next stage begins).
  const finalizeBefore = (i: number) => {
    for (let j = 0; j < i; j++) {
      if (stages[j].status === 'running') {
        stages[j].status = 'done'
        stages[j].endedAt = Date.now()
      }
    }
  }

  switch (ev.event) {
    case 'run_start':
      stages[0].status = 'running'
      stages[0].startedAt = Date.now()
      return { ...state, runId: ev.run_id, stages }

    case 'stage_start': {
      const i = idx(ev.stage)
      if (i < 0) return state
      finalizeBefore(i)
      stages[i].status = 'running'
      if (!stages[i].startedAt) stages[i].startedAt = Date.now()
      if (ev.stage === 'generate' && ev.need != null) {
        stages[i].detail = `Generating (need ${ev.need}, have ${ev.have ?? 0})…`
      }
      return { ...state, stages }
    }

    case 'stage_progress': {
      const i = idx('generate')
      finalizeBefore(i)
      stages[i].status = 'running'
      if (!stages[i].startedAt) stages[i].startedAt = Date.now()
      stages[i].detail = `Generated ${ev.generated ?? 0} candidates…`
      return { ...state, stages, generated: state.generated + (ev.generated ?? 0) }
    }

    case 'stage_done': {
      const i = idx(ev.stage)
      if (i < 0) return state
      finalizeBefore(i)
      stages[i].status = 'done'
      stages[i].endedAt = Date.now()
      stages[i].detail = stageDoneDetail(ev)
      // Advance the next linear stage to running (reframe is conditional).
      if (i + 1 < stages.length && stages[i + 1].status === 'pending' && stages[i + 1].id !== 'reframe') {
        stages[i + 1].status = 'running'
        stages[i + 1].startedAt = Date.now()
      }
      const analyzeCost =
        ev.stage === 'analyze' && typeof ev.cost === 'number' ? ev.cost : state.analyzeCost
      return { ...state, stages, analyzeCost }
    }

    case 'question_accepted':
      return {
        ...state,
        accepted: [
          ...state.accepted,
          {
            n: ev.total_accepted,
            stem: ev.stem,
            difficulty: ev.difficulty,
            bloom: ev.bloom_level,
            salvaged: ev.salvaged,
          },
        ],
      }

    case 'question_rejected':
      return {
        ...state,
        rejected: [
          ...state.rejected,
          { failureClass: ev.failure_class, issues: ev.issues },
        ],
      }

    case 'run_complete':
      stages.forEach((s) => {
        if (s.status === 'running') {
          s.status = 'done'
          s.endedAt = Date.now()
        }
        if (s.id === 'reframe' && s.status === 'pending') s.status = 'skipped'
      })
      return { ...state, stages, running: false, summary: ev }

    case 'error': {
      const i = idx(ev.stage as StageId)
      if (i >= 0) {
        stages[i].status = 'failed'
        stages[i].endedAt = Date.now()
        stages[i].detail = ev.message
      }
      // Don't set running:false here — process_exit is the authoritative signal that
      // proc is null in the main process. Setting it early creates a window where
      // a fast "New run" click races the OS process close.
      return { ...state, stages, error: { stage: ev.stage, message: ev.message } }
    }

    case 'process_exit': {
      if (!state.running) return state
      stages.forEach((s) => {
        if (s.status === 'running') {
          s.status = 'failed'
          s.endedAt = Date.now()
        }
      })
      if (!state.summary && !state.error) {
        return {
          ...state,
          stages,
          running: false,
          error: { stage: 'process', message: `Pipeline exited (code ${ev.code ?? '?'})` },
        }
      }
      return { ...state, stages, running: false }
    }

    default:
      return state
  }
}
