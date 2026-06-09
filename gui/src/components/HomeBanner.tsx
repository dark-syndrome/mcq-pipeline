import { BarChart3, Database, Play, Sliders, type LucideIcon } from 'lucide-react'
import { useStore } from '../store'
import type { TabId } from '../types'

const CARDS: { id: TabId; title: string; desc: string; Icon: LucideIcon }[] = [
  { id: 'run', title: 'New Run', desc: 'Upload a lesson and generate questions', Icon: Play },
  { id: 'files', title: 'Browse Questions', desc: 'Query and export the question bank', Icon: Database },
  { id: 'dashboard', title: 'View Dashboard', desc: 'Cost, acceptance, and quality trends', Icon: BarChart3 },
  { id: 'model', title: 'Edit Config', desc: 'Model routing and quality thresholds', Icon: Sliders },
]

// Landing banner (§2.3) shown when no tab is selected.
export default function HomeBanner() {
  const setActiveTab = useStore((s) => s.setActiveTab)
  const lastRun = useStore((s) => s.lastRun)

  return (
    <div className="mx-auto max-w-5xl px-10 py-12">
      <p className="text-sm font-medium uppercase tracking-widest text-primary">
        NxtWave Robotics Engineering
      </p>
      <h1 className="mt-2 text-4xl font-bold">MCQ Pipeline</h1>
      <p className="mt-4 max-w-3xl leading-relaxed text-muted">
        MCQ Pipeline is an agentic system that transforms Markdown lesson files into
        high-quality multiple-choice questions. It runs a five-stage pipeline—Parse →
        Analyze → Generate → Critique → Reframe—enforcing 7 deterministic validators and
        13 LLM quality criteria on every question before acceptance.
      </p>

      <div className="mt-10 grid grid-cols-2 gap-4">
        {CARDS.map(({ id, title, desc, Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className="flex items-start gap-4 rounded-xl border border-border bg-surface p-5 text-left transition-colors hover:border-primary"
          >
            <Icon className="h-6 w-6 shrink-0 text-primary" />
            <span>
              <span className="block font-semibold">{title}</span>
              <span className="mt-1 block text-sm text-muted">{desc}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="mt-10 rounded-xl border border-border bg-surface p-5">
        <p className="text-sm font-medium text-text">Last run</p>
        {lastRun ? (
          <div className="mt-3 flex flex-wrap gap-x-10 gap-y-2 text-sm">
            <span>
              <span className="text-muted">Generated</span>{' '}
              <span className="font-medium">{lastRun.generated_count}</span>
            </span>
            <span>
              <span className="text-muted">Accepted</span>{' '}
              <span className="font-medium text-success">{lastRun.passed_count}</span>
            </span>
            <span>
              <span className="text-muted">Cost</span>{' '}
              <span className="font-medium">${Number(lastRun.cost_usd).toFixed(3)}</span>
            </span>
            <span>
              <span className="text-muted">When</span>{' '}
              <span className="font-medium">{String(lastRun.timestamp).slice(0, 19)}</span>
            </span>
            <span className="text-muted">{String(lastRun.input_file)}</span>
          </div>
        ) : (
          <p className="mt-1 text-sm text-muted">No runs recorded yet.</p>
        )}
      </div>
    </div>
  )
}
