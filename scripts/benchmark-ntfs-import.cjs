const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { DatabaseSync } = require('node:sqlite')
const { createFileSearchService } = require('../desktop/file-search.cjs')

const input = process.argv[2]
if (!input) throw new Error('Supply an existing search SQLite database')
const source = new DatabaseSync(path.resolve(input), { readOnly: true })
let rows, volume
try {
  volume = process.argv[4] ? source.prepare('SELECT * FROM search_ntfs_volumes WHERE root=? COLLATE NOCASE').get(process.argv[4])
    : source.prepare('SELECT * FROM search_ntfs_volumes WHERE complete=1 LIMIT 1').get()
  if (!volume) throw new Error('A completed native volume is required')
  rows = source.prepare(`SELECT l.ref,l.parent,s.name,l.attributes,s.size,s.modified_at,s.path
    FROM search_files s JOIN search_ntfs_links l ON l.root=? AND l.path=s.path
    WHERE s.root=? ORDER BY s.rowid LIMIT ?`).all(volume.root, volume.root, Number(process.argv[3] || 50000))
    .map(row => [row.ref, row.parent, row.name, row.attributes, row.size, row.modified_at, row.path])
} finally { source.close() }
const realPrepare = DatabaseSync.prototype.prepare, realExec = DatabaseSync.prototype.exec
let timings = new Map(), cacheKiB = 65536, checkpointPages = 1000
function measure(name, callback) {
  const start = performance.now()
  try { return callback() } finally {
    const total = timings.get(name) || { calls: 0, ms: 0 }; total.calls++; total.ms += performance.now() - start; timings.set(name, total)
  }
}
DatabaseSync.prototype.prepare = function (sql) {
  const statement = realPrepare.call(this, sql)
  const label = sql.trim().replace(/\s+/gu, ' ').slice(0, 110)
  for (const method of ['run', 'get', 'all']) {
    const original = statement[method].bind(statement)
    statement[method] = (...args) => measure(label, () => original(...args))
  }
  return statement
}
DatabaseSync.prototype.exec = function (sql) {
  sql = sql.replace(/PRAGMA cache_size\s*=\s*-\d+/u, `PRAGMA cache_size=-${cacheKiB}`)
  sql = sql.replace(/PRAGMA wal_autocheckpoint\s*=\s*\d+/u, `PRAGMA wal_autocheckpoint=${checkpointPages}`)
  return measure(sql.trim().slice(0, 80), () => realExec.call(this, sql))
}
;(async () => {
  const variants = process.argv.includes('--checkpoint-compare') ? [{ sorted: false, cache: 65536, checkpoint: 1000 }, { sorted: false, cache: 65536, checkpoint: 16384 }]
    : process.argv.includes('--cache-compare') ? [{ sorted: false, cache: 65536 }, { sorted: false, cache: 262144 }]
    : [{ sorted: false, cache: 65536 }, { sorted: true, cache: 65536 }]
  for (const { sorted, cache, checkpoint = 16384 } of variants) {
    cacheKiB = cache
    checkpointPages = checkpoint
    const parent = path.resolve('release-search-validation')
    const directory = fs.mkdtempSync(path.join(parent, 'ntfs-import-benchmark-'))
    const candidate = sorted ? [...rows].sort((a, b) => String(a[6]).localeCompare(String(b[6]), 'en', { sensitivity: 'base' })) : rows
    const client = { close() {}, async *request(input) {
      if (input.op === 'probe') { yield { available: true, journalId: volume.journal_id }; return }
      if (input.op !== 'snapshot') return
      yield { type: 'volume', serial: volume.serial, journalId: volume.journal_id, nextUsn: volume.next_usn, rootId: volume.root_id }
      for (let offset = 0; offset < candidate.length; offset += 512) yield { type: 'records', rows: candidate.slice(offset, offset + 512) }
      yield { type: 'snapshot-end', serial: volume.serial, journalId: volume.journal_id, complete: true }
    } }
    let service
    try {
      timings = new Map()
      const start = performance.now()
      service = createFileSearchService({ databasePath: path.join(directory, 'index.sqlite'), getVolumeRoots: async () => [volume.root],
        ntfsClientFactory: async () => client, reconcileIntervalMs: 0, watchFactory() { throw new Error('Use NTFS') } })
      await service.startAutomatic(); await service.waitForIdle()
      console.log(JSON.stringify({ sorted, cacheKiB, checkpointPages, entries: service.status().entries, ms: Math.round(performance.now() - start),
        topCosts: [...timings].sort((a, b) => b[1].ms - a[1].ms).slice(0, 10).map(([sql, cost]) => ({ sql, calls: cost.calls, ms: Math.round(cost.ms) })) }))
    } finally {
      await service?.close()
      if (path.dirname(directory) !== parent || !path.basename(directory).startsWith('ntfs-import-benchmark-')) throw new Error('Unexpected benchmark location')
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
