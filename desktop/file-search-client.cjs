const path = require('node:path')
const { Worker } = require('node:worker_threads')

function initialStatus() {
  return {
    available: true,
    indexed: false,
    building: false,
    phase: 'idle',
    roots: [],
    entries: 0,
    directories: 0,
    inaccessible: 0,
    skippedLinks: 0,
    current: '',
    startedAt: null,
    completedAt: null,
    durationMs: 0,
    truncated: false,
    cancelled: false,
    automatic: false,
    watching: false,
    watcherCount: 0,
    pendingChanges: 0,
    lastChangedAt: null,
    lastError: ''
  }
}

function reviveError(value) {
  const error = new Error(value?.message || '文件搜索工作线程执行失败')
  error.name = value?.name || 'Error'
  if (value?.stack) error.stack = value.stack
  if (value?.code) error.code = value.code
  return error
}

function createFileSearchWorkerService({
  databasePath,
  getVolumeRoots = async () => [],
  onProgress = () => {},
  onError = () => {},
  maximumEntries,
  changeDebounceMs,
  reconcileIntervalMs,
  workerPath = path.join(__dirname, 'file-search-worker.cjs')
}) {
  let requestId = 0
  let ready = false
  let closing = false
  let closed = false
  let cachedStatus = initialStatus()
  const pending = new Map()
  let resolveReady
  let rejectReady
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const worker = new Worker(workerPath, {
    workerData: {
      databasePath,
      maximumEntries,
      changeDebounceMs,
      reconcileIntervalMs
    }
  })
  worker.unref()

  function failPending(error) {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }

  worker.on('message', message => {
    if (message?.type === 'ready') {
      ready = true
      cachedStatus = message.status || cachedStatus
      resolveReady(cachedStatus)
      return
    }
    if (message?.type === 'progress') {
      cachedStatus = message.payload || cachedStatus
      onProgress(cachedStatus)
      return
    }
    if (message?.type !== 'response') return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.ok) {
      if (message.result?.phase || message.result?.index) {
        cachedStatus = message.result.index || message.result
      } else if (message.result?.status?.phase) {
        cachedStatus = message.result.status
      }
      request.resolve(message.result)
    } else {
      request.reject(reviveError(message.error))
    }
  })

  worker.on('error', error => {
    onError(error)
    if (!ready) rejectReady(error)
    failPending(error)
  })

  worker.on('exit', code => {
    closed = true
    if (!closing) {
      const error = new Error(`文件搜索工作线程异常退出（代码 ${code}）`)
      onError(error)
      if (!ready) rejectReady(error)
      failPending(error)
    }
  })

  async function request(method, payload = {}) {
    if (closed || (closing && method !== 'close')) throw new Error('文件搜索工作线程已经关闭')
    await readyPromise
    return new Promise((resolve, reject) => {
      const id = ++requestId
      pending.set(id, { resolve, reject })
      worker.postMessage({ id, method, payload })
    })
  }

  async function currentRoots() {
    const values = await getVolumeRoots()
    return Array.isArray(values) ? values : []
  }

  async function status() {
    cachedStatus = await request('status')
    return cachedStatus
  }

  async function startAutomatic() {
    return request('startAutomatic', { roots: await currentRoots() })
  }

  function stopAutomatic(options) {
    return request('stopAutomatic', { options })
  }

  async function rebuild(input = {}) {
    const roots = Array.isArray(input.roots) && input.roots.length
      ? input.roots
      : await currentRoots()
    return request('rebuild', { input, roots })
  }

  async function rebuildScope(input = {}) {
    return request('rebuildScope', { input, roots: await currentRoots() })
  }

  async function close() {
    if (closed) return
    if (closing) return
    closing = true
    try {
      await request('close')
    } finally {
      await worker.terminate().catch(() => {})
      closed = true
    }
  }

  return {
    status,
    startAutomatic,
    stopAutomatic,
    rebuild,
    rebuildScope,
    cancel: () => request('cancel'),
    search: input => request('search', { input }),
    checkpoint: () => request('checkpoint'),
    waitForIdle: () => request('waitForIdle'),
    close,
    cachedStatus: () => cachedStatus
  }
}

module.exports = { createFileSearchWorkerService }
