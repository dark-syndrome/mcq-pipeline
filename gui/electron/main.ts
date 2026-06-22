import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { registerIpc } from './ipc'
import { cancelRun, isRunning } from './sidecar'

// Window chrome only. IPC (Python sidecar + better-sqlite3) is added in Session 2.
function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0a0e1a',
    title: 'MCQ Pipeline',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Single, reliable cleanup: if any Python sidecar (generation run OR Supabase
  // push) is still running when the window closes, kill it so it doesn't keep
  // consuming API quota as an orphan. Registered once per window — not per run —
  // so listeners never accumulate and it covers every subprocess flow.
  win.on('closed', () => {
    if (isRunning()) cancelRun()
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
