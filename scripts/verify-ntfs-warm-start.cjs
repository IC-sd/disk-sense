// Real service and real index snapshot; mutations are restricted to an owned fixture.
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const os = require('node:os')
const assert = require('node:assert/strict')
const { DatabaseSync, backup } = require('node:sqlite')
const { performance } = require('node:perf_hooks')
const { createFileSearchService } = require('../desktop/file-search.cjs')
const { createNtfsClient } = require('../desktop/ntfs-client.cjs')

;(async () => {
  const parent = path.resolve('release-search-validation')
  await fs.mkdir(parent, { recursive: true })
  const owned = await fs.mkdtemp(path.join(parent, 'native-warm-'))
  const databasePath = path.join(owned, 'index.sqlite')
  const fixtureParent = path.resolve(os.tmpdir())
  const fixture = await fs.mkdtemp(path.join(fixtureParent, 'disk-sense-ntfs-warm-'))
  const marker = `warmcheck${crypto.randomBytes(5).toString('hex')}`
  const original = path.join(fixture, '📁项目', 'docs'), filename = `${marker}报告.txt`
  const source = new DatabaseSync(path.join(process.env.APPDATA, 'Disk Sense', 'disk-sense-search.sqlite'), { readOnly: true })
  let service
  const journal = [], operations = []
  const rename = async (from, to) => {
    for (let attempt = 0; ; attempt++) {
      try { return await fs.rename(from, to) } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 15) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  }
  try {
    await backup(source, databasePath, { rate: 1_000_000 }); source.close()
    const control = new DatabaseSync(databasePath)
    const roots = control.prepare('SELECT root FROM search_ntfs_volumes WHERE complete=1 ORDER BY root').all().map(row => row.root)
    control.close(); assert(roots.length >= 2)
    await fs.mkdir(original, { recursive: true })
    await fs.writeFile(path.join(original, filename), 'before')
    await fs.writeFile(path.join(original, `${marker}deleted.txt`), 'owned deletion fixture')
    const options = { databasePath, getVolumeRoots: async () => roots, reconcileIntervalMs: 0,
      watchFactory() { throw new Error('Native volumes must use USN') },
      ntfsClientFactory: async (_cache, settings) => {
        assert(!settings?.elevate, 'Warm startup never requests administrator authorization')
        const native = await createNtfsClient(path.resolve('.cache/ntfs-service-validation'), settings)
        assert(native?.persistent)
        return { persistent: native.persistent, close: () => native.close(), async *request(input) {
          operations.push(input.op); const started = performance.now()
          for await (const event of native.request(input)) {
            if (event.type === 'journal-end') journal.push({ root: input.root, changed: event.changed, events: event.events, nativeMs: Math.round(performance.now() - started) })
            yield event
          }
        } }
      }
    }
    service = createFileSearchService(options)
    await service.startAutomatic(); await service.waitForIdle()
    assert(service.search({ query: marker }).items.some(item => item.name === filename))
    await service.close(); service = null
    await rename(path.join(fixture, '📁项目'), path.join(fixture, '新项目'))
    await rename(path.join(fixture, '新项目', 'docs'), path.join(fixture, '新项目', 'documents'))
    const moved = path.join(fixture, '新项目', 'documents')
    await fs.appendFile(path.join(moved, filename), ' after')
    await fs.unlink(path.join(moved, `${marker}deleted.txt`))
    await fs.writeFile(path.join(moved, `${marker}created.txt`), 'offline creation')
    await fs.link(path.join(moved, filename), path.join(fixture, `${marker}hardlink.txt`))
    const start = performance.now()
    service = createFileSearchService(options)
    const constructorMs = Math.round(performance.now() - start)
    const queryStart = performance.now()
    assert(service.search({ query: marker }).items.some(item => item.path === path.join(original, filename)), 'The persisted index is searchable before synchronization')
    const cachedQueryMs = Math.round(performance.now() - queryStart)
    const syncStart = performance.now()
    await service.startAutomatic(); await service.waitForIdle()
    const replayMs = Math.round(performance.now() - syncStart)
    const found = service.search({ query: marker }).items
    assert(found.some(item => item.path === path.join(moved, filename) && item.size === 12))
    assert(found.some(item => item.name === `${marker}hardlink.txt`))
    assert(found.some(item => item.name === `${marker}created.txt`))
    assert(!found.some(item => item.name === `${marker}deleted.txt` || item.path.includes('📁项目')))
    assert(!operations.includes('snapshot'), 'A restart and offline changes must not trigger a full MFT snapshot')
    assert(service.status().ntfs.persistent && !service.status().building)
    const report = { date: new Date().toISOString(), entries: service.status().entries, constructorMs, cachedQueryMs, replayMs,
      snapshotCalls: 0, uacRequests: 0, persistent: true, checks: ['cached-query-before-replay', 'offline-parent-and-child-rename', 'offline-size', 'offline-delete', 'offline-create', 'hardlinks'], journal }
    console.log(JSON.stringify(report, null, 2))
    await fs.writeFile(path.join(parent, 'ntfs-warm-start-validation.json'), JSON.stringify(report, null, 2) + '\n')
  } finally {
    try { source.close() } catch {}
    await service?.close()
    assert(path.dirname(owned) === parent && path.basename(owned).startsWith('native-warm-'))
    await fs.rm(owned, { recursive: true, force: true })
    assert(path.dirname(fixture) === fixtureParent && path.basename(fixture).startsWith('disk-sense-ntfs-warm-'))
    await fs.rm(fixture, { recursive: true, force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
