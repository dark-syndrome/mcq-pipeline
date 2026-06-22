import { useEffect, type FC } from 'react'
import NavRail from './components/NavRail'
import StatusBar from './components/StatusBar'
import HomeBanner from './components/HomeBanner'
import { useStore } from './store'
import type { TabId } from './types'
import ModelTab from './tabs/ModelTab'
import DashboardTab from './tabs/DashboardTab'
import FilesTab from './tabs/FilesTab'
import RunTab from './tabs/RunTab'
import EvalSetTab from './tabs/EvalSetTab'

const TABS: Record<TabId, FC> = {
  model: ModelTab,
  dashboard: DashboardTab,
  files: FilesTab,
  run: RunTab,
  evalset: EvalSetTab,
}

export default function App() {
  const activeTab = useStore((s) => s.activeTab)
  const hydrate = useStore((s) => s.hydrate)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // The Run tab is kept mounted at all times (hidden with CSS when inactive) so
  // an in-flight generation keeps streaming its events and its progress survives
  // navigating away and back. Unmounting it would tear down the IPC listener and
  // orphan the Python subprocess. Every other tab mounts on demand (and so
  // refreshes its data on mount) via the swap below.
  const isRun = activeTab === 'run'
  const OtherComponent: FC | null = isRun
    ? null
    : activeTab
      ? TABS[activeTab]
      : HomeBanner

  return (
    <div className="flex h-full w-full flex-col bg-bg text-text">
      <div className="flex min-h-0 flex-1">
        <NavRail />
        <main className="min-w-0 flex-1 overflow-y-auto">
          {OtherComponent && <OtherComponent />}
          <div className={isRun ? '' : 'hidden'}>
            <RunTab />
          </div>
        </main>
      </div>
      <StatusBar />
    </div>
  )
}
