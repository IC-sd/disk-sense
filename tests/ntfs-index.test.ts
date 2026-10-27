import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Native indexing is a CommonJS desktop module.
import { createNtfsIndex } from '../desktop/ntfs-index.cjs'

const databases: DatabaseSync[] = []
afterEach(() => { while (databases.length) databases.pop()?.close() })

function fixture(maximumEntries = 1000) {
  const database = new DatabaseSync(':memory:')
  databases.push(database)
  database.exec(`CREATE TABLE search_files(path TEXT PRIMARY KEY COLLATE NOCASE,name TEXT,root TEXT,kind TEXT,is_directory INTEGER,is_link INTEGER,size INTEGER,modified_at INTEGER,generation INTEGER);
    CREATE TABLE search_phonetics(path TEXT,alias TEXT,initials TEXT,PRIMARY KEY(path,alias));`)
  const root = 'C:\\', parent = '28147497671065601', file = '28147497671065602', child = '28147497671065603'
  const snapshotRows: any[] = [
    [parent, '5', '📁项目', 16, 0, 1000, 'C:\\📁项目'],
    [child, parent, 'docs', 16, 0, 1000, 'C:\\📁项目\\docs'],
    [file, child, '报告.txt', 32, 19, 2000, 'C:\\📁项目\\docs\\报告.txt']
  ]
  let journal: any[] = []
  let complete = true
  let finalizeCount = 0
  let journalObserver: (() => void) | undefined
  let journalFailure: Error | undefined
  let probeFailure: Error | undefined
  let snapshotObserver: (() => void) | undefined
  let journalRequests = 0
  const client = {
    persistent: true,
    async *request(input: any) {
      if (input.op === 'probe') { if (probeFailure) throw probeFailure; yield { available: true, journalId: '10' }; return }
      if (input.op === 'snapshot') {
        yield { type: 'volume', root, serial: '42', journalId: '10', nextUsn: '100', rootId: '5' }
        yield { type: 'records', rows: snapshotRows }
        snapshotObserver?.()
        yield { type: 'snapshot-end', serial: '42', journalId: '10', complete }
      } else {
        journalRequests++
        if (journalFailure) throw journalFailure
        for (const event of journal) { yield event; if (event.type === 'journal-end') journalObserver?.() }
      }
    },
    close() {}
  }
  const insert = database.prepare('INSERT OR REPLACE INTO search_files VALUES (?,?,?,?,?,?,?,?,?)')
  const remove = (target: string) => {
    const rows = database.prepare('SELECT path FROM search_files').all() as { path: string }[]
    for (const row of rows) if (row.path.toLowerCase() === target.toLowerCase() || row.path.toLowerCase().startsWith((target + '\\').toLowerCase())) {
      database.prepare('DELETE FROM search_files WHERE path=?').run(row.path)
      database.prepare('DELETE FROM search_phonetics WHERE path=?').run(row.path)
    }
  }
  const createIndex = () => createNtfsIndex({ database, cacheDirectory: '.', maximumEntries,
    clientFactory: async () => client,
    upsertItem(item: any) { item.row[3] = item.row[4] ? 'folder' : 'file'; insert.run(...item.row) },
    removeTarget: remove,
    finalizeRoot(root: string, generation: number) {
      database.prepare('DELETE FROM search_files WHERE root=? AND generation<>?').run(root, generation)
      finalizeCount++
    }, isDatabaseFile: () => false, changed() {}, progress() {}
  })
  let index = createIndex()
  const state = () => ({ entries: 0, directories: 0, current: root, truncated: false })
  const end = (nextUsn = '200') => ({ type: 'journal-end', root, serial: '42', journalId: '10', nextUsn })
  return { database, get index() { return index }, root, parent, child, file, state, end, rows: snapshotRows,
    reopen() { index.close(); index = createIndex(); return index.prepare([root]) },
    observeSnapshot(callback?: () => void) { snapshotObserver = callback },
    journalRequests: () => journalRequests,
    setJournal(events: any[]) { journal = events }, setComplete(value: boolean) { complete = value },
    failJournal(error?: Error) { journalFailure = error },
    failProbe(error?: Error) { probeFailure = error },
    observeJournal(callback: () => void) { journalObserver = callback },
    finalized: () => finalizeCount,
    paths: () => (database.prepare('SELECT path FROM search_files ORDER BY path').all() as { path: string }[]).map(row => row.path)
  }
}

