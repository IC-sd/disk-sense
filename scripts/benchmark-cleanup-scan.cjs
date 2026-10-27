// Controlled, read-only scans. Only this script's mkdtemp fixture is removed.
const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { collectRuleFiles } = require('../desktop/cleaner.cjs')

async function main() {
  const cache = path.resolve('.cache')
  fs.mkdirSync(cache, { recursive: true })
  const root = fs.mkdtempSync(path.join(cache, 'cleanup-benchmark-owned-'))
  try {
    const nested = path.join(root, 'nested')
    const deep = path.join(nested, 'deep')
    fs.mkdirSync(deep, { recursive: true })
    const now = Date.now()
    const write = (dir, index, recent) => {
      const file = path.join(dir, `${index}.tmp`)
      fs.writeFileSync(file, Buffer.alloc(128))
      const date = new Date(now - (recent ? 1 : 30) * 86400000)
      fs.utimesSync(file, date, date)
    }
    for (let i = 0; i < 40; i++) write(root, i, false)
    for (const dir of [nested, deep]) for (let i = 0; i < 300; i++) write(dir, i, i % 2 === 0)
    const roots = [root, nested, deep]
    const rule = { id: 'benchmark', roots, pattern: /.*/, risk: 'safe', minimumAgeDays: 7, processNames: [], selectable: true }
    const measure = async shared => {
      const calls = { lstat: 0, realpath: 0, opendir: 0 }
      const fileSystem = { ...fs.promises }
      for (const method of Object.keys(calls)) fileSystem[method] = async (...args) => {
        calls[method]++
        return fs.promises[method](...args)
      }
      const start = performance.now()
      const scans = []
      if (shared) scans.push(await collectRuleFiles(rule, { now, fileSystem }))
      else for (const location of roots) scans.push(await collectRuleFiles({ ...rule, roots: [location] }, { now, fileSystem }))
      return {
        observedItems: scans.reduce((sum, scan) => sum + scan.observed.items, 0),
        candidates: scans.reduce((sum, scan) => sum + scan.files.length, 0),
        retained: scans.reduce((sum, scan) => sum + scan.retained.recentItems, 0),
        calls, durationMs: Number((performance.now() - start).toFixed(2))
      }
    }
    const independentRootsReference = await measure(false)
    const sharedRuleTraversal = await measure(true)
    if (sharedRuleTraversal.observedItems !== 640 || sharedRuleTraversal.candidates !== 340 || sharedRuleTraversal.retained !== 300) throw new Error('incorrect-shared-traversal')
    const report = { date: new Date().toISOString(), fixtureFiles: 640, configuredRoots: 3,
      reference: 'Independent single-root scans using the same scanner; not a historical binary benchmark. Wall time is order/cache sensitive.',
      independentRootsReference, sharedRuleTraversal, realUserFilesRead: false, cleanupExecuted: false }
    fs.mkdirSync(path.resolve('docs'), { recursive: true })
    fs.writeFileSync(path.resolve('docs/cleanup-scan-benchmark.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report, null, 2))
  } finally {
    if (path.dirname(root) !== cache || !path.basename(root).startsWith('cleanup-benchmark-owned-')) throw new Error('unowned-fixture-cleanup')
    fs.rmSync(root, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
