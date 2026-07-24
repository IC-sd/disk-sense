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

function registerInspectHandlers({ ipcMain, aiConfig }) {
  const loadExplainer = createExplainerLoader()

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
  createExplainerLoader,
  registerInspectHandlers
}
