import type {
  AppConfig,
  CostPoint,
  DashboardKpis,
  DbHealth,
  DbStatus,
  DifficultySlice,
  ExportOptions,
  FilterOptions,
  FullConfig,
  GenerationBar,
  LintReport,
  McqFilter,
  McqRow,
  PipelineEvent,
  ProcessExitEvent,
  QueryResult,
  RowCounts,
  RunRow,
  SupabasePushEvent,
  TypeSlice,
} from './types'

export interface RunStartParams {
  input: string
  count?: number
  difficulty?: string
  type?: string
  topic?: string
  outputDir?: string
}

// Shape of the preload bridge (electron/preload.ts). Keep in sync with it.
export interface Api {
  db: {
    rowCounts: () => Promise<RowCounts>
    recentRuns: (limit?: number) => Promise<RunRow[]>
    lastRun: () => Promise<RunRow | null>
    reload: () => Promise<void>
    dashboardKpis: () => Promise<DashboardKpis>
    questionsPerGeneration: (limit?: number) => Promise<GenerationBar[]>
    typeDistribution: () => Promise<TypeSlice[]>
    difficultyDistribution: () => Promise<DifficultySlice[]>
    costPerRun: (limit?: number) => Promise<CostPoint[]>
    filterOptions: () => Promise<FilterOptions>
    queryMcqs: (filter?: McqFilter) => Promise<QueryResult>
    status: () => Promise<DbStatus>
    health: () => Promise<DbHealth>
    clearConceptCache: () => Promise<{ cleared: number }>
  }
  export: {
    run: (
      rows: McqRow[],
      opts: ExportOptions,
      defaultName: string,
    ) => Promise<string | null>
  }
  supabase: {
    push: (opts: { runId?: string; dryRun?: boolean }) => Promise<void>
    onEvent: (cb: (e: SupabasePushEvent) => void) => () => void
  }
  config: {
    get: () => Promise<AppConfig | null>
    dump: (defaults?: boolean) => Promise<FullConfig>
    write: (changes: Record<string, unknown>) => Promise<{ written: number }>
  }
  lint: {
    run: (input: string) => Promise<LintReport>
  }
  dialog: {
    openMarkdown: () => Promise<string | null>
  }
  file: {
    saveCopy: (srcPath: string) => Promise<string | null>
    showInFolder: (p: string) => Promise<void>
  }
  getPathForFile: (file: File) => string
  run: {
    isRunning: () => Promise<boolean>
    start: (params: RunStartParams) => Promise<void>
    cancel: () => Promise<void>
  }
  onPipelineEvent: (
    cb: (e: PipelineEvent | ProcessExitEvent) => void,
  ) => () => void
}

declare global {
  interface Window {
    api: Api
  }
}
