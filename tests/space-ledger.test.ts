import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
// @ts-expect-error CommonJS desktop module is intentionally tested from TypeScript.
import { createSpaceLedger } from '../desktop/space-ledger.cjs'
// @ts-expect-error CommonJS desktop module is intentionally tested from TypeScript.
import { createFileSearchService } from '../desktop/file-search.cjs'

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE search_files (path TEXT PRIMARY KEY COLLATE NOCASE, size INTEGER, is_directory INTEGER, is_link INTEGER)')
  const root = path.resolve('ledger-fixture')
  const status = { roots: [root], phase: 'ready', coverageVersion: 1, building: false, pendingChanges: 0, truncated: false, inaccessible: 0, skippedLinks: 0, lastError: '', lastChangedAt: null }
  const ledger = createSpaceLedger(db)
  const observe = (entity: string, relative: string) => ledger.observe({ entityId: entity, entityName: entity, entityType: 'project', entityKind: '项目', rootPath: path.join(root, relative), basis: 'project-markers', evidence: ['package.json'] })
  const file = (relative: string, size: number, isLink = 0) => db.prepare('INSERT OR REPLACE INTO search_files VALUES (?, ?, 0, ?)').run(path.join(root, relative), size, isLink)
  return { db, root, status, ledger, observe, file }
}

describe('persistent space ledger', () => {
  it('does not commit a growth baseline when indexing changes while a summary yields', async () => {
    const f = fixture()
    try {
      for (let index = 0; index < 9; index++) { f.observe(`app-${index}`, `app-${index}`); f.file(`app-${index}/data`, 1) }
      let reads = 0
      const result = await f.ledger.summary(() => ({ ...f.status, revision: reads++ === 0 ? 1 : 2 }))
      expect(result.entities.every((entity: any) => entity.deltaBytes === null)).toBe(true)
      expect(f.db.prepare('SELECT COUNT(*) AS count FROM space_baselines').get()?.count).toBe(0)
    } finally { f.db.close() }
  })

  it('treats an unreadable ancestor as incomplete for every affected location', async () => {
    const f = fixture()
    try {
      f.observe('app', 'app/data'); f.file('app/data/file', 10)
      f.db.prepare('INSERT INTO search_gaps VALUES (?, ?)').run(path.join(f.root, 'app'), 'EACCES')
      const result = await f.ledger.summary(() => f.status)
      expect(result.entities[0].deltaBytes).toBeNull()
      expect(result.entities[0].locations[0].incomplete).toBe(true)
    } finally { f.db.close() }
  })
  it('deduplicates nested locations and excludes links from logical totals', async () => {
    const f = fixture()
    try {
      f.observe('project', 'project'); f.observe('project', 'project/cache')
      f.file('project/main.txt', 20); f.file('project/cache/data', 10); f.file('project/link', 999, 1)
      const result = await f.ledger.summary(() => f.status)
      expect(result.entities[0]).toMatchObject({ bytes: 30, files: 2, deltaBytes: 0 })
      expect(result.entities[0].locations.filter((item: any) => item.counted)).toHaveLength(1)
      f.file('project/cache/data', 15)
      expect((await f.ledger.summary(() => f.status)).entities[0].deltaBytes).toBe(5)
      const reloaded = createSpaceLedger(f.db)
      expect((await reloaded.summary(() => f.status)).entities[0].deltaBytes).toBe(5)
    } finally { f.db.close() }
  })

  it('marks overlap between entities instead of implying exclusive ownership', async () => {
    const f = fixture()
    try {
      f.observe('parent', 'project'); f.observe('child', 'project/nested')
      f.file('project/nested/content', 50)
      const result = await f.ledger.summary(() => f.status)
      expect(result.entities).toHaveLength(2)
      expect(result.entities.every((entity: any) => entity.locations[0].shared)).toBe(true)
    } finally { f.db.close() }
  })

  it('does not mistake missing index coverage for freed space or mix different scopes', async () => {
    const f = fixture()
    try {
      f.observe('app', 'app'); f.file('app/data', 100)
      await f.ledger.summary(() => f.status)
      f.file('app/data', 50)
      expect((await f.ledger.summary(() => ({ ...f.status, truncated: true }))).entities[0].deltaBytes).toBeNull()
      expect((await f.ledger.summary(() => ({ ...f.status, roots: [] }))).entities[0].deltaBytes).toBeNull()
      expect((await f.ledger.summary(() => f.status)).entities[0].deltaBytes).toBe(-50)
      f.observe('app', 'app-other'); f.file('app-other/data', 80)
      expect((await f.ledger.summary(() => f.status)).entities[0].deltaBytes).toBe(0)
    } finally { f.db.close() }
  })

  it('escapes SQL wildcard characters and never counts similarly prefixed siblings', async () => {
    const f = fixture()
    try {
      f.observe('one', '100%_app'); f.file('100%_app/a', 10)
      f.file('100XXapp/a', 100); f.file('100%_app-extra/a', 200)
      expect((await f.ledger.summary(() => f.status)).entities[0].bytes).toBe(10)
    } finally { f.db.close() }
  })

  it('removes only ledger records, not files in the search index', async () => {
    const f = fixture()
    try {
      f.observe('app', 'app'); f.file('app/data', 100)
      await f.ledger.summary(() => f.status)
      f.ledger.forget('app')
      expect((await f.ledger.summary(() => f.status)).entities).toEqual([])
      expect(f.db.prepare('SELECT COUNT(*) AS count FROM search_files').get()?.count).toBe(1)
      expect(f.db.prepare('SELECT COUNT(*) AS count FROM space_baselines').get()?.count).toBe(0)
    } finally { f.db.close() }
  })

  it('preserves observed relationships on reopen and a search-schema rebuild', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-ledger-'))
    const databasePath = path.join(root, 'index.sqlite')
    let service: any
    try {
      const appRoot = path.join(root, 'app'); fs.mkdirSync(appRoot)
      fs.writeFileSync(path.join(appRoot, 'file'), 'abc')
      service = createFileSearchService({ databasePath })
      service.observeSpace({ entityId: 'app', entityName: 'App', rootPath: appRoot, basis: 'install-path' })
      await service.rebuild({ roots: [appRoot] }); await service.waitForIdle()
      expect((await service.spaceSummary()).entities[0].bytes).toBe(3)
      await service.close(); service = null
      const database = new DatabaseSync(databasePath)
      database.exec('PRAGMA user_version = 1'); database.close()
      service = createFileSearchService({ databasePath })
      const reloaded = await service.spaceSummary()
      expect(reloaded.entities[0].name).toBe('App')
      expect(reloaded.entities[0].deltaBytes).toBeNull()
    } finally {
      await service?.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
