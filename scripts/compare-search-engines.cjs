const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const { DatabaseSync, backup } = require('node:sqlite')
const { performance } = require('node:perf_hooks')
const { createWordIndex } = require('../desktop/search-word-index.cjs')

;(async () => {
  const parent = path.resolve('release-search-validation')
  await fs.mkdir(parent, { recursive: true })
  const reuse = process.argv.find(value => value.startsWith('--snapshot='))?.slice('--snapshot='.length)
  const owned = reuse ? path.dirname(path.resolve(reuse)) : await fs.mkdtemp(path.join(parent, 'query-comparison-'))
  assert(path.dirname(owned) === parent && path.basename(owned).startsWith('query-comparison-'))
  const databasePath = path.join(owned, 'index.sqlite')
  const source = new DatabaseSync(path.join(process.env.APPDATA, 'Disk Sense', 'disk-sense-search.sqlite'), { readOnly: true })
  let database
  try {
    console.log('Taking one consistent read-only snapshot for both engines')
    if (!reuse) await backup(source, databasePath, { rate: 1_000_000 })
    source.close()
    database = new DatabaseSync(databasePath)
    database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=16384; PRAGMA cache_size=-65536;')
    const started = performance.now()
    const words = createWordIndex(database)
    await words.start()
    const wordIndexMs = Math.round(performance.now() - started)
    const entries = Number(database.prepare('SELECT count(*) AS count FROM search_files').get().count)
    database.close(); database = null
    console.log(`Abbreviation index ready: ${entries} entries, ${wordIndexMs} ms`)
    const baseline = process.argv.find(value => value.startsWith('--baseline='))?.slice('--baseline='.length)
    const before = require(path.resolve(baseline || 'release-search-validation/query-before/search-engine.cjs'))
    const after = require('../desktop/search-engine.cjs')
    const connections = [before, after].map(module => {
      const db = new DatabaseSync(databasePath, { readOnly: true })
      db.exec('PRAGMA temp_store=MEMORY; PRAGMA cache_size=-65536; PRAGMA busy_timeout=2000;')
      return { db, engine: module.createSearchEngine(db, { cacheMs: 0 }) }
    })
    const measurements = []
    try {
      for (const query of ['word', 'listary', 'vsc', 'report', 'baogao', 'Documents report']) {
        const input = { query, scope: 'all', kind: 'all', sort: 'relevance', limit: 100 }
        const samples = [[], []], totals = []
        for (const { engine } of connections) engine.search(input)
        for (let round = 0; round < 5; round++) for (const index of round % 2 ? [1, 0] : [0, 1]) {
          const start = performance.now(), result = connections[index].engine.search(input)
          samples[index].push(performance.now() - start); totals[index] = result.total
        }
        const metrics = samples.map(values => { const ordered = values.sort((a, b) => a - b); return { medianMs: +ordered[2].toFixed(1), maximumMs: +ordered[4].toFixed(1) } })
        const record = { query, before: { total: totals[0], ...metrics[0] }, after: { total: totals[1], ...metrics[1] } }
        measurements.push(record); console.log(JSON.stringify(record))
      }
    } finally { connections.forEach(({ db }) => db.close()) }
    const report = { date: new Date().toISOString(), entries, wordIndexMs,
      mode: 'Same frozen SQLite snapshot; alternating before/after engines; five warm samples; query result cache disabled; engine time only', measurements }
    await fs.writeFile(path.join(parent, 'query-engine-comparison.json'), JSON.stringify(report, null, 2) + '\n')
  } finally {
    try { source.close() } catch {}
    database?.close()
    assert(path.dirname(owned) === parent && path.basename(owned).startsWith('query-comparison-'))
    if (process.argv.includes('--keep')) console.log(`Comparison snapshot: ${databasePath}`)
    else await fs.rm(owned, { recursive: true, force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
