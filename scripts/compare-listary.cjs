// Runs the user-supplied research harness against an isolated custom-folder index.
// Neither Listary's profile nor its installed binaries are modified.
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { performance } = require('node:perf_hooks')
const { createFileSearchService } = require('../desktop/file-search.cjs')
const { DatabaseSync } = require('node:sqlite')
const { createSearchEngine } = require('../desktop/search-engine.cjs')

;(async () => {
  const sourcePath = process.env.LISTARY_RESEARCH_SOURCE || 'D:\\Users\\12285\\Desktop\\Listary6-搜索核心逆向完整资料\\experiments\\ListaryScaleProbe.cs'
  const product = process.argv[2] || 'D:\\yingyong\\listary\\Listary'
  assert(!/["\r\n]/u.test(product))
  const cache = path.resolve('.cache/listary-comparison'), parent = path.join(cache, 'runs')
  await fs.mkdir(parent, { recursive: true })
  const owned = path.join(parent, `case-${Date.now()}`), output = path.join(cache, 'native-result.json')
  const source = (await fs.readFile(sourcePath, 'utf8'))
    .replace(/static readonly string Product=@"[^"]+";/u, `static readonly string Product=@"${product}";`)
    .replace(/^  string owned=.*$/mu, '  string owned=Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"runs"))+"\\\\";')
  assert(source.includes('AppDomain.CurrentDomain.BaseDirectory,"runs"'), 'Harness ownership guard was adapted')
  const sourceCopy = path.join(cache, 'ListaryScaleProbe.cs'), executable = path.join(cache, 'ListaryScaleProbe.exe')
  await fs.writeFile(sourceCopy, source)
  const compiler = path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
  await promisify(execFile)(compiler, ['/nologo', '/optimize+', '/r:System.Web.Extensions.dll', `/out:${executable}`, sourceCopy], { windowsHide: true })
  let service, benchmarkDb
  try {
    console.log('Indexing 10000 owned zero-byte files with the original Listary engine')
    const native = await promisify(execFile)(executable, ['10000', owned, output], { windowsHide: true, timeout: 180_000 })
    console.log(native.stdout.trim())
    const raw = JSON.parse(await fs.readFile(output, 'utf8'))
    const fixture = path.join(owned, 'fixture')
    service = createFileSearchService({ databasePath: path.join(owned, 'disk-sense.sqlite'), getVolumeRoots: async () => [fixture] })
    const start = performance.now()
    await service.rebuild(); await service.waitForIdle(); await service.waitForQueryIndex()
    const buildMs = Math.round(performance.now() - start), comparisons = []
    await service.close(); service = null
    benchmarkDb = new DatabaseSync(path.join(owned, 'disk-sense.sqlite'), { readOnly: true })
    benchmarkDb.exec('PRAGMA temp_store=MEMORY; PRAGMA cache_size=-65536;')
    const engine = createSearchEngine(benchmarkDb, { cacheMs: 0, profile: (stage, ms) => {
      if (process.argv.includes('--profile')) console.log(`${stage}: ${ms.toFixed(1)} ms`)
    } })
    for (const prefix of ['broad_', 'exact_', 'extension_', 'page2_']) {
      const cases = raw.cases.filter(item => item.label.startsWith(prefix))
      assert.equal(cases.length, 5)
      const times = [], totals = []
      for (const item of cases) {
        const input = { query: item.input.query + (item.input.extensions?.length ? ` ext:${item.input.extensions.join(',')}` : ''), kind: 'file', sort: prefix === 'page2_' ? 'name' : 'relevance', limit: 100 }
        const started = performance.now()
        let result = engine.search(input)
        if (prefix === 'page2_') result = engine.search({ ...input, sessionId: result.sessionId, offset: 100 })
        times.push(performance.now() - started); totals.push(result.total)
        assert.equal(result.total, Number(item.total), `${prefix} total matches Listary`)
        assert.equal(result.rows.length, Number(item.returned), `${prefix} page length matches Listary`)
        if (prefix === 'page2_' || prefix === 'exact_') assert.deepEqual(result.rows.map(row => path.relative(fixture, row.path).replaceAll('\\', '/')).sort(), item.rows.map(row => row.path.replaceAll('\\', '/')).sort())
      }
      const median = values => +values.sort((a, b) => a - b)[2].toFixed(2)
      comparisons.push({ query: prefix.slice(0, -1), total: totals[0], listaryMedianMs: median(cases.map(item => item.searchMilliseconds + item.pageMilliseconds)), diskSenseMedianMs: median(times) })
    }
    const report = { date: '2026-10-19', listaryVersion: '6.3.5.94', files: 10000, listaryIndexMs: raw.indexMilliseconds, diskSenseBuildAndAuxiliaryIndexMs: buildMs,
      scope: 'Same owned files and machine; isolated custom-folder indexes; five samples; query result cache disabled; no GUI; Disk Sense page2 includes first-page construction',
      checks: ['same-total-counts', 'same-page-lengths', 'same-exact-file', 'same-second-page-file-set'], comparisons,
      limits: ['A 10000-file custom index does not establish million-file or full-volume performance equivalence', 'General Listary Fuzzy and date-boundary cases are outside this comparison'] }
    await fs.mkdir('release-search-validation', { recursive: true })
    await fs.writeFile('release-search-validation/listary-comparison.json', JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await service?.close()
    benchmarkDb?.close()
    assert(path.dirname(owned) === parent && path.basename(owned).startsWith('case-'))
    await fs.rm(owned, { recursive: true, force: true })
  }
})().catch(error => { console.error(error.stdout || error); process.exitCode = 1 })
