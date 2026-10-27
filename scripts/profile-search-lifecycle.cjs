// Reads the real index through SQLite's backup API; all profiling writes use an owned copy.
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const { DatabaseSync, backup } = require('node:sqlite')
const { performance } = require('node:perf_hooks')
const { createFileSearchService } = require('../desktop/file-search.cjs')

;(async () => {
  const parent = path.resolve('release-search-validation')
  await fs.mkdir(parent, { recursive: true })
  const directory = await fs.mkdtemp(path.join(parent, 'lifecycle-profile-'))
  const databasePath = path.join(directory, 'index.sqlite')
  const source = new DatabaseSync(path.resolve(process.argv[2] || path.join(process.env.APPDATA, 'Disk Sense', 'disk-sense-search.sqlite')), { readOnly: true })
  console.log('Copying a consistent read-only snapshot for profiling')
  try { await backup(source, databasePath, { rate: 1_000_000 }) } finally { source.close() }
  console.log('Sampling journal changes')
  const timings = new Map()
  const originalPrepare = DatabaseSync.prototype.prepare, originalExec = DatabaseSync.prototype.exec
  const measure = (label, callback) => {
    const start = performance.now()
    try { return callback() } finally {
      const cost = timings.get(label) || { calls: 0, ms: 0 }; cost.calls++; cost.ms += performance.now() - start; timings.set(label, cost)
    }
  }
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = originalPrepare.call(this, sql), label = sql.trim().replace(/\s+/gu, ' ').slice(0, 140)
    for (const method of ['get', 'run', 'all']) {
      const execute = statement[method].bind(statement)
      statement[method] = (...args) => measure(label, () => execute(...args))
    }
    return statement
  }
  DatabaseSync.prototype.exec = function (sql) { return measure(sql.trim().slice(0, 100), () => originalExec.call(this, sql)) }
  let service
  try {
    const control = new DatabaseSync(databasePath)
    const volumes = control.prepare('SELECT * FROM search_ntfs_volumes WHERE complete=1 ORDER BY root').all()
    assert(volumes.length, 'A complete native index is required')
    const quota = Number(process.argv[3] || 6000)
    const changed = new Map()
    for (const volume of volumes) {
      console.log(`Sampling ${volume.root}`)
      const sample = control.prepare(`SELECT l.ref,l.parent,l.name,l.attributes,s.size,s.modified_at
        FROM search_ntfs_links l JOIN search_files s ON s.path=l.path
        WHERE l.root=? AND s.is_directory=0 GROUP BY l.ref LIMIT ?`).all(volume.root, Math.ceil(quota / volumes.length))
      changed.set(volume.root, sample.map((row, index) => index % 3 === 0 ? { id: row.ref, deleted: true }
        : { id: row.ref, attributes: row.attributes, size: row.size + (index % 3 === 1 ? 1 : 0), modified: row.modified_at,
          links: control.prepare('SELECT parent,name FROM search_ntfs_links WHERE root=? AND ref=?').all(volume.root, row.ref).map(link => [link.parent, link.name]) }))
    }
    control.close()
    const clientFactory = async () => ({ close() {}, async *request(request) {
      const volume = volumes.find(item => item.root.toLowerCase() === request.root.toLowerCase())
      if (request.op === 'probe') { yield { available: true, journalId: volume.journal_id }; return }
      assert.equal(request.op, 'journal', 'Warm startup must not rebuild')
      const rows = changed.get(volume.root)
      for (let offset = 0; offset < rows.length; offset += 256) yield { type: 'changes', rows: rows.slice(offset, offset + 256) }
      yield { type: 'journal-end', serial: volume.serial, journalId: volume.journal_id, nextUsn: (BigInt(volume.next_usn) + 1n).toString() }
    } })
    timings.clear()
    console.log('Opening the indexed search service')
    const start = performance.now()
    service = createFileSearchService({ databasePath, getVolumeRoots: async () => volumes.map(volume => volume.root), ntfsClientFactory: clientFactory,
      reconcileIntervalMs: 0, watchFactory() { throw new Error('Use native journal') } })
    const constructorMs = Math.round(performance.now() - start)
    console.log(`Constructor: ${constructorMs} ms; applying ${quota} changes`)
    const applyStart = performance.now()
    await service.startAutomatic()
    const report = { date: new Date().toISOString(), mode: 'Owned SQLite backup; deterministic metadata updates and deletions; native I/O excluded',
      entries: service.status().entries, changes: [...changed.values()].reduce((sum, rows) => sum + rows.length, 0), constructorMs,
      replayMs: Math.round(performance.now() - applyStart), topCosts: [...timings].sort((a, b) => b[1].ms - a[1].ms).slice(0, 14)
        .map(([sql, cost]) => ({ sql, calls: cost.calls, ms: Math.round(cost.ms) })) }
    console.log(JSON.stringify(report, null, 2))
    await fs.writeFile(path.join(parent, 'search-lifecycle-profile.json'), JSON.stringify(report, null, 2) + '\n')
  } finally {
    await service?.close()
    assert(path.dirname(directory) === parent && path.basename(directory).startsWith('lifecycle-profile-'))
    await fs.rm(directory, { recursive: true, force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
