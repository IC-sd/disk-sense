const { app, BrowserWindow, ipcMain, shell, safeStorage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { scan, scanAsync } = require('./scanner.cjs')
const { store } = require('./state.cjs')
const { rules, scanRule } = require('./cleaner.cjs')
const { candidates } = require('./duplicates.cjs')
const { storageRelationship, findRelatedLocations } = require('./app-attribution.cjs')
const { status: aiStatus, review: aiReview, testConnection: aiTestConnection, listModels: aiListModels, validateConfig: validateAiConfig } = require('./ai-explainer.cjs')
const { inventory, diff: diffChanges } = require('./change-tracker.cjs')

app.setName('Disk Sense')
app.setPath('userData', path.join(app.getPath('appData'), 'Disk Sense'))

let win
let db
let activeScan = null
let activeChangeScan = null

function aiRuntimeConfig() {
  const stored = db?.read().aiSettings || {}
  let apiKey = process.env.DISK_SENSE_AI_KEY || ''
  if (stored.apiKeyEncrypted) try { apiKey = safeStorage.decryptString(Buffer.from(stored.apiKeyEncrypted, 'base64')) } catch {}
  return { endpoint: stored.endpoint || process.env.DISK_SENSE_AI_ENDPOINT || '', model: stored.model || process.env.DISK_SENSE_AI_MODEL || '', apiKey }
}

function aiDraftConfig(input = {}) {
  const runtime = aiRuntimeConfig()
  const endpoint = String(input.endpoint ?? runtime.endpoint).trim()
  const providedKey = String(input.apiKey || '').trim()
  const canReuseKey = endpoint === runtime.endpoint
  return { ...runtime, ...input, endpoint, apiKey: providedKey || (canReuseKey ? runtime.apiKey : '') }
}

function publicAiConfig() {
  const runtime = aiRuntimeConfig()
  return { ...aiStatus(runtime), keyStored: Boolean(db?.read().aiSettings?.apiKeyEncrypted), encryptionAvailable: safeStorage.isEncryptionAvailable() }
}

function saveAiConfig(input = {}) {
  const current = db.read().aiSettings || {}
  const endpoint = String(input.endpoint || '').trim()
  const model = String(input.model || '').trim()
  const validation = validateAiConfig({ endpoint, model, apiKey: 'validation-only' })
  if (!validation.ok) throw new Error(validation.reason)
  let apiKeyEncrypted = endpoint === current.endpoint ? current.apiKeyEncrypted || '' : ''
  if (input.clearApiKey) apiKeyEncrypted = ''
  else if (String(input.apiKey || '').trim()) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统无法安全保存 API 密钥，请改用 DISK_SENSE_AI_KEY 环境变量')
    apiKeyEncrypted = safeStorage.encryptString(String(input.apiKey).trim()).toString('base64')
  }
  db.read().aiSettings = { endpoint, model, apiKeyEncrypted, updatedAt: new Date().toISOString() }
  db.save()
  return publicAiConfig()
}
const watchers = []

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1000,
    minHeight: 680,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false }
  })
  if (process.argv.includes('--dev')) win.loadURL('http://localhost:5173')
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
}

function addInspectHandlers() {
  const loadExplainer = () => {
    const modulePath = require.resolve('./explainer.cjs')
    if (process.argv.includes('--dev')) delete require.cache[modulePath]
    return require(modulePath)
  }
  ipcMain.handle('inspect:list', async (_event, dir) => loadExplainer().listDirectory(dir || 'C:\\'))
  ipcMain.handle('inspect:explain', async (_event, filePath) => {
    const result = await loadExplainer().explainPath(filePath)
    return { ...result, relationship: storageRelationship(result.path), relatedLocations: findRelatedLocations(result.path) }
  })
  ipcMain.handle('analysis:ai-status', () => publicAiConfig())
  ipcMain.handle('analysis:ai-config:get', () => publicAiConfig())
  ipcMain.handle('analysis:ai-config:save', (_event, input) => saveAiConfig(input))
  ipcMain.handle('analysis:ai-config:clear', () => { db.read().aiSettings = null; db.save(); return publicAiConfig() })
  ipcMain.handle('analysis:ai-models', async (_event, draft) => aiListModels(aiDraftConfig(draft)))
  ipcMain.handle('analysis:ai-test', async (_event, draft) => aiTestConnection(aiDraftConfig(draft)))
  ipcMain.handle('analysis:ai-review', async (_event, evidence) => aiReview(evidence, aiRuntimeConfig()))
}

