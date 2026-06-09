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
    costPerRun: (limit?: number) => ipcRenderer.invoke('db:costPerRun', limit),
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
}

contextBridge.exposeInMainWorld('api', api)
