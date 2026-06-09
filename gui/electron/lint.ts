import { spawn } from 'node:child_process'
import { REPO_ROOT, resolvePython } from './paths'

// Runs the Layer-1 static linter (mcq-agent lint --json) — no API calls.
// Request/response (not streamed): collect stdout, parse the JSON report.
export function lintFile(input: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const py = resolvePython()
    const proc = spawn(
      py,
      ['-m', 'mcq_agent.cli', 'lint', '-i', input, '--json'],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      },
    )

    let out = ''
    let err = ''
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()))
    proc.stderr.on('data', (d: Buffer) => (err += d.toString()))

    proc.on('error', (e) =>
      reject(
        new Error(
          `Failed to start Python (${py}): ${e.message}. Set MCQ_PYTHON or launch from an activated environment.`,
        ),
      ),
    )
    proc.on('close', (code) => {
      const text = out.trim()
      let parsed: unknown = null
      try {
        parsed = text ? JSON.parse(text) : null
      } catch {
        parsed = null
      }
      // The linter emits {"error": ...} with exit 1 on parse/IO failure.
      if (parsed && typeof parsed === 'object' && 'error' in (parsed as object)) {
        return reject(new Error(String((parsed as { error: unknown }).error)))
      }
      if (code !== 0 || !parsed) {
        return reject(new Error(err.trim() || `Linter exited with code ${code}`))
      }
      resolve(parsed)
    })
  })
}
