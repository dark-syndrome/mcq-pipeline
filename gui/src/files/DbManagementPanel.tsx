import { useEffect, useRef, useState } from 'react'
import type {
  DbHealth,
  DbStatus,
  DedupEvent,
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
  const unsubRef = useRef<(() => void) | null>(null)
  useEffect(() => () => unsubRef.current?.(), [])

  // Dedup state
  const [dedupThreshold, setDedupThreshold] = useState(95)
  const [dedupIncludeSupabase, setDedupIncludeSupabase] = useState(false)
  const [dedupLog, setDedupLog] = useState<string[]>([])
  const [dedupRunning, setDedupRunning] = useState(false)
  const [dedupResult, setDedupResult] = useState<{
    total: number; clusters: number; would_drop: number;
    sbClusters?: number; sbWouldDrop?: number
  } | null>(null)
  const dedupUnsubRef = useRef<(() => void) | null>(null)
  useEffect(() => () => dedupUnsubRef.current?.(), [])

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

  const stopDedupListener = () => {
    dedupUnsubRef.current?.()
    dedupUnsubRef.current = null
  }

  const onDedup = (apply: boolean, applyCloud = false) => {
    if (dedupRunning) return
    setDedupRunning(true)
    setDedupResult(null)
    setDedupLog([apply ? 'Removing duplicates…' : 'Scanning for duplicates…'])
    stopDedupListener()
    dedupUnsubRef.current = window.api.dedup.onEvent((e: DedupEvent) => {
      if (e.event === 'dedup_start') {
        setDedupLog((l) => [...l, `Loaded ${e.total} questions · threshold ${e.threshold}%`])
      } else if (e.event === 'dedup_scan_done') {
        setDedupResult({ total: e.total, clusters: e.clusters, would_drop: e.would_drop })
        if (e.clusters === 0) {
          setDedupLog((l) => [...l, `Clean — no duplicates found in ${e.total} questions.`])
        } else {
          setDedupLog((l) => [
            ...l,
            `${e.clusters} cluster${e.clusters === 1 ? '' : 's'} · ${e.would_drop} duplicate${e.would_drop === 1 ? '' : 's'} found`,
            ...e.cluster_details.slice(0, 5).map(
              (c) => `  keep id=${c.keep_id}: ${c.keep_stem.slice(0, 70)}… (${c.drop_count} dup${c.drop_count === 1 ? '' : 's'})`
            ),
            ...(e.cluster_details.length > 5 ? [`  … and ${e.cluster_details.length - 5} more cluster(s)`] : []),
          ])
        }
      } else if (e.event === 'dedup_apply_done') {
        setDedupLog((l) => [...l, `Deleted ${e.deleted} duplicate(s). Backup: ${e.backup}`])
        void loadStatus()
      } else if (e.event === 'dedup_supabase_done') {
        setDedupResult((r) => r ? { ...r, sbClusters: e.clusters, sbWouldDrop: e.would_drop } : r)
        if (e.clusters === 0) {
          setDedupLog((l) => [...l, `Supabase: clean (${e.total} questions checked).`])
        } else {
          setDedupLog((l) => [
            ...l,
            `Supabase: ${e.clusters} cluster(s) · ${e.would_drop} would drop` +
              (e.deleted > 0 ? ` · deleted ${e.deleted}` : ''),
          ])
        }
      } else if (e.event === 'dedup_supabase_error') {
        setDedupLog((l) => [...l, `Supabase unavailable: ${e.message}`])
      } else if (e.event === 'dedup_error') {
        setDedupLog((l) => [...l, `Error: ${e.message}`])
      } else if (e.event === 'dedup_process_exit') {
        setDedupRunning(false)
        stopDedupListener()
      }
    })
    window.api.dedup
      .start({ threshold: dedupThreshold, apply, applyCloud, includeSupabase: dedupIncludeSupabase })
      .catch((err: unknown) => {
        setDedupLog((l) => [...l, String(err)])
        setDedupRunning(false)
        stopDedupListener()
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
        <div className="grid grid-cols-1 gap-4 px-6 pb-6 lg:grid-cols-2 xl:grid-cols-4">
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

          {/* Deduplication */}
          <div className="rounded-lg border border-border bg-surface p-4">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
              Deduplication
            </h4>
            <p className="mt-1 text-[11px] text-muted">
              Detect near-duplicate questions using fuzzy similarity.
            </p>

            <div className="mt-3 flex items-center gap-2">
              <label className="shrink-0 text-xs">Threshold</label>
              <input
                type="range"
                min={80}
                max={100}
                value={dedupThreshold}
                onChange={(e) => setDedupThreshold(Number(e.target.value))}
                className="flex-1 accent-primary"
              />
              <span className="w-8 text-right text-xs tabular-nums">{dedupThreshold}%</span>
            </div>

            <label className="mt-2 flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={dedupIncludeSupabase}
                onChange={(e) => setDedupIncludeSupabase(e.target.checked)}
                className="accent-primary"
              />
              Include Supabase
            </label>

            <div className="mt-3 flex gap-2">
              <button
                onClick={() => onDedup(false)}
                disabled={dedupRunning}
                className="flex-1 rounded-md border border-border px-2 py-1 text-xs hover:border-primary disabled:opacity-50"
              >
                {dedupRunning ? 'Scanning…' : 'Scan'}
              </button>
              {dedupResult && dedupResult.would_drop > 0 && (
                <button
                  onClick={() => {
                    if (window.confirm(
                      `Remove ${dedupResult.would_drop} duplicate${dedupResult.would_drop === 1 ? '' : 's'} from local DB? A backup will be created automatically.`
                    )) {
                      onDedup(true, dedupIncludeSupabase && (dedupResult.sbWouldDrop ?? 0) > 0)
                    }
                  }}
                  disabled={dedupRunning}
                  className="flex-1 rounded-md border border-danger/40 px-2 py-1 text-xs text-danger hover:bg-danger/10 disabled:opacity-50"
                >
                  Remove {dedupResult.would_drop}
                </button>
              )}
            </div>

            {dedupLog.length > 0 && (
              <pre className="mt-2 max-h-36 overflow-y-auto whitespace-pre-wrap rounded bg-bg p-2 text-[11px] text-muted">
                {dedupLog.join('\n')}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
