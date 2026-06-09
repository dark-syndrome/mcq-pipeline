import type { AppConfig, PipelineEvent, ProcessExitEvent, RowCounts, RunRow } from './types'

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
  }
  config: {
    get: () => Promise<AppConfig | null>
  }
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
