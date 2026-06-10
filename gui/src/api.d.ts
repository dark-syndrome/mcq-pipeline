import type {
  AppConfig,
  CacheHitRate,
  CostPerQuestionPoint,
  CostPoint,
  CriticHeatmap,
  CumulativeCost,
  DashboardKpis,
  DbHealth,
  DbStatus,
  DifficultySlice,
  EvalSet,
  EvalSetMeta,
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
  ReframerClassSlice,
  RowCounts,
  RunHistoryRow,
  RunRow,
  SourceLinterStats,
  SupabasePushEvent,
  TokenUsageByStage,
  TypeSlice,
  ValidatorFailure,
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
    criticCriteriaHeatmap: (limit?: number) => Promise<CriticHeatmap>
    validatorFailureBreakdown: () => Promise<ValidatorFailure[]>
    reframerClassBreakdown: () => Promise<ReframerClassSlice[]>
    cumulativeCost: () => Promise<CumulativeCost>
    costPerAcceptedQuestion: () => Promise<CostPerQuestionPoint[]>
    runHistory: () => Promise<RunHistoryRow[]>
    tokenUsageByStage: (limit?: number) => Promise<TokenUsageByStage>
    analyzerCacheHitRate: () => Promise<CacheHitRate>
    sourceLinterStats: () => Promise<SourceLinterStats>
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
  evalset: {
    list: () => Promise<EvalSetMeta[]>
    load: (name: string) => Promise<EvalSet | null>
    save: (set: EvalSet) => Promise<void>
    delete: (name: string) => Promise<void>
    export: (set: EvalSet, defaultName: string) => Promise<string | null>
    import: () => Promise<EvalSet | null>
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