function addSpaceHandlers() {
  ipcMain.handle('changes:state', () => ({ baseline: db.read().changeBaseline || null, last: db.read().lastChangeScan || null }))
  ipcMain.handle('changes:baseline', async () => {
    if (activeChangeScan) return { running: true, id: activeChangeScan.id }
    const id = `baseline-${Date.now()}`; const controller = new AbortController(); activeChangeScan = { id, controller }
    try {
      const snapshot = await inventory({}, { signal: controller.signal, onProgress: progress => { if (win && !win.isDestroyed()) win.webContents.send('changes:progress', { id, ...progress }) } })
      if (!snapshot.cancelled) { db.read().changeBaseline = { ...snapshot, createdAt: new Date().toISOString() }; db.save() }
      return { id, running: false, snapshot: { ...snapshot, entries: undefined }, baselineCreatedAt: db.read().changeBaseline?.createdAt }
    } finally { activeChangeScan = null }
  })
  ipcMain.handle('changes:scan', async () => {
    const baseline = db.read().changeBaseline
    if (!baseline) return { ok: false, reason: '请先建立一次变化基线' }
    if (activeChangeScan) return { ok: false, reason: '变化扫描正在进行' }
    const id = `changes-${Date.now()}`; const controller = new AbortController(); activeChangeScan = { id, controller }
    try {
      const snapshot = await inventory({}, { signal: controller.signal, onProgress: progress => { if (win && !win.isDestroyed()) win.webContents.send('changes:progress', { id, ...progress }) } })
      const result = diffChanges(baseline, snapshot)
      db.read().lastChangeScan = { id, createdAt: new Date().toISOString(), snapshot: { ...snapshot, entries: undefined }, result }; db.save()
      return { ok: true, id, ...result, baselineCreatedAt: baseline.createdAt, scannedAt: db.read().lastChangeScan.createdAt }
    } finally { activeChangeScan = null }
  })
  ipcMain.handle('changes:cancel', () => { if (!activeChangeScan) return { cancelled: false }; activeChangeScan.controller.abort(); return { cancelled: true, id: activeChangeScan.id } })
  ipcMain.handle('space:scan:start', () => {
    if (activeScan) return { id: activeScan.id, running: true }
    const id = `scan-${Date.now()}`
    const controller = new AbortController()
    activeScan = { id, controller }
    scanAsync({}, { signal: controller.signal, onProgress: progress => { if (win && !win.isDestroyed()) win.webContents.send('space:scan:progress', { id, ...progress }) } }).then(result => {
      if (win && !win.isDestroyed()) win.webContents.send('space:scan:complete', { id, result })
    }).catch(error => { if (win && !win.isDestroyed()) win.webContents.send('space:scan:error', { id, error: error.message }) }).finally(() => { activeScan = null })
    return { id, running: true }
  })
  ipcMain.handle('space:scan:cancel', () => { if (!activeScan) return { cancelled: false }; activeScan.controller.abort(); return { cancelled: true, id: activeScan.id } })
  ipcMain.handle('space:scan', () => {
    const started = Date.now()
    const result = scan()
    const previous = db.read().snapshots[0]
    const snapshot = { id: `snapshot-${Date.now()}`, createdAt: new Date().toISOString(), durationMs: Date.now() - started, ...result }
    snapshot.items = snapshot.items.map(item => ({ ...item, relationship: storageRelationship(item.path) }))
    if (previous) for (const item of result.items.slice(0, 10000)) {
      const old = previous.items.find(x => x.id === item.id)
      if (!old) db.read().events.unshift({ kind: 'added', path: item.path, observedAt: snapshot.createdAt })
      else if (old.size !== item.size) db.read().events.unshift({ kind: 'modified', path: item.path, beforeSize: old.size, afterSize: item.size, observedAt: snapshot.createdAt })
    }
    db.read().snapshots.unshift(snapshot); db.read().snapshots = db.read().snapshots.slice(0, 20)
    db.read().events = db.read().events.slice(0, 1000); db.save()
    return { ...snapshot, events: db.read().events.slice(0, 50) }
  })
  ipcMain.handle('space:state', () => db.read())
  ipcMain.handle('space:duplicates', () => candidates(db.read().snapshots[0]?.items || []))
  ipcMain.handle('space:diagnostics', () => ({ userData: app.getPath('userData'), electron: process.versions.electron, node: process.versions.node, platform: process.platform }))
}

function addCleanerHandlers() {
  ipcMain.handle('cleaner:rules', () => rules.map(({ id, title, category, risk, reason }) => ({ id, title, category, risk, reason })))
  ipcMain.handle('cleaner:scan', (_event, id) => scanRule(id))
  ipcMain.handle('cleaner:execute', async (_event, files) => {
    const results = []
    for (const file of files || []) {
      try { await shell.trashItem(file.path); results.push({ ...file, success: true }) }
      catch (error) { results.push({ ...file, success: false, error: error.message }) }
    }
    const job = { id: `cleanup-${Date.now()}`, createdAt: new Date().toISOString(), results, freed: results.filter(x => x.success).reduce((sum, x) => sum + x.size, 0) }
    db.read().cleanupJobs = [job, ...(db.read().cleanupJobs || [])].slice(0, 100); db.save(); return job
  })
}

function watchRoots() {
  for (const root of require('./scanner.cjs').roots()) try {
    const watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
      if (!filename || !win || win.isDestroyed() || win.webContents.isDestroyed()) return
      win.webContents.send('space:change', { eventType, path: path.join(root, filename), observedAt: new Date().toISOString() })
    })
    watchers.push(watcher)
  } catch { /* a missing or protected root must not stop the application */ }
}

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus() }
  })
  app.whenReady().then(() => {
  db = store(path.join(app.getPath('userData'), 'disk-sense-state.json'))
  addInspectHandlers(); addSpaceHandlers(); addCleanerHandlers(); createWindow(); watchRoots()
  })
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
