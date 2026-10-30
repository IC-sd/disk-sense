import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error Desktop engine is CommonJS.
import { createSearchEngine } from '../desktop/search-engine.cjs'

const databases: DatabaseSync[] = [], directories: string[] = []
afterEach(() => {
  while (databases.length) databases.pop()?.close()
  while (directories.length) fs.rmSync(directories.pop()!, { recursive: true, force: true })
})

function fixture(options: { race?: boolean; sessionMaxBytes?: number; readOnlySource?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-input-version-'))
  directories.push(root)
  const filename = path.join(root, 'index.sqlite'), database = new DatabaseSync(filename)
  databases.push(database)
  database.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE search_files (path TEXT PRIMARY KEY COLLATE NOCASE,name TEXT,root TEXT,kind TEXT,
      is_directory INTEGER,is_link INTEGER,size INTEGER,modified_at INTEGER);
    CREATE INDEX search_files_name ON search_files(name);
    CREATE INDEX search_directory_names ON search_files(name,path) WHERE is_directory=1;
    CREATE TABLE search_phonetics(path TEXT,alias TEXT,initials TEXT);
    CREATE VIRTUAL TABLE search_fts USING fts5(name,tokenize='trigram');
    CREATE TRIGGER insert_fts AFTER INSERT ON search_files BEGIN
      INSERT INTO search_fts(rowid,name) VALUES (new.rowid,new.name);
    END;`)
  const insert = database.prepare('INSERT INTO search_files(rowid,path,name,root,kind,is_directory,is_link,size,modified_at) VALUES (?,?,?,?,?,0,0,?,?)')
  for (let id = 1; id <= 8; id++) insert.run(id, path.join(root, `result-${id}.txt`), `result-${id}.txt`, root, 'document', id, id)
  const writer = new DatabaseSync(filename)
  databases.push(writer)
  let race = false
  const proxy = new Proxy(database, { get(target, key) {
    if (key === 'exec') return (sql: string) => {
      if (race && sql === 'SAVEPOINT disk_search_recall') {
        race = false
        writer.exec('UPDATE search_files SET size=999 WHERE rowid=1')
      }
      return target.exec(sql)
    }
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const events: Array<{ stage: string; details: any }> = []
  const reader = options.readOnlySource ? new DatabaseSync(filename, { readOnly: true }) : database
  if (reader !== database) databases.push(reader)
  const engine = createSearchEngine(options.race ? proxy : reader, {
    cacheMs: 60_000, sessionMaxBytes: options.sessionMaxBytes,
    readOnlySource: options.readOnlySource,
    profile(stage: string, _ms: number, details: any) { events.push({ stage, details }) }
  })
  return { database, writer, engine, events, armRace: () => { race = true } }
}

describe('candidate data versioning', () => {
  it('reuses a read-only disk session despite its temp writes and invalidates it after a source commit', () => {
    const { engine, writer } = fixture({ sessionMaxBytes: 1, readOnlySource: true })
    const first = engine.search({ query: 'result', sort: 'size', limit: 2 })
    engine.search({ query: 'result', sort: 'size', sessionId: first.sessionId, offset: first.nextOffset })
    const repeated = engine.search({ query: 'result', sort: 'size', limit: 2 })
    expect(repeated.sessionId).toBe(first.sessionId)
    expect(repeated.diagnostics.stages.recall).toBeUndefined()
    writer.exec('UPDATE search_files SET size=999 WHERE rowid=1')
    const refreshed = engine.search({ query: 'result', sort: 'size' })
    expect(refreshed.sessionId).not.toBe(first.sessionId)
    expect(refreshed.rows[0].id).toBe(1)
  })
  it('invalidates both exact-query and candidate-data caches after another connection commits', () => {
    const { writer, engine, events } = fixture()
    const first = engine.search({ query: 'res', sort: 'size' })
    expect(first.rows[0].id).toBe(8)
    writer.exec('UPDATE search_files SET size=999 WHERE rowid=1')
    const eventStart = events.length
    const sameQuery = engine.search({ query: 'res', sort: 'size' })
    expect(sameQuery.sessionId).not.toBe(first.sessionId)
    expect(sameQuery.rows[0].id).toBe(1)
    const refined = engine.search({ query: 'resu', sort: 'size' })
    expect(refined.rows[0].id).toBe(1)
    expect(events.slice(eventStart).find(event => event.stage === 'fetch')?.details.count).toBe(8)
  })

  it('detects same-connection mutations even without an application revision callback', () => {
    const { database, engine, events } = fixture()
    engine.search({ query: 'res', sort: 'size' })
    database.exec('UPDATE search_files SET size=999 WHERE rowid=1')
    const eventStart = events.length
    const refined = engine.search({ query: 'resu', sort: 'size' })
    expect(refined.rows[0].id).toBe(1)
    expect(events.slice(eventStart).some(event => event.stage === 'reuse')).toBe(false)
    expect(events.slice(eventStart).find(event => event.stage === 'fetch')?.details.count).toBe(8)
  })

  it('retries without cached columns if a writer commits between checking and opening the snapshot', () => {
    const { engine, armRace, events } = fixture({ race: true })
    engine.search({ query: 'res', sort: 'size' })
    armRace()
    const eventStart = events.length
    const refined = engine.search({ query: 'resu', sort: 'size' })
    expect(refined.rows[0].id).toBe(1)
    expect(refined.rows[0].size).toBe(999)
    expect(events.slice(eventStart).some(event => event.stage === 'reuse')).toBe(false)
    expect(events.slice(eventStart).find(event => event.stage === 'fetch')?.details.count).toBe(8)
    expect(engine.search({ query: 'result', sort: 'size' }).rows[0].id).toBe(1)
  })

  it('continues every page of an oversized active query and retains only its current sort under pressure', () => {
    const { engine } = fixture({ sessionMaxBytes: 1 })
    const first = engine.search({ query: 'result', sort: 'name', limit: 2 })
    const ids = first.rows.map((row: any) => row.id)
    let page = first
    while (page.nextOffset !== null) {
      page = engine.search({ query: 'result', sort: 'name', limit: 2, sessionId: first.sessionId, offset: page.nextOffset })
      expect(page.sessionId).toBe(first.sessionId)
      ids.push(...page.rows.map((row: any) => row.id))
    }
    expect(new Set(ids).size).toBe(8)
    expect(first.diagnostics.counts.storage.mode).toBe('disk')
    expect(engine.cacheStats()).toMatchObject({ size: 1, overBudget: false, oversizedPinned: false })
    const reordered = engine.search({ query: 'result', sort: 'size', sessionId: first.sessionId })
    expect(reordered.total).toBe(8)
    expect(reordered.rows[0].id).toBe(8)
    const restored = engine.search({ query: 'result', sort: 'name', sessionId: first.sessionId })
    expect(restored.rows.map((row: any) => row.id)).toEqual(ids)
  })

  it('never reuses uncommitted candidate data after rollback or in a later caller transaction', () => {
    const { database, engine, events } = fixture()
    database.exec('BEGIN; UPDATE search_files SET size=999 WHERE rowid=1')
    expect(engine.search({ query: 'res', sort: 'size' }).rows[0].id).toBe(1)
    database.exec('ROLLBACK; BEGIN')
    const eventStart = events.length
    expect(engine.search({ query: 'resu', sort: 'size' }).rows[0].id).toBe(8)
    expect(events.slice(eventStart).some(event => event.stage === 'reuse')).toBe(false)
    database.exec('ROLLBACK')
    expect(engine.search({ query: 'res', sort: 'size' }).rows[0].id).toBe(8)
  })
})
