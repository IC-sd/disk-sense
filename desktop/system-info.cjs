const fs = require('node:fs')
const path = require('node:path')
const { volumes } = require('./change-tracker.cjs')

function safeNumber(value) {
  if (typeof value === 'bigint') {
    const maximum = BigInt(Number.MAX_SAFE_INTEGER)
    return Number(value > maximum ? maximum : value)
  }
  return Number(value || 0)
}

function volumeMetrics(root, stat, systemDrive = process.env.SystemDrive || 'C:') {
  const blockSize = safeNumber(stat.bsize || stat.frsize)
  const totalBytes = blockSize * safeNumber(stat.blocks)
  const freeBytes = blockSize * safeNumber(stat.bavail)
  const usedBytes = Math.max(0, totalBytes - freeBytes)
  return {
    root: path.parse(root).root || root,
    totalBytes,
    freeBytes,
    usedBytes,
    usagePercent: totalBytes ? Math.round(usedBytes / totalBytes * 1000) / 10 : 0,
    isSystem: String(root).slice(0, 2).toLowerCase() === String(systemDrive).slice(0, 2).toLowerCase()
  }
}

async function diskVolumes() {
  const result = []
  for (const root of volumes()) {
    try {
      const stat = await fs.promises.statfs(root, { bigint: true })
      result.push(volumeMetrics(root, stat))
    } catch {
      // Disconnected removable and network volumes are omitted.
    }
  }
  return result.sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || a.root.localeCompare(b.root))
}

function stateSummary(state = {}) {
  const jobs = Array.isArray(state.cleanupJobs) ? state.cleanupJobs : []
  return {
    cleanupJobs: jobs.length,
    movedToTrashBytes: jobs.reduce((sum, job) => sum + Number(job.movedToTrashBytes || 0), 0),
    movedToTrashFiles: jobs.reduce((sum, job) => sum + Number(job.succeeded || 0), 0),
    lastCleanupAt: jobs[0]?.createdAt || null,
    baselineCreatedAt: state.changeBaseline?.createdAt || null,
    lastChangeScanAt: state.lastChangeScan?.createdAt || null,
    exclusionCount: Array.isArray(state.cleanupExclusions) ? state.cleanupExclusions.length : 0
  }
}

async function overview(state) {
  return {
    generatedAt: new Date().toISOString(),
    volumes: await diskVolumes(),
    activity: stateSummary(state)
  }
}

module.exports = { overview, diskVolumes, volumeMetrics, stateSummary, safeNumber }
