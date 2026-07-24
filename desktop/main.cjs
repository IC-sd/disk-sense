const { app, BrowserWindow, ipcMain, shell, safeStorage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const packageMetadata = require('../package.json')
const { store } = require('./state.cjs')
const { registerChangeHandlers } = require('./handlers/change-handlers.cjs')
const { registerCleanerHandlers } = require('./handlers/cleaner-handlers.cjs')
const { createAiConfigService, registerInspectHandlers } = require('./handlers/inspect-handlers.cjs')
const { overview } = require('./system-info.cjs')
const { createDiagnostics } = require('./diagnostics.cjs')

app.setName('Disk Sense')
app.setPath('userData', process.env.DISK_SENSE_USER_DATA
  ? path.resolve(process.env.DISK_SENSE_USER_DATA)
  : path.join(app.getPath('appData'), 'Disk Sense'))

let win
let db
const smokeTest = process.argv.includes('--smoke-test')
const applicationVersion = () => app.isPackaged ? app.getVersion() : packageMetadata.version
const aiConfig = createAiConfigService({ getDb: () => db, safeStorage })
const diagnostics = createDiagnostics(path.join(app.getPath('userData'), 'disk-sense.log'))
diagnostics.installProcessMonitors()
function sendToRenderer(channel, payload) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(channel, payload)
}

function createWindow() {
  win = new BrowserWindow({
    title: 'Disk Sense',
    width: 1280,
    height: 860,
    minWidth: 1000,
    minHeight: 680,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: '#08111d',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  win.setMenuBarVisibility(false)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
    if (isMainFrame) diagnostics.log('error', 'renderer-load-failed', { code, description, validatedUrl })
  })
  win.webContents.on('render-process-gone', (_event, details) => diagnostics.log('error', 'renderer-process-gone', details))
  win.on('unresponsive', () => diagnostics.log('warn', 'window-unresponsive'))
  const revealWindow = () => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.show()
  }
  if (!smokeTest) {
    win.once('ready-to-show', revealWindow)
    win.webContents.once('did-finish-load', revealWindow)
  }
  win.on('closed', () => { win = null })
  const rendererLoad = process.argv.includes('--dev')
    ? win.loadURL('http://127.0.0.1:5173')
    : win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  rendererLoad
    .then(() => { if (!smokeTest) revealWindow() })
    .catch(error => diagnostics.log('error', 'renderer-load-rejected', { message: error?.message || String(error) }))
}

function addOverviewHandlers() {
  ipcMain.handle('overview:get', () => overview(db.read()))
  ipcMain.handle('app:info', () => ({
    name: app.getName(),
    version: applicationVersion(),
    platform: process.platform,
    architecture: process.arch,
    packaged: app.isPackaged,
    userDataPath: app.getPath('userData'),
    stateVersion: Number(db.read().version || 0),
    aiConfigured: aiConfig.publicConfig().configured,
    security: {
      rendererSandbox: true,
      contextIsolation: true,
      permanentDelete: false,
      remoteAiRequiresHttps: true
    }
  }))
  ipcMain.handle('app:open-data-directory', async () => {
    const target = app.getPath('userData')
    fs.mkdirSync(target, { recursive: true })
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
    return { opened: true }
  })
}

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      if (!win.isVisible()) win.show()
      win.focus()
    }
  })
  app.whenReady().then(() => {
    db = store(path.join(app.getPath('userData'), 'disk-sense-state.json'))
    diagnostics.log('info', 'application-ready', {
      version: applicationVersion(),
      packaged: app.isPackaged,
      platform: process.platform,
      architecture: process.arch
    })
    addOverviewHandlers()
    registerInspectHandlers({ ipcMain, aiConfig })
    registerChangeHandlers({ ipcMain, db, sendToRenderer })
    registerCleanerHandlers({ ipcMain, db, shell, sendToRenderer })
    createWindow()
  })
  app.on('activate', () => {
    if (!win || win.isDestroyed()) createWindow()
    else if (!win.isVisible()) win.show()
  })
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
