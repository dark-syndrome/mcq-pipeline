import { create } from 'zustand'
import type { RunRow, StatusInfo, TabId } from './types'

interface AppState {
  // null activeTab = homepage banner (§2.3)
  activeTab: TabId | null
  setActiveTab: (tab: TabId | null) => void

  status: StatusInfo
  setStatus: (patch: Partial<StatusInfo>) => void
  addSessionCost: (usd: number) => void

  lastRun: RunRow | null

  // Load config + DB snapshot into the store (status bar, home banner).
  hydrate: () => Promise<void>
}

const initialStatus: StatusInfo = {
  provider: 'openrouter',
  connected: false,
  modelRoute: { analyzer: '—', generator: '—', critic: '—' },
  dbPath: 'logs/runs.db',
  dbRows: null,
  supabaseEnabled: false,
  sessionCost: 0,
}

export const useStore = create<AppState>((set) => ({
  activeTab: null,
  setActiveTab: (tab) => set({ activeTab: tab }),

  status: initialStatus,
  setStatus: (patch) => set((s) => ({ status: { ...s.status, ...patch } })),
  addSessionCost: (usd) =>
    set((s) => ({
      status: { ...s.status, sessionCost: s.status.sessionCost + usd },
    })),

  lastRun: null,

  hydrate: async () => {
    if (!window.api) return
    const [config, counts, lastRun] = await Promise.all([
      window.api.config.get(),
      window.api.db.rowCounts(),
      window.api.db.lastRun(),
    ])
    set((s) => ({
      status: {
        ...s.status,
        provider: config?.provider ?? s.status.provider,
        connected: !!config,
        modelRoute: config?.modelRoute ?? s.status.modelRoute,
        supabaseEnabled: config?.supabaseEnabled ?? false,
        dbPath: config?.dbPath ?? s.status.dbPath,
        dbRows: counts?.mcqs ?? null,
      },
      lastRun,
    }))
  },
}))
