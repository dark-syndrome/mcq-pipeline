import fs from 'node:fs'
import YAML from 'yaml'
import { CONFIG_PATH } from './paths'

// Read config.yaml for the status bar + Run-tab defaults. Per-stage model
// resolution mirrors the Settings fallback (per-stage override → top-level
// model). The full Model-tab read/write form is built in Session 5.
export function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null
  const c = YAML.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) ?? {}
  const model = c.model ?? '—'
  return {
    provider: c.provider ?? 'openrouter',
    modelRoute: {
      analyzer: c.analyzer_model ?? model,
      generator: c.generator_model ?? model,
      critic: c.critic_model ?? model,
    },
    supabaseEnabled: !!c.enable_supabase,
    dbPath: c.log_db_path ?? 'logs/runs.db',
    pricing: {
      input:
        c.generator_pricing?.input_per_million_tokens ??
        c.pricing?.input_per_million_tokens ??
        0.15,
      output:
        c.generator_pricing?.output_per_million_tokens ??
        c.pricing?.output_per_million_tokens ??
        0.6,
    },
    defaults: {
      num_questions: c.num_questions ?? 10,
      difficulty: c.difficulty ?? 'medium',
      question_type: c.question_type ?? 'single_correct',
      num_options: c.num_options ?? 4,
      over_generation_factor: c.over_generation_factor ?? 2.0,
    },
  }
}
