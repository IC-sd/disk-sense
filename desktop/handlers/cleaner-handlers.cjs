const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { rules, publicRule, scanRuleAsync, isPathExcluded } = require('../cleaner.cjs')
const { CandidateVault, compactCleanupJob, executeCleanup } = require('../cleanup-executor.cjs')
const {
  inspectSlimming,
  maintenanceStatus,
  executeMaintenanceAction
} = require('../system-maintenance.cjs')

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
  let activeMaintenance = null
  let maintenanceStatusCache = null
  let maintenanceStatusPromise = null
  const exclusions = () => db.read().cleanupExclusions || []
  const maintenanceHistory = () => db.read().maintenanceJobs || []

  const baseMaintenanceStatus = async () => {
    if (maintenanceStatusCache && Date.now() - maintenanceStatusCache.readAt < 5000) {
      return maintenanceStatusCache.value
    }
    if (!maintenanceStatusPromise) {
      maintenanceStatusPromise = maintenanceStatus()
        .then(value => {
          maintenanceStatusCache = { value, readAt: Date.now() }
          return value
        })
        .finally(() => { maintenanceStatusPromise = null })
    }
    return maintenanceStatusPromise
  }

  const readMaintenanceStatus = async () => ({
    ...(await baseMaintenanceStatus()),
    activeTask: activeMaintenance
      ? {
          id: activeMaintenance.id,
          actionId: activeMaintenance.actionId,
          startedAt: activeMaintenance.startedAt
        }
      : null
  })

  ipcMain.handle('cleaner:rules', () => rules.map(publicRule))
  ipcMain.handle('cleaner:scan', async (_event, id) => {
    const ruleId = String(id || '')
    if (activeMaintenance) throw new Error('系统维护正在执行，完成后才能扫描垃圾文件')
    if (activeCleanup) throw new Error('垃圾清理正在执行，完成后才能重新扫描')
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

  ipcMain.handle('cleaner:slimming', async () => inspectSlimming(await readMaintenanceStatus()))
  ipcMain.handle('cleaner:slimming-status', () => readMaintenanceStatus())
  ipcMain.handle('cleaner:slimming-history', () => maintenanceHistory())
  ipcMain.handle('cleaner:slimming-execute', async (_event, input) => {
    if (activeMaintenance) throw new Error('已有系统维护任务正在执行')
    if (activeCleanup || activeScans.size) throw new Error('请先等待垃圾扫描或清理任务结束')
    const task = {
      id: `maintenance-${Date.now()}`,
      actionId: String(input?.actionId || ''),
      startedAt: new Date().toISOString()
    }
    activeMaintenance = task
    try {
      const status = await baseMaintenanceStatus()
      const result = await executeMaintenanceAction({
        actionId: task.actionId,
        confirmation: String(input?.confirmation || '')
      }, {
        status,
        openPath: target => shell.openPath(target),
        openExternal: target => shell.openExternal(target),
        onProgress: progress => sendToRenderer('cleaner:slimming-progress', {
          id: task.id,
          ...progress
        })
      })
      const job = { ...result, id: task.id }
      db.read().maintenanceJobs = [job, ...maintenanceHistory()].slice(0, 30)
      db.save()
      maintenanceStatusCache = null
      return job
    } finally {
      activeMaintenance = null
    }
  })
  ipcMain.handle('cleaner:history', () => (db.read().cleanupJobs || []).map(historySummary))
  ipcMain.handle('cleaner:history-detail', (_event, id) => {
    const job = (db.read().cleanupJobs || []).find(item => item.id === String(id || ''))
    if (!job) throw new Error('未找到这条操作记录')
    return { ...historySummary(job), results: job.results || [] }
  })
  ipcMain.handle('cleaner:history-clear', () => {
    if (activeCleanup || activeMaintenance) throw new Error('清理或系统维护任务执行中，暂时不能清空记录')
    db.read().cleanupJobs = []
    db.read().maintenanceJobs = []
    db.save()
    return { cleared: true }
  })

  ipcMain.handle('cleaner:exclusions', () => exclusions())
  ipcMain.handle('cleaner:exclusion-add', (_event, input) => {
    if (activeCleanup || activeMaintenance || activeScans.size) throw new Error('请等待扫描、清理或系统维护任务结束')
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
    if (activeCleanup || activeMaintenance || activeScans.size) throw new Error('请等待扫描、清理或系统维护任务结束')
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
    if (activeMaintenance) throw new Error('系统维护正在执行，完成后才能清理垃圾文件')
    if (activeScans.size) throw new Error('请等待垃圾扫描完成后再执行清理')
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
