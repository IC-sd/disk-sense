const { validateCandidate, runningExecutableNames, PROCESS_CHECK_FAILED } = require('./cleaner.cjs')

const CANDIDATE_TTL_MS = 30 * 60 * 1000
const MAX_EXECUTE_FILES = 5000
const MAX_PERSISTED_RESULTS = 1000
const PROCESS_REFRESH_FILES = 25
const PROCESS_REFRESH_MS = 2000

class CandidateVault {
  constructor(options = {}) {
    this.now = options.now || Date.now
    this.items = new Map()
  }

  registerScan(result) {
    this.clearRule(result.id)
    const registeredAt = this.now()
    for (const file of result.files || []) {
      this.items.set(file.candidateId, {
        ...file,
        selectable: Boolean(result.selectable),
        configuredSelectable: Boolean(result.configuredSelectable),
        registeredAt
      })
    }
  }

  clearRule(ruleId) {
    for (const [key, candidate] of this.items) {
      if (candidate.ruleId === ruleId) this.items.delete(key)
    }
  }

  clearAll() {
    this.items.clear()
  }

  get(candidateId) {
    return this.items.get(String(candidateId || ''))
  }

  delete(candidateId) {
    this.items.delete(String(candidateId || ''))
  }

  prune() {
    const now = this.now()
    for (const [key, candidate] of this.items) {
      if (now - candidate.registeredAt > CANDIDATE_TTL_MS) this.items.delete(key)
    }
  }
}

function publicResult(candidate, overrides) {
  return {
    candidateId: candidate?.candidateId || '',
    path: candidate?.path || '',
    size: Number(candidate?.size || 0),
    modifiedAt: Number(candidate?.modifiedAt || 0),
    ruleId: candidate?.ruleId || '',
    ...overrides
  }
}

function compactCleanupJob(job, limit = MAX_PERSISTED_RESULTS) {
  const results = Array.isArray(job?.results) ? job.results : []
  if (results.length <= limit) return { ...job, results: [...results], omittedResults: 0 }
  const failures = results.filter(item => !item.success)
  const successes = results.filter(item => item.success)
  const kept = [...failures.slice(0, limit), ...successes.slice(0, Math.max(0, limit - failures.length))]
  return {
    ...job,
    results: kept,
    omittedResults: Math.max(0, results.length - kept.length)
  }
}

async function executeCleanup(input = {}) {
  const {
    requests = [],
    vault,
    trashItem,
    signal,
    now = Date.now,
    onProgress,
    getRunningProcesses = runningExecutableNames,
    isExcluded = () => false
  } = input
  if (!vault || typeof trashItem !== 'function') throw new Error('cleanup-executor-not-configured')

  vault.prune()
  const requested = Array.isArray(requests) ? requests.slice(0, MAX_EXECUTE_FILES) : []
  const rejectedOverflow = Math.max(0, (Array.isArray(requests) ? requests.length : 0) - requested.length)
  const results = []
  const seen = new Set()
  const readRunningProcesses = async () => {
    try {
      const value = await getRunningProcesses()
      return value instanceof Set ? value : new Set([PROCESS_CHECK_FAILED])
    } catch {
      return new Set([PROCESS_CHECK_FAILED])
    }
  }
  let running = await readRunningProcesses()
  let processCheckAt = now()
  let guardedSinceCheck = 0
  let succeeded = 0
  let failed = 0

  const record = (result, current = result.path) => {
    results.push(result)
    if (result.success) succeeded++
    else failed++
    onProgress?.({
      processed: results.length,
      total: requested.length,
      succeeded,
      failed,
      current
    })
  }

  for (const request of requested) {
    if (signal?.aborted) break
    const candidateId = String(request?.candidateId || '')
    const candidate = vault.get(candidateId)
    if (!candidate || seen.has(candidateId)) {
      record(publicResult(request, {
        success: false,
        error: seen.has(candidateId) ? '重复的清理候选已跳过' : '该文件不在当前有效扫描结果中'
      }))
      continue
    }
    seen.add(candidateId)

    if (!candidate.selectable || !candidate.configuredSelectable) {
      record(publicResult(candidate, { success: false, error: '该规则当前不允许执行清理' }))
      continue
    }
    if (isExcluded(candidate.path)) {
      record(publicResult(candidate, { success: false, error: '该文件已加入用户排除项，已阻止处理' }))
      continue
    }
    if (now() - candidate.registeredAt > CANDIDATE_TTL_MS) {
      vault.delete(candidateId)
      record(publicResult(candidate, { success: false, error: '扫描结果已经过期，请重新扫描' }))
      continue
    }
    if ((candidate.processNames || []).length && running.has(PROCESS_CHECK_FAILED)) {
      record(publicResult(candidate, { success: false, error: '无法确认相关应用是否正在运行，已阻止处理' }))
      continue
    }
    if ((candidate.processNames || []).length) {
      guardedSinceCheck++
      if (guardedSinceCheck > PROCESS_REFRESH_FILES || now() - processCheckAt >= PROCESS_REFRESH_MS) {
        running = await readRunningProcesses()
        processCheckAt = now()
        guardedSinceCheck = 1
      }
      if (running.has(PROCESS_CHECK_FAILED)) {
        record(publicResult(candidate, { success: false, error: '无法确认相关应用是否正在运行，已阻止处理' }))
        continue
      }
    }
    const blocking = (candidate.processNames || []).filter(name => running.has(name.toLowerCase()))
    if (blocking.length) {
      record(publicResult(candidate, { success: false, error: `检测到 ${blocking.join('、')} 正在运行，请关闭后重新扫描` }))
      continue
    }

    const validation = await validateCandidate(candidate, { now: now() })
    if (!validation.ok) {
      record(publicResult(candidate, { success: false, error: validation.reason }))
      continue
    }

    try {
      await trashItem(candidate.canonicalPath)
      vault.delete(candidateId)
      record(publicResult(candidate, { success: true }))
    } catch (error) {
      record(publicResult(candidate, {
        success: false,
        error: error?.code === 'EBUSY' ? '文件正在被占用' : String(error?.message || '移入回收站失败')
      }))
    }
  }

  const movedToTrashBytes = results.filter(item => item.success).reduce((sum, item) => sum + item.size, 0)
  return {
    results,
    requested: Array.isArray(requests) ? requests.length : 0,
    processed: results.length,
    succeeded,
    failed,
    cancelled: Boolean(signal?.aborted),
    rejectedOverflow,
    movedToTrashBytes,
    reclaimedBytes: 0
  }
}

module.exports = {
  CandidateVault,
  executeCleanup,
  CANDIDATE_TTL_MS,
  MAX_EXECUTE_FILES,
  MAX_PERSISTED_RESULTS,
  PROCESS_REFRESH_FILES,
  PROCESS_REFRESH_MS,
  compactCleanupJob
}
