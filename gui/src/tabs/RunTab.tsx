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
  const [config, setConfig] = useState<RunConfig>({
    count: 10,
    difficulty: 'medium',
    types: ['single_correct'],
    topic: '',
  })

  // Seed run defaults from config.yaml.
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
    return () => {
      active = false
    }
  }, [])

  const onSelect = async (f: SelectedFile) => {
    setError(null)
    setReport(null)
    setFile(f)
    setConfig((c) => ({
      ...c,
      topic: c.topic || titleCase(f.name.replace(/\.(md|markdown)$/i, '')),
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
    config.types.length > 0

  const onGenerate = () => {
    if (!file || !canGenerate) return
    setRunParams({
      input: file.path,
      count: config.count,
      difficulty: config.difficulty,
      // The CLI takes a single --type; only override when one is selected,
      // otherwise let config.yaml (mixed_question_types) decide.
      type: config.types.length === 1 ? config.types[0] : undefined,
      topic: config.topic || undefined,
    })
  }

  // Phase 3 replaces the upload + config view during/after execution.
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

      <div className="mt-8 grid grid-cols-[1fr_360px] gap-6">
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
        />
      </div>
    </div>
  )
}

function titleCase(s: string): string {
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())
}

// Heuristic pre-flight estimate (§6.1) — not a guarantee. Models the dominant
// cost: an over-generation batch of candidates filtered by the Critic.
function estimateCost(
  sourceWords: number,
  count: number,
  cfg: AppConfig | null,
): { tokens: number; cost: number } {
  const priceIn = (cfg?.pricing.input ?? 0.15) / 1_000_000
  const priceOut = (cfg?.pricing.output ?? 0.6) / 1_000_000
  const factor = cfg?.defaults.over_generation_factor ?? 2.0
  const candidates = Math.ceil(count * factor)
  const estIn = sourceWords * 1.3 + candidates * 320 // analyzer + amortized gen/critic prompt
  const estOut = candidates * 220 // ~per-MCQ JSON output
  const cost = estIn * priceIn + estOut * priceOut
  return { tokens: estIn + estOut, cost }
}
