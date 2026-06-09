import { useEffect, useState, type ReactNode } from 'react'
import {
  Accordion,
  NumberField,
  SegmentedField,
  SelectField,
  SliderField,
  TextField,
  ToggleField,
} from '../model/fields'
import { deepDiff, getPath, pathModified, setPath } from '../model/paths'
import { useStore } from '../store'
import type { FullConfig } from '../types'

const PROVIDERS = [
  { value: 'anthropic', label: 'anthropic' },
  { value: 'groq', label: 'groq' },
  { value: 'openrouter', label: 'openrouter' },
]
const PROVIDERS_OPT = [{ value: '', label: '(use global)' }, ...PROVIDERS]
const DIFFICULTIES = ['easy', 'medium', 'hard', 'expert']
const QTYPES = ['single_correct', 'ordering', 'code_snippet']
const BLOOM = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create']

const PROFILES_KEY = 'mcq.profiles'
function loadProfiles(): Record<string, FullConfig> {
  try {
    return JSON.parse(localStorage.getItem(PROFILES_KEY) ?? '{}')
  } catch {
    return {}
  }
}

export default function ModelTab() {
  const [staged, setStaged] = useState<FullConfig | null>(null)
  const [saved, setSaved] = useState<FullConfig | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [profiles, setProfiles] = useState<Record<string, FullConfig>>({})
  const [profileName, setProfileName] = useState('')
  const hydrate = useStore((s) => s.hydrate)

  useEffect(() => {
    setProfiles(loadProfiles())
    window.api
      ?.config.dump()
      .then((c) => {
        setStaged(c)
        setSaved(c)
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
  }, [])

  if (loadError) {
    return (
      <div className="px-10 py-8">
        <h1 className="text-2xl font-bold">Model</h1>
        <div className="mt-6 rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          {loadError}
        </div>
      </div>
    )
  }
  if (!staged || !saved) {
    return <div className="px-10 py-8 text-muted">Loading config…</div>
  }

  const update = (path: string, value: unknown) =>
    setStaged((s) => (s ? setPath(s, path, value) : s))
  const mod = (path: string) => pathModified(staged, saved, path)
  const changes = deepDiff(staged, saved)
  const dirty = Object.keys(changes).length

  const flash = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2500)
  }

  // --- field builders (return elements, not components — preserves focus) ---
  const num = (
    path: string,
    label: string,
    o: { min?: number; max?: number; step?: number; hint?: string } = {},
  ) => (
    <NumberField
      label={label}
      value={Number(getPath(staged, path) ?? 0)}
      modified={mod(path)}
      onChange={(v) => update(path, v)}
      {...o}
    />
  )
  const slider = (
    path: string,
    label: string,
    min: number,
    max: number,
    step: number,
    hint?: string,
  ) => (
    <SliderField
      label={label}
      value={Number(getPath(staged, path) ?? 0)}
      min={min}
      max={max}
      step={step}
      hint={hint}
      modified={mod(path)}
      onChange={(v) => update(path, v)}
    />
  )
  const toggle = (path: string, label: string, hint?: string) => (
    <ToggleField
      label={label}
      value={Boolean(getPath(staged, path))}
      hint={hint}
      modified={mod(path)}
      onChange={(v) => update(path, v)}
    />
  )
  const text = (path: string, label: string, ph?: string, hint?: string) => (
    <TextField
      label={label}
      value={String(getPath(staged, path) ?? '')}
      placeholder={ph}
      hint={hint}
      modified={mod(path)}
      onChange={(v) => update(path, v)}
    />
  )
  const seg = (path: string, label: string, opts: string[]) => (
    <SegmentedField
      label={label}
      value={String(getPath(staged, path) ?? '')}
      options={opts}
      modified={mod(path)}
      onChange={(v) => update(path, v)}
    />
  )
  const select = (
    path: string,
    label: string,
    opts: { value: string; label: string }[],
    nullable = false,
  ) => (
    <SelectField
      label={label}
      value={String(getPath(staged, path) ?? '')}
      options={opts}
      modified={mod(path)}
      onChange={(v) => update(path, nullable && v === '' ? null : v)}
    />
  )

  const agentCard = (
    title: string,
    providerPath: string,
    modelPath: string,
    maxTokPath: string,
    tempPath: string,
  ): ReactNode => (
    <div className="space-y-3 rounded-lg border border-border bg-bg p-4">
      <h4 className="font-medium">{title}</h4>
      {select(providerPath, 'Provider', PROVIDERS_OPT, true)}
      {text(modelPath, 'Model ID', 'e.g. google/gemini-2.5-flash')}
      {num(maxTokPath, 'Max Tokens', { min: 1, step: 1000 })}
      {slider(tempPath, 'Temperature', 0, 1, 0.05)}
    </div>
  )

  // --- actions ---
  const onSave = async () => {
    if (!dirty) return
    setSaving(true)
    try {
      await window.api.config.write(changes)
      setSaved(staged)
      void hydrate()
      flash(`Saved ${dirty} change${dirty === 1 ? '' : 's'} to config.yaml`)
    } catch (e) {
      flash(`Save failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }
  const onReset = async () => {
    if (
      !window.confirm(
        'Reset all fields to pipeline defaults? Changes are staged — config.yaml is not written until you Save.',
      )
    )
      return
    try {
      setStaged(await window.api.config.dump(true))
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e))
    }
  }
  const onSaveProfile = () => {
    const name = profileName.trim()
    if (!name) return
    const next = { ...profiles, [name]: staged }
    setProfiles(next)
    localStorage.setItem(PROFILES_KEY, JSON.stringify(next))
    setProfileName('')
    flash(`Profile "${name}" saved`)
  }

  return (
    <div className="px-10 py-8">
      <div className="mb-2 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Model</h1>
          <p className="mt-1 text-sm text-muted">
            Every control maps to a config.yaml key. Changes are staged (yellow dot)
            and written only on Save.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={onReset}
            className="rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-text"
          >
            Reset to Defaults
          </button>
          <button
            onClick={onSave}
            disabled={!dirty || saving}
            className={`rounded-lg px-4 py-2 text-sm font-semibold ${
              dirty && !saving
                ? 'bg-primary text-white hover:bg-primary/90'
                : 'cursor-not-allowed bg-border text-muted'
            }`}
          >
            {saving ? 'Saving…' : dirty ? `Save Config (${dirty})` : 'Saved'}
          </button>
        </div>
      </div>

      {/* Profile bar (§3.2) */}
      <div className="mb-6 mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-3">
        <span className="text-sm text-muted">Profiles:</span>
        <select
          value=""
          onChange={(e) => {
            const p = profiles[e.target.value]
            if (p) {
              setStaged(p)
              flash(`Profile "${e.target.value}" loaded (staged)`)
            }
          }}
          className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm"
        >
          <option value="">Load…</option>
          {Object.keys(profiles).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <input
          value={profileName}
          onChange={(e) => setProfileName(e.target.value)}
          placeholder="profile name"
          className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm"
        />
        <button
          onClick={onSaveProfile}
          className="rounded-lg border border-border px-3 py-1.5 text-sm hover:border-primary"
        >
          Save as profile
        </button>
        {toast && <span className="ml-auto text-sm text-success">{toast}</span>}
      </div>

      <div className="space-y-3">
        <Accordion title="A — LLM Provider & Model Routing">
          <div className="grid grid-cols-3 gap-4">
            {agentCard('Analyzer Agent', 'analyzer_provider', 'analyzer_model', 'analyzer_max_tokens', 'analyzer_temperature')}
            {agentCard('Generator Agent', 'generator_provider', 'generator_model', 'max_tokens', 'temperature')}
            {agentCard('Critic Agent', 'critic_provider', 'critic_model', 'critic_max_tokens', 'critic_temperature')}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4 border-t border-border pt-4">
            {select('provider', 'Global Fallback Provider', PROVIDERS)}
            {text('model', 'Global Fallback Model')}
          </div>
        </Accordion>

        <Accordion title="B — Question Generation Defaults">
          <div className="grid grid-cols-2 gap-4">
            {num('num_questions', 'Default Question Count', { min: 1, max: 200 })}
            {seg('difficulty', 'Default Difficulty', DIFFICULTIES)}
            {select('question_type', 'Question Type', QTYPES.map((q) => ({ value: q, label: q.replace(/_/g, ' ') })))}
            {num('num_options', 'Options Per Question', { min: 3, max: 6 })}
            {slider('over_generation_factor', 'Over-Generation Factor', 1, 3, 0.1, 'Generates N× candidates; Critic filters down.')}
            <div className="flex items-end">{toggle('mixed_question_types', 'Mixed Question Types')}</div>
          </div>
        </Accordion>

        <Accordion title="C — Quality Control Thresholds">
          <div className="grid grid-cols-2 gap-4">
            {slider('source_grounding_threshold', 'Source Grounding Threshold', 0.4, 0.9, 0.05, Number(getPath(staged, 'source_grounding_threshold')) < 0.5 ? 'Low threshold may allow weakly grounded questions.' : undefined)}
            {num('guarantee_n_retries', 'Guarantee-N Retries', { min: 1, max: 50, hint: 'Max Generator→Critic loops per run.' })}
            {slider('supabase_similarity_threshold', 'Supabase Dedup Threshold', 60, 100, 1, 'Questions scoring ≥ this against the bank are dropped.')}
            <div className="space-y-3">
              {toggle('linter_fail_on_warn', 'Fail on Linter Warning', 'Any WARN aborts the run before API calls.')}
              {toggle('include_rejected_in_output', 'Include Rejected in Output')}
            </div>
          </div>
        </Accordion>

        <Accordion title="D — Bloom Level & Difficulty Tuning" subtitle="Per-Bloom generation temperature (§3.4)">
          <div className="grid grid-cols-3 gap-4">
            {BLOOM.map((b) => (
              <div key={b}>{slider(`bloom_temperatures.${b}`, b[0].toUpperCase() + b.slice(1), 0, 1, 0.05)}</div>
            ))}
          </div>
        </Accordion>

        <Accordion title="E — Source Linter Thresholds">
          <div className="grid grid-cols-2 gap-4">
            {num('linter_min_words', 'Min Words', { min: 0 })}
            {num('linter_min_sections', 'Min Sections', { min: 0 })}
            {num('linter_min_words_per_section', 'Min Words Per Section', { min: 0 })}
            {slider('linter_min_concept_density', 'Min Concept Density', 0.1, 1, 0.05)}
          </div>
        </Accordion>

        <Accordion title="F — Pricing & API Settings" subtitle="USD per 1M tokens">
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-3">
              <h4 className="text-sm font-medium">Analyzer</h4>
              {num('pricing.input_per_million_tokens', 'Input / 1M', { min: 0, step: 0.01 })}
              {num('pricing.output_per_million_tokens', 'Output / 1M', { min: 0, step: 0.01 })}
            </div>
            <div className="space-y-3">
              <h4 className="text-sm font-medium">Generator</h4>
              {num('generator_pricing.input_per_million_tokens', 'Input / 1M', { min: 0, step: 0.01 })}
              {num('generator_pricing.output_per_million_tokens', 'Output / 1M', { min: 0, step: 0.01 })}
            </div>
            <div className="space-y-3">
              <h4 className="text-sm font-medium">Critic</h4>
              {num('critic_pricing.input_per_million_tokens', 'Input / 1M', { min: 0, step: 0.01 })}
              {num('critic_pricing.output_per_million_tokens', 'Output / 1M', { min: 0, step: 0.01 })}
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4 border-t border-border pt-4">
            {num('api_max_retries', 'API Max Retries', { min: 1, max: 5 })}
            {num('api_retry_initial_backoff', 'API Retry Initial Backoff (s)', { min: 0.5, max: 10, step: 0.5 })}
          </div>
        </Accordion>
      </div>
    </div>
  )
}
