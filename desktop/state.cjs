const fs = require('node:fs')
const path = require('node:path')

const STATE_VERSION = 7
const SIDECAR_VERSION = 1

function defaults() {
  return {
    version: STATE_VERSION,
    cleanupJobs: [],
    maintenanceJobs: [],
    changeScans: [],
    changeBaseline: null,
    lastChangeScan: null,
    aiSettings: null,
    aiAnalyses: [],
    cleanupExclusions: [],
    appearance: {
      theme: 'dark'
    }
  }
}

function readJsonWithBackup(file) {
  for (const candidate of [file, `${file}.bak`]) {
    try {
      return JSON.parse(fs.readFileSync(candidate, 'utf8'))
    } catch {
      // Try the backup before falling back to an empty safe state.
    }
  }
  return null
}

function atomicWrite(file, value, pretty = false) {
  const temporary = `${file}.tmp`
  const backup = `${file}.bak`
  const serialized = JSON.stringify(value, null, pretty ? 2 : 0)
  fs.writeFileSync(temporary, serialized, { encoding: 'utf8', flag: 'w' })
  if (fs.existsSync(file)) {
    try {
      JSON.parse(fs.readFileSync(file, 'utf8'))
      fs.copyFileSync(file, backup)
    } catch {
      // Never replace a known-good backup with a malformed primary file.
    }
  }
  fs.renameSync(temporary, file)
}

function store(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const stored = readJsonWithBackup(file) || {}
  const changeFile = `${file}.changes.json`
  const operationFile = `${file}.operations.json`
  const analysisFile = `${file}.analyses.json`
  const storedChanges = readJsonWithBackup(changeFile) || {}
  const storedOperationsSource = readJsonWithBackup(operationFile)
  const storedOperations = storedOperationsSource || {}
  const storedAnalysesSource = readJsonWithBackup(analysisFile)
  const storedAnalyses = storedAnalysesSource || {}
  let data = {
    ...defaults(),
    ...stored,
    cleanupJobs: storedOperations.cleanupJobs ?? stored.cleanupJobs ?? [],
    maintenanceJobs: storedOperations.maintenanceJobs ?? stored.maintenanceJobs ?? [],
    aiAnalyses: storedAnalyses.aiAnalyses ?? stored.aiAnalyses ?? [],
    changeBaseline: storedChanges.changeBaseline ?? stored.changeBaseline ?? null,
    lastChangeScan: storedChanges.lastChangeScan ?? stored.lastChangeScan ?? null,
    version: STATE_VERSION
  }
  delete data.memories
  delete data.snapshots
  delete data.events
  if (!Array.isArray(data.cleanupJobs)) data.cleanupJobs = []
  if (!Array.isArray(data.maintenanceJobs)) data.maintenanceJobs = []
  if (!Array.isArray(data.changeScans)) data.changeScans = []
  if (!Array.isArray(data.aiAnalyses)) data.aiAnalyses = []
  if (!Array.isArray(data.cleanupExclusions)) data.cleanupExclusions = []
  if (!data.appearance || typeof data.appearance !== 'object') data.appearance = { theme: 'dark' }
  data.appearance.theme = data.appearance.theme === 'light' ? 'light' : 'dark'
  let needsHeavyMigration = Boolean(
    (stored.changeBaseline || stored.lastChangeScan) &&
    storedChanges.changeBaseline === undefined &&
    storedChanges.lastChangeScan === undefined
  )
  let savedBaseline = data.changeBaseline
  let savedLastChangeScan = data.lastChangeScan
  let needsOperationMigration = Boolean(
    !storedOperationsSource ||
    !Array.isArray(storedOperations.cleanupJobs) ||
    !Array.isArray(storedOperations.maintenanceJobs)
  )
  let needsAnalysisMigration = Boolean(
    !storedAnalysesSource ||
    !Array.isArray(storedAnalyses.aiAnalyses)
  )
  let savedCleanupJobs = data.cleanupJobs
  let savedMaintenanceJobs = data.maintenanceJobs
  let savedAiAnalyses = data.aiAnalyses

  return {
    read: () => data,
    save: () => {
      const heavyChanged = needsHeavyMigration || data.changeBaseline !== savedBaseline || data.lastChangeScan !== savedLastChangeScan
      if (heavyChanged) {
        atomicWrite(changeFile, {
          version: 1,
          changeBaseline: data.changeBaseline,
          lastChangeScan: data.lastChangeScan
        })
        savedBaseline = data.changeBaseline
        savedLastChangeScan = data.lastChangeScan
        needsHeavyMigration = false
      }
      const operationsChanged = needsOperationMigration ||
        data.cleanupJobs !== savedCleanupJobs ||
        data.maintenanceJobs !== savedMaintenanceJobs
      if (operationsChanged) {
        atomicWrite(operationFile, {
          version: SIDECAR_VERSION,
          cleanupJobs: data.cleanupJobs,
          maintenanceJobs: data.maintenanceJobs
        })
        savedCleanupJobs = data.cleanupJobs
        savedMaintenanceJobs = data.maintenanceJobs
        needsOperationMigration = false
      }
      const analysesChanged = needsAnalysisMigration || data.aiAnalyses !== savedAiAnalyses
      if (analysesChanged) {
        atomicWrite(analysisFile, {
          version: SIDECAR_VERSION,
          aiAnalyses: data.aiAnalyses
        })
        savedAiAnalyses = data.aiAnalyses
        needsAnalysisMigration = false
      }
      const {
        changeBaseline,
        lastChangeScan,
        cleanupJobs,
        maintenanceJobs,
        aiAnalyses,
        ...lightState
      } = data
      atomicWrite(file, { ...lightState, version: STATE_VERSION }, true)
    }
  }
}

module.exports = { store, readJsonWithBackup, atomicWrite }
