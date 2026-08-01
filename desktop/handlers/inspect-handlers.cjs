const fs = require('node:fs')
const path = require('node:path')
const { storageRelationship, findRelatedLocations } = require('../app-attribution.cjs')
const {
  status,
  review,
  testConnection,
  listModels,
  validateConfig
} = require('../ai-explainer.cjs')

const KNOWN_APPLICATION_NAMES = new Map([
  ['winword.exe', 'Microsoft Word'],
  ['excel.exe', 'Microsoft Excel'],
  ['powerpnt.exe', 'Microsoft PowerPoint'],
  ['outlook.exe', 'Microsoft Outlook'],
  ['onenote.exe', 'Microsoft OneNote']
])

const OFFICE_BRAND_ICON_NAMES = new Map([
  ['winword.exe', ['word.png', 'word-icon_']],
  ['excel.exe', ['excel.png', 'excel-icon_']],
  ['powerpnt.exe', ['powerpoint.png', 'powerpoint-icon_']],
  ['outlook.exe', ['outlook.png', 'outlook-icon_']],
  ['onenote.exe', ['onenote.png', 'onenote-icon_']]
])

const officeBrandIconCache = new Map()

function fileStem(filePath) {
  const name = path.basename(String(filePath || ''))
  const extension = path.extname(name)
  return extension ? name.slice(0, -extension.length) : name
}

function findOfficeBrandIcon(applicationPath) {
  const resolvedApplication = path.resolve(String(applicationPath || ''))
  const executableName = path.basename(resolvedApplication).toLowerCase()
  const iconNames = OFFICE_BRAND_ICON_NAMES.get(executableName)
  if (!iconNames) return ''
  const officeDirectory = path.dirname(resolvedApplication)
  const cacheKey = `${officeDirectory.toLowerCase()}|${executableName}`
  if (officeBrandIconCache.has(cacheKey)) return officeBrandIconCache.get(cacheKey)

  const packagesDirectory = path.join(officeDirectory, 'sdxs')
  let result = ''
  try {
    const packageDirectories = fs.readdirSync(packagesDirectory, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .slice(0, 256)
    for (const packageDirectory of packageDirectories) {
      const packagePath = path.join(packagesDirectory, packageDirectory.name)
      const fixedAsset = path.join(packagePath, 'assets', 'src', 'assets', 'images', iconNames[0])
      if (fs.existsSync(fixedAsset)) {
        result = fixedAsset
        break
      }
      const offlineDirectory = path.join(packagePath, 'OfflineFiles')
      if (!fs.existsSync(offlineDirectory)) continue
      const matchingIcon = fs.readdirSync(offlineDirectory, { withFileTypes: true })
        .filter(entry => entry.isFile())
        .slice(0, 128)
        .find(entry => entry.name.toLowerCase().startsWith(iconNames[1]) && entry.name.toLowerCase().endsWith('.png'))
      if (matchingIcon) {
        result = path.join(offlineDirectory, matchingIcon.name)
        break
      }
    }
  } catch {
    result = ''
  }
  officeBrandIconCache.set(cacheKey, result)
  return result
}

function imageFileToDataUrl(filePath) {
  if (!filePath || path.extname(filePath).toLowerCase() !== '.png') return ''
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size <= 0 || stat.size > 1024 * 1024) return ''
    return `data:image/png;base64,${fs.readFileSync(filePath).toString('base64')}`
  } catch {
    return ''
  }
}

