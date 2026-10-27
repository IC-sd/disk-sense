// An isolated architecture experiment, never loaded by the application.
// Production recall and ranking are observed unchanged; selection is replayed
// against those exact candidates. Timings below are NOT replacement-engine timings.
const fs = require('node:fs/promises')
const path = require('node:path')
const Module = require('node:module')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { DatabaseSync, backup } = require('node:sqlite')
const { performance } = require('node:perf_hooks')

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const nameOrder = (a, b) => compare(a.nameKey, b.nameKey) || compare(a.pathKey, b.pathKey)
const ids = rows => rows.map(row => row.id)
const rounded = value => +value.toFixed(2)

// Exact selection: all candidates are visited. A limit on output is never a
// limit on recall. The worst retained row is at the root of this max heap.
function topK(rows, count, order) {
  if (!count) return []
  const heap = []
  for (const row of rows) {
    if (heap.length < count) {
      let index = heap.length
      heap.push(row)
      while (index > 0) {
        const parent = (index - 1) >> 1
        if (order(heap[parent], row) >= 0) break
        heap[index] = heap[parent]; index = parent
      }
      heap[index] = row
    } else if (order(row, heap[0]) < 0) {
      let index = 0
      while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1
        if (child + 1 < heap.length && order(heap[child + 1], heap[child]) > 0) child++
        if (order(row, heap[child]) >= 0) break
        heap[index] = heap[child]; index = child
      }
      heap[index] = row
    }
  }
  return heap.sort(order)
}

// The current relevance mode selects the best physical application shortcut
// before suppressing duplicates. Deduplicating an arbitrary first hit is wrong.
function uniqueApplications(rows, order) {
  const ordinary = [], applications = new Map()
  for (const row of rows) {
    if (row.kind !== 'application') { ordinary.push(row); continue }
    const title = row.nameKey.slice(0, row.nameKey.endsWith('.appref-ms') ? -10 : -4)
    const previous = applications.get(title)
    if (!previous || order(row, previous) < 0) applications.set(title, row)
  }
  return [...ordinary, ...applications.values()]
}

function selfTest() {
  let seed = 123456789
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
  for (const length of [0, 1, 7, 1000]) {
    const rows = Array.from({ length }, (_, id) => ({ id, score: random() % 13 }))
    const order = (a, b) => a.score - b.score || a.id - b.id
    for (const count of [0, 1, 100, length + 2]) assert.deepEqual(ids(topK(rows, count, order)), ids([...rows].sort(order).slice(0, count)))
  }
  const apps = [{ id: 1, kind: 'application', nameKey: 'demo.lnk', score: 9 },
    { id: 2, kind: 'application', nameKey: 'demo.lnk', score: 2 },
    { id: 3, kind: 'file', nameKey: 'demo.lnk', score: 1 }]
  assert.deepEqual(ids(uniqueApplications(apps, (a, b) => a.score - b.score)).sort(), [2, 3])
}

function sample(operation) {
  const values = []
  operation() // warm the operation, not an OS cold-cache simulation
  let result
  for (let repeat = 0; repeat < 5; repeat++) {
    const started = performance.now()
    result = operation(); values.push(performance.now() - started)
  }
  return { result, medianMs: rounded(values.sort((a, b) => a - b)[2]) }
}

function nameStatistics(catalog) {
  const names = new Set()
  let nameCodeUnits = 0, pathCodeUnits = 0
  for (const row of catalog) { names.add(row.nameKey); nameCodeUnits += row.nameKey.length; pathCodeUnits += row.pathKey.length }
  return { distinctFoldedBasenames: names.size, nameCodeUnits, fullPathCodeUnits: pathCodeUnits }
}

