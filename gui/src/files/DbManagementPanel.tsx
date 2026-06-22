import { useEffect, useRef, useState } from 'react'
import type {
  DbHealth,
  DbStatus,
  FilterOptions,
  PushPreviewEvent,
  SupabasePushEvent,
} from '../types'

// §5.7 — collapsible DB management accordion at the bottom of the Files tab.

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export default function DbManagementPanel({
  runs,
  supabaseEnabled,
}: {
  runs: FilterOptions['runs']
  supabaseEnabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<DbStatus | null>(null)
  const [health, setHealth] = useState<DbHealth | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  // Supabase push state
  const [runId, setRunId] = useState('')
  const [pushLog, setPushLog] = useState<string[]>([])
  const [pushing, setPushing] = useState(false)
  // Holds the active push event-listener unsubscribe so we can tear it down on
  // unmount (e.g. switching tabs mid-push) and never leak an ipcRenderer
  // listener. The push subprocess itself keeps running and is reaped on window
  // close (main.ts); it is short and the dedup gate makes a re-push safe.
  const unsubRef = useRef<(() => void) | null>(null)
  useEffect(() => () => unsubRef.current?.(), [])

  const loadStatus = () => window.api?.db.status().then(setStatus)
  useEffect(() => {
    if (open && !status) loadStatus()
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const onHealth = async () => {
    setBusy('health')
    try {
      setHealth(await window.api.db.health())
    } finally {
      setBusy(null)
    }
  }

  const onClearCache = async () => {
    if (
      !window.confirm(
        'Clear the concept-map cache? The next run will re-analyze its source from scratch (a fresh Analyzer API call).',
      )
    )
      return
    setBusy('cache')
    try {
      const { cleared } = await window.api.db.clearConceptCache()
      await loadStatus()
      alert(`Cleared ${cleared} cached concept map${cleared === 1 ? '' : 's'}.`)
    } finally {
      setBusy(null)
    }
  }

  const stopPushListener = () => {
    unsubRef.current?.()
    unsubRef.current = null
  }

  const onPush = (dryRun: boolean) => {
    if (pushing) return
    setPushing(true)
    setPushLog([dryRun ? 'Computing dedup preview…' : 'Pushing to Supabase…'])
    stopPushListener() // drop any stale listener before opening a new one
    unsubRef.current = window.api.supabase.onEvent((e: SupabasePushEvent) => {
      if (e.event === 'push_start') {
        setPushLog((l) => [...l, `Submitting ${e.submitted} (threshold ${e.threshold})`])
      } else if (e.event === 'push_preview' || e.event === 'push_pushed') {
        const ev = e as PushPreviewEvent
        setPushLog((l) => [
          ...l,
          `Would push ${ev.would_push} · skip ${ev.filtered} duplicate(s)`,
          ...ev.would_skip
            .slice(0, 8)
            .map((s) => `  ✗ [${s.score}] ${s.question}`),
        ])
      } else if (e.event === 'push_done') {
        if (e.disabled) setPushLog((l) => [...l, e.message ?? 'Supabase disabled.'])
        else if (!e.ok) setPushLog((l) => [...l, `Error: ${e.message ?? 'failed'}`])
        else if (!e.dry_run)
          setPushLog((l) => [...l, `Pushed ${e.pushed} · ${e.filtered} skipped.`])
      } else if (e.event === 'process_exit') {
        setPushing(false)
        stopPushListener()
      } else if (e.event === 'error') {
        setPushLog((l) => [...l, `Error: ${e.message}`])
      }
    })
    window.api.supabase.push({ runId: runId || undefined, dryRun }).catch((err) => {
      setPushLog((l) => [...l, String(err)])
      setPushing(false)
      stopPushListener()
    })
  }

  return (
    <div className="border-t border-border">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-6 py-3 text-sm font-semibold hover:bg-surface"
      >
        <span>Database Management</span>
        <span className="text-muted">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="grid grid-cols-1 gap-4 px-6 pb-6 lg:grid-cols-3">
          {/* SQLite status */}
          <div className="rounded-lg border border-border bg-surface p-4">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
              SQLite
            </h4>
            {status ? (
              <div className="mt-2 space-y-1 text-xs">
                <p className="truncate text-muted" title={status.path}>
                  {status.path}
                </p>
                <p>Size: {fmtBytes(status.sizeBytes)}</p>
                <p>
                  Runs {status.counts.runs} · MCQs {status.counts.mcqs} · Concept
                  maps {status.counts.concept_maps}
                </p>
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted">Loading…</p>
            )}
            <button
              onClick={onHealth}
              disabled={busy === 'health'}
              className="mt-3 rounded-md border border-border px-2 py-1 text-xs hover:border-primary"
            >
              {busy === 'health' ? 'Checking…' : 'DB Health Check'}
            </button>
            {health && (
              <p
                className={`mt-2 text-xs ${health.ok ? 'text-success' : 'text-danger'}`}
              >
                Integrity: {health.integrity} · orphans: {health.orphanedMcqs}
              </p>
            )}
          </div>

          {/* Concept map cache */}
          <div className="rounded-lg border border-border bg-surface p-4">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
              Concept Map Cache
            </h4>
            <p className="mt-2 text-xs">
              {status ? status.conceptMaps.length : '—'} cached
            </p>
            <ul className="mt-1 max-h-24 overflow-y-auto text-[11px] text-muted">
              {status?.conceptMaps.map((c, i) => (
                <li key={i} className="truncate" title={c.source_file}>
                  {c.source_file}
                </li>
              ))}
            </ul>
            <button
              onClick={onClearCache}
              disabled={busy === 'cache' || !status?.conceptMaps.length}
              className="mt-3 rounded-md border border-danger/40 px-2 py-1 text-xs text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === 'cache' ? 'Clearing…' : 'Clear Cache'}
            </button>
          </div>

          {/* Supabase sync */}
          <div className="rounded-lg border border-border bg-surface p-4">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
              Supabase Sync
            </h4>
            {!supabaseEnabled ? (
              <p className="mt-2 text-xs text-muted">
                Disabled (enable_supabase: false). Push via the Python dedup gate
                once enabled in config.
              </p>
            ) : (
              <>
                <select
                  value={runId}
                  onChange={(e) => setRunId(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-border bg-bg px-2 py-1.5 text-xs"
                >
                  <option value="">Latest run</option>
                  {runs.map((r) => (
                    <option key={r.run_id} value={r.run_id}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => onPush(true)}
                    disabled={pushing}
                    className="flex-1 rounded-md border border-border px-2 py-1 text-xs hover:border-primary disabled:opacity-50"
                  >
                    Dry-run preview
                  </button>
                  <button
                    onClick={() => onPush(false)}
                    disabled={pushing}
                    className="flex-1 rounded-md bg-primary px-2 py-1 text-xs font-semibold text-white hover:bg-primary/90 disabled:opacity-50"
                  >
                    Push
                  </button>
                </div>
              </>
            )}
            {pushLog.length > 0 && (
              <pre className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap rounded bg-bg p-2 text-[11px] text-muted">
                {pushLog.join('\n')}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
