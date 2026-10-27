// Validate complete query sequences against uncached metadata reads on one
// immutable copy. No user filenames or paths are written to the report.
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { DatabaseSync, backup } = require('node:sqlite')
const { createSearchEngine } = require('../desktop/search-engine.cjs')

function collect(connection, query) {
  connection.stages = {}
  const started = performance.now()
  const input = { query, scope: 'all', kind: 'all', sort: 'relevance', limit: 500 }
  const first = connection.engine.search(input)
  const firstPageMs = performance.now() - started
  const hash = createHash('sha256'), seen = new Set()
  let page = first, returned = 0
  for (;;) {
    for (const row of page.rows) {
      assert(!seen.has(row.path), 'No duplicate result across pages')
      seen.add(row.path); returned++
      hash.update(JSON.stringify([row.id, row.path, row.name, row.size, row.modified_at, row.selectionReason]) + '\n')
    }
    if (page.nextOffset === null) break
    const next = connection.engine.search({ ...input, sessionId: first.sessionId, offset: page.nextOffset })
    assert.equal(next.sessionId, first.sessionId, 'The active session survives its byte budget')
    assert(next.offset > page.offset)
    page = next
  }
  assert.equal(returned, first.total)
  return { total: first.total, returned, digest: hash.digest('hex'), firstPageMs: +firstPageMs.toFixed(2),
    fetched: connection.stages.fetch?.count ?? 0, reused: connection.stages.reuse?.reused ?? 0, cache: connection.engine.cacheStats() }
}

;(async () => {
  const parent = path.resolve('.cache/search-input-validation')
  await fs.mkdir(parent, { recursive: true })
  const owned = await fs.mkdtemp(path.join(parent, 'case-'))
  let source
  const connections = []
  try {
    source = new DatabaseSync(path.join(process.env.APPDATA, 'Disk Sense/disk-sense-search.sqlite'), { readOnly: true })
    const frozen = path.join(owned, 'index.sqlite')
    console.log('Taking a read-only source snapshot for complete input-sequence comparison')
    await backup(source, frozen, { rate: 1_000_000 })
    source.close(); source = null
    for (const incrementalReuse of [false, true]) {
      const database = new DatabaseSync(frozen, { readOnly: true })
      database.exec('PRAGMA temp_store=MEMORY; PRAGMA cache_size=-65536;')
      const connection = { database, stages: {}, engine: null }
      connection.engine = createSearchEngine(database, { cacheMs: 0, incrementalReuse, profile: (stage, _ms, details) => {
        if (stage === 'fetch' || stage === 'reuse') connection.stages[stage] = details
      } })
      connections.push(connection)
    }
    const entries = Number(connections[0].database.prepare('SELECT count(*) AS count FROM search_files').get().count)
    const queries = ['repo', 'repor', 'report', 'repor', 'vs', 'vsc', 'vsco', 'vsc', 'bao', 'baog', 'baogao', 'baogao ', 'baogao', 'Documents', 'Documents report']
    const cases = []
    for (const [index, query] of queries.entries()) {
      const values = []
      for (const variant of index % 2 ? [1, 0] : [0, 1]) values[variant] = collect(connections[variant], query)
      assert.equal(values[0].total, values[1].total, 'Same complete recall')
      assert.equal(values[0].digest, values[1].digest, 'Same ordered identities, metadata and selection reasons over all pages')
      const record = { query, total: values[1].total, referenceFetched: values[0].fetched,
        reuseFetched: values[1].fetched, reused: values[1].reused, referenceFirst500Ms: values[0].firstPageMs,
        reuseFirst500Ms: values[1].firstPageMs, estimatedRetainedBytes: values[1].cache.estimatedBytes,
        oversizedActive: values[1].cache.oversizedPinned, allPagesEqual: true }
      cases.push(record); console.log(JSON.stringify(record))
    }
    assert(cases.some(item => item.reused > 0), 'Exercise data reuse, not merely equivalent fallback')
    const sourceFiles = ['desktop/search-engine.cjs', 'desktop/search-candidate-session.cjs', 'desktop/search-session-cache.cjs', 'desktop/search-result-view.cjs']
    const sourceHashes = []
    for (const file of sourceFiles) sourceHashes.push({ file, sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') })
    const report = { date: new Date().toISOString(), entries, cases, sourceHashes,
      checks: ['same-query-total', 'all-pages-ordered-identity-and-metadata-digest', 'no-duplicate-pages', 'active-session-survives-budget', 'reuse-exercised'],
      scope: 'Same frozen index; complete ID recall on both variants; query-result cache disabled; alternate variant order; one first-500 sample per input, not GUI latency',
      limits: ['Full recall SQL and abbreviation name verification still execute', 'Fetch counts cover ranking metadata, not page presentation or matcher-internal reads',
        'Single timing samples are diagnostic, not a speedup or Listary parity claim', 'Retained-byte estimates are conservative and exclude runtime/SQLite/transient RSS',
        'One oversized active snapshot is retained for correct stable pagination; other views/sessions are evicted'] }
    await fs.writeFile('docs/search-input-validation.json', JSON.stringify(report, null, 2) + '\n')
  } finally {
    source?.close(); connections.forEach(connection => connection.database.close())
    assert.equal(path.dirname(owned), parent)
    assert(path.basename(owned).startsWith('case-'))
    await fs.rm(owned, { recursive: true, force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
