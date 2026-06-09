import { BrowserWindow, dialog, ipcMain } from 'electron'
import * as db from './db'
import { readConfig } from './config'
import { lintFile } from './lint'
import { cancelRun, isRunning, startRun, type RunParams } from './sidecar'

// Single place that wires the renderer's window.api (see preload.ts) to the
// main-process implementations.
export function registerIpc(): void {
  ipcMain.handle('db:rowCounts', () => db.rowCounts())
  ipcMain.handle('db:recentRuns', (_e, limit?: number) => db.recentRuns(limit))
  ipcMain.handle('db:lastRun', () => db.lastRun())
  ipcMain.handle('db:reload', () => db.reload())

  ipcMain.handle('config:get', () => readConfig())

  ipcMain.handle('lint:run', (_e, input: string) => lintFile(input))

  ipcMain.handle('dialog:openMarkdown', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('run:isRunning', () => isRunning())
  ipcMain.handle('run:start', (e, params: RunParams) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) throw new Error('No window for this run request.')
    startRun(win, params)
  })
  ipcMain.handle('run:cancel', () => cancelRun())
}
