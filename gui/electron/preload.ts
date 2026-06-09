import { contextBridge } from 'electron'

// Placeholder bridge. The real API surface (sidecar spawn/stream + better-sqlite3
// query functions) is the IPC contract built in Session 2 — see
// docs/BUILD_CHECKLIST.md. Exposed now so the renderer can type against window.api.
contextBridge.exposeInMainWorld('api', {
  ready: true,
})