describe('NTFS snapshot and journal replay', () => {
  it('keeps a completed volume available when SCM is still starting at login', async () => {
    const f = fixture(); await f.index.prepare([f.root]); await f.index.snapshot(f.root, 1, f.state(), { cancelled: false })
    f.failProbe(Object.assign(new Error('Service not ready'), { code: 'NTFS_TRANSPORT_UNAVAILABLE' }))
    expect(await f.index.prepare([f.root])).toBe(true)
    expect(f.index.status()).toMatchObject({ persistent: true, requiresElevation: false, active: true })
    expect(f.index.usable(f.root)).toBe(true)
    f.failProbe(); f.setJournal([f.end()])
    expect(await f.index.replay(f.root, 2)).toMatchObject({ used: true, changed: 0 })
    expect(f.finalized()).toBe(1)
  })
  it('retries a temporarily disconnected service from the same cursor without rebuilding', async () => {
    const f = fixture(); await f.index.prepare([f.root]); await f.index.snapshot(f.root, 1, f.state(), { cancelled: false })
    f.failJournal(Object.assign(new Error('Service restarting'), { code: 'NTFS_TRANSPORT_UNAVAILABLE' }))
    expect(await f.index.replay(f.root, 2)).toMatchObject({ retry: true })
    expect(f.database.prepare('SELECT next_usn FROM search_ntfs_volumes').get()?.next_usn).toBe('100')
    expect(f.index.hasSnapshot(f.root)).toBe(true)
    f.failJournal(); f.setJournal([{ type: 'changes', rows: [{ id: f.file, attributes: 32, size: 23, modified: 3000, links: [[f.child, '报告.txt']] }] }, f.end()])
    expect(await f.index.replay(f.root, 3)).toMatchObject({ used: true, changed: 1 })
    expect(f.database.prepare('SELECT next_usn FROM search_ntfs_volumes').get()?.next_usn).toBe('200')
    expect(f.finalized()).toBe(1)
  })
  it('imports full-width identities, sizes and timestamps from the native snapshot', async () => {
    const f = fixture()
    await f.index.prepare([f.root])
    expect(await f.index.snapshot(f.root, 1, f.state(), { cancelled: false })).toBe(true)
    expect(f.finalized()).toBe(1)
    expect(f.database.prepare('SELECT ref FROM search_ntfs_links WHERE name=?').get('报告.txt')?.ref).toBe(f.file)
    expect(f.database.prepare('SELECT size,modified_at FROM search_files WHERE name=?').get('报告.txt')).toEqual({ size: 19, modified_at: 2000 })
  })
  it('moves a parent and child directory in one delta without losing descendant paths or phonetic aliases', async () => {
    const f = fixture(); await f.index.prepare([f.root]); await f.index.snapshot(f.root, 1, f.state(), { cancelled: false })
    f.database.prepare('INSERT INTO search_phonetics VALUES (?,?,?)').run('C:\\📁项目\\docs\\报告.txt', 'baogao', 'bg')
    f.setJournal([{ type: 'changes', rows: [
      { id: f.child, attributes: 16, size: 0, modified: 3000, links: [[f.parent, 'documents']] },
      { id: f.parent, attributes: 16, size: 0, modified: 3000, links: [['5', '新项目']] }
    ] }, f.end()])
    const result = await f.index.replay(f.root, 2)
    expect(result.reset).not.toBe(true)
    expect(f.paths()).toEqual(['C:\\新项目', 'C:\\新项目\\documents', 'C:\\新项目\\documents\\报告.txt'])
    expect(f.database.prepare('SELECT path FROM search_phonetics').get()?.path).toBe('C:\\新项目\\documents\\报告.txt')
    expect(f.database.prepare('SELECT next_usn FROM search_ntfs_volumes').get()?.next_usn).toBe('200')
  })
  it('handles deletion before creation when a path is reused by another full file identity', async () => {
    const f = fixture(); await f.index.prepare([f.root]); await f.index.snapshot(f.root, 1, f.state(), { cancelled: false })
    f.setJournal([{ type: 'changes', rows: [
      { id: '56294995342131202', attributes: 32, size: 99, modified: 5000, links: [[f.child, '报告.txt']] },
      { id: f.file, deleted: true }
    ] }, f.end()])
    expect((await f.index.replay(f.root, 3)).reset).not.toBe(true)
    expect(f.database.prepare('SELECT size FROM search_files WHERE name=?').get('报告.txt')?.size).toBe(99)
  })
  it('preserves both descendant trees when directory names are swapped', async () => {
    const f = fixture(), other = '28147497671065604'
    f.rows.push([other, '5', '另一项目', 16, 0, 1000, 'C:\\另一项目'],
      ['28147497671065605', other, 'other.txt', 32, 7, 1000, 'C:\\另一项目\\other.txt'])
    await f.index.prepare([f.root]); await f.index.snapshot(f.root, 1, f.state(), { cancelled: false })
    f.setJournal([{ type: 'changes', rows: [
      { id: f.parent, attributes: 16, size: 0, modified: 3000, links: [['5', '另一项目']] },
      { id: other, attributes: 16, size: 0, modified: 3000, links: [['5', '📁项目']] }
    ] }, f.end()])
    expect((await f.index.replay(f.root, 2)).reset).not.toBe(true)
    expect(f.paths()).toContain('C:\\另一项目\\docs\\报告.txt')
    expect(f.paths()).toContain('C:\\📁项目\\other.txt')
    expect(f.paths().some((target: string) => target.includes('.disk-sense-index-'))).toBe(false)
  })
  it('preserves a moved subtree when its former parent was deleted while the app was closed', async () => {
    const f = fixture(); await f.index.prepare([f.root]); await f.index.snapshot(f.root, 1, f.state(), { cancelled: false })
    f.setJournal([{ type: 'changes', rows: [
      { id: f.parent, deleted: true },
      { id: f.child, attributes: 16, size: 0, modified: 3000, links: [['5', 'rescued']] }
    ] }, f.end()])
    expect((await f.index.replay(f.root, 2)).reset).not.toBe(true)
    expect(f.paths()).toEqual(['C:\\rescued', 'C:\\rescued\\报告.txt'])
  })
  it('retains descendants when a deleted parent path is occupied by a new directory identity', async () => {
    const f = fixture(), replacement = '28147497671065604'
    await f.index.prepare([f.root]); await f.index.snapshot(f.root, 1, f.state(), { cancelled: false })
    f.setJournal([{ type: 'changes', rows: [
      { id: f.parent, deleted: true },
      { id: replacement, attributes: 16, size: 0, modified: 3000, links: [['5', '📁项目']] },
      { id: f.child, attributes: 16, size: 0, modified: 3000, links: [[replacement, 'docs']] }
    ] }, f.end()])
    expect((await f.index.replay(f.root, 2)).reset).not.toBe(true)
    expect(f.paths()).toContain('C:\\📁项目\\docs\\报告.txt')
    expect(f.database.prepare('SELECT ref FROM search_ntfs_links WHERE name=?').get('📁项目')?.ref).toBe(replacement)
  })
  it('allows queries between deletion batches while keeping stable paths visible', async () => {
    const f = fixture(), removed = Array.from({ length: 600 }, (_, index) => String(28147497671066000n + BigInt(index)))
    removed.forEach((ref, index) => f.rows.push([ref, '5', `old-${index}.txt`, 32, 7, 1000, `C:\\old-${index}.txt`]))
    await f.index.prepare([f.root]); await f.index.snapshot(f.root, 1, f.state(), { cancelled: false })
    let observed: string[] = []
    f.observeJournal(() => setImmediate(() => { observed = f.paths() }))
    f.setJournal([{ type: 'changes', rows: removed.map(id => ({ id, deleted: true })) }, f.end()])
    expect((await f.index.replay(f.root, 2)).reset).not.toBe(true)
    expect(observed).toContain('C:\\📁项目\\docs\\报告.txt')
    expect(observed.filter(target => target.startsWith('C:\\old-')).length).toBeGreaterThan(0)
    expect(observed.filter(target => target.startsWith('C:\\old-')).length).toBeLessThan(600)
    expect(observed.some(target => target.includes('.disk-sense-index-'))).toBe(false)
    expect(f.paths()).toHaveLength(3)
  })
  it('updates descendant display paths after a case-only directory rename', async () => {
    const f = fixture(); await f.index.prepare([f.root]); await f.index.snapshot(f.root, 1, f.state(), { cancelled: false })
    f.setJournal([{ type: 'changes', rows: [{ id: f.child, attributes: 16, size: 0, modified: 3000, links: [[f.parent, 'Docs']] }] }, f.end()])
    expect((await f.index.replay(f.root, 2)).reset).not.toBe(true)
    expect(f.paths()).toContain('C:\\📁项目\\Docs\\报告.txt')
  })
  it('resolves a renamed grandchild through an unchanged intermediate directory', async () => {
    const f = fixture(), nested = '28147497671065604'
    f.rows.push([nested, f.child, 'nested', 16, 0, 1000, 'C:\\📁项目\\docs\\nested'],
      ['28147497671065605', nested, 'kept.txt', 32, 7, 1000, 'C:\\📁项目\\docs\\nested\\kept.txt'])
    await f.index.prepare([f.root]); await f.index.snapshot(f.root, 1, f.state(), { cancelled: false })
    f.setJournal([{ type: 'changes', rows: [
      { id: f.parent, attributes: 16, size: 0, modified: 3000, links: [['5', '新项目']] },
      { id: nested, attributes: 16, size: 0, modified: 3000, links: [[f.child, 'renamed']] }
    ] }, f.end()])
    expect((await f.index.replay(f.root, 2)).reset).not.toBe(true)
    expect(f.paths()).toContain('C:\\新项目\\docs\\renamed\\kept.txt')
    expect(f.paths().some((target: string) => target.includes('📁项目'))).toBe(false)
  })
  it('does not advance a cursor or apply records from an interrupted delta', async () => {
    const f = fixture(); await f.index.prepare([f.root]); await f.index.snapshot(f.root, 1, f.state(), { cancelled: false })
    f.setJournal([{ type: 'changes', rows: [{ id: f.file, deleted: true }] }])
    expect((await f.index.replay(f.root, 2)).reset).toBe(true)
    expect(f.paths()).toContain('C:\\📁项目\\docs\\报告.txt')
    expect(f.database.prepare('SELECT next_usn FROM search_ntfs_volumes').get()?.next_usn).toBe('100')
  })
  it('requests a snapshot when a journal is replaced or a parent identity is unavailable', async () => {
    const f = fixture(); await f.index.prepare([f.root]); await f.index.snapshot(f.root, 1, f.state(), { cancelled: false })
    f.setJournal([{ type: 'reset', reason: 'journal-discontinuity' }])
    expect((await f.index.replay(f.root, 2)).reset).toBe(true)
    f.setJournal([{ type: 'changes', rows: [{ id: f.file, attributes: 32, size: 1, modified: 5000, links: [['99999', 'report.txt']] }] }, f.end()])
    expect((await f.index.replay(f.root, 3)).reset).toBe(true)
    expect(f.database.prepare('SELECT next_usn FROM search_ntfs_volumes').get()?.next_usn).toBe('100')
  })
  it('preserves old rows and avoids stale pruning after an incomplete snapshot', async () => {
    const f = fixture(); await f.index.prepare([f.root])
    f.database.prepare('INSERT INTO search_files VALUES (?,?,?,?,?,?,?,?,?)').run('C:\\protected.txt', 'protected.txt', f.root, 'file', 0, 0, 10, 100, 0)
    f.setComplete(false)
    expect(await f.index.snapshot(f.root, 1, f.state(), { cancelled: false })).toBe(false)
    expect(f.finalized()).toBe(0)
    expect(f.paths()).toContain('C:\\protected.txt')
    expect(f.index.hasSnapshot(f.root)).toBe(false)
  })
  it('keeps the previous rows, link graph and cursor searchable throughout shadow collection', async () => {
    const f = fixture(); await f.index.prepare([f.root]); await f.index.snapshot(f.root, 1, f.state(), { cancelled: false })
    const previous = f.paths()
    const links = f.database.prepare('SELECT * FROM search_ntfs_links ORDER BY path').all()
    f.rows.splice(0, f.rows.length, [f.parent, '5', 'replacement', 16, 0, 4000, 'C:\\replacement'])
    f.observeSnapshot(() => {
      expect(f.paths()).toEqual(previous)
      expect(f.database.prepare('SELECT * FROM search_ntfs_links ORDER BY path').all()).toEqual(links)
      expect(f.index.hasSnapshot(f.root)).toBe(true)
      expect(f.database.prepare('SELECT next_usn FROM search_ntfs_volumes').get()?.next_usn).toBe('100')
    })
    expect(await f.index.snapshot(f.root, 2, f.state(), { cancelled: false })).toBe(true)
    expect(f.paths()).toEqual(['C:\\replacement'])
    expect(f.database.prepare('SELECT path FROM search_ntfs_links').all()).toEqual([{ path: 'C:\\replacement' }])
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM search_ntfs_snapshot_stage').get()?.count).toBe(0)
    expect(f.index.status().publication).toMatchObject({ root: f.root, entries: 1 })
  })
  it.each(['incomplete', 'cancelled', 'truncated', 'publication-failure'] as const)('preserves an existing complete graph after %s', async failure => {
    const f = fixture(failure === 'truncated' ? 3 : 1000); await f.index.prepare([f.root]); await f.index.snapshot(f.root, 1, f.state(), { cancelled: false })
    const previous = f.paths()
    const links = f.database.prepare('SELECT * FROM search_ntfs_links ORDER BY path').all()
    f.rows.push(['900', '5', 'new.txt', 32, 1, 5000, 'C:\\new.txt'])
    const signal = { cancelled: false }, state = f.state()
    if (failure === 'incomplete') f.setComplete(false)
    if (failure === 'cancelled') f.observeSnapshot(() => { signal.cancelled = true })
    if (failure === 'publication-failure') f.database.exec(`CREATE TRIGGER fail_publication BEFORE INSERT ON search_files
      WHEN NEW.name='new.txt' BEGIN SELECT RAISE(ABORT,'simulated disk write failure'); END;`)
    expect(await f.index.snapshot(f.root, 2, state, signal)).toBe(['cancelled', 'truncated'].includes(failure))
    expect(f.paths()).toEqual(previous)
    expect(f.database.prepare('SELECT * FROM search_ntfs_links ORDER BY path').all()).toEqual(links)
    expect(f.index.hasSnapshot(f.root)).toBe(true)
    expect(state.entries).toBe(0)
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM search_ntfs_snapshot_stage').get()?.count).toBe(0)
  })
  it('resumes durable deletion progress after shutdown without replaying the committed directory rename', async () => {
    const f = fixture(), removed = Array.from({ length: 600 }, (_, index) => String(10000 + index))
    removed.forEach((ref, index) => f.rows.push([ref, '5', `old-${index}.txt`, 32, 7, 1000, `C:\\old-${index}.txt`]))
    await f.index.prepare([f.root]); await f.index.snapshot(f.root, 1, f.state(), { cancelled: false })
    f.observeJournal(() => setImmediate(() => f.index.close()))
    f.setJournal([{ type: 'changes', rows: [
      { id: f.parent, attributes: 16, size: 0, modified: 3000, links: [['5', 'moved']] },
      ...removed.map(id => ({ id, deleted: true }))
    ] }, f.end()])
    expect(await f.index.replay(f.root, 2)).toMatchObject({ retry: true })
    expect(f.database.prepare('SELECT phase,position FROM search_ntfs_replays').get()).toEqual({ phase: 'deletions', position: 256 })
    expect(f.database.prepare('SELECT next_usn FROM search_ntfs_volumes').get()?.next_usn).toBe('100')
    await f.reopen()
    f.failJournal(new Error('A persisted plan must not request live metadata'))
    expect(await f.index.replay(f.root, 3)).toMatchObject({ used: true, changed: 601 })
    expect(f.journalRequests()).toBe(1)
    expect(f.paths()).toEqual(['C:\\moved', 'C:\\moved\\docs', 'C:\\moved\\docs\\报告.txt'])
    expect(f.database.prepare('SELECT next_usn FROM search_ntfs_volumes').get()?.next_usn).toBe('200')
    expect(f.index.status().pendingReplays).toEqual([])
  })
  it('rolls back a failed file batch with its checkpoint and resumes the immutable delta after restart', async () => {
    const f = fixture()
    const files = Array.from({ length: 300 }, (_, index) => ({ id: String(10000 + index), attributes: 32, size: index, modified: 4000,
      links: [[f.child, `new-${index}.txt`]] }))
    await f.index.prepare([f.root]); await f.index.snapshot(f.root, 1, f.state(), { cancelled: false })
    f.database.exec(`CREATE TRIGGER fail_file_batch BEFORE INSERT ON search_files WHEN NEW.name='new-270.txt'
      BEGIN SELECT RAISE(ABORT,'simulated disk full'); END;`)
    f.setJournal([{ type: 'changes', rows: files }, f.end()])
    expect(await f.index.replay(f.root, 2)).toMatchObject({ retry: true })
    expect(f.database.prepare('SELECT phase,position FROM search_ntfs_replays').get()).toEqual({ phase: 'files', position: 256 })
    expect(f.paths().filter(target => target.includes('new-'))).toHaveLength(256)
    expect(f.database.prepare('SELECT next_usn FROM search_ntfs_volumes').get()?.next_usn).toBe('100')
    f.database.exec('DROP TRIGGER fail_file_batch')
    await f.reopen()
    f.setJournal([{ type: 'changes', rows: [{ id: f.file, deleted: true }] }, f.end('300')])
    expect(await f.index.replay(f.root, 3)).toMatchObject({ changed: 300 })
    expect(f.journalRequests()).toBe(1)
    expect(f.paths()).toHaveLength(303)
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM search_ntfs_replay_changes').get()?.count).toBe(0)
    expect(f.database.prepare('SELECT next_usn FROM search_ntfs_volumes').get()?.next_usn).toBe('200')
  })
})
