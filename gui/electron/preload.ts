import { contextBridge, ipcRenderer } from 'electron'

// Typed bridge exposed to the renderer as window.api. The renderer-side types
// live in src/api.d.ts (kept in sync with this surface).
const api = {
  db: {
    rowCounts: () => ipcRenderer.invoke('db:rowCounts'),
    recentRuns: (limit?: number) => ipcRenderer.invoke('db:recentRuns', limit),
    lastRun: () => ipcRenderer.invoke('db:lastRun'),
    reload: () => ipcRenderer.invoke('db:reload'),
  },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
  },
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
