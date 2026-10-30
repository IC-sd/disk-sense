const { parentPort, workerData } = require('node:worker_threads')
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(workerData.databasePath)
const status = { phase: 'ready', available: true, indexed: true }
parentPort.postMessage({ type: 'ready', status })
parentPort.on('message', message => {
  if (message.method === 'rebuild') {
    db.exec('BEGIN; UPDATE search_files SET size=999;')
    parentPort.postMessage({ type: 'progress', payload: { ...status, phase: 'publishing', building: true } })
    // Deliberately block the writer event loop while its new generation is uncommitted.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)
    db.exec('COMMIT')
  }
  if (message.method === 'close') db.close()
  parentPort.postMessage({ type: 'response', id: message.id, ok: true, result: status })
  if (message.method === 'close') parentPort.close()
})
