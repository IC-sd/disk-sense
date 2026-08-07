const { app, BrowserWindow, ipcMain, shell, safeStorage, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const packageMetadata = require('../package.json')
const { store } = require('./state.cjs')
const {
  normalizeTheme,
  resolveDataLocation,
  directoryUsage,
  migrateDataDirectory
} = require('./app-settings.cjs')
const { collectDeviceInfo } = require('./device-info.cjs')
const { registerChangeHandlers } = require('./handlers/change-handlers.cjs')
const { registerCleanerHandlers } = require('./handlers/cleaner-handlers.cjs')
const { createAiConfigService, registerInspectHandlers } = require('./handlers/inspect-handlers.cjs')
const { createAiAnalysisStore } = require('./ai-analysis-store.cjs')
const { overview, diskVolumes } = require('./system-info.cjs')
const { createFileSearchWorkerService } = require('./file-search-client.cjs')
const { createDiagnostics } = require('./diagnostics.cjs')

app.setName('Disk Sense')
const dataLocation = resolveDataLocation({
  appDataPath: app.getPath('appData'),
  environment: process.env
})
app.setPath('userData', dataLocation.userDataPath)

let win
let db
let searchService
let automaticSearchTimer
let dataUsagePromise = null
let dataUsageCache = {
  bytes: 0,
  files: 0,
  directories: 0,
  inaccessible: 0,
  truncated: false
}
const smokeTest = process.argv.includes('--smoke-test')
const developmentMode = process.argv.includes('--dev')
const smokeSearchRoot = smokeTest && process.env.DISK_SENSE_SMOKE_SEARCH_ROOT
  ? path.resolve(process.env.DISK_SENSE_SMOKE_SEARCH_ROOT)
  : null
if (smokeTest) app.disableHardwareAcceleration()
const applicationVersion = () => app.isPackaged ? app.getVersion() : packageMetadata.version
const installDirectory = () => app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..')
const aiConfig = createAiConfigService({ getDb: () => db, safeStorage })
const aiAnalysisStore = createAiAnalysisStore({ getDb: () => db })
const diagnostics = createDiagnostics(path.join(app.getPath('userData'), 'disk-sense.log'))
diagnostics.installProcessMonitors()
function sendToRenderer(channel, payload) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(channel, payload)
}

function appDataUsage() {
  if (dataUsagePromise) return dataUsagePromise
  dataUsagePromise = directoryUsage(app.getPath('userData'))
    .then(usage => {
      dataUsageCache = usage
      return usage
    })
    .finally(() => { dataUsagePromise = null })
  return dataUsagePromise
}

function unavailableSearchService(error) {
  const message = error instanceof Error ? error.message : String(error)
  const status = () => ({
    available: false,
    indexed: false,
    building: false,
    phase: 'failed',
    roots: [],
    entries: 0,
    directories: 0,
    inaccessible: 0,
    skippedLinks: 0,
    current: '',
    startedAt: null,
    completedAt: null,
    durationMs: 0,
    truncated: false,
    cancelled: false,
    automatic: false,
    watching: false,
    watcherCount: 0,
    pendingChanges: 0,
    lastChangedAt: null,
    lastError: message,
    error: message
  })
  const reject = async () => { throw new Error(`文件索引不可用：${message}`) }
  return {
    status,
    startAutomatic: reject,
    stopAutomatic: () => {},
    rebuildScope: reject,
    search: reject,
    cancel: () => ({ cancelled: false }),
    checkpoint: async () => status()
  }
}

