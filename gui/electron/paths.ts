import path from 'node:path'
import fs from 'node:fs'

// gui/ lives inside the repo. The bundled main process runs from
// gui/dist-electron/, so the repo root is two levels up.
export const REPO_ROOT = path.resolve(__dirname, '..', '..')
export const DB_PATH = path.join(REPO_ROOT, 'logs', 'runs.db')
export const CONFIG_PATH = path.join(REPO_ROOT, 'config.yaml')

// Resolve the Python interpreter for the pipeline sidecar (Open Item #2).
// Order: explicit MCQ_PYTHON env var → project venv → PATH fallback.
// Conda users either launch the GUI from an activated env (PATH fallback picks
// it up) or set MCQ_PYTHON to the env's python.exe.
export function resolvePython(): string {
  const override = process.env.MCQ_PYTHON
  if (override && fs.existsSync(override)) return override

  const venvCandidates =
    process.platform === 'win32'
      ? [
          path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe'),
          path.join(REPO_ROOT, 'venv', 'Scripts', 'python.exe'),
        ]
      : [
          path.join(REPO_ROOT, '.venv', 'bin', 'python'),
          path.join(REPO_ROOT, 'venv', 'bin', 'python'),
        ]
  for (const c of venvCandidates) if (fs.existsSync(c)) return c

  return process.platform === 'win32' ? 'python.exe' : 'python3'
}
