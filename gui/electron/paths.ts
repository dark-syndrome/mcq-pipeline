import path from 'node:path'
import fs from 'node:fs'

// gui/ lives inside the repo. The bundled main process runs from
// gui/dist-electron/, so the repo root is two levels up.
export const REPO_ROOT = path.resolve(__dirname, '..', '..')
export const DB_PATH = path.join(REPO_ROOT, 'logs', 'runs.db')
export const CONFIG_PATH = path.join(REPO_ROOT, 'config.yaml')

// Resolve the Python interpreter for the pipeline sidecar.
// Order:
//   1. MCQ_PYTHON env var (explicit override)
//   2. Repo-local .venv / venv
//   3. Active conda env (CONDA_PREFIX, set when conda activate was run before npm run dev)
//   4. Active venv (VIRTUAL_ENV, set by venv/activate)
//   5. PATH fallback (python.exe / python3)
export function resolvePython(): string {
  const override = process.env.MCQ_PYTHON
  if (override && fs.existsSync(override)) return override

  const isWin = process.platform === 'win32'
  const venvCandidates = isWin
    ? [
        path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe'),
        path.join(REPO_ROOT, 'venv', 'Scripts', 'python.exe'),
      ]
    : [
        path.join(REPO_ROOT, '.venv', 'bin', 'python'),
        path.join(REPO_ROOT, 'venv', 'bin', 'python'),
      ]
  for (const c of venvCandidates) if (fs.existsSync(c)) return c

  // Conda env activated before `npm run dev` sets CONDA_PREFIX.
  const condaPrefix = process.env.CONDA_PREFIX
  if (condaPrefix) {
    const condaPy = isWin
      ? path.join(condaPrefix, 'python.exe')
      : path.join(condaPrefix, 'bin', 'python')
    if (fs.existsSync(condaPy)) return condaPy
  }

  // Standard venv activated before `npm run dev` sets VIRTUAL_ENV.
  const virtualEnv = process.env.VIRTUAL_ENV
  if (virtualEnv) {
    const venvPy = isWin
      ? path.join(virtualEnv, 'Scripts', 'python.exe')
      : path.join(virtualEnv, 'bin', 'python')
    if (fs.existsSync(venvPy)) return venvPy
  }

  return isWin ? 'python.exe' : 'python3'
}