function createWindow() {
  const theme = normalizeTheme(db?.read()?.appearance?.theme)
  const requestedWidth = Number.parseInt(process.env.DISK_SENSE_WINDOW_WIDTH || '', 10)
  const requestedHeight = Number.parseInt(process.env.DISK_SENSE_WINDOW_HEIGHT || '', 10)
  win = new BrowserWindow({
    title: 'Disk Sense',
    width: Number.isFinite(requestedWidth) ? Math.max(1000, requestedWidth) : 1280,
    height: Number.isFinite(requestedHeight) ? Math.max(680, requestedHeight) : 820,
    minWidth: 1000,
    minHeight: 680,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: theme === 'light' ? '#edf1f5' : '#08111d',
    autoHideMenuBar: true,
    // Vite may briefly re-optimize dependencies after a lockfile change.
    // Keep the development shell visible instead of waiting indefinitely for
    // ready-to-show while the renderer is being rebuilt.
    show: developmentMode && !smokeTest,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      additionalArguments: smokeTest ? ['--disk-sense-smoke'] : [],
      backgroundThrottling: !smokeTest,
      offscreen: smokeTest,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  diagnostics.log('info', 'window-created', {
    id: win.id,
    visible: win.isVisible(),
    bounds: win.getBounds(),
    developmentMode
  })
  win.setMenuBarVisibility(false)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
    if (isMainFrame) diagnostics.log('error', 'renderer-load-failed', { code, description, validatedUrl })
  })
  win.webContents.on('render-process-gone', (_event, details) => diagnostics.log('error', 'renderer-process-gone', details))
  win.on('unresponsive', () => diagnostics.log('warn', 'window-unresponsive'))
  let revealLogged = false
  const revealWindow = () => {
    if (!win || win.isDestroyed()) return
    if (!win.isVisible()) win.show()
    if (developmentMode) win.focus()
    if (!revealLogged) {
      revealLogged = true
      diagnostics.log('info', 'window-revealed', {
        id: win.id,
        visible: win.isVisible(),
        focused: win.isFocused(),
        bounds: win.getBounds()
      })
    }
  }
  if (!smokeTest) {
    win.once('ready-to-show', revealWindow)
    win.webContents.once('did-finish-load', revealWindow)
    if (developmentMode) setTimeout(revealWindow, 800).unref()
  }
  win.on('closed', () => { win = null })
  const rendererLoad = developmentMode
    ? win.loadURL('http://127.0.0.1:5173')
    : win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  rendererLoad
    .then(() => { if (!smokeTest) revealWindow() })
    .catch(error => diagnostics.log('error', 'renderer-load-rejected', { message: error?.message || String(error) }))
}

