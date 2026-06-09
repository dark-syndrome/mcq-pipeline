import { Download, FolderOpen, Table2 } from 'lucide-react'
import type { RunCompleteEvent } from '../types'

function Metric({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-0.5 text-xl font-bold ${accent ?? ''}`}>{value}</p>
    </div>
  )
}

// Completion summary card (§6.1 Phase 3).
export default function CompletionCard({
  summary,
  onSave,
  onReveal,
  onViewFiles,
}: {
  summary: RunCompleteEvent
  onSave: (path: string) => void
  onReveal: (path: string) => void
  onViewFiles: () => void
}) {
  const files = summary.output_files
  return (
    <div className="mt-6 rounded-xl border border-border bg-surface p-5">
      <h3 className="mb-4 font-semibold">Run Complete</h3>

      <div className="grid grid-cols-4 gap-4">
        <Metric
          label="Accepted"
          value={`${summary.accepted} / ${summary.requested}`}
          accent="text-success"
        />
        <Metric label="Rejected" value={String(summary.rejected)} accent="text-warning" />
        <Metric label="Salvaged" value={String(summary.salvaged)} accent="text-primary" />
        <Metric label="Total Cost" value={`$${summary.cost_usd.toFixed(3)}`} />
      </div>

      <p className="mt-3 text-xs text-muted">
        Analyzer ${summary.cost_breakdown.analyzer.toFixed(3)} · Generator $
        {summary.cost_breakdown.generator.toFixed(3)} · Critic $
        {summary.cost_breakdown.critic.toFixed(3)} · Reframer $
        {summary.cost_breakdown.reframer.toFixed(3)}
      </p>

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          onClick={() => onSave(files.accepted)}
          className="flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary/90"
        >
          <Download className="h-4 w-4" /> Download Accepted JSON
        </button>
        <button
          onClick={() => onSave(files.rejected)}
          className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:border-primary"
        >
          <Download className="h-4 w-4" /> Download Rejected JSON
        </button>
        <button
          onClick={() => onReveal(files.accepted)}
          className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:border-primary"
        >
          <FolderOpen className="h-4 w-4" /> Reveal in folder
        </button>
        <button
          onClick={onViewFiles}
          className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:border-primary"
        >
          <Table2 className="h-4 w-4" /> View in Files Tab
        </button>
      </div>
    </div>
  )
}
