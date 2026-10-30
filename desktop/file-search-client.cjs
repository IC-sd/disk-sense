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
  nativeEnumeration,
  changeDebounceMs,
  reconcileIntervalMs,
  workerPath = path.join(__dirname, 'file-search-worker.cjs')
}) {
  let requestId = 0
  let ready = false
  let reader
  let searchPaused = false
  let closing = false
  let closed = false
  let cachedStatus = initialStatus()
  const searchCancellation = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  const searchVersion = new Int32Array(searchCancellation)
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
      nativeEnumeration,
      changeDebounceMs,
      reconcileIntervalMs,
      searchCancellation
    }
  })
  worker.unref()

  function failPending(error) {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }

  function receive(message, fromReader = false) {
    if (message?.type === 'ready') {
      reader = new Worker(path.join(__dirname, 'file-search-reader.cjs'), { workerData: { databasePath, searchCancellation } })
      reader.unref()
      reader.on('message', message => receive(message, true))
      reader.on('error', error => { onError(error); failPending(error) })
      reader.on('exit', code => {
        if (!closing) { const error = new Error(`文件查询工作线程异常退出（代码 ${code}）`); onError(error); failPending(error); closed = true }
      })
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
      if (fromReader && message.result?.index) message.result.index = cachedStatus
      else if (message.result?.phase || message.result?.index) {
        cachedStatus = message.result.index || message.result
      } else if (message.result?.status?.phase) {
        cachedStatus = message.result.status
      }
      request.resolve(message.result)
    } else {
      request.reject(reviveError(message.error))
    }
  }
  worker.on('message', receive)

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
    if (closed || (closing && !['close', 'readerClose'].includes(method))) throw new Error('文件搜索工作线程已经关闭')
    await readyPromise
    return new Promise((resolve, reject) => {
      const id = ++requestId
      if (method === 'search') {
        payload.searchVersion = Atomics.add(searchVersion, 0, 1) + 1
        payload.index = cachedStatus
      }
      pending.set(id, { resolve, reject })
      const target = ['search', 'readerClose', 'readerReset'].includes(method) ? reader : worker
      target.postMessage({ id, method, payload })
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
    const result = await request('startAutomatic', { roots: await currentRoots() })
    searchPaused = false
    return result
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
    if (closing) return
    closing = true
    try {
      if (closed) return
      Atomics.add(searchVersion, 0, 1)
      await request('readerClose')
      await request('close')
    } finally {
      if (reader) await reader.terminate().catch(() => {})
      await worker.terminate().catch(() => {})
      closed = true
    }
  }

  return {
    status,
    startAutomatic,
    enableNtfs: async () => request('enableNtfs', { roots: await currentRoots() }),
    disableNtfs: () => request('disableNtfs'),
    stopAutomatic,
    rebuild,
    rebuildScope,
    cancel: () => request('cancel'),
    search: input => searchPaused ? Promise.reject(Object.assign(new Error('数据迁移期间搜索已暂停'), { code: 'SEARCH_PAUSED' })) : request('search', { input }),
    recordSelection: input => request('recordSelection', { input }),
    checkpoint: async () => {
      searchPaused = true
      Atomics.add(searchVersion, 0, 1)
      await request('readerReset')
      return request('checkpoint')
    },
    waitForIdle: () => request('waitForIdle'),
    close,
    cachedStatus: () => cachedStatus
  }
}

module.exports = { createFileSearchWorkerService }
