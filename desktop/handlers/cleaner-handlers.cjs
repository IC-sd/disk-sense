const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { rules, publicRule, scanRuleAsync, isPathExcluded } = require('../cleaner.cjs')
const { CandidateVault, compactCleanupJob, executeCleanupPlan } = require('../cleanup-executor.cjs')
const { createScanSession } = require('../cleanup-scan-session.cjs')
const {
  inspectSlimming,
  maintenanceActions,
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
    isolatedBytes: Number(job.isolatedBytes || 0),
    quarantineId: job.quarantineId || null,
    volumeChanges: job.volumeChanges || [],
    reclaimedBytes: Number(job.reclaimedBytes || 0),
    omittedResults: Number(job.omittedResults || 0),
    state: job.state,
    uncertainCount: Number(job.uncertainCount || 0),
    recoveryRequired: Boolean(job.recoveryRequired)
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

function failedMaintenanceJob(task, error) {
  const action = maintenanceActions.find(item => item.id === task.actionId)
  const message = error instanceof Error ? error.message : String(error || '系统维护执行失败')
  return {
    id: task.id,
    actionId: task.actionId,
    ruleId: action?.ruleId || '',
    title: action?.label || '系统维护',
    risk: action?.risk || 'danger',
    readOnly: Boolean(action?.readOnly),
    irreversible: Boolean(action?.irreversible),
    requiresAdmin: Boolean(action?.requiresAdmin),
    success: false,
    exitCode: -1,
    startedAt: task.startedAt,
    finishedAt: new Date().toISOString(),
    reclaimedBytes: 0,
    outcome: 'failed',
    rebootState: 'not-reported',
    restartRequired: false,
    cancellable: false,
    observedAvailableDeltaBytes: null,
    spaceMeasurement: 'volume-delta-not-attributed',
    message,
    stdoutTail: '',
    stderrTail: message.slice(-2000)
  }
}

function registerCleanerHandlers({ ipcMain, db, shell, sendToRenderer, operationCoordinator, journal, requireJournal = false, diagnostics,
  maintenanceRunner = executeMaintenanceAction, maintenanceStatusReader = maintenanceStatus }) {
  const candidateVault = new CandidateVault()
  const activeScans = new Map()
  let scanSession = null
  let activeCleanup = null
  let activeMaintenance = null
  let maintenanceStatusCache = null
  let maintenanceStatusPromise = null
  const exclusions = () => db.read().cleanupExclusions || []
  const maintenanceHistory = () => {
    const durable = (journal?.list() || []).filter(job => job.kind === 'maintenance').map(job => ({ ...job,
      ...(job.recoveryRequired ? { success: false, exitCode: -1, message: '上次系统维护中断，请核对 Windows 维护结果，程序不会自动重试。' } : {}) }))
    const ids = new Set(durable.map(job => job.id))
    return [...durable, ...(db.read().maintenanceJobs || []).filter(job => !ids.has(job.id))]
      .sort((a,b) => String(b.createdAt || b.startedAt).localeCompare(String(a.createdAt || a.startedAt)))
  }

  const baseMaintenanceStatus = async () => {
    if (maintenanceStatusCache && Date.now() - maintenanceStatusCache.readAt < 5000) {
      return maintenanceStatusCache.value
    }
    if (!maintenanceStatusPromise) {
      maintenanceStatusPromise = maintenanceStatusReader()
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
  let toolInspection = null
  ipcMain.handle('cleaner:tool-caches', async () => {
    if (!toolInspection) toolInspection = require('../tool-cache-locations.cjs').inspectToolCaches({ queryCommands: true }).finally(() => { toolInspection = null })
    return toolInspection
  })
  ipcMain.handle('cleaner:scan', async (_event, id) => {
    const ruleId = String(id || '')
    if (activeMaintenance) throw new Error('系统维护正在执行，完成后才能扫描垃圾文件')
    if (activeCleanup) throw new Error('垃圾清理正在执行，完成后才能重新扫描')
    if (activeScans.has(ruleId)) throw new Error('该规则正在扫描')
    const releaseOperation = operationCoordinator?.acquire('cleanup-scan', `rule-${ruleId}`) || (() => {})
    const controller = new AbortController()
    if (!activeScans.size) scanSession = createScanSession()
    activeScans.set(ruleId, controller)
    try {
      const result = await scanRuleAsync(ruleId, {
        session: scanSession,
        signal: controller.signal,
        exclusions: exclusions(),
        onProgress: progress => sendToRenderer('cleaner:scan-progress', progress)
      })
      candidateVault.registerScan(result)
      return result
    } finally {
      activeScans.delete(ruleId)
      if (!activeScans.size) scanSession = null
      releaseOperation()
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
    if (requireJournal && !journal) throw new Error('操作日志不可写，已暂停系统维护')
    const task = {
      id: `maintenance-${randomUUID()}`,
      actionId: String(input?.actionId || ''),
      startedAt: new Date().toISOString()
    }
    const releaseOperation = operationCoordinator?.acquire('maintenance', task.id) || (() => {})
    activeMaintenance = task
    let commandResult = null
    let commandAttempted = false
    try {
      journal?.begin(task.id, [], { ...failedMaintenanceJob(task, new Error('维护结果尚未确认')), kind: 'maintenance' })
      diagnostics?.log('info', 'maintenance-started', { operationId: task.id, actionId: task.actionId })
      const status = await baseMaintenanceStatus()
      const result = await maintenanceRunner({
        actionId: task.actionId,
        confirmation: String(input?.confirmation || '')
      }, {
        status,
        openPath: target => shell.openPath(target),
        openExternal: target => shell.openExternal(target),
        onProgress: progress => {
          if (progress.phase === 'running') commandAttempted = true
          sendToRenderer('cleaner:slimming-progress', { id: task.id, ...progress })
        }
      })
      const job = { ...result, id: task.id }
      commandResult = job
      journal?.finish(task.id, job)
      diagnostics?.log('info', 'maintenance-finished', { operationId: task.id, actionId: task.actionId, success: job.success, exitCode: job.exitCode })
      db.read().maintenanceJobs = [job, ...maintenanceHistory()].slice(0, 30)
      try { db.save() } catch (error) {
        if (!journal) throw error
        diagnostics?.log('warn', 'maintenance-legacy-save-failed', { operationId: task.id, message: String(error) })
      }
      maintenanceStatusCache = null
      return job
    } catch (error) {
      if (commandResult || commandAttempted) {
        journal?.interrupted(task.id)
        diagnostics?.log('error', 'maintenance-result-unconfirmed', { operationId: task.id, message: String(error) })
        throw error
      }
      const job = failedMaintenanceJob(task, error)
      diagnostics?.log('error', 'maintenance-failed', { operationId: task.id, message: job.message })
      journal?.finish(task.id, job)
      db.read().maintenanceJobs = [job, ...maintenanceHistory()].slice(0, 30)
      db.save()
      maintenanceStatusCache = null
      throw error
    } finally {
      activeMaintenance = null
      releaseOperation()
    }
  })
  ipcMain.handle('cleaner:history', () => {
    const durable = (journal?.list() || []).filter(job => job.kind === 'cleanup')
    const ids = new Set(durable.map(job => job.id))
    return [...durable, ...(db.read().cleanupJobs || []).filter(job => !ids.has(job.id))]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(historySummary)
  })
  ipcMain.handle('cleaner:history-detail', (_event, input) => {
    const id = typeof input === 'string' ? input : input?.id
    const durable = journal?.detail(String(id || ''), typeof input === 'object' ? input : {})
    if (durable) return durable
    const job = (db.read().cleanupJobs || []).find(item => item.id === String(id || ''))
    if (!job) throw new Error('未找到这条操作记录')
    return { ...historySummary(job), results: job.results || [] }
  })
  ipcMain.handle('cleaner:history-clear', () => {
    if (activeCleanup || activeMaintenance) throw new Error('清理或系统维护任务执行中，暂时不能清空记录')
    const recoveryIds = new Set((journal?.list() || []).filter(job => job.recoveryRequired).map(job => job.id))
    const retained = journal?.clearCompleted().retained || 0
    db.read().cleanupJobs = (db.read().cleanupJobs || []).filter(job => recoveryIds.has(job.id))
    db.read().maintenanceJobs = []
    db.save()
    return { cleared: true, retained }
  })
  ipcMain.handle('cleaner:history-acknowledge', (_event, id) => journal?.acknowledge(String(id || '')) || { acknowledged: false })

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

  ipcMain.handle('cleaner:execute', async (_event, input) => {
    const files = Array.isArray(input) ? input : input?.files
    const mode = Array.isArray(input) ? 'trash' : input?.mode || 'trash'
    if (mode !== 'trash') throw new Error('不支持的清理方式，请使用回收站清理')
    if (!Array.isArray(files) || !files.length || files.length > 50000) throw new Error('请选择有效数量的已扫描候选文件')
    if (activeCleanup) throw new Error('已有清理任务正在执行')
    if (activeMaintenance) throw new Error('系统维护正在执行，完成后才能清理垃圾文件')
    if (activeScans.size) throw new Error('请等待垃圾扫描完成后再执行清理')
    if (requireJournal && !journal) throw new Error('操作日志不可写，已暂停清理。请检查数据目录或查看诊断记录。')
    const id = `cleanup-${randomUUID()}`
    const releaseOperation = operationCoordinator?.acquire('cleanup-execute', id) || (() => {})
    const controller = new AbortController()
    activeCleanup = { id, controller }
    try {
      journal?.begin(id, files.map(request => candidateVault.get(String(request?.candidateId || '')) || { candidateId: request?.candidateId }))
      diagnostics?.log('info', 'cleanup-started', { operationId: id, requested: files.length })
      const execution = await executeCleanupPlan({
        requests: files,
        vault: candidateVault,
        trashItem: filePath => shell.trashItem(filePath),
        signal: controller.signal,
        isExcluded: filePath => isPathExcluded(filePath, exclusions()),
        onAttempt: ({ ordinal, candidate }) => journal?.attempted(id, ordinal, candidate),
        onResult: ({ ordinal, result }) => journal?.recorded(id, ordinal, result),
        onProgress: progress => sendToRenderer('cleaner:execute-progress', { id, ...progress })
      })
      const job = {
        id,
        createdAt: new Date().toISOString(),
        ...execution,
        executionMode: 'trash',
        reclaimedBytes: 0
      }
      journal?.finish(id, execution)
      diagnostics?.log('info', 'cleanup-finished', { operationId: id, succeeded: execution.succeeded, failed: execution.failed, cancelled: execution.cancelled })
      db.read().cleanupJobs = [
        compactCleanupJob(job),
        ...(db.read().cleanupJobs || [])
      ].slice(0, 50)
      try { db.save() } catch (error) {
        if (!journal) throw error
        diagnostics?.log('warn', 'cleanup-legacy-save-failed', { operationId: id, message: String(error) })
      }
      return job
    } catch (error) {
      diagnostics?.log('error', 'cleanup-interrupted', { operationId: id, message: error instanceof Error ? error.message : String(error) })
      journal?.interrupted(id)
      throw error
    } finally {
      activeCleanup = null
      releaseOperation()
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
  validateExclusion,
  failedMaintenanceJob
}