function resolveFilePresentation(filePath, shell) {
  const resolvedPath = path.resolve(filePath)
  const ordinaryFile = {
    iconTarget: resolvedPath,
    displayName: '',
    target: ''
  }
  if (path.extname(resolvedPath).toLowerCase() !== '.lnk' || !shell?.readShortcutLink) return ordinaryFile
  const shortcutFallback = { ...ordinaryFile, displayName: fileStem(resolvedPath) }
  try {
    const shortcut = shell.readShortcutLink(resolvedPath)
    const target = path.isAbsolute(shortcut?.target || '') ? path.resolve(shortcut.target) : ''
    const iconCandidate = String(shortcut?.icon || '').replace(/,-?\d+$/u, '')
    const shortcutIcon = path.isAbsolute(iconCandidate) ? path.resolve(iconCandidate) : ''
    const applicationName = KNOWN_APPLICATION_NAMES.get(path.basename(target).toLowerCase()) || ''
    return {
      iconTarget: shortcutIcon || target || resolvedPath,
      brandIconPath: applicationName ? findOfficeBrandIcon(target) : '',
      displayName: applicationName || shortcutFallback.displayName,
      target,
      description: String(shortcut?.description || '')
    }
  } catch {
    return shortcutFallback
  }
}

function createAiConfigService({ getDb, safeStorage, environment = process.env }) {
  const runtime = () => {
    const database = getDb()
    const stored = database?.read().aiSettings || {}
    let apiKey = environment.DISK_SENSE_AI_KEY || ''
    if (stored.apiKeyEncrypted) {
      try {
        apiKey = safeStorage.decryptString(Buffer.from(stored.apiKeyEncrypted, 'base64'))
      } catch {
        apiKey = ''
      }
    }
    return {
      endpoint: stored.endpoint || environment.DISK_SENSE_AI_ENDPOINT || '',
      model: stored.model || environment.DISK_SENSE_AI_MODEL || '',
      apiKey
    }
  }

  const draft = (input = {}) => {
    const current = runtime()
    const endpoint = String(input.endpoint ?? current.endpoint).trim()
    const providedKey = String(input.apiKey || '').trim()
    const canReuseKey = endpoint === current.endpoint
    return {
      ...current,
      ...input,
      endpoint,
      apiKey: providedKey || (canReuseKey ? current.apiKey : '')
    }
  }

  const publicConfig = () => {
    const database = getDb()
    const current = runtime()
    return {
      ...status(current),
      keyStored: Boolean(database?.read().aiSettings?.apiKeyEncrypted),
      encryptionAvailable: safeStorage.isEncryptionAvailable()
    }
  }

  const save = (input = {}) => {
    const database = getDb()
    const current = database.read().aiSettings || {}
    const endpoint = String(input.endpoint || '').trim()
    const model = String(input.model || '').trim()
    const validation = validateConfig({ endpoint, model, apiKey: 'validation-only' })
    if (!validation.ok) throw new Error(validation.reason)
    let apiKeyEncrypted = endpoint === current.endpoint ? current.apiKeyEncrypted || '' : ''
    if (input.clearApiKey) {
      apiKeyEncrypted = ''
    } else if (String(input.apiKey || '').trim()) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('当前系统无法安全保存 API 密钥，请改用 DISK_SENSE_AI_KEY 环境变量')
      }
      apiKeyEncrypted = safeStorage.encryptString(String(input.apiKey).trim()).toString('base64')
    }
    database.read().aiSettings = {
      endpoint,
      model,
      apiKeyEncrypted,
      updatedAt: new Date().toISOString()
    }
    database.save()
    return publicConfig()
  }

  const clear = () => {
    const database = getDb()
    database.read().aiSettings = null
    database.save()
    return publicConfig()
  }

  return { runtime, draft, publicConfig, save, clear }
}

function createExplainerLoader() {
  let loadedModule = null
  let loadedModifiedAt = 0
  return () => {
    const modulePath = require.resolve('../explainer.cjs')
    const modifiedAt = fs.statSync(modulePath).mtimeMs
    if (!loadedModule || modifiedAt !== loadedModifiedAt) {
      delete require.cache[modulePath]
      loadedModule = require(modulePath)
      loadedModifiedAt = modifiedAt
    }
    return loadedModule
  }
}

