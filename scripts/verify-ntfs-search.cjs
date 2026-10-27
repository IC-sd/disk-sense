const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')
const { createFileSearchService } = require('../desktop/file-search.cjs')
const { createNtfsClient } = require('../desktop/ntfs-client.cjs')

;(async () => {
  const parent = path.resolve('release-search-validation')
  await fs.mkdir(parent, { recursive: true })
  const owned = await fs.mkdtemp(path.join(parent, 'ntfs-search-check-'))
  const databasePath = path.join(owned, 'index.sqlite')
  const fixture = path.join(owned, 'files'), original = path.join(fixture, '📁项目', 'docs')
  const marker = `ntfscheck${crypto.randomBytes(5).toString('hex')}`
  const filename = `${marker}报告.txt`
  const cache = process.env.DISK_SENSE_NTFS_CACHE || path.join(process.env.APPDATA, 'Disk Sense', 'search-native-cache')
  const roots = process.argv.slice(2).filter(value => !value.startsWith('--'))
  const volumes = roots.length ? roots : ['D:\\', 'C:\\']
  let service
  try {
    await fs.mkdir(original, { recursive: true })
    await fs.writeFile(path.join(original, filename), 'existing searchable entry')
    await fs.writeFile(path.join(original, `${marker}deleted.txt`), 'delete while closed')
    service = createFileSearchService({ databasePath, nativeEnumeration: false, getVolumeRoots: async () => [fixture] })
    await service.rebuild(); await service.waitForIdle(); await service.close()
    let started, firstProgressMs, watcherCalls = 0
    const journalMetrics = []
    const options = { databasePath, nativeEnumeration: false, reconcileIntervalMs: 0,
      getVolumeRoots: async () => volumes,
      ntfsClientFactory: async (_cache, options) => {
        const native = await createNtfsClient(cache, options)
        if (!native) return null
        return { close: () => native.close(), async *request(input) {
          const start = performance.now()
          for await (const event of native.request(input)) {
            if (event.type === 'journal-end') journalMetrics.push({ root: input.root, events: event.events, changed: event.changed, nativeMs: Math.round(performance.now() - start) })
            yield event
          }
        } }
      },
      watchFactory() { watcherCalls++; throw new Error('Native volumes must not use recursive watchers') },
      onProgress(status) {
        if (started && firstProgressMs == null && status.scannedEntries > 0) firstProgressMs = Math.round(performance.now() - started)
      }
    }
    started = performance.now()
    service = createFileSearchService(options)
    await service.startAutomatic()
    assert(service.status().ntfs.active, 'Authenticated native helper must be available')
    assert(service.status().building, 'Snapshot is running')
    assert(service.search({ query: marker, limit: 100 }).items.some(item => item.name === filename), 'Existing index remains searchable during MFT rebuild')
    const status = await service.waitForIdle()
    assert.equal(status.phase, 'ready', JSON.stringify(status))
    assert(status.ntfs.active && status.ntfs.volumes.filter(volume => volume.complete).length === volumes.length, 'Every native volume has a complete snapshot')
    assert.equal(watcherCalls, 0, 'No duplicate recursive watchers')
    assert(service.search({ query: marker, limit: 100 }).items.some(item => item.name === filename), 'Full native index query')
    const snapshotMs = Math.round(performance.now() - started), completedAt = status.completedAt
    console.log(JSON.stringify({ stage: 'snapshot-import', entries: status.entries, snapshotMs, firstProgressMs, scanner: status.scanner }))
    await service.close(); service = null
    const renamed = path.join(fixture, '新项目', 'documents')
    await fs.rename(path.join(fixture, '📁项目'), path.join(fixture, '新项目'))
    await fs.rename(path.join(fixture, '新项目', 'docs'), renamed)
    await fs.appendFile(path.join(renamed, filename), '\nupdated while closed')
    await fs.unlink(path.join(renamed, `${marker}deleted.txt`))
    await fs.writeFile(path.join(renamed, `${marker}created.txt`), 'new while closed')
    const reopen = performance.now()
    service = createFileSearchService(options)
    await service.startAutomatic()
    const restarted = service.status()
    assert(!restarted.building, `Restart unexpectedly rebuilt: ${JSON.stringify(restarted.ntfs)}`)
    assert.equal(restarted.completedAt, completedAt, 'USN replay must not replace the snapshot')
    const result = service.search({ query: marker, limit: 100 })
    assert(!result.items.some(item => item.name.endsWith('deleted.txt')), 'Offline deletion is searchable immediately')
    assert(result.items.some(item => item.name.endsWith('created.txt')), 'Offline creation is searchable immediately')
    const updated = result.items.find(item => item.name === filename)
    assert.equal(updated?.path, path.join(renamed, filename), 'Parent and child rename paths')
    assert.equal(updated?.size, (await fs.stat(path.join(renamed, filename))).size, 'Offline size update')
    const report = { date: new Date().toISOString(), roots: volumes, entries: status.entries,
      snapshotAndImportMs: snapshotMs, firstCommittedProgressMs: firstProgressMs,
      restartAndReplayAndQueryMs: Math.round(performance.now() - reopen), scanner: restarted.scanner, journalMetrics,
      checks: ['search-during-rebuild', 'all-volume-snapshots', 'no-recursive-watchers', 'restart-without-snapshot',
        'offline-create', 'offline-delete', 'offline-size', 'offline-parent-and-child-rename'] }
    await fs.writeFile(path.join(parent, 'ntfs-search-live.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ passed: true, ...report }))
  } finally {
    await service?.close()
    assert(path.dirname(owned) === parent && path.basename(owned).startsWith('ntfs-search-check-'))
    await fs.rm(owned, { recursive: true, force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
