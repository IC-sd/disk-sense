import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error CommonJS desktop service.
import { createFileSearchService } from '../desktop/file-search.cjs'

const owned: string[] = []
afterEach(() => { for (const directory of owned.splice(0)) fs.rmSync(directory, { recursive: true, force: true }) })

describe('native search lifecycle', () => {
  it('skips unchanged journal rows and updates metadata without rewriting name and path indexes', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-ntfs-noop-')); owned.push(directory)
    const databasePath = path.join(directory, 'index.sqlite')
    let size = 19
    const clientFactory = async () => ({ persistent: true, close() {}, async *request(input: any) {
      if (input.op === 'probe') { yield { available: true, journalId: '10' }; return }
      if (input.op === 'snapshot') {
        yield { type: 'volume', serial: '42', journalId: '10', rootId: '5', nextUsn: '100' }
        yield { type: 'records', rows: [['28147497671065602', '5', '报告.txt', 32, 19, 1000, 'C:\\报告.txt']] }
        yield { type: 'snapshot-end', serial: '42', journalId: '10', complete: true }
      } else {
        yield { type: 'changes', rows: [{ id: '28147497671065602', attributes: 32, size, modified: 1000, links: [['5', '报告.txt']] }] }
        yield { type: 'journal-end', serial: '42', journalId: '10', nextUsn: '200' }
      }
    } })
    const options = { databasePath, getVolumeRoots: async () => ['C:\\'], ntfsClientFactory: clientFactory, reconcileIntervalMs: 0 }
    let service = createFileSearchService(options)
    await service.startAutomatic(); await service.waitForIdle(); await service.close()
    const control = new DatabaseSync(databasePath)
    control.exec(`CREATE TABLE validation_updates(kind TEXT);
      CREATE TRIGGER validation_any_update AFTER UPDATE ON search_files BEGIN INSERT INTO validation_updates VALUES ('any'); END;
      CREATE TRIGGER validation_name_update AFTER UPDATE OF name,path,root,kind,is_directory,is_link ON search_files BEGIN INSERT INTO validation_updates VALUES ('identity'); END;
      CREATE TRIGGER validation_link_update AFTER UPDATE ON search_ntfs_links BEGIN INSERT INTO validation_updates VALUES ('link'); END;`)
    service = createFileSearchService(options)
    try {
      await service.startAutomatic()
      expect(service.status().ntfs?.persistent).toBe(true)
      expect(control.prepare('SELECT * FROM validation_updates').all()).toHaveLength(0)
      size = 29
      await service.enableNtfs()
      expect(service.search({ query: 'baogao' }).items[0]?.size).toBe(29)
      expect(control.prepare('SELECT kind FROM validation_updates').all()).toEqual([{ kind: 'any' }])
    } finally { await service.close(); control.close() }
  })
  it('queries a native snapshot and replays offline changes on restart without another snapshot or recursive watcher', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-ntfs-search-')); owned.push(directory)
    const calls: string[] = []
    let cursor = '100', offline = false, watchers = 0
    const clientFactory = async () => ({
      close() {},
      async *request(input: any) {
        calls.push(input.op)
        if (input.op === 'probe') { yield { type: 'probe', available: true, journalId: '10' }; return }
        if (input.op === 'snapshot') {
          yield { type: 'volume', serial: '42', journalId: '10', rootId: '5', nextUsn: cursor }
          yield { type: 'records', rows: [
            ['28147497671065601', '5', '项目', 16, 0, 1000, 'C:\\项目'],
            ['28147497671065602', '28147497671065601', '报告.txt', 32, 19, 1000, 'C:\\项目\\报告.txt'],
            ['28147497671065603', '5', 'old.txt', 32, 9, 1000, 'C:\\old.txt']
          ] }
          yield { type: 'snapshot-end', serial: '42', journalId: '10', complete: true }
        } else {
          expect(input.nextUsn).toBe(cursor)
          if (offline) {
            yield { type: 'changes', rows: [
              { id: '28147497671065601', attributes: 16, size: 0, modified: 2000, links: [['5', '新项目']] },
              { id: '28147497671065602', attributes: 32, size: 27, modified: 2000, links: [['28147497671065601', '新报告.txt']] },
              { id: '28147497671065603', deleted: true }
            ] }
            cursor = '200'
          }
          yield { type: 'journal-end', serial: '42', journalId: '10', nextUsn: cursor }
        }
      }
    })
    const options = { databasePath: path.join(directory, 'index.sqlite'), getVolumeRoots: async () => ['C:\\'],
      ntfsClientFactory: clientFactory, reconcileIntervalMs: 0,
      watchFactory() { watchers++; throw new Error('Must use USN') }
    }
    let service = createFileSearchService(options)
    const checkpoint = new DatabaseSync(options.databasePath)
    checkpoint.prepare('INSERT INTO search_metadata VALUES (?,?)').run('scan', JSON.stringify({ generation: 1, state: { roots: ['C:\\'], entries: 400, directories: 100 } }))
    checkpoint.prepare('INSERT INTO search_scan_queue VALUES (?,?,?,?)').run(1, 'C:\\', 'C:\\', 0)
    checkpoint.close()
    try {
      await service.startAutomatic(); await service.waitForIdle()
      expect(service.status().ntfs).toMatchObject({ active: true, requiresElevation: false })
      expect(service.status().directories).toBe(1)
      expect(service.search({ query: 'baogao' }).items).toEqual([expect.objectContaining({ path: 'C:\\项目\\报告.txt', size: 19 })])
    } finally { await service.close() }
    const previousSnapshots = calls.filter(op => op === 'snapshot').length
    const interrupted = new DatabaseSync(options.databasePath)
    interrupted.prepare('UPDATE search_metadata SET value=? WHERE key=?').run(JSON.stringify({ generation: 1, state: { roots: ['C:\\'], entries: 400 } }), 'scan')
    interrupted.close()
    offline = true
    service = createFileSearchService(options)
    try {
      await service.startAutomatic()
      expect(service.status()).toMatchObject({ building: false, scanner: 'ntfs-usn' })
      expect(service.search({ query: 'baogao' }).items).toEqual([expect.objectContaining({ path: 'C:\\新项目\\新报告.txt', size: 27 })])
      expect(service.status().entries).toBe(2)
      expect(calls.filter(op => op === 'snapshot')).toHaveLength(previousSnapshots)
      expect(calls).toContain('journal')
      await service.enableNtfs()
      expect(calls.filter(op => op === 'snapshot')).toHaveLength(previousSnapshots)
      expect(watchers).toBe(0)
    } finally { await service.close() }
  })
  it('resumes only the unfinished native volume while preserving the completed volume', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-native-resume-')); owned.push(directory)
    const databasePath = path.join(directory, 'index.sqlite'), snapshots: string[] = []
    const roots = ['C:\\', 'D:\\']
    const options = { databasePath, getVolumeRoots: async () => roots, reconcileIntervalMs: 0,
      ntfsClientFactory: async () => ({ close() {}, async *request(input: any) {
        if (input.op === 'probe') { yield { available: true, journalId: '10' }; return }
        if (input.op === 'snapshot') {
          snapshots.push(input.root)
          yield { type: 'volume', serial: '42', journalId: '10', rootId: '5', nextUsn: '100' }
          yield { type: 'records', rows: [['28147497671065602', '5', '保留.txt', 32, 19, 1000, input.root + '保留.txt']] }
          yield { type: 'snapshot-end', serial: '42', journalId: '10', complete: true }
        } else yield { type: 'journal-end', serial: '42', journalId: '10', nextUsn: '200' }
      } })
    }
    let service = createFileSearchService(options)
    await service.startAutomatic(); await service.waitForIdle(); await service.close()
    const control = new DatabaseSync(databasePath)
    control.prepare('UPDATE search_ntfs_volumes SET complete=0 WHERE root=?').run(roots[1]); control.close()
    snapshots.length = 0
    service = createFileSearchService(options)
    try {
      await service.startAutomatic(); await service.waitForIdle()
      expect(snapshots).toEqual([roots[1]])
      expect(service.search({ query: '保留' }).items.map((item: any) => item.path).sort()).toEqual(roots.map(root => root + '保留.txt'))
      expect(service.status().entries).toBe(2)
    } finally { await service.close() }
  })
})
