// Live read-only volume validation; file changes are confined to owned temp fixtures.
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')
const { createNtfsClient } = require('../desktop/ntfs-client.cjs')

;(async () => {
  const cache = path.resolve(process.env.DISK_SENSE_NTFS_CACHE || 'release-search-validation/ntfs-native-cache')
  const roots = process.argv.slice(2).filter(value => !value.startsWith('--'))
  const report = { date: new Date().toISOString(), mode: 'live read-only MFT plus USN; owned file fixtures', volumes: [] }
  let client = await createNtfsClient(cache, { elevate: process.argv.includes('--elevate') })
  assert(client, 'Windows required')
  try {
    if (process.argv.includes('--cancel-reconnect')) {
      const root = roots[0] || 'D:\\'
      for await (const event of client.request({ op: 'snapshot', root })) if (event.type === 'progress') break
      client.close()
      client = null
      for (let attempt = 0; attempt < 15 && !client; attempt++) {
        client = await createNtfsClient(cache, { connectOnly: true })
        if (!client) await new Promise(resolve => setTimeout(resolve, 150))
      }
      assert(client, 'Helper must survive a cancelled snapshot')
      let available = false
      for await (const event of client.request({ op: 'probe', root })) available ||= Boolean(event.available)
      assert(available, 'Authenticated read-only access after cancellation')
      console.log(JSON.stringify({ passed: true, check: 'cancel-snapshot-and-reconnect', root }))
      return
    }
    for (const root of roots.length ? roots : ['C:\\', 'D:\\']) {
      const parent = path.parse(os.tmpdir()).root.toLowerCase() === root.toLowerCase() ? os.tmpdir() : path.resolve('release-search-validation')
      assert.equal(path.parse(parent).root.toLowerCase(), root.toLowerCase(), 'Fixture must be on the requested volume')
      await fs.mkdir(parent, { recursive: true })
      const fixture = await fs.mkdtemp(path.join(parent, 'disk-sense-ntfs-check-'))
      const original = path.join(fixture, '📁项目', 'docs')
      const renamed = path.join(fixture, '新项目', 'documents')
      const reportPath = path.join(original, '报告.txt')
      const large = path.join(original, 'large.bin')
      const alias = path.join(original, 'hardlink.txt')
      const deleted = path.join(original, 'delete.txt')
      try {
        await fs.mkdir(original, { recursive: true })
        await fs.writeFile(reportPath, 'resident metadata\n')
        await fs.writeFile(large, Buffer.alloc(96 * 1024, 71))
        await fs.link(reportPath, alias)
        // Force filename attributes into extension records and a nonresident attribute list.
        for (let i = 0; i < 45; i++) await fs.link(reportPath, path.join(original, `many-hardlinks-${String(i).padStart(2, '0')}.txt`))
        await fs.writeFile(deleted, 'delete me')
        const fixedTime = new Date('2026-01-02T03:04:05.000Z')
        await fs.utimes(reportPath, fixedTime, fixedTime)
        const stat = await fs.stat(reportPath)
        const start = performance.now()
        let header, end, count = 0
        const own = new Map()
        for await (const event of client.request({ op: 'snapshot', root })) {
          if (event.type === 'volume') header = event
          if (event.type === 'records') for (const row of event.rows) {
            count++
            if (row[6].toLowerCase().startsWith(fixture.toLowerCase() + path.sep)) own.set(row[6], row)
          }
          if (event.type === 'snapshot-end') end = event
        }
        const snapshotMs = Math.round(performance.now() - start)
        assert(header && end?.complete, `Incomplete snapshot: ${JSON.stringify(end)}`)
        assert.equal(own.get(reportPath)?.[4], stat.size, 'Resident size')
        assert.equal(own.get(reportPath)?.[5], Math.floor(stat.mtimeMs), 'Standard-information timestamp')
        assert.equal(own.get(large)?.[4], 96 * 1024, 'Nonresident logical size')
        assert.equal(own.get(reportPath)?.[0], own.get(alias)?.[0], 'Hardlink full identity')
        for (let i = 0; i < 45; i++) assert.equal(own.get(path.join(original, `many-hardlinks-${String(i).padStart(2, '0')}.txt`))?.[0], own.get(reportPath)?.[0], 'Extension-record hardlink identity')
        assert(own.get(original)?.[3] & 16, 'Directory attribute')
        const fileId = own.get(reportPath)[0], deletedId = own.get(deleted)[0]
        const parentId = own.get(path.dirname(original))[0], childId = own.get(original)[0]
        // Reconnect the broker while retaining the persisted USN baseline.
        client.close()
        client = await createNtfsClient(cache, { connectOnly: true })
        assert(client, 'Authenticated helper reconnect')
        await fs.rename(path.dirname(original), path.dirname(renamed))
        await fs.rename(path.join(path.dirname(renamed), 'docs'), renamed)
        await fs.appendFile(path.join(renamed, '报告.txt'), 'updated\n')
        await fs.unlink(path.join(renamed, 'hardlink.txt'))
        await fs.rename(path.join(renamed, 'many-hardlinks-44.txt'), path.join(renamed, 'renamed-hardlink.txt'))
        await fs.unlink(path.join(renamed, 'delete.txt'))
        await fs.writeFile(path.join(renamed, 'created.txt'), 'created after snapshot')
        let journalEnd
        const changes = new Map(), journalStart = performance.now()
        for await (const event of client.request({ op: 'journal', root, serial: header.serial, journalId: header.journalId, nextUsn: header.nextUsn })) {
          assert.notEqual(event.type, 'reset', `Unexpected journal reset: ${JSON.stringify(event)}`)
          if (event.type === 'changes') for (const row of event.rows) changes.set(row.id, row)
          if (event.type === 'journal-end') journalEnd = event
        }
        assert(journalEnd, 'Completed journal cursor')
        const updated = changes.get(fileId)
        assert(updated && !updated.deleted, 'Updated file identity')
        assert.equal(updated.size, (await fs.stat(path.join(renamed, '报告.txt'))).size, 'Updated logical size')
        assert(updated.links.some(link => link[1] === '报告.txt'), 'Remaining hardlink')
        assert(!updated.links.some(link => link[1] === 'hardlink.txt'), 'Removed hardlink')
        assert(updated.links.some(link => link[1] === 'renamed-hardlink.txt'), 'Renamed extension-record hardlink')
        assert.equal(updated.links.length, 46, 'All hardlinks, including extension records')
        assert(changes.get(deletedId)?.deleted, 'Deleted identity')
        assert(changes.get(parentId)?.links.some(link => link[1] === '新项目'), 'Parent directory rename')
        assert(changes.get(childId)?.links.some(link => link[1] === 'documents'), 'Child directory rename')
        assert([...changes.values()].some(row => row.links.some(link => link[1] === 'created.txt')), 'New file')
        const measurement = { root, strategy: end.strategy, records: count, mftBytes: header.mftBytes, snapshotMs, damaged: end.damaged,
          unresolved: end.unresolved, journalMs: Math.round(performance.now() - journalStart), journalEvents: journalEnd.events,
          journalChanges: journalEnd.changed, checks: ['resident-size', 'nonresident-size', 'modified-time', 'hardlinks',
            'extension-records', 'nonresident-attribute-list', 'broker-reconnect', 'persisted-journal-cursor', 'file-update', 'file-delete', 'parent-and-child-rename', 'file-create'] }
        report.volumes.push(measurement)
        console.log(JSON.stringify(measurement))
      } finally {
        // mkdtemp returns a literal, owned child of the validated parent.
        assert(path.dirname(fixture) === parent && path.basename(fixture).startsWith('disk-sense-ntfs-check-'))
        await fs.rm(fixture, { recursive: true, force: true })
      }
    }
    const destination = path.resolve('release-search-validation/ntfs-live.json')
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.writeFile(destination, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ passed: true, report: destination }))
  } finally { client?.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
