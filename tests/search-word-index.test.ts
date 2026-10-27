import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Desktop index is CommonJS.
import { createWordIndex } from '../desktop/search-word-index.cjs'
// @ts-expect-error Desktop matcher is CommonJS.
import { abbreviationQuery } from '../desktop/search-query.cjs'

const databases: DatabaseSync[] = []
afterEach(() => { while (databases.length) databases.pop()?.close() })
function fixture(count: number) {
  const database = new DatabaseSync(':memory:'); databases.push(database)
  database.exec('CREATE TABLE search_files(name TEXT);CREATE TABLE search_metadata(key TEXT PRIMARY KEY,value TEXT);')
  const insert = database.prepare('INSERT INTO search_files VALUES (?)')
  for (let index = 0; index < count; index++) insert.run(`VisualStudioCode${index}.txt`)
  return database
}

describe('resumable word abbreviation index', () => {
  it('continues an interrupted backfill and keeps contentless postings consistent after replacement and deletion', async () => {
    const database = fixture(2001)
    let stop = false
    const first = createWordIndex(database, { shouldStop: () => stop })
    const task = first.start()
    setImmediate(() => { stop = true })
    await task
    const saved = JSON.parse(String(database.prepare("SELECT value FROM search_metadata WHERE key='wordIndex'").get()?.value))
    expect(saved).toMatchObject({ cursor: 1000, complete: false })
    const next = createWordIndex(database)
    await next.start()
    expect(next.ready()).toBe(true)
    const found = () => database.prepare('SELECT rowid FROM search_abbreviations WHERE search_abbreviations MATCH ?').all(abbreviationQuery('vsc'))
    expect(found()).toHaveLength(2001)
    database.prepare('UPDATE search_files SET name=? WHERE rowid=1').run('AlphaBetaReport.txt')
    next.index(1, 'AlphaBetaReport.txt')
    expect(found()).toHaveLength(2000)
    database.prepare('DELETE FROM search_files WHERE rowid=2').run()
    expect(found()).toHaveLength(1999)
  })
  it('does not mark an auxiliary index complete when a transaction fails', async () => {
    const database = fixture(1)
    const index = createWordIndex(database)
    database.exec("CREATE TRIGGER fail_word_checkpoint BEFORE INSERT ON search_metadata BEGIN SELECT RAISE(ABORT,'owned failure'); END;")
    await expect(index.start()).rejects.toThrow('owned failure')
    expect(index.ready()).toBe(false)
    expect(database.prepare("SELECT value FROM search_metadata WHERE key='wordIndex'").get()).toBeUndefined()
  })
})
