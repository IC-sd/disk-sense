import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error Desktop search service is CommonJS.
import { createFileSearchService } from '../desktop/file-search.cjs'
// @ts-expect-error Desktop search engine is CommonJS.
import { createSearchEngine } from '../desktop/search-engine.cjs'

const directories: string[] = []
const services: Array<{ close: () => Promise<void> }> = []
const databases: DatabaseSync[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  while (services.length) await services.pop()?.close()
  while (databases.length) databases.pop()?.close()
  while (directories.length) {
    const directory = directories.pop()
    if (directory) fs.rmSync(directory, { recursive: true, force: true })
  }
})

async function fileFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-sessions-'))
  directories.push(root)
  const files = [
    ['result-alpha.txt', 3, 3000],
    ['result-bravo.txt', 9, 1000],
    ['result-charlie.txt', 6, 2000],
    [path.join('Nested', 'result-delta.png'), 12, 4000],
    [path.join('Programs-A', 'ResultTool.lnk'), 1, 5000],
    [path.join('Programs-B', 'ResultTool.lnk'), 2, 6000]
  ] as const
  for (const [relative, size, timestamp] of files) {
    const filename = path.join(root, relative)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, Buffer.alloc(size))
    fs.utimesSync(filename, new Date(timestamp), new Date(timestamp))
  }
  const service = createFileSearchService({
    databasePath: path.join(root, '.state', 'search.sqlite'),
    nativeEnumeration: false,
    getVolumeRoots: async () => [root],
    searchCacheMs: 0
  })
  services.push(service)
  await service.rebuild({ roots: [root] })
  await service.waitForIdle()
  await service.waitForQueryIndex()
  return { service, root }
}

function sqliteFixture(options: { cancellation?: SharedArrayBuffer; profile?: (stage: string, duration: number) => void } = {}) {
  const database = new DatabaseSync(':memory:')
  databases.push(database)
  database.exec(`
    CREATE TABLE search_files (
      path TEXT PRIMARY KEY COLLATE NOCASE, name TEXT NOT NULL COLLATE NOCASE,
      root TEXT NOT NULL COLLATE NOCASE, kind TEXT NOT NULL,
      is_directory INTEGER NOT NULL, is_link INTEGER NOT NULL,
      size INTEGER NOT NULL, modified_at INTEGER NOT NULL
    );
    CREATE INDEX search_files_name ON search_files(name);
    CREATE INDEX search_directory_names ON search_files(name,path) WHERE is_directory=1;
    CREATE TABLE search_phonetics (path TEXT,alias TEXT,initials TEXT);
    CREATE VIRTUAL TABLE search_fts USING fts5(name,tokenize='trigram');
    CREATE TRIGGER insert_fts AFTER INSERT ON search_files BEGIN
      INSERT INTO search_fts(rowid,name) VALUES (new.rowid,new.name);
    END;
    CREATE TRIGGER delete_fts AFTER DELETE ON search_files BEGIN
      DELETE FROM search_fts WHERE rowid=old.rowid;
    END;
  `)
  const root = path.resolve('session-fixture')
  const insert = database.prepare('INSERT INTO search_files(rowid,path,name,root,kind,is_directory,is_link,size,modified_at) VALUES (?,?,?,?,?,0,0,?,?)')
  function add(id: number, name: string, size: number, modified: number) {
    const filename = path.join(root, name)
    insert.run(id, filename, name, root, 'document', size, modified)
    return filename
  }
  add(1, 'result-alpha.txt', 3, 1000)
  add(2, 'result-bravo.txt', 9, 3000)
  add(3, 'result-charlie.txt', 6, 2000)
  add(4, 'result-delta.txt', 12, 4000)
  let revision = 0
  const materialize: number[] = []
  const engine = createSearchEngine(database, {
    cacheMs: 0,
    cancellation: options.cancellation,
    revision: () => revision,
    profile: (stage: string, duration: number) => {
      if (stage === 'materialize') materialize.push(duration)
      options.profile?.(stage, duration)
    }
  })
  return { database, engine, add, materialize, changed: () => { revision++ } }
}

