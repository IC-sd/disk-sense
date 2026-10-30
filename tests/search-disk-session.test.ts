import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error CommonJS search engine.
import { createSearchEngine } from '../desktop/search-engine.cjs'
// @ts-expect-error CommonJS search aliases.
import { phoneticAliases } from '../desktop/search-query.cjs'

const databases: DatabaseSync[] = []
afterEach(() => { while (databases.length) databases.pop()?.close() })
function fixture() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  db.exec(`CREATE TABLE search_files(path TEXT PRIMARY KEY COLLATE NOCASE,name TEXT,root TEXT,kind TEXT,is_directory INTEGER,is_link INTEGER,size INTEGER,modified_at INTEGER);
    CREATE INDEX search_directory_names ON search_files(name,path) WHERE is_directory=1;
    CREATE TABLE search_phonetics(path TEXT,alias TEXT,initials TEXT);
    CREATE TABLE search_choices(query TEXT,file_id INTEGER,last_used INTEGER,uses INTEGER);
    CREATE VIRTUAL TABLE search_fts USING fts5(name,tokenize='trigram');`)
  const add = db.prepare('INSERT INTO search_files VALUES(?,?,?,?,?,0,?,?)')
  const alias = db.prepare('INSERT INTO search_phonetics VALUES(?,?,?)')
  for (let id = 1; id <= 120; id++) {
    const name = id % 9 === 0 ? 'VisualStudioCode.txt' : id % 7 === 0 ? '季度报告.txt'
      : id % 5 === 0 ? 'ResultTool.lnk' : `result-${id % 3 ? '中文' : '𐀀'}-${id}.txt`
    const file = path.resolve(`disk-fixture/${id}/${name}`)
    const directory = id % 11 === 0
    add.run(file, name, path.parse(file).root, directory ? 'folder' : name.endsWith('.lnk') ? 'application' : 'document', Number(directory), id % 11, id % 13)
    db.prepare('INSERT INTO search_fts(rowid,name) VALUES (?,?)').run(id, name)
    for (const value of phoneticAliases(name)) alias.run(file, value.alias, value.initials)
  }
  db.prepare('INSERT INTO search_choices VALUES(?,?,?,1)').run('result', 5, Date.now())
  const memory = createSearchEngine(db)
  const disk = createSearchEngine(db, { sessionMaxBytes: 1 })
  return { db, memory, disk }
}
function pages(engine: any, query: string, sort: string) {
  let result = engine.search({ query, sort, limit: 7 })
  const ids = result.rows.map((row: any) => row.id)
  while (result.nextOffset !== null) {
    result = engine.search({ query, sort, limit: 7, sessionId: result.sessionId, offset: result.nextOffset })
    ids.push(...result.rows.map((row: any) => row.id))
  }
  return { ids, total: result.total }
}
describe('disk-backed complete search sessions', () => {
  it('discards transient disk tables when a query is superseded before retention', () => {
    const { db } = fixture()
    const cancellation = new SharedArrayBuffer(4)
    const engine = createSearchEngine(db, { sessionMaxBytes: 1, cancellation,
      profile: (stage: string) => { if (stage === 'recall') Atomics.add(new Int32Array(cancellation), 0, 1) } })
    expect(() => engine.search({ query: 'result' })).toThrow('替代')
    expect(db.prepare("SELECT count(*) AS count FROM sqlite_temp_master WHERE type='table'").get()!.count).toBe(0)
  })
  it.each(['*', 'result', '*.txt', 'vsc', 'jdbg', 'baogao', 'result 中文'])(
    'preserves every ordered page and relevance deduplication for %s', query => {
      const { memory, disk } = fixture()
      for (const sort of ['relevance', 'name', 'size', 'modified']) expect(pages(disk, query, sort)).toEqual(pages(memory, query, sort))
      expect(disk.cacheStats().overBudget).toBe(false)
    })
  it('disposes evicted tables and all retained tables on close', () => {
    const { db, disk } = fixture()
    for (const query of ['*', 'result', '*.txt', 'vsc', 'baogao', '中文']) disk.search({ query })
    const tables = db.prepare("SELECT name FROM sqlite_temp_master WHERE type='table'").all()
    expect(tables.filter(row => /^disk_candidates_\d+$/.test(String(row.name)))).toHaveLength(4)
    disk.close()
    expect(db.prepare("SELECT count(*) AS count FROM sqlite_temp_master WHERE type='table'").get()!.count).toBe(0)
  })
  it('keeps early pages bounded and defers the complete sorting index until a deep page', () => {
    const { db, disk } = fixture()
    db.exec('BEGIN')
    for (let id = 121; id <= 2300; id++) {
      const name = `result-extra-${id}.txt`, file = path.resolve(`disk-fixture/${id}/${name}`)
      db.prepare('INSERT INTO search_files VALUES(?,?,?,?,0,0,?,?)').run(file, name, path.parse(file).root, 'document', id, id)
      db.prepare('INSERT INTO search_fts(rowid,name) VALUES(?,?)').run(id, name)
    }
    db.exec('COMMIT')
    const first = disk.search({ query: 'result', sort: 'name', limit: 5 })
    expect(db.prepare("SELECT count(*) AS count FROM sqlite_temp_master WHERE type='index' AND name LIKE '%_name_order'").get()!.count).toBe(0)
    const next = disk.search({ query: 'result', sort: 'name', limit: 5, sessionId: first.sessionId, offset: first.nextOffset })
    expect(next.rows).toHaveLength(5)
    expect(db.prepare("SELECT count(*) AS count FROM sqlite_temp_master WHERE type='index' AND name LIKE '%_name_order'").get()!.count).toBe(0)
    disk.search({ query: 'result', sort: 'name', limit: 5, sessionId: first.sessionId, offset: 2050 })
    expect(db.prepare("SELECT count(*) AS count FROM sqlite_temp_master WHERE type='index' AND name LIKE '%_name_order'").get()!.count).toBe(1)
    const again = disk.search({ query: 'result', sort: 'name', limit: 5, sessionId: first.sessionId })
    expect(again.rows.map((row: any) => row.id)).toEqual(first.rows.map((row: any) => row.id))
  })
})
