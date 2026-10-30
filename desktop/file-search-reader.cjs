// This connection only reads the committed WAL snapshot. Publishing a new
// index in the writer cannot monopolize this worker's event loop.
const { parentPort, workerData } = require('node:worker_threads')
const { DatabaseSync } = require('node:sqlite')
const { createSearchEngine } = require('./search-engine.cjs')
const { presentSearchResult, wildcardKind } = require('./file-search.cjs')

let database, engine
function open() {
  if (database) return
  database = new DatabaseSync(workerData.databasePath, { readOnly: true })
  database.exec('PRAGMA busy_timeout=1500; PRAGMA cache_size=-16384; PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-4096;')
  engine = createSearchEngine(database, { cancellation: workerData.searchCancellation, readOnlySource: true })
}
const version = new Int32Array(workerData.searchCancellation)
let queued, scheduled = false
let closing = false
function respond(message) {
  try {
    open()
    const started = Date.now()
    const input = message.payload.input || {}
    const result = engine.search({ ...input, inferredKind: wildcardKind(input.query), _searchVersion: message.payload.searchVersion })
    parentPort.postMessage({ type: 'response', id: message.id, ok: true,
      result: presentSearchResult(result, input, message.payload.index, started) })
  } catch (error) {
    parentPort.postMessage({ type: 'response', id: message.id, ok: false,
      error: { message: error.message, code: error.code, stack: error.stack } })
  }
}
parentPort.on('message', message => {
  if (message.method === 'readerClose' || message.method === 'readerReset') {
    closing = message.method === 'readerClose'
    if (queued) parentPort.postMessage({ type: 'response', id: queued.id, ok: false,
      error: { message: '搜索服务正在关闭', code: 'SEARCH_CLOSING' } })
    queued = null
    engine?.close()
    database?.close()
    engine = null; database = null
    parentPort.postMessage({ type: 'response', id: message.id, ok: true })
    if (closing) parentPort.close()
    return
  }
  if (queued) parentPort.postMessage({ type: 'response', id: queued.id, ok: false,
    error: { message: '搜索请求已被更新的关键词替代', code: 'SEARCH_SUPERSEDED' } })
  queued = message
  if (scheduled) return
  scheduled = true
  setImmediate(() => {
    scheduled = false
    if (closing) return
    const latest = queued
    queued = null
    if (latest && Atomics.load(version, 0) === latest.payload.searchVersion) respond(latest)
    else if (latest) parentPort.postMessage({ type: 'response', id: latest.id, ok: false,
      error: { message: '搜索请求已被更新的关键词替代', code: 'SEARCH_SUPERSEDED' } })
  })
})
