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

// Emitted by the sidecar wrapper (not the pipeline) when the child exits.
export interface ProcessExitEvent {
  event: 'process_exit'
  code: number | null
}

// --- DB row shapes (read from logs/runs.db; columns match the runs table) ---
export interface RunRow {
  run_id: string
  generation_number: number
  timestamp: string
  input_file: string
  generated_count: number
  passed_count: number
  cost_usd: number
}

export interface RowCounts {
  runs: number
  mcqs: number
  concept_maps: number
}

// --- Full resolved Settings (mcq-agent config-dump) for the Model tab ---
interface PriceBlock {
  input_per_million_tokens: number
  output_per_million_tokens: number
}
export interface FullConfig {
  provider: string
  model: string
  analyzer_provider: string | null
  analyzer_model: string | null
  generator_provider: string | null
  generator_model: string | null
  critic_provider: string | null
  critic_model: string | null
  num_questions: number
  difficulty: string
  question_type: string
  num_options: number
  include_explanations: boolean
  over_generation_factor: number
  max_regeneration_attempts: number
  mixed_question_types: boolean
  source_grounding_threshold: number
  temperature: number
  critic_temperature: number
  analyzer_temperature: number
  bloom_temperatures: {
    remember: number
    understand: number
    apply: number
    analyze: number
    evaluate: number
    create: number
  }
  max_tokens: number
  critic_max_tokens: number
  analyzer_max_tokens: number
  guarantee_n_retries: number
  linter_min_words: number
  linter_min_sections: number
  linter_min_words_per_section: number
  linter_min_concept_density: number
  linter_fail_on_warn: boolean
  api_max_retries: number
  api_retry_initial_backoff: number
  pricing: PriceBlock
  generator_pricing: PriceBlock
  critic_pricing: PriceBlock
  enable_supabase: boolean
  supabase_similarity_threshold: number
  include_rejected_in_output: boolean
  [key: string]: unknown
}

// --- Layer-1 source linter report (mcq-agent lint --json) ---
export type LintStatus = 'PASS' | 'WARN' | 'FAIL'
export interface LintCheck {
  name: string
  status: LintStatus
  message: string
  value: number | string | null
  threshold: number | string | null
}
export interface LintReport {
  source_file: string
  run_id: string
  overall_status: LintStatus
  concept_density_score: number | null
  recommendation: string
  checks: LintCheck[]
}

// --- config.yaml projection used by the status bar + Run-tab defaults ---
export interface AppConfig {
  provider: string
  modelRoute: { analyzer: string; generator: string; critic: string }
  supabaseEnabled: boolean
  dbPath: string
  pricing: { input: number; output: number }
  defaults: {
    num_questions: number
    difficulty: Difficulty
    question_type: string
    num_options: number
    over_generation_factor: number
  }
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
