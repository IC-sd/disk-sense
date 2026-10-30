// Synthetic index only. No user files, installed service or real index is read.
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { createSearchEngine } = require('../desktop/search-engine.cjs')
const count = Number(process.argv[2] || 100000)
if (!Number.isSafeInteger(count) || count < 1 || count > 1000000) throw new Error('Expected 1..1000000 entries')
const base = path.resolve(__dirname, '..', 'work', 'search-benchmark')
fs.mkdirSync(base, { recursive: true })
const directory = fs.mkdtempSync(path.join(base, 'run-'))
const db = new DatabaseSync(path.join(directory, 'fixture.sqlite'))
let engine
try {
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE search_files(path TEXT PRIMARY KEY COLLATE NOCASE,name TEXT,root TEXT,kind TEXT,is_directory INTEGER,is_link INTEGER,size INTEGER,modified_at INTEGER);
    CREATE INDEX search_directory_names ON search_files(name,path) WHERE is_directory=1;
    CREATE TABLE search_phonetics(path TEXT,alias TEXT,initials TEXT);
    CREATE VIRTUAL TABLE search_fts USING fts5(name,tokenize='trigram'); BEGIN;`)
  const insert = db.prepare('INSERT INTO search_files VALUES(?,?,?,?,0,0,?,?)')
  const fts = db.prepare('INSERT INTO search_fts(rowid,name) VALUES(?,?)')
  for (let id = 1; id <= count; id++) {
    const name = `report-${String(id).padStart(8, '0')}.txt`
    insert.run(path.join(directory, 'Documents', name), name, directory, 'document', id, id)
    fts.run(id, name)
  }
  db.exec('COMMIT')
  engine = createSearchEngine(db, { cacheMs: 0 })
  const measurements = []
  for (const sort of ['name', 'relevance', 'size', 'modified']) {
    global.gc?.()
    const before = process.memoryUsage()
    const started = performance.now()
    const result = engine.search({ query: 'report', sort, limit: 100 })
    const firstPageMs = performance.now() - started
    const secondStarted = performance.now()
    const second = engine.search({ query: 'report', sort, limit: 100, sessionId: result.sessionId, offset: result.nextOffset })
    const secondPageMs = performance.now() - secondStarted
    const repeatedStarted = performance.now()
    engine.search({ query: 'report', sort, limit: 100, sessionId: result.sessionId })
    const repeatedFirstPageMs = performance.now() - repeatedStarted
    const after = process.memoryUsage()
    measurements.push({ sort, total: result.total, returned: result.rows.length,
      secondReturned: second.rows.length, storage: result.diagnostics.counts.storage?.mode || 'memory',
      firstPageMs: +firstPageMs.toFixed(2), secondPageMs: +secondPageMs.toFixed(2), repeatedFirstPageMs: +repeatedFirstPageMs.toFixed(2),
      heapDeltaMiB: +((after.heapUsed - before.heapUsed) / 1048576).toFixed(2),
      rssDeltaMiB: +((after.rss - before.rss) / 1048576).toFixed(2), cache: engine.cacheStats() })
  }
  process.stdout.write(JSON.stringify({ date: new Date().toISOString(), node: process.version, entries: count,
    scope: 'synthetic engine call; memory deltas are not peak RSS or GUI latency', measurements }, null, 2) + '\n')
} finally {
  engine?.close()
  db.close()
  // Only the fresh benchmark fixture inside this workspace may be removed.
  const target = path.resolve(directory)
  if (!target.startsWith(base + path.sep)) throw new Error('Unsafe benchmark cleanup path')
  fs.rmSync(target, { recursive: true, force: true })
}
