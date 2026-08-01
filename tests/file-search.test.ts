import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error CommonJS desktop module is intentionally tested from TypeScript.
import { createFileSearchService, fileKind, hasWildcard, searchRanking, searchRelevanceScore, wildcardToLike } from '../desktop/file-search.cjs'

const temporaryDirectories: string[] = []
const services: Array<{ close: () => Promise<void> }> = []

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-search-'))
  temporaryDirectories.push(root)
  fs.mkdirSync(path.join(root, 'Documents', 'Nested'), { recursive: true })
  fs.mkdirSync(path.join(root, 'Pictures'), { recursive: true })
  fs.mkdirSync(path.join(root, 'ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'), { recursive: true })
  fs.mkdirSync(path.join(root, 'Users', 'Test', 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'), { recursive: true })
  fs.mkdirSync(path.join(root, 'Users', 'Test', 'AppData', 'Local', 'Microsoft', 'Office', 'Word'), { recursive: true })
  fs.writeFileSync(path.join(root, 'Documents', 'quarterly-report.docx'), 'office fixture')
  fs.writeFileSync(path.join(root, 'Documents', '100% complete.txt'), 'escaped wildcard fixture')
  fs.writeFileSync(path.join(root, 'Documents', 'Nested', 'project-notes.md'), 'notes fixture')
  fs.writeFileSync(path.join(root, 'Pictures', 'holiday.jpg'), 'image fixture')
  fs.writeFileSync(path.join(root, 'ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Word.lnk'), 'shortcut fixture')
  fs.writeFileSync(path.join(root, 'Users', 'Test', 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Word.lnk'), 'duplicate shortcut fixture')
  fs.writeFileSync(path.join(root, 'setup.msi'), 'installer fixture')
  return root
}

function serviceFor(root: string, options: Record<string, unknown> | number = {}) {
  const databasePath = path.join(root, '.state', 'search.sqlite')
  const serviceOptions = typeof options === 'number' ? { maximumEntries: options } : options
  const service = createFileSearchService({
    databasePath,
    getVolumeRoots: async () => [root],
    ...serviceOptions
  })
  services.push(service)
  return service
}

afterEach(async () => {
  while (services.length) await services.pop()?.close()
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop()
    if (directory) fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('persistent file search index', () => {
  it('indexes a controlled tree and applies scope, type and escaped SQL wildcard filters', async () => {
    const root = fixture()
    const service = serviceFor(root)
    const start = await service.rebuild({ roots: [root] })
    expect(start.started).toBe(true)
    const status = await service.waitForIdle()
    expect(status.phase).toBe('ready')
    expect(status.entries).toBeGreaterThanOrEqual(8)

    const documents = service.search({
      query: 'report',
      scope: 'directory',
      root,
      kind: 'document',
      modified: 'any',
      sort: 'relevance'
    })
    expect(documents.items.map((item: { name: string }) => item.name)).toEqual(['quarterly-report.docx'])
    expect(documents.items[0]).toMatchObject({
      isDirectory: false,
      searchKind: 'document'
    })

    const literalPercent = service.search({
      query: '100%',
      scope: 'directory',
      root,
      kind: 'all',
      modified: 'any',
      sort: 'name'
    })
    expect(literalPercent.items.map((item: { name: string }) => item.name)).toContain('100% complete.txt')

    const folders = service.search({
      query: 'documents',
      scope: 'directory',
      root,
      kind: 'folder',
      modified: 'any',
      sort: 'name'
    })
    expect(folders.items[0]).toMatchObject({ name: 'Documents', isDirectory: true })
  })

  it('searches the full index with keyword and wildcard matching', async () => {
    const root = fixture()
    const service = serviceFor(root)
    await service.rebuild({ roots: [root] })
    await service.waitForIdle()

    const keyword = service.search({
      query: 'project',
      scope: 'all',
      kind: 'all',
      modified: 'any',
      sort: 'relevance'
    })
    expect(keyword.items.map((item: { name: string }) => item.name)).toContain('project-notes.md')

    const wildcard = service.search({
      query: '*.docx',
      scope: 'all',
      kind: 'all',
      modified: 'any',
      sort: 'relevance'
    })
    expect(wildcard.items.map((item: { name: string }) => item.name)).toEqual(['quarterly-report.docx'])

    const singleCharacter = service.search({
      query: 'holida?.jpg',
      scope: 'all',
      kind: 'image',
      modified: 'any',
      sort: 'relevance'
    })
    expect(singleCharacter.items.map((item: { name: string }) => item.name)).toEqual(['holiday.jpg'])

  })

  it('parses wildcard syntax used by normal search', () => {
    expect(hasWildcard('word*')).toBe(true)
    expect(hasWildcard('word')).toBe(false)
    expect(wildcardToLike('word?.doc*')).toBe('word_.doc%')
  })

  it('prioritizes launchable exact-name matches over deep cache folders', async () => {
    const root = fixture()
    const service = serviceFor(root)
    await service.rebuild({ roots: [root] })
    await service.waitForIdle()

    const result = service.search({
      query: 'word',
      scope: 'all',
      kind: 'all',
      modified: 'any',
      sort: 'relevance'
    })

    expect(result.items[0]).toMatchObject({ name: 'Word.lnk', displayName: 'Word', searchKind: 'application' })
    expect(result.items.filter((item: { displayName: string; searchKind: string }) => (
      item.displayName === 'Word' && item.searchKind === 'application'
    ))).toHaveLength(1)
    expect(searchRelevanceScore({
      name: 'Word.lnk',
      path: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Word.lnk',
      is_directory: 0
    }, 'word')).toBeLessThan(searchRelevanceScore({
      name: 'Word',
      path: 'C:\\Users\\User\\AppData\\Local\\Microsoft\\Office\\Word',
      is_directory: 1
    }, 'word'))
  })

  it('keeps useful folders and recent user results ahead of dependency files', async () => {
    const root = fixture()
    const documentsA = path.join(root, 'Users', 'Test', 'Documents', 'Current')
    const documentsB = path.join(root, 'Users', 'Test', 'Documents', 'Archive')
    const internal = path.join(root, 'node_modules', 'word', 'lib')
    const practicalFolder = path.join(root, 'workspaces', 'wordwj')
    fs.mkdirSync(documentsA, { recursive: true })
    fs.mkdirSync(documentsB, { recursive: true })
    fs.mkdirSync(internal, { recursive: true })
    fs.mkdirSync(practicalFolder, { recursive: true })

    const recentDocument = path.join(documentsA, 'word-plan.docx')
    const oldDocument = path.join(documentsB, 'word-plan.docx')
    const internalFile = path.join(internal, 'word.tcl')
    fs.writeFileSync(recentDocument, 'recent user document')
    fs.writeFileSync(oldDocument, 'old user document')
    fs.writeFileSync(internalFile, 'new dependency file')
    const now = Date.now()
    fs.utimesSync(recentDocument, new Date(now - 2 * 86_400_000), new Date(now - 2 * 86_400_000))
    fs.utimesSync(oldDocument, new Date(now - 500 * 86_400_000), new Date(now - 500 * 86_400_000))
    fs.utimesSync(internalFile, new Date(now), new Date(now))

    const service = serviceFor(root)
    await service.rebuild({ roots: [root] })
    await service.waitForIdle()
    const result = service.search({ query: 'word', scope: 'all', sort: 'relevance', limit: 50 })
    const paths = result.items.map((item: { path: string }) => item.path)
    const exactFolder = path.join(root, 'node_modules', 'word')

    expect(result.items[0]).toMatchObject({
      name: 'Word.lnk',
      searchPriority: 'primary',
      relevanceReason: '应用入口'
    })
    expect(paths.indexOf(recentDocument)).toBeLessThan(paths.indexOf(oldDocument))
    expect(paths.indexOf(exactFolder)).toBeLessThan(paths.indexOf(practicalFolder))
    expect(searchRelevanceScore({
      name: 'word-plan.docx',
      path: 'C:\\Users\\User\\Documents\\word-plan.docx',
      modified_at: now - 2 * 86_400_000,
      is_directory: 0,
      kind: 'document'
    }, 'word', now)).toBeLessThan(searchRelevanceScore({
      name: 'word.tcl',
      path: 'D:\\Python\\Lib\\tcl8.6\\word.tcl',
      modified_at: now,
      is_directory: 0,
      kind: 'file'
    }, 'word', now))
    expect(searchRelevanceScore({
      name: 'wordwj',
      path: 'D:\\yingyong\\office\\wordwj',
      is_directory: 1,
      kind: 'folder'
    }, 'word')).toBeLessThan(searchRelevanceScore({
      name: 'word.tcl',
      path: 'D:\\Python\\Lib\\tcl8.6\\word.tcl',
      is_directory: 0,
      kind: 'file'
    }, 'word'))
    expect(result.items.find((item: { path: string }) => item.path === internalFile)).toMatchObject({
      searchPriority: 'secondary',
      relevanceReason: '程序内部文件'
    })
  })

  it('reports the ranking reason used by the result hierarchy', () => {
    const application = searchRanking({
      name: 'Word.lnk',
      path: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Word.lnk',
      modified_at: Date.now() - 180 * 86_400_000,
      kind: 'application',
      is_directory: 0
    }, 'word')
    const dependency = searchRanking({
      name: 'word.tcl',
      path: 'D:\\Python\\Lib\\site-packages\\word\\word.tcl',
      modified_at: Date.now(),
      kind: 'file',
      is_directory: 0
    }, 'word')

    expect(application).toMatchObject({ priority: 'primary', reason: '应用入口' })
    expect(dependency).toMatchObject({ priority: 'secondary', reason: '程序内部文件' })
    expect(application.score).toBeLessThan(dependency.score)
  })

  it('removes stale entries only after a completed rebuild', async () => {
    const root = fixture()
    const service = serviceFor(root)
    await service.rebuild({ roots: [root] })
    await service.waitForIdle()
    fs.rmSync(path.join(root, 'setup.msi'))
    await service.rebuild({ roots: [root] })
    await service.waitForIdle()

    const result = service.search({
      query: 'setup',
      scope: 'directory',
      root,
      kind: 'all',
      modified: 'any',
      sort: 'relevance'
    })
    expect(result.items).toHaveLength(0)
  })

  it('starts automatically and incrementally tracks created, renamed and removed files', async () => {
    const root = fixture()
    let onChange = (_eventType: string, _filename: string) => {}
    let watcherClosed = false
    const watcher = {
      on: () => watcher,
      close: () => { watcherClosed = true }
    }
    const service = serviceFor(root, {
      changeDebounceMs: 1,
      reconcileIntervalMs: 0,
      watchFactory: (
        _root: string,
        _options: { recursive: boolean; persistent: boolean },
        listener: (eventType: string, filename: string) => void
      ) => {
        onChange = listener
        return watcher
      }
    })

    await service.startAutomatic()
    let status = await service.waitForIdle()
    expect(status).toMatchObject({ automatic: true, watching: true, watcherCount: 1 })

    const created = path.join(root, 'Documents', 'new-invoice.pdf')
    fs.writeFileSync(created, 'new file')
    onChange('rename', path.relative(root, created))
    status = await service.waitForIdle()
    expect(status.lastChangedAt).toBeTruthy()
    expect(service.search({ query: 'new-invoice', scope: 'all' }).items).toHaveLength(1)

    const renamed = path.join(root, 'Documents', 'archived-invoice.pdf')
    fs.renameSync(created, renamed)
    onChange('rename', path.relative(root, created))
    onChange('rename', path.relative(root, renamed))
    await service.waitForIdle()
    expect(service.search({ query: 'new-invoice', scope: 'all' }).items).toHaveLength(0)
    expect(service.search({ query: 'archived-invoice', scope: 'all' }).items).toHaveLength(1)

    fs.rmSync(renamed)
    onChange('rename', path.relative(root, renamed))
    await service.waitForIdle()
    expect(service.search({ query: 'archived-invoice', scope: 'all' }).items).toHaveLength(0)

    service.stopAutomatic()
    expect(watcherClosed).toBe(true)
  })

  it('stops at the configured performance boundary and reports a partial index', async () => {
    const root = fixture()
    const service = serviceFor(root, 2)
    await service.rebuild({ roots: [root] })
    const status = await service.waitForIdle()
    expect(status.phase).toBe('partial')
    expect(status.truncated).toBe(true)
    expect(status.entries).toBe(2)
  })

  it('classifies common search result types without reading file content', () => {
    expect(fileKind('budget.xlsx', false)).toBe('document')
    expect(fileKind('capture.mp4', false)).toBe('video')
    expect(fileKind('source.ts', false)).toBe('code')
    expect(fileKind('Word.lnk', false)).toBe('application')
    expect(fileKind('WINWORD.EXE', false)).toBe('application')
    expect(fileKind('product-setup.exe', false)).toBe('installer')
    expect(fileKind('folder', true)).toBe('folder')
  })
})