async function run() {
  selfTest()
  if (process.argv.includes('--self-test')) { console.log('Architecture experiment self-check passed'); return }
  const parent = path.resolve('.cache/search-architecture')
  await fs.mkdir(parent, { recursive: true })
  const owned = await fs.mkdtemp(path.join(parent, 'case-'))
  const databasePath = path.join(owned, 'index.sqlite')
  let source, database
  try {
    source = new DatabaseSync(path.join(process.env.APPDATA, 'Disk Sense/disk-sense-search.sqlite'), { readOnly: true })
    console.log('Creating a consistent metadata snapshot; the application database is read-only')
    await backup(source, databasePath, { rate: 1_000_000 })
    source.close(); source = null
    database = new DatabaseSync(databasePath, { readOnly: true })
    database.exec('PRAGMA temp_store=MEMORY; PRAGMA cache_size=-65536;')

    // Deliberately simple JS catalog to quantify the cost of naive residency.
    // It is not a proposed compact binary on-disk format or final implementation.
    global.gc?.()
    const heapBefore = process.memoryUsage().heapUsed, rssBefore = process.memoryUsage().rss
    const buildStarted = performance.now(), catalog = [], ordinals = new Map()
    for (const row of database.prepare('SELECT rowid AS id,name,path FROM search_files').iterate()) {
      ordinals.set(row.id, catalog.length)
      catalog.push({ id: row.id, nameKey: row.name.toLowerCase(), pathKey: row.path.toLowerCase() })
    }
    const loadMs = performance.now() - buildStarted
    const orderStarted = performance.now(), orderedByName = [...catalog].sort(nameOrder)
    const nameRanks = new Uint32Array(catalog.length)
    orderedByName.forEach((row, rank) => { nameRanks[ordinals.get(row.id)] = rank })
    const orderMs = performance.now() - orderStarted
    const names = nameStatistics(catalog)
    global.gc?.()
    const catalogMetrics = { entries: catalog.length, loadMs: rounded(loadMs), nameOrderBuildMs: rounded(orderMs),
      heapIncreaseMiB: rounded((process.memoryUsage().heapUsed - heapBefore) / 1048576),
      rssIncreaseMiB: rounded((process.memoryUsage().rss - rssBefore) / 1048576),
      ...names,
      representation: 'JS objects, normalized full paths, Map<rowid,ordinal>, sorted references and Uint32 name ranks; NOT a compact final catalog' }
    console.log(JSON.stringify({ catalog: catalogMetrics }))

    // Instrument only our own source in this process. An exact anchor prevents
    // silently observing the wrong stage after production code changes.
    const enginePath = path.resolve('desktop/search-engine.cjs')
    const original = await fs.readFile(enginePath, 'utf8')
    const anchor = '      candidates.sort((a, b) => { if ((++comparisons & 1023) === 0) assertActive(); return order(a, b) })'
    const loaded = new Module(enginePath, module)
    loaded.filename = enginePath; loaded.paths = Module._nodeModulePaths(path.dirname(enginePath))
    let captured, ordering
    const capture = (rows, order) => { captured = rows.slice(); ordering = order }
    let helperSha256
    if (original.includes(anchor)) {
      assert.equal(original.split(anchor).length, 2, 'Expected exactly one ranking anchor')
      const instrumented = original.replace('profile = () => {}, revision', 'capture = () => {}, profile = () => {}, revision')
        .replace(anchor, `      capture(candidates, order, sort)\n${anchor}`)
      loaded._compile(instrumented, enginePath)
    } else {
      // The newer session engine ranks integer ordinals. Observe its private
      // comparator while reconstructing only the replay experiment's row shape.
      const helperPath = path.resolve('desktop/search-candidate-session.cjs')
      const helperSource = await fs.readFile(helperPath, 'utf8')
      const helperAnchor = helperSource.includes('  const view = createResultView(indices, order, { assertActive })')
        ? '  const view = createResultView(indices, order, { assertActive })'
        : '  return { ...createResultView(indices, order, { assertActive }), recent }'
      assert.equal(helperSource.split(helperAnchor).length, 2, 'Expected exactly one candidate-view anchor')
      helperSha256 = createHash('sha256').update(helperSource).digest('hex')
      const helper = new Module(helperPath, module)
      helper.filename = helperPath; helper.paths = Module._nodeModulePaths(path.dirname(helperPath))
      helper._compile('let capture = () => {}\n' + helperSource.replace(helperAnchor, `  capture(set, order, sort)\n${helperAnchor}`)
        + '\nmodule.exports.observe = callback => { capture = callback }\n', helperPath)
      helper.exports.observe((set, order, sort) => {
        if (sort !== 'relevance') return
        const rows = Array.from({ length: set.count }, (_, ordinal) => ({ id: set.ids[ordinal], ordinal,
          nameKey: set.names[set.nameIds[ordinal]].key, pathKey: set.paths[ordinal], kind: set.flags[ordinal] & 2 ? 'application' : 'file' }))
        capture(rows, (a, b) => order(a.ordinal, b.ordinal))
      })
      const ordinaryRequire = loaded.require.bind(loaded)
      loaded.require = name => name === './search-candidate-session.cjs' ? helper.exports : ordinaryRequire(name)
      loaded._compile(original, enginePath)
    }
    const engine = loaded.exports.createSearchEngine(database, { cacheMs: 0, capture })
    const materialize = database.prepare('SELECT rowid AS id,path,name FROM search_files WHERE rowid IN (' + Array(100).fill('?').join(',') + ')')
    const cases = []
    for (const query of ['word', 'vsc', 'report', 'baogao', 'Documents report', 'ext:txt']) {
      const input = { query, scope: 'all', kind: 'all', sort: 'relevance', limit: 100 }
      const first = engine.search(input), candidates = captured, order = ordering
      const canonical = uniqueApplications(candidates, order)
      const ranked = [...canonical].sort(order)
      assert.equal(ranked.length, first.total)
      assert.deepEqual(ids(first.rows), ids(ranked.slice(0, 100)))
      const page2 = first.nextOffset == null ? null : engine.search({ ...input, sessionId: first.sessionId, offset: 100 })
      if (page2) assert.deepEqual(ids(page2.rows), ids(ranked.slice(100, 200)))

      const fullSort = sample(() => [...canonical].sort(order).slice(0, 200))
      const selected = sample(() => topK(canonical, 200, order))
      assert.deepEqual(ids(selected.result), ids(ranked.slice(0, 200)))

      // A frozen candidate set can be reprojected into a catalog's precomputed
      // name order without rerunning matching or recomputing relevance scores.
      const projection = sample(() => {
        const membership = new Uint8Array(catalog.length)
        for (const row of candidates) membership[ordinals.get(row.id)] = 1
        const rows = []
        let inspected = 0
        for (const row of orderedByName) {
          inspected++
          if (membership[ordinals.get(row.id)]) rows.push(row)
          if (rows.length >= Math.min(200, candidates.length)) break
        }
        return { rows, inspected }
      })
      // A sparse query need not scan the catalog. A stored total-order rank
      // lets its own candidate ordinals be sorted by integers instead.
      const sparseProjection = sample(() => {
        const dense = Uint32Array.from(candidates, row => ordinals.get(row.id))
        dense.sort((a, b) => nameRanks[a] - nameRanks[b])
        return Array.from(dense.subarray(0, 200), ordinal => catalog[ordinal])
      })
      assert.deepEqual(ids(sparseProjection.result), ids(projection.result.rows))
      const explicit = engine.search({ ...input, sort: 'name' })
      assert.equal(explicit.total, candidates.length, 'Explicit sort retains physical application entries')
      assert.deepEqual(ids(explicit.rows), ids(projection.result.rows.slice(0, 100)))
      if (explicit.nextOffset != null) {
        const next = engine.search({ ...input, sort: 'name', sessionId: explicit.sessionId, offset: 100 })
        assert.deepEqual(ids(next.rows), ids(projection.result.rows.slice(100, 200)))
      }
      const page = selected.result.slice(0, 100)
      const display = sample(() => {
        const parameters = [...ids(page), ...Array(100 - page.length).fill(-1)]
        const rows = new Map(materialize.all(...parameters).map(row => [row.id, row]))
        return page.map(entry => { const row = rows.get(entry.id); assert.equal(row.path.toLowerCase(), entry.pathKey); return row })
      })
      assert.deepEqual(ids(display.result), ids(first.rows))
      const record = { query, candidateCount: candidates.length, distinctCandidateNames: new Set(candidates.map(row => row.nameKey)).size, relevanceTotal: first.total,
        rankingOnly: { fullSort200Ms: fullSort.medianMs, exactTop200Ms: selected.medianMs },
        nameProjection: { membershipAndScanMs: projection.medianMs, inspectedCatalogRows: projection.result.inspected,
          candidateIntegerRankSortMs: sparseProjection.medianMs },
        pageIdNamePathFetchMs: display.medianMs,
        verified: ['same-relevance-total', 'same-relevance-first-two-pages', 'same-name-total-and-first-two-pages', 'same-ordered-page-identities'] }
      cases.push(record); console.log(JSON.stringify(record))
    }
    const report = { date: new Date().toISOString(), node: process.version,
      engineSha256: createHash('sha256').update(original).digest('hex'), helperSha256, catalog: catalogMetrics, cases,
      scope: 'One frozen metadata snapshot; unchanged production recall and scoring captured before sorting; five warm phase samples, no GUI',
      limitations: ['Candidate recall, scoring and application deduplication costs are excluded from replay timings',
        'Catalog loading, global ordering and memory are paid separately; this is not a cold-start or compact-format benchmark',
        'Top K visits every candidate; it does not prove interactive million-result performance or a deep-pagination strategy',
        'A sparse query can force a preordered catalog scan; choose between candidate sort and order intersection using cost estimates',
        'No incremental input reuse, live snapshot publication, USN replay or production replacement is implemented here',
        'The page fetch measures only id/name/path, not icons, full metadata or rendering'] }
    const output = process.argv.find(value => value.startsWith('--output='))?.slice('--output='.length) || 'docs/search-architecture-experiment.json'
    await fs.writeFile(path.resolve(output), JSON.stringify(report, null, 2) + '\n')
  } finally {
    source?.close(); database?.close()
    assert.equal(path.dirname(owned), parent)
    assert(path.basename(owned).startsWith('case-'))
    await fs.rm(owned, { recursive: true, force: true })
  }
}

run().catch(error => { console.error(error); process.exitCode = 1 })
