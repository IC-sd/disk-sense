const fs = require('node:fs')
const path = require('node:path')

function defaults() {
  return {
    version: 4,
    snapshots: [],
    events: [],
    cleanupJobs: [],
    changeScans: [],
    changeBaseline: null,
    lastChangeScan: null,
    aiSettings: null,
    cleanupExclusions: []
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
  const storedChanges = readJsonWithBackup(changeFile) || {}
  let data = {
    ...defaults(),
    ...stored,
    changeBaseline: storedChanges.changeBaseline ?? stored.changeBaseline ?? null,
    lastChangeScan: storedChanges.lastChangeScan ?? stored.lastChangeScan ?? null,
    version: 4
  }
  delete data.memories
  if (!Array.isArray(data.cleanupJobs)) data.cleanupJobs = []
  if (!Array.isArray(data.changeScans)) data.changeScans = []
  if (!Array.isArray(data.cleanupExclusions)) data.cleanupExclusions = []
  let needsHeavyMigration = Boolean(
    (stored.changeBaseline || stored.lastChangeScan) &&
    storedChanges.changeBaseline === undefined &&
    storedChanges.lastChangeScan === undefined
  )
  let savedBaseline = data.changeBaseline
  let savedLastChangeScan = data.lastChangeScan

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
      const { changeBaseline, lastChangeScan, ...lightState } = data
      atomicWrite(file, { ...lightState, version: 4 }, true)
    }
  }
}

module.exports = { store, readJsonWithBackup, atomicWrite }
