import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error CommonJS bounded Top-K.
import { topPage } from '../desktop/search-top-page.cjs'
// @ts-expect-error CommonJS reference candidate ordering.
import { createCandidateSet, createCandidateView } from '../desktop/search-candidate-session.cjs'
// @ts-expect-error CommonJS matching.
import { matchName } from '../desktop/search-query.cjs'
// @ts-expect-error CommonJS ranking location rules.
import { locationScore } from '../desktop/search-disk-session.cjs'
// @ts-expect-error CommonJS integration engine.
import { createSearchEngine } from '../desktop/search-engine.cjs'

type Row = { id: number; path: string; name: string; kind: string; is_directory: number; size: number; modified_at: number }
type Choice = { exact: boolean; last_used: number }
type Sort = 'relevance' | 'name' | 'size' | 'modified'
const sorts: Sort[] = ['relevance', 'name', 'size', 'modified']
const root = path.resolve('top-page-fixture')
function row(id: number, name: string, modified = 0, size = 0, directory = false): Row {
  return { id, path: path.join(root, String(id).padStart(5, '0'), name), name,
    kind: directory ? 'folder' : /\.(?:exe|lnk|url|appref-ms)$/i.test(name) ? 'application' : 'document',
    is_directory: Number(directory), size, modified_at: modified }
}
function options(term: string, choices = new Map<number, Choice>(), assertActive = () => {}) {
  return { term, choices, context: root, partial: 1, assertActive, locationScore,
    matchScore: (name: string, query: string, partial: number) => matchName(name, query, { allowPartial: Boolean(partial), scoreOnly: true })?.score ?? 10000 }
}
function reference(rows: Row[], limit: number, sort: Sort, config: ReturnType<typeof options>) {
  const candidates = createCandidateSet(new Map(rows.map(value => [value.id, value])), config)
  const view = createCandidateView(candidates, sort, config)
  return Array.from(view.range(0, Math.min(limit, view.total)), (ordinal: any) => ({
    id: candidates.ids[ordinal], recent: view.recent?.[ordinal] || 0
  }))
}
function bounded(rows: Iterable<Row>, limit: number, sort: Sort, config: ReturnType<typeof options>) {
  function* source() {
    for (const value of rows) yield { id: value.id, path: value.path, name: value.name, size: value.size,
      modified: value.modified_at, application: Number(value.kind === 'application'), directory: value.is_directory }
  }
  return topPage(source(), limit, sort, config).map((value: any) => ({ id: value.id, recent: value.recent }))
}
function random(seed: number) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 0x100000000 }
}

describe('exact bounded first-page ranking', () => {
  it('handles launch titles leaving/reentering the heap and improves a retained title in place', () => {
    const rows = [row(1, 'ToolA.lnk', 10), row(2, 'ToolB.exe', 20), row(3, 'ToolC.url', 30),
      row(4, 'ToolA.exe', 0), row(5, 'ToolA.appref-ms', 40), row(6, 'ToolB.lnk', 50), row(7, 'ToolA.url', 60)]
    const config = options('tool')
    expect(bounded(rows, 2, 'relevance', config).map((value: any) => value.id)).toEqual([7, 6])
    for (const limit of [1, 2, 3, 10]) expect(bounded(rows, limit, 'relevance', config)).toEqual(reference(rows, limit, 'relevance', config))
    const history = options('tool', new Map([[1, { exact: true, last_used: 50 }], [3, { exact: false, last_used: 40 }]]))
    expect(bounded(rows, 2, 'relevance', history)).toEqual(reference(rows, 2, 'relevance', history))
  })

  it.each([1, 17, 10831, 71959])('matches full reference ordering for fixed-seed mixed input %s', seed => {
    const next = random(seed)
    const names = ['ToolA.exe', 'toolA.lnk', 'ToolB.url', 'ToolB.appref-ms', 'VisualStudioCode.txt',
      '季度报告.txt', 'Report.txt', 'report.txt', '𐀀-report.txt', '\uE000-report.txt', 'Éclair.txt', 'e\u0301clair.txt', '工具.exe']
    const rows = Array.from({ length: 257 }, (_, index) => row(index + 1, names[Math.floor(next() * names.length)],
      Math.floor(next() * 5), Math.floor(next() * 7), next() < .15))
    for (let index = rows.length - 1; index > 0; index--) {
      const other = Math.floor(next() * (index + 1)); [rows[index], rows[other]] = [rows[other], rows[index]]
    }
    const choices = new Map<number, Choice>(rows.slice(0, 12).map((value, index) => [value.id, { exact: index % 3 === 0, last_used: index % 2 }]))
    for (const term of ['tool', 'vsc', 'baogao', '']) for (const sort of sorts) for (const limit of [1, 2, 7, 31, 300]) {
      const config = options(term, choices)
      expect(bounded(rows, limit, sort, config), `${term}/${sort}/${limit}`).toEqual(reference(rows, limit, sort, config))
    }
  })

  it('keeps UTF-16 ordering for supplementary/private-use names and path tie breaks', () => {
    const rows = [row(1, '\uE000.txt', 3, 4), row(2, '𐀀.txt', 3, 4), row(3, 'É.txt', 3, 4), row(4, 'é.txt', 3, 4)]
    for (const sort of sorts) expect(bounded(rows, 4, sort, options(''))).toEqual(reference(rows, 4, sort, options('')))
    expect(bounded(rows, 4, 'name', options('')).map((value: any) => value.id)).toEqual([3, 4, 2, 1])
  })

  it('stops streaming when superseded instead of finishing an unbounded source', () => {
    let yielded = 0
    function* source() { for (let id = 1; id <= 10000; id++) { yielded++; yield row(id, 'Report.txt') } }
    expect(() => bounded(source(), 7, 'name', options('report', new Map(), () => { throw new Error('superseded') }))).toThrow('superseded')
    expect(yielded).toBeLessThanOrEqual(256)
    expect(bounded([], 7, 'name', options('report'))).toEqual([])
  })
})

