import { create } from 'zustand'
import type { StatusInfo, TabId } from './types'

interface AppState {
  // null activeTab = homepage banner (§2.3)
  activeTab: TabId | null
  setActiveTab: (tab: TabId | null) => void

  status: StatusInfo
  setStatus: (patch: Partial<StatusInfo>) => void
  addSessionCost: (usd: number) => void
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
}))
