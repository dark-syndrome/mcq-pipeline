import fs from 'node:fs'
import { spawn } from 'node:child_process'
import YAML from 'yaml'
import { CONFIG_PATH, REPO_ROOT, resolvePython } from './paths'

// Authoritative read: the fully-resolved Settings (all fields, effective values)
// via `mcq-agent config-dump`. With defaults=true, the pipeline's built-in
// defaults (for "Reset to Defaults").
export function dumpConfig(defaults = false): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const py = resolvePython()
    const args = ['-m', 'mcq_agent.cli', 'config-dump']
    if (defaults) args.push('--defaults')
    const proc = spawn(py, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    let out = ''
    let err = ''
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()))
    proc.stderr.on('data', (d: Buffer) => (err += d.toString()))
    proc.on('error', (e) =>
      reject(new Error(`Failed to start Python (${py}): ${e.message}`)),
    )
    proc.on('close', (code) => {
      let parsed: unknown = null
      try {
        parsed = out.trim() ? JSON.parse(out.trim()) : null
      } catch {
        parsed = null
      }
      if (parsed && typeof parsed === 'object' && 'error' in (parsed as object)) {
        return reject(new Error(String((parsed as { error: unknown }).error)))
      }
      if (code !== 0 || !parsed) {
        return reject(new Error(err.trim() || `config-dump exited with code ${code}`))
      }
      resolve(parsed)
    })
  })
}

// Non-destructive write (§1.1, §3): apply only the changed dotted-path values to
// config.yaml via the YAML Document API, preserving comments and untouched keys.
export function writeConfig(changes: Record<string, unknown>): { written: number } {
  const doc = YAML.parseDocument(fs.readFileSync(CONFIG_PATH, 'utf-8'))
  for (const [path, value] of Object.entries(changes)) {
    doc.setIn(path.split('.'), value)
  }
  fs.writeFileSync(CONFIG_PATH, doc.toString(), 'utf-8')
  return { written: Object.keys(changes).length }
}