const databases: DatabaseSync[] = []
afterEach(() => { while (databases.length) databases.pop()?.close() })
function integration() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  db.exec(`CREATE TABLE search_files(path TEXT PRIMARY KEY COLLATE NOCASE,name TEXT,root TEXT,kind TEXT,is_directory INTEGER,is_link INTEGER,size INTEGER,modified_at INTEGER);
    CREATE INDEX search_directory_names ON search_files(name,path) WHERE is_directory=1;
    CREATE TABLE search_phonetics(path TEXT,alias TEXT,initials TEXT);
    CREATE VIRTUAL TABLE search_fts USING fts5(name,tokenize='trigram');`)
  for (let id = 1; id <= 12; id++) {
    const value = row(id, `report-${String(id).padStart(2, '0')}.txt`, id, id)
    db.prepare('INSERT INTO search_files(rowid,path,name,root,kind,is_directory,is_link,size,modified_at) VALUES(?,?,?,?,?,0,0,?,?)')
      .run(id, value.path, value.name, root, 'document', value.size, value.modified_at)
    db.prepare('INSERT INTO search_fts(rowid,name) VALUES(?,?)').run(id, value.name)
  }
  return { db, disk: createSearchEngine(db, { sessionMaxBytes: 1 }) }
}
describe('bounded first page with live changes', () => {
  it('refills a deleted leading result and continues after its frozen ordinal without duplicates', () => {
    const { db, disk } = integration()
    const first = disk.search({ query: 'report', sort: 'name', limit: 3 })
    expect(first.rows.map((value: any) => value.id)).toEqual([1, 2, 3])
    db.exec('DELETE FROM search_files WHERE rowid=1')
    const again = disk.search({ query: 'report', sort: 'name', limit: 3, sessionId: first.sessionId })
    expect(again.rows.map((value: any) => value.id)).toEqual([2, 3, 4])
    expect(again.nextOffset).toBe(4)
    const ids = again.rows.map((value: any) => value.id)
    let page = again
    while (page.nextOffset !== null) {
      page = disk.search({ query: 'report', sort: 'name', limit: 3, sessionId: first.sessionId, offset: page.nextOffset })
      ids.push(...page.rows.map((value: any) => value.id))
    }
    expect(ids).toEqual(Array.from({ length: 11 }, (_, index) => index + 2))
    disk.close()
  })

  it('sorts by frozen metadata even if the live size changes before another first-page request', () => {
    const { db, disk } = integration()
    const first = disk.search({ query: 'report', sort: 'size', limit: 3 })
    db.exec('UPDATE search_files SET size=999 WHERE rowid=1')
    const again = disk.search({ query: 'report', sort: 'size', limit: 3, sessionId: first.sessionId })
    expect(again.rows.map((value: any) => value.id)).toEqual(first.rows.map((value: any) => value.id))
    disk.close()
  })
})
