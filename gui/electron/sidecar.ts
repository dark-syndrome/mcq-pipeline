import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { REPO_ROOT, resolvePython } from './paths'

// Spawns the Python pipeline as a sidecar and streams its --json-events NDJSON
// (GUI spec §8.2) to the renderer over the 'pipeline:event' channel.

let proc: ChildProcess | null = null
let dedupProc: ChildProcess | null = null

export interface RunParams {
  input: string
  count?: number
  difficulty?: string
  type?: string
  topic?: string
  topicTag?: string
  runName?: string
  subtopics?: string[]
  course?: string
  isPublic?: boolean
  outputDir?: string
}

export function isRunning(): boolean {
  return proc !== null
}

export function isDedupRunning(): boolean {
  return dedupProc !== null
}

// Shared spawn/stream/error handling for any mcq_agent.cli subcommand that
// emits --json-events NDJSON. Events are forwarded to the renderer on `channel`.
function runSidecar(
  win: BrowserWindow,
  args: string[],
  channel: string,
): void {
  if (proc) throw new Error('A pipeline operation is already in progress.')
  const py = resolvePython()

  const send = (e: unknown) => {
    if (!win.isDestroyed()) win.webContents.send(channel, e)
  }

  proc = spawn(py, ['-m', 'mcq_agent.cli', ...args], {
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

export function startRun(win: BrowserWindow, params: RunParams): void {
  const args = ['generate', '-i', params.input, '--json-events']
  if (params.count != null) args.push('--count', String(params.count))
  if (params.difficulty) args.push('--difficulty', params.difficulty)
  if (params.type) args.push('--type', params.type)
  if (params.topic) args.push('--topic', params.topic)
  if (params.topicTag) args.push('--topic-tag', params.topicTag)
  if (params.runName) args.push('--run-name', params.runName)
  if (params.subtopics?.length) args.push('--subtopics', params.subtopics.join(','))
  if (params.course) args.push('--course', params.course)
  if (params.isPublic === false) args.push('--no-public')
  // Absolute output dir so run_complete.output_files are absolute paths the
  // renderer can save/reveal regardless of the main process cwd.
  args.push('--output-dir', params.outputDir ?? path.join(REPO_ROOT, 'output'))
  runSidecar(win, args, 'pipeline:event')
}

// Push a run's accepted MCQs to Supabase through the Python dedup gate (§5.7).
// Streams push_start / push_preview / push_done on the 'supabase:event' channel.
export function startSupabasePush(
  win: BrowserWindow,
  opts: { runId?: string; dryRun?: boolean },
): void {
  const args = ['push-supabase', '--json-events']
  if (opts.runId) args.push('--run-id', opts.runId)
  if (opts.dryRun) args.push('--dry-run')
  runSidecar(win, args, 'supabase:event')
}

export function cancelRun(): void {
  if (proc) {
    proc.kill()
    proc = null
  }
}

export interface DedupParams {
  threshold?: number
  apply?: boolean
  applyCloud?: boolean
  includeSupabase?: boolean
}

export function startDedup(win: BrowserWindow, params: DedupParams): void {
  if (dedupProc) throw new Error('A dedup scan is already in progress.')
  const py = resolvePython()
  const scriptPath = path.join(REPO_ROOT, 'scripts', 'dedup_db.py')

  const send = (e: unknown) => {
    if (!win.isDestroyed()) win.webContents.send('dedup:event', e)
  }

  const args = [scriptPath, '--json-events']
  if (params.threshold != null) args.push('--threshold', String(params.threshold))
  if (params.apply) args.push('--apply')
  if (params.applyCloud) args.push('--apply-cloud')
  if (params.includeSupabase) args.push('--include-supabase')

  dedupProc = spawn(py, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
  })

  const rl = readline.createInterface({ input: dedupProc.stdout! })
  rl.on('line', (line) => {
    const text = line.trim()
    if (!text) return
    try {
      send(JSON.parse(text))
    } catch { /* ignore non-JSON */ }
  })

  let stderrTail = ''
  dedupProc.stderr!.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-4000)
  })

  dedupProc.on('error', (err) => {
    send({ event: 'dedup_error', message: `Failed to start dedup (${py}): ${err.message}` })
    dedupProc = null
  })

  dedupProc.on('close', (code) => {
    if (code && code !== 0 && !stderrTail.includes('dedup_error')) {
      send({ event: 'dedup_error', message: stderrTail.trim() || `Dedup exited with code ${code}` })
    }
    send({ event: 'dedup_process_exit', code })
    dedupProc = null
  })
}

export function cancelDedup(): void {
  if (dedupProc) {
    dedupProc.kill()
    dedupProc = null
  }
}
