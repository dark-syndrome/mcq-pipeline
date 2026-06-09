// Shared types — frozen contracts for the GUI.
// Keep the pipeline event types in sync with mcq_agent/cli.py header and
// docs/GUI_SPEC.md §8.2. The DB row shapes are refined in Session 2.

export type TabId = 'model' | 'dashboard' | 'files' | 'run' | 'evalset'

export type Difficulty = 'easy' | 'medium' | 'hard' | 'expert'
export type BloomLevel =
  | 'remember'
  | 'understand'
  | 'apply'
  | 'analyze'
  | 'evaluate'
  | 'create'
export type QuestionType = 'single_correct' | 'ordering' | 'code_snippet'

export type StageId =
  | 'parse'
  | 'linter_l1'
  | 'analyze'
  | 'linter_l2'
  | 'generate'
  | 'reframe'

// --- Pipeline NDJSON events (GUI spec §8.2) ---
export interface RunStartEvent {
  event: 'run_start'
  run_id: string
}
export interface StageStartEvent {
  event: 'stage_start'
  stage: StageId
  attempt?: number
  need?: number
  have?: number
}
export interface StageDoneEvent {
  event: 'stage_done'
  stage: StageId
  tokens_in?: number
  tokens_out?: number
  cost?: number
  cache_hit?: boolean
  chars?: number
  sections?: number
  concepts?: number
  status?: string
  salvaged?: number
  still_rejected?: number
}
export interface StageProgressEvent {
  event: 'stage_progress'
  stage: 'generate'
  generated?: number
  tokens_in?: number
  tokens_out?: number
}
export interface QuestionAcceptedEvent {
  event: 'question_accepted'
  total_accepted: number
  stem: string
  difficulty: Difficulty
  bloom_level: BloomLevel
  salvaged: boolean
}
export interface RunCompleteEvent {
  event: 'run_complete'
  run_id: string
  run_label: string
  generated: number
  accepted: number
  salvaged: number
  rejected: number
  requested: number
  cost_usd: number
  cost_breakdown: {
    analyzer: number
    generator: number
    critic: number
    reframer: number
  }
  output_files: {
    accepted: string
    rejected: string
    quality: string
    run_config: string
  }
}
export interface ErrorEvent {
  event: 'error'
  stage: string
  message: string
  retryable: boolean
}
export type PipelineEvent =
  | RunStartEvent
  | StageStartEvent
  | StageDoneEvent
  | StageProgressEvent
  | QuestionAcceptedEvent
  | RunCompleteEvent
  | ErrorEvent

// --- DB row shapes (read from logs/runs.db; refined in Session 2) ---
export interface RunRow {
  run_id: string
  generation_number: number
  timestamp: string
  input_file: string
  generated_count: number
  passed_count: number
  rejected_count: number
  cost_usd: number
}

// --- Persistent status bar (§2.2) ---
export interface StatusInfo {
  provider: string
  connected: boolean
  modelRoute: { analyzer: string; generator: string; critic: string }
  dbPath: string
  dbRows: number | null
  supabaseEnabled: boolean
  sessionCost: number
}
