import { useEffect, useRef, useState } from 'react'
import BrowseView from '../evalset/BrowseView'
import CreateModal from '../evalset/CreateModal'
import QualitySummary from '../evalset/QualitySummary'
import TableView from '../evalset/TableView'
import type { EvalAnnotation, EvalSet, EvalSetMeta } from '../types'

type View = 'browse' | 'table'

export default function EvalSetTab() {
  const [metas, setMetas] = useState<EvalSetMeta[]>([])
  const [current, setCurrent] = useState<EvalSet | null>(null)
  const [view, setView] = useState<View>('browse')
  const [showCreate, setShowCreate] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Debounce timer for auto-save on annotation changes
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    refreshList()
  }, [])

  async function refreshList() {
    if (!window.api) return
    try {
      setMetas(await window.api.evalset.list())
    } catch {
      /* ignore */
    }
  }

  async function loadSet(name: string) {
    if (!window.api) return
    const set = await window.api.evalset.load(name)
    setCurrent(set)
    setError(null)
  }

  // Update a single question's annotation and auto-save after 600 ms of quiet.
  function handleAnnotationUpdate(id: number, annotation: EvalAnnotation) {
    if (!current) return
    const updated: EvalSet = {
      ...current,
      questions: current.questions.map((q) =>
        q.id === id ? { ...q, annotation } : q,
      ),
    }
    setCurrent(updated)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      setSaving(true)
      try {
        await window.api?.evalset.save(updated)
        refreshList() // update annotated count in selector
      } finally {
        setSaving(false)
      }
    }, 600)
  }

  async function handleImport() {
    if (!window.api) return
    try {
      const imported = await window.api.evalset.import()
      if (imported) {
        await window.api.evalset.save(imported)
        await refreshList()
        setCurrent(imported)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleExport() {
    if (!current || !window.api) return
    const defaultName = `${current.name}_${current.created_at.slice(0, 10)}`
    await window.api.evalset.export(current, defaultName)
  }

  async function handleDelete() {
    if (!current || !window.api) return
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete eval set "${current.name}"? This cannot be undone.`)) return
    await window.api.evalset.delete(current.name)
    setCurrent(null)
    refreshList()
  }

  function handleCreated(set: EvalSet) {
    setShowCreate(false)
    refreshList()
    setCurrent(set)
  }

  // When user clicks a stem in the table view, switch to browse view
  function handleJumpToBrowse(_id: number) {
    setView('browse')
  }

  const hasAnnotations =
    current?.questions.some(
      (q) => q.annotation.confirmed !== null || q.annotation.rating > 0,
    ) ?? false

  return (
    <div className="px-10 py-8">
      {/* Header */}
      <div className="mb-6 flex items-start gap-4">
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Eval Set</h1>
          <p className="mt-1 text-sm text-muted">
            Curate question sets with manual quality annotations to benchmark Critic accuracy over
            time.
          </p>
        </div>
        {saving && <span className="self-center text-xs text-muted">Saving…</span>}
      </div>

      {/* Toolbar */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        {/* Set selector */}
        {metas.length > 0 ? (
          <select
            className="h-9 rounded border border-border bg-bg px-3 text-sm text-text focus:outline-none focus:ring-1 focus:ring-primary"
            value={current?.name ?? ''}
            onChange={(e) => (e.target.value ? loadSet(e.target.value) : setCurrent(null))}
          >
            <option value="">Select eval set…</option>
            {metas.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name} · {m.count}q · {m.annotated} annotated
              </option>
            ))}
          </select>
        ) : (
          <span className="text-sm text-muted">No eval sets yet</span>
        )}

        <button
          onClick={() => setShowCreate(true)}
          className="h-9 rounded bg-primary px-4 text-sm text-white hover:bg-primary/90"
        >
          + Create
        </button>
        <button
          onClick={handleImport}
          className="h-9 rounded border border-border px-4 text-sm text-muted hover:text-text"
        >
          Import
        </button>
        {current && (
          <>
            <button
              onClick={handleExport}
              className="h-9 rounded border border-border px-4 text-sm text-muted hover:text-text"
            >
              ↓ Export
            </button>
            <button
              onClick={handleDelete}
              className="h-9 rounded border border-danger/40 px-4 text-sm text-danger hover:bg-danger/10"
            >
              Delete
            </button>
          </>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
          {error}
        </div>
      )}

      {/* View toggle */}
      {current && (
        <div className="mb-4 flex items-center border-b border-border">
          {(['browse', 'table'] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`relative px-4 py-2 text-sm ${
                view === v ? 'text-text' : 'text-muted hover:text-text'
              }`}
            >
              {v === 'browse' ? 'Browse & Annotate' : 'Table View'}
              {view === v && (
                <span className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-primary" />
              )}
            </button>
          ))}
          <span className="ml-auto text-xs text-muted">
            {current.questions.length} questions ·{' '}
            {current.questions.filter((q) => q.annotation.confirmed !== null).length} annotated
          </span>
        </div>
      )}

      {/* Main content area */}
      {!current ? (
        <EmptyState
          onCreate={() => setShowCreate(true)}
          onImport={handleImport}
        />
      ) : view === 'browse' ? (
        <BrowseView questions={current.questions} onUpdate={handleAnnotationUpdate} />
      ) : (
        <TableView
          questions={current.questions}
          onSelectQuestion={handleJumpToBrowse}
        />
      )}

      {/* Quality Summary — appears once any annotation exists */}
      {current && hasAnnotations && (
        <div className="mt-6">
          <QualitySummary questions={current.questions} />
        </div>
      )}

      {showCreate && (
        <CreateModal onCreated={handleCreated} onClose={() => setShowCreate(false)} />
      )}
    </div>
  )
}

function EmptyState({
  onCreate,
  onImport,
}: {
  onCreate: () => void
  onImport: () => void
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-20 text-center">
      <div className="mb-2 text-3xl text-muted/40">📋</div>
      <p className="mb-1 text-sm font-medium">No eval set selected</p>
      <p className="mb-6 text-xs text-muted">
        Create a curated question set from the bank, or import an existing JSON eval set.
      </p>
      <div className="flex gap-3">
        <button
          onClick={onCreate}
          className="rounded bg-primary px-5 py-2 text-sm text-white hover:bg-primary/90"
        >
          Create from question bank
        </button>
        <button
          onClick={onImport}
          className="rounded border border-border px-5 py-2 text-sm text-muted hover:text-text"
        >
          Import JSON
        </button>
      </div>
    </div>
  )
}
