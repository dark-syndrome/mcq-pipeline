import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import * as db from './db'
import * as evalset from './evalset'
import * as outputs from './outputs'
import { readConfig } from './config'
import { dumpConfig, writeConfig } from './modelConfig'
import { lintFile } from './lint'
import {
  buildDocx,
  buildJson,
  buildPdf,
  writeFileSync,
  type ExportOptions,
  type ExportRow,
} from './export'
import {
  cancelRun,
  isRunning,
  startRun,
  startSupabasePush,
  type RunParams,
} from './sidecar'

// Single place that wires the renderer's window.api (see preload.ts) to the
// main-process implementations.
export function registerIpc(): void {
  ipcMain.handle('db:rowCounts', () => db.rowCounts())
  ipcMain.handle('db:recentRuns', (_e, limit?: number) => db.recentRuns(limit))
  ipcMain.handle('db:lastRun', () => db.lastRun())
  ipcMain.handle('db:reload', () => db.reload())
  ipcMain.handle('db:dashboardKpis', () => db.dashboardKpis())
  ipcMain.handle('db:questionsPerGeneration', (_e, limit?: number) =>
    db.questionsPerGeneration(limit),
  )
  ipcMain.handle('db:typeDistribution', () => db.typeDistribution())
  ipcMain.handle('db:difficultyDistribution', () => db.difficultyDistribution())
  ipcMain.handle('db:costPerRun', (_e, limit?: number) => db.costPerRun(limit))
  // Dashboard sub-tabs 2–4 (§4.2)
  ipcMain.handle('db:criticCriteriaHeatmap', (_e, limit?: number) =>
    db.criticCriteriaHeatmap(limit),
  )
  ipcMain.handle('db:validatorFailureBreakdown', () => db.validatorFailureBreakdown())
  ipcMain.handle('db:reframerClassBreakdown', () => db.reframerClassBreakdown())
  ipcMain.handle('db:cumulativeCost', () => db.cumulativeCost())
  ipcMain.handle('db:costPerAcceptedQuestion', () => db.costPerAcceptedQuestion())
  ipcMain.handle('db:runHistory', () => db.runHistory())
  ipcMain.handle('outputs:tokenUsageByStage', (_e, limit?: number) =>
    outputs.tokenUsageByStage(limit),
  )
  ipcMain.handle('outputs:analyzerCacheHitRate', () => outputs.analyzerCacheHitRate())
  ipcMain.handle('outputs:sourceLinterStats', () => outputs.sourceLinterStats())
  ipcMain.handle('db:filterOptions', () => db.filterOptions())
  ipcMain.handle('db:queryMcqs', (_e, filter?: db.McqFilter) =>
    db.queryMcqs(filter ?? {}),
  )

  ipcMain.handle('config:get', () => readConfig())
  ipcMain.handle('config:dump', (_e, defaults?: boolean) => dumpConfig(!!defaults))
  ipcMain.handle('config:write', (_e, changes: Record<string, unknown>) =>
    writeConfig(changes),
  )

  ipcMain.handle('lint:run', (_e, input: string) => lintFile(input))

  ipcMain.handle('dialog:openMarkdown', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // Save a copy of a generated output file to a user-chosen location.
  ipcMain.handle('file:saveCopy', async (e, srcPath: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showSaveDialog(win ?? undefined!, {
      defaultPath: path.basename(srcPath),
    })
    if (result.canceled || !result.filePath) return null
    await fs.promises.copyFile(srcPath, result.filePath)
    return result.filePath
  })
  ipcMain.handle('file:showInFolder', (_e, p: string) => shell.showItemInFolder(p))

  ipcMain.handle('run:isRunning', () => isRunning())
  ipcMain.handle('run:start', (e, params: RunParams) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) throw new Error('No window for this run request.')
    startRun(win, params)
  })
  ipcMain.handle('run:cancel', () => cancelRun())

  // --- Files export (§5.6) ---
  // Renderer sends the selected rows + options; we generate the file and prompt
  // for a save location, then write it. Returns the saved path (or null if
  // cancelled). The default filename comes from the template the renderer built.
  const saveExport = async (
    e: Electron.IpcMainInvokeEvent,
    rows: ExportRow[],
    opts: ExportOptions,
    defaultName: string,
    ext: string,
  ): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showSaveDialog(win ?? undefined!, {
      defaultPath: `${defaultName}.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    })
    if (result.canceled || !result.filePath) return null
    if (opts.format === 'json') {
      writeFileSync(result.filePath, buildJson(rows, opts))
    } else if (opts.format === 'docx') {
      writeFileSync(result.filePath, await buildDocx(rows, opts))
    } else {
      writeFileSync(result.filePath, await buildPdf(rows, opts))
    }
    return result.filePath
  }
  ipcMain.handle(
    'export:run',
    (e, rows: ExportRow[], opts: ExportOptions, defaultName: string) => {
      const ext = opts.format
      return saveExport(e, rows, opts, defaultName, ext)
    },
  )

  // --- DB management panel (§5.7) ---
  ipcMain.handle('db:status', () => db.dbStatus())
  ipcMain.handle('db:health', () => db.dbHealth())
  ipcMain.handle('db:clearConceptCache', () => db.clearConceptCache())

  // --- Eval Set tab (§7) --- JSON files in <repo>/eval-sets/ ---
  ipcMain.handle('evalset:list', () => evalset.listEvalSets())
  ipcMain.handle('evalset:load', (_e, name: string) => evalset.loadEvalSet(name))
  ipcMain.handle('evalset:save', (_e, set: evalset.EvalSet) => evalset.saveEvalSet(set))
  ipcMain.handle('evalset:delete', (_e, name: string) => evalset.deleteEvalSet(name))

  ipcMain.handle(
    'evalset:export',
    async (e, set: evalset.EvalSet, defaultName: string) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const result = await dialog.showSaveDialog(win ?? undefined!, {
        defaultPath: `${defaultName}.json`,
        filters: [{ name: 'JSON Eval Set', extensions: ['json'] }],
      })
      if (result.canceled || !result.filePath) return null
      fs.writeFileSync(result.filePath, JSON.stringify(set, null, 2), 'utf-8')
      return result.filePath
    },
  )

  ipcMain.handle('evalset:import', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openFile'],
      filters: [{ name: 'JSON Eval Set', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePaths[0]) return null
    try {
      return JSON.parse(fs.readFileSync(result.filePaths[0], 'utf-8'))
    } catch {
      return null
    }
  })

  // --- Supabase push (§5.7) via the Python dedup gate ---
  ipcMain.handle(
    'supabase:push',
    (e, opts: { runId?: string; dryRun?: boolean }) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win) throw new Error('No window for this push request.')
      startSupabasePush(win, opts ?? {})
    },
  )
}
