const { parentPort, workerData } = require('node:worker_threads')
const { createFileSearchService } = require('./file-search.cjs')

if (!parentPort) throw new Error('文件搜索工作线程缺少父进程通信端口')

let roots = Array.isArray(workerData?.roots) ? workerData.roots : []
let closing = false
let queuedSearch = null
let searchScheduled = false

function serializeError(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : 'Error',
    stack: error instanceof Error ? error.stack : undefined,
    code: error?.code
  }
}

function respond(id, result) {
  parentPort.postMessage({ type: 'response', id, ok: true, result })
}

function reject(id, error) {
  parentPort.postMessage({ type: 'response', id, ok: false, error: serializeError(error) })
}

function replaceRoots(values) {
  if (Array.isArray(values)) roots = values
}

const service = createFileSearchService({
  databasePath: workerData.databasePath,
  maximumEntries: workerData.maximumEntries,
  changeDebounceMs: workerData.changeDebounceMs,
  reconcileIntervalMs: workerData.reconcileIntervalMs,
  getVolumeRoots: async () => roots,
  onProgress: payload => parentPort.postMessage({ type: 'progress', payload })
})

async function execute(message) {
  const payload = message.payload || {}
  switch (message.method) {
    case 'status':
      return service.status()
    case 'startAutomatic':
      replaceRoots(payload.roots)
      return service.startAutomatic()
    case 'stopAutomatic':
      return service.stopAutomatic(payload.options)
    case 'rebuild':
      replaceRoots(payload.roots)
      return service.rebuild({ ...payload.input, roots: payload.roots })
    case 'rebuildScope':
      replaceRoots(payload.roots)
      return service.rebuildScope(payload.input)
    case 'cancel':
      return service.cancel()
    case 'search':
      return service.search(payload.input)
    case 'checkpoint':
      return service.checkpoint()
    case 'waitForIdle':
      return service.waitForIdle()
    case 'close':
      closing = true
      return service.close()
    default:
      throw new Error(`未知文件搜索工作线程操作：${message.method}`)
  }
}

async function run(message) {
  try {
    const result = await execute(message)
    respond(message.id, result)
    if (message.method === 'close') setImmediate(() => parentPort.close())
  } catch (error) {
    reject(message.id, error)
  }
}

function scheduleLatestSearch(message) {
  if (queuedSearch) {
    const error = new Error('搜索请求已被更新的关键词替代')
    error.code = 'SEARCH_SUPERSEDED'
    reject(queuedSearch.id, error)
  }
  queuedSearch = message
  if (searchScheduled) return
  searchScheduled = true
  setImmediate(() => {
    searchScheduled = false
    const latest = queuedSearch
    queuedSearch = null
    if (latest && !closing) void run(latest)
  })
}

parentPort.on('message', message => {
  if (!message || closing) return
  if (message.method === 'search') scheduleLatestSearch(message)
  else {
    if (message.method === 'close' && queuedSearch) {
      const error = new Error('搜索服务正在关闭')
      error.code = 'SEARCH_CLOSING'
      reject(queuedSearch.id, error)
      queuedSearch = null
    }
    void run(message)
  }
})

parentPort.postMessage({ type: 'ready', status: service.status() })
