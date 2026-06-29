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
  DedupEvent,
  DifficultySlice,
  EvalQuestion,
  EvalSet,
  EvalSetMeta,
  ExportOptions,
  FilterOptions,
  FullConfig,
  GenerationBar,
  LintReport,
  McqFilter,
  McqRow,
  PaperBucket,
  PaperFilterOptions,
  PaperQueryParams,
  PaperQueryResult,
  PipelineEvent,
  ProcessExitEvent,
  QueryResult,
  ReframerClassSlice,
  RowCounts,
  RunHistoryRow,
  RunRow,
  SourceLinterStats,
  SubtopicCount,
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
  topicTag?: string
  runName?: string
  subtopics?: string[]
  course?: string
  isPublic?: boolean
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
    subtopicCounts: () => Promise<SubtopicCount[]>
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
    topicTags: () => Promise<string[]>
    courses: () => Promise<string[]>
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
  paper: {
    filterOptions: () => Promise<PaperFilterOptions>
    queryMcqs: (params: PaperQueryParams) => Promise<PaperQueryResult>
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
    promoteFewShot: (
      questions: EvalQuestion[],
      minRating: number,
    ) => Promise<{ added: number; skipped: number; eligible: number; path: string }>
  }
  onPipelineEvent: (
    cb: (e: PipelineEvent | ProcessExitEvent) => void,
  ) => () => void
  dedup: {
    isRunning: () => Promise<boolean>
    start: (params: { threshold?: number; apply?: boolean; applyCloud?: boolean; includeSupabase?: boolean }) => Promise<void>
    cancel: () => Promise<void>
    onEvent: (cb: (e: DedupEvent) => void) => () => void
  }
}

declare global {
  interface Window {
    api: Api
  }
}