describe('search candidate sessions and sorted views', () => {
  it('prepares repeated wide-fetch batches once and keeps complete deterministic pagination with stage diagnostics', () => {
    const f = sqliteFixture()
    for (let id = 5; id <= 1604; id++) f.add(id, `result-${String(id).padStart(5, '0')}.txt`, id, id)
    const prepare = vi.spyOn(f.database, 'prepare')
    const first = f.engine.search({ query: 'result', sort: 'name', limit: 500 })
    expect(first.total).toBe(1604)
    expect(first.diagnostics).toMatchObject({ candidates: 1604, returned: 500, reusedSession: false,
      counts: { recall: { candidates: 1604 }, fetch: { count: 1604 }, sort: { count: 1604 } } })
    for (const stage of ['recall', 'fetch', 'columns', 'sort', 'page']) expect(first.diagnostics.stages[stage]).toBeGreaterThanOrEqual(0)
    expect(first.diagnostics.stages.score).toBeUndefined()
    const candidatePrepares = prepare.mock.calls.filter(([sql]) => sql.includes('file.name, file.kind') && /WHERE file.rowid IN \(\?(?:,\?)*\)$/.test(sql))
    expect(candidatePrepares).toHaveLength(2) // full 500-ID batches plus the last 104 IDs
    const paths = first.rows.map((row: { path: string }) => row.path)
    let page = first
    while (page.nextOffset !== null) {
      page = f.engine.search({ query: 'result', sort: 'name', limit: 500, sessionId: first.sessionId, offset: page.nextOffset })
      expect(page.diagnostics.reusedSession).toBe(true)
      expect(page.diagnostics.stages.recall).toBeUndefined()
      paths.push(...page.rows.map((row: { path: string }) => row.path))
    }
    expect(new Set(paths).size).toBe(1604)
    expect(paths).toEqual([...paths].sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0))
    const relevance = f.engine.search({ query: 'result', sort: 'relevance', limit: 10, sessionId: first.sessionId })
    expect(relevance.diagnostics.reusedSession).toBe(true)
    expect(relevance.diagnostics.counts.score).toMatchObject({ count: 1604 })
    expect(relevance.diagnostics.stages.score).toBeGreaterThanOrEqual(0)
  })
  it('keeps one candidate session across sorts while reporting each view\'s accurate total', async () => {
    const { service } = await fileFixture()
    const input = { query: 'result', limit: 2 }
    const relevance = service.search(input)
    expect(relevance.total).toBe(5)
    expect(relevance.sessionId).toBeTruthy()
    for (const sort of ['name', 'modified', 'size']) {
      const first = service.search({ ...input, sort, sessionId: relevance.sessionId })
      expect(first.sessionId).toBe(relevance.sessionId)
      expect(first.total).toBe(6)
      const paths = first.items.map((item: any) => item.path)
      let page = first
      while (page.nextOffset !== null) {
        page = service.search({ ...input, sort, sessionId: first.sessionId, offset: page.nextOffset })
        expect(page.sessionId).toBe(first.sessionId)
        expect(page.total).toBe(6)
        paths.push(...page.items.map((item: any) => item.path))
      }
      expect(paths).toHaveLength(6)
      expect(new Set(paths).size).toBe(6)
      expect(paths.filter((filename: string) => path.basename(filename) === 'ResultTool.lnk')).toHaveLength(2)
    }
    const restored = service.search({ ...input, sort: 'relevance', sessionId: relevance.sessionId })
    expect(restored.sessionId).toBe(relevance.sessionId)
    expect(restored.total).toBe(5)
    expect(restored.items.map((item: any) => item.path)).toEqual(relevance.items.map((item: any) => item.path))
  })

  it.each([
    ['name', ['result-alpha.txt', 'result-bravo.txt', 'result-charlie.txt']],
    ['modified', ['result-alpha.txt', 'result-charlie.txt', 'result-bravo.txt']],
    ['size', ['result-bravo.txt', 'result-charlie.txt', 'result-alpha.txt']]
  ])('paginates the complete %s view in its requested order', async (sort, expected) => {
    const { service } = await fileFixture()
    const input = { query: 'result', kind: 'document', sort, limit: 1 }
    const first = service.search(input)
    expect(first.total).toBe(3)
    const names = first.items.map((item: any) => item.name)
    let page = first
    while (page.nextOffset !== null) {
      page = service.search({ ...input, sessionId: first.sessionId, offset: page.nextOffset })
      expect(page.sessionId).toBe(first.sessionId)
      names.push(...page.items.map((item: any) => item.name))
    }
    expect(names).toEqual(expected)
  })

  it('starts a new session when the query, filters or directory context change', async () => {
    const { service, root } = await fileFixture()
    const input = { query: 'result', scope: 'all', root, kind: 'all', modified: 'any', limit: 2 }
    const changes = [
      { query: 'result-alpha' },
      { kind: 'document' },
      { modified: 'day' },
      { scope: 'directory', root: path.join(root, 'Nested') },
      { root: path.join(root, 'Nested') }
    ]
    for (const change of changes) {
      const first = service.search(input)
      const changed = service.search({ ...input, ...change, sessionId: first.sessionId, offset: 99 })
      expect(changed.sessionId).not.toBe(first.sessionId)
      expect(changed.offset).toBe(0)
    }
  })

  it('reuses recalled candidates when changing the sort or returning to a previously read view', () => {
    const { engine, materialize } = sqliteFixture()
    const first = engine.search({ query: 'result', sort: 'relevance', limit: 2 })
    expect(materialize).toHaveLength(1)
    for (const sort of ['name', 'modified', 'size', 'relevance', 'name']) {
      const sorted = engine.search({ query: 'result', sort, sessionId: first.sessionId, limit: 2 })
      expect(sorted.sessionId).toBe(first.sessionId)
      expect(sorted.total).toBe(4)
      expect(materialize).toHaveLength(1)
      const next = engine.search({ query: 'result', sort, sessionId: first.sessionId, limit: 2, offset: sorted.nextOffset })
      expect(next.sessionId).toBe(first.sessionId)
      expect([...sorted.rows, ...next.rows]).toHaveLength(4)
      expect(new Set([...sorted.rows, ...next.rows].map((row: any) => row.path)).size).toBe(4)
      expect(materialize).toHaveLength(1)
    }
  })

  it('does not expose deleted members or recycled rowids through an older session', () => {
    const { database, engine, add, changed, materialize } = sqliteFixture()
    const input = { query: 'result', sort: 'name', limit: 1 }
    const first = engine.search(input)
    expect(first.rows.map((row: any) => row.name)).toEqual(['result-alpha.txt'])
    database.exec('DELETE FROM search_files WHERE rowid IN (2,3)')
    const replacement = add(2, 'result-replacement.txt', 99, 6000)
    const created = add(5, 'result-new.txt', 100, 7000)
    changed()
    const continuation = engine.search({ ...input, sessionId: first.sessionId, offset: first.nextOffset, limit: 10 })
    expect(continuation.sessionId).toBe(first.sessionId)
    expect(continuation.total).toBe(4)
    expect(continuation.rows.map((row: any) => row.name)).toEqual(['result-delta.txt'])
    expect(continuation.nextOffset).toBe(null)
    const oldSorted = engine.search({ ...input, sort: 'size', sessionId: first.sessionId, limit: 10 })
    expect(oldSorted.sessionId).toBe(first.sessionId)
    expect(oldSorted.rows.map((row: any) => row.name)).toEqual(['result-delta.txt', 'result-alpha.txt'])
    expect(materialize).toHaveLength(1)
    const fresh = engine.search({ ...input, limit: 10 })
    expect(fresh.sessionId).not.toBe(first.sessionId)
    expect(fresh.total).toBe(4)
    expect(fresh.rows.map((row: any) => row.path)).toEqual(expect.arrayContaining([replacement, created]))
    expect(fresh.rows.map((row: any) => row.name)).not.toContain('result-bravo.txt')
    expect(fresh.rows.map((row: any) => row.name)).not.toContain('result-charlie.txt')
    expect(materialize).toHaveLength(2)
  })

  it('rebuilds a cancelled sorted view from the same candidates without recalling again', () => {
    const cancellation = new SharedArrayBuffer(4), version = new Int32Array(cancellation)
    let cancel = false
    const { engine, materialize } = sqliteFixture({ cancellation, profile(stage) {
      if (cancel && stage === 'deduplicate') Atomics.add(version, 0, 1)
    } })
    const input = { query: 'result', sort: 'name', limit: 2 }
    const first = engine.search(input)
    cancel = true
    expect(() => engine.search({ ...input, sort: 'size', sessionId: first.sessionId })).toThrow(expect.objectContaining({ code: 'SEARCH_SUPERSEDED' }))
    cancel = false
    const resumed = engine.search({ ...input, sort: 'size', sessionId: first.sessionId })
    expect(resumed.sessionId).toBe(first.sessionId)
    expect(resumed.rows.map((row: any) => row.name)).toEqual(['result-delta.txt', 'result-bravo.txt'])
    const next = engine.search({ ...input, sort: 'size', sessionId: first.sessionId, offset: resumed.nextOffset })
    expect(next.rows.map((row: any) => row.name)).toEqual(['result-charlie.txt', 'result-alpha.txt'])
    expect(materialize).toHaveLength(1)
  })

  it('retains raw camel boundaries when choosing among same-title application entries', () => {
    const { database, engine } = sqliteFixture()
    const root = path.resolve('session-fixture')
    const insert = database.prepare('INSERT INTO search_files(rowid,path,name,root,kind,is_directory,is_link,size,modified_at) VALUES (?,?,?,?,?,0,0,0,?)')
    insert.run(10, path.join(root, 'A', 'VisualStudioCode.exe'), 'VisualStudioCode.exe', root, 'application', 1000)
    insert.run(11, path.join(root, 'B', 'visualstudiocode.exe'), 'visualstudiocode.exe', root, 'application', 9000)
    const result = engine.search({ query: 'vsc', sort: 'relevance' })
    expect(result.total).toBe(1)
    expect(result.rows[0].name).toBe('VisualStudioCode.exe')
    const physical = engine.search({ query: 'vsc', sort: 'modified', sessionId: result.sessionId })
    expect(physical.total).toBe(2)
    expect(physical.rows.map((row: any) => row.name)).toEqual(['visualstudiocode.exe', 'VisualStudioCode.exe'])
  })
})
