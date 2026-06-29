import { useEffect, useState } from 'react'
import SourceDropZone, { type SelectedFile } from '../components/SourceDropZone'
import SourceQualityCard from '../components/SourceQualityCard'
import RunConfigPanel, { type RunConfig } from '../components/RunConfigPanel'
import RunExecution from '../components/RunExecution'
import type { RunStartParams } from '../api'
import type { AppConfig, LintReport } from '../types'

export default function RunTab() {
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null)
  const [file, setFile] = useState<SelectedFile | null>(null)
  const [linting, setLinting] = useState(false)
  const [report, setReport] = useState<LintReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [runParams, setRunParams] = useState<RunStartParams | null>(null)
  // True when a Python subprocess is already running (e.g. renderer reloaded mid-run).
  const [orphanRunning, setOrphanRunning] = useState(false)
  const [availableTags, setAvailableTags] = useState<string[]>([])
  const [availableCourses, setAvailableCourses] = useState<string[]>([])
  const [config, setConfig] = useState<RunConfig>({
    count: 10,
    difficulty: 'medium',
    types: ['single_correct'],
    topic: '',
    topicTags: [],
    runName: '',
    course: '',
    isPublic: true,
  })

  // Check on mount whether a background Python run is still alive (e.g. after a
  // renderer reload while a generation was in progress).
  useEffect(() => {
    window.api?.run.isRunning().then((running) => {
      if (running) setOrphanRunning(true)
    }).catch(() => {})
  }, [])

  // Load defaults from config.yaml and tag catalogs from the DB.
  useEffect(() => {
    let active = true
    window.api?.config.get().then((cfg) => {
      if (!active || !cfg) return
      setAppConfig(cfg)
      setConfig((c) => ({
        ...c,
        count: cfg.defaults.num_questions,
        difficulty: cfg.defaults.difficulty,
      }))
    })
    // Tags + courses come from the DB — may be empty on first launch before
    // any Python run has been made (DB not yet created).
    window.api?.db.topicTags().then((tags) => {
      if (active) setAvailableTags(tags)
    }).catch(() => {})
    window.api?.db.courses().then((courses) => {
      if (active) {
        setAvailableCourses(courses)
        // Pre-fill course with the first known course if none set yet.
        if (courses.length > 0) {
          setConfig((c) => ({ ...c, course: c.course || courses[0] }))
        }
      }
    }).catch(() => {})
    return () => { active = false }
  }, [])

  const onSelect = async (f: SelectedFile) => {
    setError(null)
    setReport(null)
    setFile(f)
    setConfig((c) => ({
      ...c,
      topic: c.topic || titleCase(f.name.replace(/\.(md|markdown)$/i, '')),
      runName: c.runName || titleCase(f.name.replace(/\.(md|markdown)$/i, '')),
    }))
    setLinting(true)
    try {
      setReport(await window.api.lint.run(f.path))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLinting(false)
    }
  }

  const sourceWords = Number(
    report?.checks.find((c) => c.name === 'word_count')?.value ?? 0,
  )
  const estimate = report ? estimateCost(sourceWords, config.count, appConfig) : null
  const canGenerate =
    !!file &&
    !!report &&
    report.overall_status !== 'FAIL' &&
    config.types.length > 0 &&
    !orphanRunning

  const onGenerate = () => {
    if (!file || !canGenerate) return
    setRunParams({
      input: file.path,
      count: config.count,
      difficulty: config.difficulty,
      type: config.types.length === 1 ? config.types[0] : undefined,
      topic: config.topic || undefined,
      // First tag is the run-level label and LLM fallback; all tags feed --subtopics
      // so the LLM assigns one per question when multiple are present.
      topicTag: config.topicTags[0] || undefined,
      subtopics: config.topicTags.length ? config.topicTags : undefined,
      runName: config.runName || undefined,
      course: config.course || undefined,
      isPublic: config.isPublic,
    })
  }

  if (runParams) {
    return <RunExecution params={runParams} onReset={() => setRunParams(null)} />
  }

  return (
    <div className="px-10 py-8">
      <h1 className="text-2xl font-bold">Run</h1>
      <p className="mt-1 text-sm text-muted">
        Upload a .md lesson, review the free source check, then configure and launch
        the pipeline.
      </p>

      {orphanRunning && (
        <div className="mt-4 rounded-lg border border-warning/40 bg-warning/10 p-4">
          <p className="text-sm font-semibold text-warning">
            A generation run is still active in the background.
          </p>
          <p className="mt-1 text-xs text-warning/80">
            The pipeline subprocess kept running after the UI lost track of it
            (e.g. the renderer reloaded mid-run). Cancel it before starting a new
            run, or wait for it to finish.
          </p>
          <button
            onClick={() =>
              window.api.run.cancel().then(() => setOrphanRunning(false)).catch(() => setOrphanRunning(false))
            }
            className="mt-2 rounded-md border border-warning/50 px-3 py-1 text-xs text-warning hover:bg-warning/10"
          >
            Cancel background run
          </button>
        </div>
      )}

      <div className="mt-8 grid grid-cols-[1fr_380px] gap-6">
        <div className="space-y-4">
          <SourceDropZone
            file={file}
            linting={linting}
            onSelect={onSelect}
            onError={setError}
          />
          {error && (
            <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
              {error}
            </div>
          )}
          {report && <SourceQualityCard report={report} />}
        </div>

        <RunConfigPanel
          config={config}
          onChange={(p) => setConfig((c) => ({ ...c, ...p }))}
          estimate={estimate}
          canGenerate={canGenerate}
          onGenerate={onGenerate}
          availableTags={availableTags}
          availableCourses={availableCourses}
        />
      </div>
    </div>
  )
}

function titleCase(s: string): string {
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())
}

function estimateCost(
  sourceWords: number,
  count: number,
  cfg: AppConfig | null,
): { tokens: number; cost: number } {
  const priceIn = (cfg?.pricing.input ?? 1.50) / 1_000_000
  const priceOut = (cfg?.pricing.output ?? 9.00) / 1_000_000
  const factor = cfg?.defaults.over_generation_factor ?? 2.0
  const candidates = Math.ceil(count * factor)
  const estIn = sourceWords * 1.3 + candidates * 320
  const estOut = candidates * 220
  const cost = estIn * priceIn + estOut * priceOut
  return { tokens: estIn + estOut, cost }
}
