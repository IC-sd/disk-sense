import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error Desktop engine is CommonJS.
import { createSearchEngine } from '../desktop/search-engine.cjs'
// @ts-expect-error Desktop matching/indexing functions are CommonJS.
import { abbreviationTokens, phoneticAliases } from '../desktop/search-query.cjs'

const databases: DatabaseSync[] = []
afterEach(() => { while (databases.length) databases.pop()?.close() })

type Input = { query: string; sort?: string; scope?: string; root?: string; kind?: string; modified?: string; limit?: number }
type Added = { relative: string; name?: string; kind?: string; directory?: boolean; size?: number; modified?: number }

function fixture({ incrementalReuse, indexedWords = true }: { incrementalReuse: boolean; indexedWords?: boolean }) {
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
    CREATE TABLE search_metadata (key TEXT PRIMARY KEY,value TEXT);
    CREATE VIRTUAL TABLE search_fts USING fts5(name,tokenize='trigram');
    CREATE TRIGGER insert_fts AFTER INSERT ON search_files BEGIN
      INSERT INTO search_fts(rowid,name) VALUES (new.rowid,new.name);
    END;
    CREATE TRIGGER delete_fts AFTER DELETE ON search_files BEGIN
      DELETE FROM search_fts WHERE rowid=old.rowid;
      DELETE FROM search_phonetics WHERE path=old.path;
    END;
  `)
  if (indexedWords) database.exec(`
    CREATE VIRTUAL TABLE search_abbreviations USING fts5(grams,content='',contentless_delete=1,detail='none');
    INSERT INTO search_metadata VALUES ('wordIndex','{"version":3,"complete":true}');
    CREATE TRIGGER delete_words AFTER DELETE ON search_files BEGIN
      DELETE FROM search_abbreviations WHERE rowid=old.rowid;
    END;
  `)
  const root = path.resolve('input-reuse-fixture')
  let lastId = 0, revision = 0
  const stages: string[] = [], events: Array<{ stage: string; details?: { reused?: number; fetched?: number; count?: number } }> = []
  const addRow = database.prepare('INSERT INTO search_files(rowid,path,name,root,kind,is_directory,is_link,size,modified_at) VALUES (?,?,?,?,?,?,0,?,?)')
  const addPhonetic = database.prepare('INSERT INTO search_phonetics VALUES (?,?,?)')
  const addWord = indexedWords ? database.prepare('INSERT INTO search_abbreviations(rowid,grams) VALUES (?,?)') : null
  function add(item: Added) {
    const filename = path.join(root, item.relative), name = item.name ?? path.basename(item.relative)
    const id = ++lastId
    addRow.run(id, filename, name, root, item.kind ?? (item.directory ? 'folder' : 'document'), Number(Boolean(item.directory)), item.size ?? id * 3, item.modified ?? 1000 + id * 17)
    for (const alias of phoneticAliases(name)) addPhonetic.run(filename, alias.alias, alias.initials)
    addWord?.run(id, abbreviationTokens(name))
    return { id, filename }
  }
  for (const directory of ['Documents', 'Reports', 'Downloads', 'Applications-A', 'Applications-B', 'VisualStudioCode', '报告中心']) add({ relative: directory, directory: true })
  for (let index = 0; index < 29; index++) {
    const name = `report-${String(index).padStart(2, '0')}.txt`
    add({ relative: path.join(index % 2 ? 'Documents' : 'Downloads', name), modified: 5000 - index * 11, size: index % 7 })
  }
  for (const item of [
    { relative: 'Documents/quarterly-report.png', kind: 'image' },
    { relative: 'Reports/unrelated-child.txt' },
    { relative: 'VisualStudioCode/unrelated-source.rs', kind: 'code' },
    { relative: 'Documents/VisualStudioCode.txt' },
    { relative: 'Documents/Visual Studio Code.txt' },
    { relative: 'Documents/VersionSourceConfig.txt' },
    { relative: 'Documents/VisualStudioConsole.txt' },
    { relative: 'Downloads/visualstudiocode.txt' },
    { relative: 'Applications-A/VisualStudioCode.exe', kind: 'application', modified: 1000 },
    { relative: 'Applications-B/visualstudiocode.exe', kind: 'application', modified: 9000 },
    { relative: 'Applications-A/OneNote.exe', kind: 'application' },
    { relative: 'Applications-A/AwesomeCodeEditorguide.exe', kind: 'application', modified: 1000 },
    { relative: 'Applications-B/AwesomecodeEditorGuide.exe', kind: 'application', modified: 9000 },
    { relative: 'Documents/Kelvin.txt' },
    { relative: 'Documents/季度报告2026.txt' },
    { relative: 'Documents/重庆报告.txt' },
    { relative: 'Downloads/重庆报告.txt' },
    { relative: '报告中心/child-with-latin-name.txt' },
    { relative: 'Documents/📁报告.txt' },
    { relative: `Documents/${'a'.repeat(33)}.txt` },
    { relative: `Applications-A/${'a'.repeat(31)}-a-a.exe`, kind: 'application' }
  ]) add(item)
  const engine = createSearchEngine(database, {
    incrementalReuse, cacheMs: 60_000, revision: () => revision,
    profile: (stage: string, _duration: number, details?: { reused?: number; fetched?: number; count?: number }) => {
      stages.push(stage); events.push({ stage, details })
    }
  })
  return { database, engine, root, stages, events, add, changed: () => { revision++ } }
}

function collect(engine: any, input: Input) {
  const first = engine.search({ limit: 5, ...input })
  const rows = [...first.rows]
  let page = first
  let iterations = 0
  while (page.nextOffset !== null) {
    expect(++iterations).toBeLessThan(100)
    page = engine.search({ limit: 5, ...input, sessionId: first.sessionId, offset: page.nextOffset })
    expect(page.sessionId).toBe(first.sessionId)
    expect(page.total).toBe(first.total)
    rows.push(...page.rows)
  }
  expect(new Set(rows.map(row => row.path)).size).toBe(rows.length)
  return { total: first.total, rows: rows.map(row => ({ path: row.path, name: row.name, selectionReason: row.selectionReason })) }
}

function compareQuery(actual: any, reference: any, input: Input) {
  const result = collect(actual.engine, input)
  expect(result, JSON.stringify(input)).toEqual(collect(reference.engine, input))
  return result
}

describe('continuous input recall equivalence', () => {
  it.each([true, false])('preserves all pages when extending, deleting and changing modes (word index=%s)', indexedWords => {
    const actual = fixture({ incrementalReuse: true, indexedWords })
    const reference = fixture({ incrementalReuse: false, indexedWords })
    for (const query of ['re', 'rep', 'repo', 'repor', 'report', 'repor', 'rep', 'v', 'vs', 'vsc', 'vsco', 'vsc', 'Visual Studio', 'Documents report', 'Documents/re', 'report*', 'report ext:txt', 'report ext:png', 'folder:Rep', 'file:report']) {
      compareQuery(actual, reference, { query })
    }
    expect(compareQuery(actual, reference, { query: 'report' }).total).toBeGreaterThan(25)
  })

  it('preserves independent directory descendants and physical application entries across sort views', () => {
    const actual = fixture({ incrementalReuse: true })
    const reference = fixture({ incrementalReuse: false })
    for (const query of ['Vi', 'Vis', 'Visu', 'Visual', 'vs', 'vsc']) {
      for (const sort of ['relevance', 'name', 'modified', 'size']) compareQuery(actual, reference, { query, sort })
    }
    const descendant = compareQuery(actual, reference, { query: 'Visual' })
    expect(descendant.rows.some((row: any) => row.name === 'unrelated-source.rs')).toBe(true)
    const relevant = compareQuery(actual, reference, { query: 'vsc', sort: 'relevance' })
    const physical = compareQuery(actual, reference, { query: 'vsc', sort: 'name' })
    expect(physical.total).toBeGreaterThan(relevant.total)
  })

  it('retains pinyin, polyphonic, Unicode and trailing-space precision semantics', () => {
    const actual = fixture({ incrementalReuse: true })
    const reference = fixture({ incrementalReuse: false })
    for (const query of ['b', 'ba', 'bao', 'baog', 'baogao', 'baogao ', 'ba', 'ba ', 'c', 'ch', 'cho', 'chong', 'chongqing', 'cq', 'cqbg', 'zh', 'zhong', 'zhongqing', '报告', '报告2']) compareQuery(actual, reference, { query })
    expect(compareQuery(actual, reference, { query: 'baogao' }).rows.some((row: any) => row.name === '季度报告2026.txt')).toBe(true)
    expect(compareQuery(actual, reference, { query: 'chongqing' }).total).toBeGreaterThan(0)
  })

  it('does not lose the query-length transition between fuzzy and keyword recall', () => {
    const actual = fixture({ incrementalReuse: true })
    const reference = fixture({ incrementalReuse: false })
    const totals: number[] = []
    for (const length of [30, 31, 32, 33, 32]) totals.push(compareQuery(actual, reference, { query: 'a'.repeat(length) }).total)
    expect(totals[2]).toBeGreaterThan(totals[3]!)
  })

  it('restarts matching when directory context, scope or filters change', () => {
    const actual = fixture({ incrementalReuse: true })
    const reference = fixture({ incrementalReuse: false })
    const changes: Input[] = [
      { query: 're', scope: 'all', root: actual.root },
      { query: 'rep', scope: 'directory', root: path.join(actual.root, 'Documents') },
      { query: 'repo', scope: 'directory', root: path.join(actual.root, 'Downloads') },
      { query: 'report', scope: 'all', root: actual.root, kind: 'image' },
      { query: 'report', scope: 'all', root: path.join(actual.root, 'Reports'), kind: 'all' },
      { query: 'report', scope: 'all', root: actual.root, modified: 'day' }
    ]
    for (const input of changes) compareQuery(actual, reference, input)
  })

  it('includes new and changed identities after the index revision changes', () => {
    const actual = fixture({ incrementalReuse: true })
    const reference = fixture({ incrementalReuse: false })
    compareQuery(actual, reference, { query: 're' })
    for (const target of [actual, reference]) {
      target.add({ relative: 'Reports/report-new-arrival.txt', modified: 50000 })
      target.database.prepare('DELETE FROM search_files WHERE name=?').run('report-00.txt')
      target.changed()
    }
    const result = compareQuery(actual, reference, { query: 'rep' })
    expect(result.rows.some((row: any) => row.name === 'report-new-arrival.txt')).toBe(true)
    expect(result.rows.some((row: any) => row.name === 'report-00.txt')).toBe(false)
    compareQuery(actual, reference, { query: 'repo' })
  })

  it('reuses candidate columns on stable revisions while reevaluating the complete new query', () => {
    const actual = fixture({ incrementalReuse: true })
    const reference = fixture({ incrementalReuse: false })
    compareQuery(actual, reference, { query: 're' })
    const eventStart = actual.events.length
    compareQuery(actual, reference, { query: 'rep' })
    const reused = actual.events.slice(eventStart).filter(event => event.stage === 'reuse')
    expect(reused.length).toBeGreaterThan(0)
    expect(reused.reduce((sum, event) => sum + (event.details?.reused ?? 0), 0)).toBeGreaterThan(0)
    expect(reference.events.some(event => event.stage === 'reuse')).toBe(false)
    const contextStart = actual.events.length
    compareQuery(actual, reference, { query: 'repo', root: path.join(actual.root, 'Documents'), scope: 'directory' })
    expect(actual.events.slice(contextStart).some(event => event.stage === 'reuse')).toBe(false)
    actual.changed(); reference.changed()
    const revisionStart = actual.events.length
    compareQuery(actual, reference, { query: 'repor', root: path.join(actual.root, 'Documents'), scope: 'directory' })
    expect(actual.events.slice(revisionStart).some(event => event.stage === 'reuse')).toBe(false)
  })

  it('does not reuse only the prior deduplicated application winner', () => {
    const actual = fixture({ incrementalReuse: true })
    const reference = fixture({ incrementalReuse: false })
    const initial = compareQuery(actual, reference, { query: 'ace' })
    const initialWinner = initial.rows.find((row: any) => row.name.toLowerCase() === 'awesomecodeeditorguide.exe')
    expect(initialWinner?.name).toBe('AwesomeCodeEditorguide.exe')
    const changed = compareQuery(actual, reference, { query: 'aceg' })
    const nextWinner = changed.rows.find((row: any) => row.name.toLowerCase() === 'awesomecodeeditorguide.exe')
    expect(nextWinner?.name).toBe('AwesomecodeEditorGuide.exe')
  })

  it('still recalls identities newly admitted by the LIKE-to-trigram transition', () => {
    const actual = fixture({ incrementalReuse: true })
    const reference = fixture({ incrementalReuse: false })
    const before = compareQuery(actual, reference, { query: 'ke' })
    const eventStart = actual.events.length
    const after = compareQuery(actual, reference, { query: 'kel' })
    expect(before.rows.some((row: any) => row.name === 'Kelvin.txt')).toBe(false)
    expect(after.rows.some((row: any) => row.name === 'Kelvin.txt')).toBe(true)
    expect(actual.events.slice(eventStart).some(event => event.stage === 'fetch' && (event.details?.count ?? 0) > 0)).toBe(true)
  })
})
