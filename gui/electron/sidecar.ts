import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import type { BrowserWindow } from 'electron'
import { REPO_ROOT, resolvePython } from './paths'

// Spawns the Python pipeline as a sidecar and streams its --json-events NDJSON
// (GUI spec §8.2) to the renderer over the 'pipeline:event' channel.

let proc: ChildProcess | null = null

export interface RunParams {
  input: string
  count?: number
  difficulty?: string
  type?: string
  topic?: string
  outputDir?: string
}

export function isRunning(): boolean {
  return proc !== null
}

export function startRun(win: BrowserWindow, params: RunParams): void {
  if (proc) throw new Error('A run is already in progress.')

  const py = resolvePython()
  const args = [
    '-m',
    'mcq_agent.cli',
    'generate',
    '-i',
    params.input,
    '--json-events',
  ]
  if (params.count != null) args.push('--count', String(params.count))
  if (params.difficulty) args.push('--difficulty', params.difficulty)
  if (params.type) args.push('--type', params.type)
  if (params.topic) args.push('--topic', params.topic)
  if (params.outputDir) args.push('--output-dir', params.outputDir)

  const send = (e: unknown) => {
    if (!win.isDestroyed()) win.webContents.send('pipeline:event', e)
  }

  proc = spawn(py, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
  })

  const rl = readline.createInterface({ input: proc.stdout! })
  rl.on('line', (line) => {
    const text = line.trim()
    if (!text) return
    try {
      send(JSON.parse(text))
    } catch {
      // Non-JSON line on stdout — ignore (stdout should be pure NDJSON).
    }
  })

  // Keep a tail of stderr so a non-zero exit can report a meaningful message.
  let stderrTail = ''
  proc.stderr!.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-8000)
  })

  proc.on('error', (err) => {
    send({
      event: 'error',
      stage: 'spawn',
      message: `Failed to start Python (${py}): ${err.message}. Set MCQ_PYTHON or launch from an activated environment.`,
      retryable: false,
    })
    proc = null
  })

  proc.on('close', (code) => {
    if (code && code !== 0) {
      send({
        event: 'error',
        stage: 'process',
        message: stderrTail.trim() || `Python exited with code ${code}`,
        retryable: false,
      })
    }
    send({ event: 'process_exit', code })
    proc = null
  })
}

export function cancelRun(): void {
  if (proc) {
    proc.kill()
    proc = null
  }
}