function addOverviewHandlers() {
  ipcMain.handle('overview:get', () => overview(db.read()))
  ipcMain.handle('app:info', () => {
    const userDataPath = app.getPath('userData')
    return {
      name: app.getName(),
      version: applicationVersion(),
      platform: process.platform,
      architecture: process.arch,
      packaged: app.isPackaged,
      installPath: installDirectory(),
      userDataPath,
      defaultUserDataPath: dataLocation.defaultUserDataPath,
      dataExternallyManaged: dataLocation.externallyManaged,
      dataUsage: dataUsageCache,
      appearance: {
        theme: normalizeTheme(db.read().appearance?.theme)
      },
      stateVersion: Number(db.read().version || 0),
      aiConfigured: aiConfig.publicConfig().configured,
      security: {
        rendererSandbox: true,
        contextIsolation: true,
        permanentDelete: false,
        remoteAiRequiresHttps: true,
        // Maintenance commands are resolved from main-process allowlists only.
        systemMaintenanceAllowlist: true
      }
    }
  })
  ipcMain.handle('app:data-usage', () => appDataUsage())
  ipcMain.handle('app:appearance:get', () => ({
    theme: normalizeTheme(db.read().appearance?.theme)
  }))
  ipcMain.handle('app:appearance:set', (_event, input) => {
    const theme = normalizeTheme(input?.theme)
    db.read().appearance = { theme }
    db.save()
    if (win && !win.isDestroyed()) win.setBackgroundColor(theme === 'light' ? '#edf1f5' : '#08111d')
    return { theme }
  })
  ipcMain.handle('app:device-info', () => collectDeviceInfo({
    app,
    installPath: installDirectory(),
    dataPath: app.getPath('userData')
  }))
  ipcMain.handle('app:open-data-directory', async () => {
    const target = app.getPath('userData')
    fs.mkdirSync(target, { recursive: true })
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
    return { opened: true }
  })
  ipcMain.handle('app:open-install-directory', async () => {
    const error = await shell.openPath(installDirectory())
    if (error) throw new Error(error)
    return { opened: true }
  })
  ipcMain.handle('app:data-directory:move', async () => {
    if (dataLocation.externallyManaged) {
      throw new Error('当前数据目录由外部环境管理，不能在应用内迁移。')
    }
    const result = await dialog.showOpenDialog(win || undefined, {
      title: '选择 Disk Sense 数据保存位置',
      buttonLabel: '选择此位置',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return { cancelled: true }
    await searchService?.checkpoint()
    db.save()
    try {
      const migration = await migrateDataDirectory({
        source: app.getPath('userData'),
        selectedDirectory: result.filePaths[0],
        pointerFile: dataLocation.pointerFile,
        forbiddenPaths: [installDirectory()]
      })
      if (!migration.changed) await searchService?.startAutomatic?.()
      return { cancelled: false, ...migration }
    } catch (error) {
      try {
        await searchService?.startAutomatic?.()
      } catch (resumeError) {
        diagnostics.log('error', 'search-index-resume-failed', {
          message: resumeError instanceof Error ? resumeError.message : String(resumeError)
        })
      }
      throw error
    }
  })
  ipcMain.handle('app:restart', () => {
    if (smokeTest) return { restarted: false }
    app.relaunch()
    app.exit(0)
    return { restarted: true }
  })
  if (smokeTest) {
    ipcMain.handle('smoke:capture', async () => {
      if (!win || win.isDestroyed()) throw new Error('smoke-window-unavailable')
      win.webContents.invalidate()
      await new Promise(resolve => setTimeout(resolve, 80))
      const image = await win.webContents.capturePage()
      return image.toPNG().toString('base64')
    })
  }
}

const singleInstance = smokeTest || app.requestSingleInstanceLock()
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
    try {
      searchService = createFileSearchWorkerService({
        databasePath: path.join(app.getPath('userData'), 'disk-sense-search.sqlite'),
        getVolumeRoots: smokeSearchRoot
          ? async () => [smokeSearchRoot]
          : async () => (await diskVolumes()).map(volume => volume.root),
        onProgress: payload => sendToRenderer('inspect:index-progress', payload),
        onError: error => diagnostics.log('error', 'search-index-worker-failed', {
          message: error instanceof Error ? error.message : String(error)
        })
      })
    } catch (error) {
      diagnostics.log('error', 'search-index-unavailable', {
        message: error instanceof Error ? error.message : String(error)
      })
      searchService = unavailableSearchService(error)
    }
    registerInspectHandlers({ ipcMain, aiConfig, aiAnalysisStore, searchService, app, shell })
    registerChangeHandlers({ ipcMain, db, sendToRenderer })
    registerCleanerHandlers({ ipcMain, db, shell, sendToRenderer })
    createWindow()
    if (!smokeTest) {
      automaticSearchTimer = setTimeout(() => {
        automaticSearchTimer = null
        searchService.startAutomatic().catch(error => {
          diagnostics.log('error', 'automatic-search-index-failed', {
            message: error instanceof Error ? error.message : String(error)
          })
        })
      }, 900)
      automaticSearchTimer.unref?.()
    }
  })
  app.on('activate', () => {
    if (!win || win.isDestroyed()) createWindow()
    else if (!win.isVisible()) win.show()
  })
}
app.on('before-quit', () => {
  if (automaticSearchTimer) clearTimeout(automaticSearchTimer)
  automaticSearchTimer = null
  void searchService?.close?.().catch(error => {
    diagnostics.log('error', 'search-index-close-failed', {
      message: error instanceof Error ? error.message : String(error)
    })
  })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