function registerInspectHandlers({ ipcMain, aiConfig, searchService, app, shell }) {
  const loadExplainer = createExplainerLoader()
  const nativePresentationCache = new Map()
  const cacheNativePresentation = (filePath, presentation) => {
    nativePresentationCache.delete(filePath)
    nativePresentationCache.set(filePath, presentation)
    while (nativePresentationCache.size > 800) nativePresentationCache.delete(nativePresentationCache.keys().next().value)
  }

  ipcMain.handle('inspect:list', async (_event, directory) => (
    loadExplainer().listDirectory(directory || 'C:\\')
  ))
  ipcMain.handle('inspect:estimate', async (_event, directory) => ({
    path: path.resolve(directory),
    ...await loadExplainer().estimateDirectory(directory)
  }))
  ipcMain.handle('inspect:explain', async (_event, filePath) => {
    const result = await loadExplainer().explainPath(filePath)
    const relationship = storageRelationship(result.path)
    return {
      ...result,
      belongsTo: relationship.owner?.name || result.source,
      relationship,
      relatedLocations: findRelatedLocations(result.path)
    }
  })

  if (searchService) {
    ipcMain.handle('inspect:index-status', () => searchService.status())
    ipcMain.handle('inspect:index-start', (_event, input = {}) => searchService.rebuildScope({
      scope: input.scope === 'all' ? 'all' : 'drive',
      root: path.parse(path.resolve(input.root || 'C:\\')).root
    }))
    ipcMain.handle('inspect:index-cancel', () => searchService.cancel())
    ipcMain.handle('inspect:search', (_event, input) => searchService.search(input))
  }
  if (app?.getFileIcon) {
    ipcMain.handle('inspect:file-presentations', async (_event, input = []) => {
      const requested = [...new Set((Array.isArray(input) ? input : [])
        .map(value => String(value || ''))
        .filter(filePath => path.isAbsolute(filePath)))]
        .slice(0, 48)
      const presentations = {}
      await Promise.all(requested.map(async filePath => {
        const cacheKey = path.resolve(filePath).toLowerCase()
        const cached = nativePresentationCache.get(cacheKey)
        if (cached) {
          presentations[filePath] = cached
          return
        }
        try {
          const resolved = resolveFilePresentation(filePath, shell)
          const brandIcon = imageFileToDataUrl(resolved.brandIconPath)
          const icon = brandIcon ? null : await app.getFileIcon(resolved.iconTarget, { size: 'normal' })
          const presentation = {
            dataUrl: brandIcon || (icon?.isEmpty() ? '' : icon.toDataURL()),
            displayName: resolved.displayName,
            target: resolved.target,
            description: resolved.description || ''
          }
          cacheNativePresentation(cacheKey, presentation)
          presentations[filePath] = presentation
        } catch {
          // Shell icon lookup is optional; the renderer keeps its local fallback.
        }
      }))
      return presentations
    })
  }

  ipcMain.handle('analysis:ai-status', () => aiConfig.publicConfig())
  ipcMain.handle('analysis:ai-config:get', () => aiConfig.publicConfig())
  ipcMain.handle('analysis:ai-config:save', (_event, input) => aiConfig.save(input))
  ipcMain.handle('analysis:ai-config:clear', () => aiConfig.clear())
  ipcMain.handle('analysis:ai-models', async (_event, input) => listModels(aiConfig.draft(input)))
  ipcMain.handle('analysis:ai-test', async (_event, input) => testConnection(aiConfig.draft(input)))
  ipcMain.handle('analysis:ai-review', async (_event, payload) => {
    const request = payload?.evidence ? payload : { evidence: payload, mode: 'normal' }
    return review(request.evidence, {
      ...aiConfig.runtime(),
      analysisMode: request.mode === 'deep' ? 'deep' : 'normal'
    })
  })
}

module.exports = {
  createAiConfigService,
  findOfficeBrandIcon,
  resolveFilePresentation,
  registerInspectHandlers
}
