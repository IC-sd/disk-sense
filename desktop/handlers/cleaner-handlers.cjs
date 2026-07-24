const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { rules, publicRule, scanRuleAsync, inspectSlimming, isPathExcluded } = require('../cleaner.cjs')
const { CandidateVault, compactCleanupJob, executeCleanup } = require('../cleanup-executor.cjs')

function historySummary(job) {
  return {
    id: job.id,
    createdAt: job.createdAt,
    executionMode: job.executionMode || 'trash',
    requested: Number(job.requested || job.results?.length || 0),
    processed: Number(job.processed || job.results?.length || 0),
    succeeded: Number(job.succeeded || job.results?.filter(item => item.success).length || 0),
    failed: Number(job.failed || job.results?.filter(item => !item.success).length || 0),
    cancelled: Boolean(job.cancelled),
    movedToTrashBytes: Number(job.movedToTrashBytes || job.freed || 0),
    reclaimedBytes: Number(job.reclaimedBytes || 0),
    omittedResults: Number(job.omittedResults || 0)
  }
}

function validateExclusion(input) {
  const raw = String(input?.path || '').trim()
  if (!raw || raw.length > 1024 || !path.isAbsolute(raw)) throw new Error('请输入完整的绝对路径')
  const resolved = path.resolve(raw)
  const mode = input?.mode === 'exact' ? 'exact' : 'prefix'
  return {
    id: randomUUID(),
    path: resolved,
    mode,
    reason: String(input?.reason || '用户手动排除').trim().slice(0, 120) || '用户手动排除',
    createdAt: new Date().toISOString()
  }
}

function registerCleanerHandlers({ ipcMain, db, shell, sendToRenderer }) {
  const candidateVault = new CandidateVault()
  const activeScans = new Map()
  let activeCleanup = null
  const exclusions = () => db.read().cleanupExclusions || []

  ipcMain.handle('cleaner:rules', () => rules.map(publicRule))
  ipcMain.handle('cleaner:scan', async (_event, id) => {
    const ruleId = String(id || '')
    if (activeScans.has(ruleId)) throw new Error('该规则正在扫描')
    const controller = new AbortController()
    activeScans.set(ruleId, controller)
    try {
      const result = await scanRuleAsync(ruleId, {
        signal: controller.signal,
        exclusions: exclusions(),
        onProgress: progress => sendToRenderer('cleaner:scan-progress', progress)
      })
      candidateVault.registerScan(result)
      return result
    } finally {
      activeScans.delete(ruleId)
    }
  })

  ipcMain.handle('cleaner:scan-cancel', (_event, id) => {
    const ids = id ? [String(id)] : [...activeScans.keys()]
    let cancelled = 0
    for (const ruleId of ids) {
      const controller = activeScans.get(ruleId)
      if (controller) {
        controller.abort()
        cancelled++
      }
    }
    return { cancelled: cancelled > 0, count: cancelled }
  })

  ipcMain.handle('cleaner:slimming', () => inspectSlimming())
  ipcMain.handle('cleaner:history', () => (db.read().cleanupJobs || []).map(historySummary))
  ipcMain.handle('cleaner:history-detail', (_event, id) => {
    const job = (db.read().cleanupJobs || []).find(item => item.id === String(id || ''))
    if (!job) throw new Error('未找到这条操作记录')
    return { ...historySummary(job), results: job.results || [] }
  })
  ipcMain.handle('cleaner:history-clear', () => {
    if (activeCleanup) throw new Error('清理任务执行中，暂时不能清空记录')
    db.read().cleanupJobs = []
    db.save()
    return { cleared: true }
  })

  ipcMain.handle('cleaner:exclusions', () => exclusions())
  ipcMain.handle('cleaner:exclusion-add', (_event, input) => {
    if (activeCleanup || activeScans.size) throw new Error('请等待扫描或清理任务结束')
    const exclusion = validateExclusion(input)
    const duplicate = exclusions().find(item => (
      item.mode === exclusion.mode &&
      path.resolve(item.path).toLowerCase() === exclusion.path.toLowerCase()
    ))
    if (duplicate) return duplicate
    db.read().cleanupExclusions = [exclusion, ...exclusions()].slice(0, 500)
    db.save()
    candidateVault.clearAll()
    return exclusion
  })
  ipcMain.handle('cleaner:exclusion-remove', (_event, id) => {
    if (activeCleanup || activeScans.size) throw new Error('请等待扫描或清理任务结束')
    const before = exclusions()
    db.read().cleanupExclusions = before.filter(item => item.id !== String(id || ''))
    const removed = before.length !== db.read().cleanupExclusions.length
    if (removed) {
      db.save()
      candidateVault.clearAll()
    }
    return { removed }
  })

  ipcMain.handle('cleaner:execute', async (_event, files) => {
    if (activeCleanup) throw new Error('已有清理任务正在执行')
    const id = `cleanup-${Date.now()}`
    const controller = new AbortController()
    activeCleanup = { id, controller }
    try {
      const execution = await executeCleanup({
        requests: files,
        vault: candidateVault,
        trashItem: filePath => shell.trashItem(filePath),
        signal: controller.signal,
        isExcluded: filePath => isPathExcluded(filePath, exclusions()),
        onProgress: progress => sendToRenderer('cleaner:execute-progress', { id, ...progress })
      })
      const job = {
        id,
        createdAt: new Date().toISOString(),
        executionMode: 'trash',
        ...execution
      }
      db.read().cleanupJobs = [
        compactCleanupJob(job),
        ...(db.read().cleanupJobs || [])
      ].slice(0, 50)
      db.save()
      return job
    } finally {
      activeCleanup = null
    }
  })
  ipcMain.handle('cleaner:cancel', () => {
    if (!activeCleanup) return { cancelled: false }
    activeCleanup.controller.abort()
    return { cancelled: true, id: activeCleanup.id }
  })
}

module.exports = {
  registerCleanerHandlers,
  historySummary,
  validateExclusion
}
