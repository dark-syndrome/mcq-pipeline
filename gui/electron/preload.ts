import { contextBridge, ipcRenderer, webUtils } from 'electron'

// Typed bridge exposed to the renderer as window.api. The renderer-side types
// live in src/api.d.ts (kept in sync with this surface).
const api = {
  db: {
    rowCounts: () => ipcRenderer.invoke('db:rowCounts'),
    recentRuns: (limit?: number) => ipcRenderer.invoke('db:recentRuns', limit),
    lastRun: () => ipcRenderer.invoke('db:lastRun'),
    reload: () => ipcRenderer.invoke('db:reload'),
    dashboardKpis: () => ipcRenderer.invoke('db:dashboardKpis'),
    questionsPerGeneration: (limit?: number) =>
      ipcRenderer.invoke('db:questionsPerGeneration', limit),
    typeDistribution: () => ipcRenderer.invoke('db:typeDistribution'),
    difficultyDistribution: () =>
      ipcRenderer.invoke('db:difficultyDistribution'),
    subtopicCounts: () => ipcRenderer.invoke('db:subtopicCounts'),
    costPerRun: (limit?: number) => ipcRenderer.invoke('db:costPerRun', limit),
    criticCriteriaHeatmap: (limit?: number) =>
      ipcRenderer.invoke('db:criticCriteriaHeatmap', limit),
    validatorFailureBreakdown: () =>
      ipcRenderer.invoke('db:validatorFailureBreakdown'),
    reframerClassBreakdown: () => ipcRenderer.invoke('db:reframerClassBreakdown'),
    cumulativeCost: () => ipcRenderer.invoke('db:cumulativeCost'),
    costPerAcceptedQuestion: () => ipcRenderer.invoke('db:costPerAcceptedQuestion'),
    runHistory: () => ipcRenderer.invoke('db:runHistory'),
    tokenUsageByStage: (limit?: number) =>
      ipcRenderer.invoke('outputs:tokenUsageByStage', limit),
    analyzerCacheHitRate: () => ipcRenderer.invoke('outputs:analyzerCacheHitRate'),
    sourceLinterStats: () => ipcRenderer.invoke('outputs:sourceLinterStats'),
    topicTags: () => ipcRenderer.invoke('db:topicTags'),
    courses: () => ipcRenderer.invoke('db:courses'),
    filterOptions: () => ipcRenderer.invoke('db:filterOptions'),
    queryMcqs: (filter?: unknown) => ipcRenderer.invoke('db:queryMcqs', filter),
    status: () => ipcRenderer.invoke('db:status'),
    health: () => ipcRenderer.invoke('db:health'),
    clearConceptCache: () => ipcRenderer.invoke('db:clearConceptCache'),
  },
  export: {
    run: (rows: unknown, opts: unknown, defaultName: string) =>
      ipcRenderer.invoke('export:run', rows, opts, defaultName),
  },
  paper: {
    filterOptions: () => ipcRenderer.invoke('paper:filterOptions'),
    queryMcqs: (params: unknown) => ipcRenderer.invoke('paper:queryMcqs', params),
  },
  supabase: {
    push: (opts: unknown) => ipcRenderer.invoke('supabase:push', opts),
    onEvent: (cb: (e: unknown) => void) => {
      const listener = (_: unknown, e: unknown) => cb(e)
      ipcRenderer.on('supabase:event', listener)
      return () => ipcRenderer.removeListener('supabase:event', listener)
    },
  },
  evalset: {
    list: () => ipcRenderer.invoke('evalset:list'),
    load: (name: string) => ipcRenderer.invoke('evalset:load', name),
    save: (set: unknown) => ipcRenderer.invoke('evalset:save', set),
    delete: (name: string) => ipcRenderer.invoke('evalset:delete', name),
    export: (set: unknown, defaultName: string) =>
      ipcRenderer.invoke('evalset:export', set, defaultName),
    import: () => ipcRenderer.invoke('evalset:import'),
    promoteFewShot: (questions: unknown, minRating: number) =>
      ipcRenderer.invoke('evalset:promoteFewShot', questions, minRating),
  },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    dump: (defaults?: boolean) => ipcRenderer.invoke('config:dump', defaults),
    write: (changes: Record<string, unknown>) =>
      ipcRenderer.invoke('config:write', changes),
  },
  lint: {
    run: (input: string) => ipcRenderer.invoke('lint:run', input),
  },
  dialog: {
    openMarkdown: () => ipcRenderer.invoke('dialog:openMarkdown'),
  },
  file: {
    saveCopy: (srcPath: string) => ipcRenderer.invoke('file:saveCopy', srcPath),
    showInFolder: (p: string) => ipcRenderer.invoke('file:showInFolder', p),
  },
  // Electron 33 removed File.path; resolve a dropped/selected file's absolute path.
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  run: {
    isRunning: () => ipcRenderer.invoke('run:isRunning'),
    start: (params: unknown) => ipcRenderer.invoke('run:start', params),
    cancel: () => ipcRenderer.invoke('run:cancel'),
  },
  // Subscribe to streamed pipeline events; returns an unsubscribe function.
  onPipelineEvent: (cb: (e: unknown) => void) => {
    const listener = (_: unknown, e: unknown) => cb(e)
    ipcRenderer.on('pipeline:event', listener)
    return () => ipcRenderer.removeListener('pipeline:event', listener)
  },
  dedup: {
    isRunning: () => ipcRenderer.invoke('dedup:isRunning'),
    start: (params: unknown) => ipcRenderer.invoke('dedup:start', params),
    cancel: () => ipcRenderer.invoke('dedup:cancel'),
    onEvent: (cb: (e: unknown) => void) => {
      const listener = (_: unknown, e: unknown) => cb(e)
      ipcRenderer.on('dedup:event', listener)
      return () => ipcRenderer.removeListener('dedup:event', listener)
    },
  },
}

contextBridge.exposeInMainWorld('api', api)
