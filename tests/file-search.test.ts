import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error CommonJS desktop module is intentionally tested from TypeScript.
import { createFileSearchService, fileKind, hasWildcard, searchRanking, searchRelevanceScore, wildcardKind, wildcardSearchesPath, wildcardToLike } from '../desktop/file-search.cjs'

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
    nativeEnumeration: false,
    getVolumeRoots: async () => [root],
    ...serviceOptions
  })
  services.push(service)
  return service
}

afterEach(async () => {
  vi.restoreAllMocks()
  while (services.length) await services.pop()?.close()
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop()
    if (directory) fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('persistent file search index', () => {
  it('recalls word abbreviations even when more than thirty literal files already match', async () => {
    const root = fixture()
    for (let index = 0; index < 45; index++) fs.writeFileSync(path.join(root, 'Documents', `vsc-${index}.txt`), '')
    fs.writeFileSync(path.join(root, 'Documents', 'VisualStudioCode.txt'), '')
    fs.writeFileSync(path.join(root, 'Pictures', 'VisualStudioCode.txt'), '')
    const service = serviceFor(root)
    await service.rebuild(); await service.waitForIdle(); await service.waitForQueryIndex()
    const result = service.search({ query: 'vsc', root: path.join(root, 'Documents'), scope: 'directory', kind: 'document' })
    expect(result.items).toHaveLength(46)
    expect(result.items.find((item: any) => item.name === 'VisualStudioCode.txt')).toMatchObject({ path: path.join(root, 'Documents', 'VisualStudioCode.txt'), relevanceReason: '模糊匹配' })
    expect(service.search({ query: 'vsc ext:png' }).items).toHaveLength(0)
  })
  it('updates abbreviation postings after a rename and removes them after deletion', async () => {
    const root = fixture(), oldPath = path.join(root, 'AlphaBetaReport.txt'), nextPath = path.join(root, 'VisualStudioCode.txt')
    fs.writeFileSync(oldPath, '')
    const service = serviceFor(root)
    await service.rebuild(); await service.waitForIdle(); await service.waitForQueryIndex()
    expect(service.search({ query: 'abr' }).items.map((item: any) => item.path)).toContain(oldPath)
    fs.renameSync(oldPath, nextPath)
    await service.rebuild(); await service.waitForIdle()
    expect(service.search({ query: 'abr' }).items.some((item: any) => item.path === oldPath)).toBe(false)
    expect(service.search({ query: 'vsc' }).items.map((item: any) => item.path)).toContain(nextPath)
    fs.unlinkSync(nextPath); await service.rebuild(); await service.waitForIdle()
    expect(service.search({ query: 'vsc' }).items).toHaveLength(0)
  })
  it('remembers a successful choice for its keyword across restarts without changing explicit name order', async () => {
    const root = fixture(), chosen = path.join(root, 'Documents', 'report-z.txt'), other = path.join(root, 'Documents', 'report-a.txt')
    fs.writeFileSync(chosen, ''); fs.writeFileSync(other, '')
    fs.utimesSync(chosen, new Date(1000), new Date(1000)); fs.utimesSync(other, new Date(2000), new Date(2000))
    const service = serviceFor(root)
    await service.rebuild(); await service.waitForIdle(); await service.waitForQueryIndex()
    expect(service.search({ query: 'report' }).items[0].path).toBe(other)
    expect(service.recordSelection({ query: 'report', path: chosen })).toEqual({ recorded: true })
    expect(service.recordSelection({ query: 'report', path: path.join(root, 'missing.txt') })).toEqual({ recorded: false })
    expect(service.search({ query: 'report' }).items[0]).toMatchObject({ path: chosen, relevanceReason: '最近使用' })
    await service.close()
    const restarted = serviceFor(root)
    expect(restarted.search({ query: 'report' }).items[0].path).toBe(chosen)
    const names = restarted.search({ query: 'report', sort: 'name' }).items.map((item: any) => item.path)
    expect(names.indexOf(other)).toBeLessThan(names.indexOf(chosen))
    expect(restarted.search({ query: 'report ext:png' }).items).toHaveLength(0)
  })
  it('prefers the latest keyword choice over a more frequently chosen older item', async () => {
    const root = fixture(), first = path.join(root, 'report-first.txt'), latest = path.join(root, 'report-latest.txt')
    fs.writeFileSync(first, ''); fs.writeFileSync(latest, '')
    const service = serviceFor(root)
    await service.rebuild(); await service.waitForIdle()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1790000000000)
    for (let index = 0; index < 20; index++) service.recordSelection({ query: 'report', path: first })
    clock.mockReturnValue(1790000000000)
    service.recordSelection({ query: 'report', path: latest })
    expect(service.search({ query: 'report' }).items[0].path).toBe(latest)
    clock.mockRestore()
  })
  it('prioritizes the current directory within a match class while retaining global recall', async () => {
    const root = fixture(), selected = path.join(root, 'Documents', 'report-context.txt'), outside = path.join(root, 'Pictures', 'report-context.txt')
    fs.writeFileSync(selected, ''); fs.writeFileSync(outside, '')
    fs.utimesSync(selected, new Date(1000), new Date(1000)); fs.utimesSync(outside, new Date(2000), new Date(2000))
    const service = serviceFor(root)
    await service.rebuild(); await service.waitForIdle()
    const result = service.search({ query: 'report-context', scope: 'all', root: path.join(root, 'Documents') })
    expect(result.items[0].path).toBe(selected)
    expect(result.items.map((item: any) => item.path)).toContain(outside)
  })
  it('keeps path hits when another filename also matches the directory word', async () => {
    const root = fixture()
    fs.writeFileSync(path.join(root, 'Pictures', 'Documents-guide.txt'), 'fixture')
    const service = serviceFor(root)
    await service.rebuild({ roots: [root] }); await service.waitForIdle()
    const result = service.search({ query: 'Documents', limit: 100 })
    expect(result.items.map((item: any) => item.name)).toEqual(expect.arrayContaining(['Documents-guide.txt', 'quarterly-report.docx']))
  })

  it('retains exact matches beyond large candidate sets and pages every result without duplicates', async () => {
    const root = fixture()
    for (let i = 0; i < 145; i++) fs.writeFileSync(path.join(root, `abc-helper-${String(i).padStart(3, '0')}.exe`), '')
    fs.writeFileSync(path.join(root, 'abc.exe'), '')
    const service = serviceFor(root)
    await service.rebuild({ roots: [root] }); await service.waitForIdle()
    const input = { query: 'abc', sort: 'relevance', limit: 10 }
    let page = service.search(input)
    expect(page.items[0].name).toBe('abc.exe')
    expect(page.total).toBe(146)
    const paths = page.items.map((item: any) => item.path)
    while (page.nextOffset !== null) {
      page = service.search({ ...input, sessionId: page.sessionId, offset: page.nextOffset })
      paths.push(...page.items.map((item: any) => item.path))
    }
    expect(paths).toHaveLength(146)
    expect(new Set(paths).size).toBe(146)
  })

  it('matches pinyin, initials and polyphonic names with scope/type constraints and matching highlights', async () => {
    const root = fixture()
    fs.writeFileSync(path.join(root, 'Documents', '重庆报告2026.txt'), '')
    fs.writeFileSync(path.join(root, 'Pictures', '报告.png'), '')
    fs.writeFileSync(path.join(root, 'Pictures', '📁报告.txt'), '')
    const service = serviceFor(root)
    await service.rebuild({ roots: [root] }); await service.waitForIdle()
    for (const query of ['baogao', 'bg', 'chongqing', 'zhongqing', 'cqbg']) {
      const result = service.search({ query, scope: 'directory', root: path.join(root, 'Documents'), kind: 'document' })
      expect(result.items.map((item: any) => item.name)).toContain('重庆报告2026.txt')
      expect(result.items.find((item: any) => item.name === '重庆报告2026.txt')).toMatchObject({ relevanceReason: '拼音匹配' })
    }
    const partial = service.search({ query: 'ba', scope: 'directory', root: path.join(root, 'Documents') })
    expect(partial.items[0].matchPositions).toEqual([2])
    expect(service.search({ query: 'ba ', scope: 'directory', root: path.join(root, 'Documents') }).items).toHaveLength(0)
    expect(service.search({ query: 'baogao ext:pdf' }).items).toHaveLength(0)
    const unicode = service.search({ query: 'bg', scope: 'directory', root: path.join(root, 'Pictures'), kind: 'document' })
    expect(unicode.items.find((item: any) => item.name === '📁报告.txt').matchPositions).toEqual([1, 2])
  })

  it('reuses a persisted index immediately on restart instead of starting another full scan', async () => {
    const root = fixture()
    const first = serviceFor(root)
    await first.rebuild({ roots: [root] }); await first.waitForIdle(); await first.close()
    const readdir = vi.spyOn(fs.promises, 'readdir')
    const second = serviceFor(root, { reconcileIntervalMs: 0 })
    expect((await second.startAutomatic()).building).toBe(false)
    expect(second.search({ query: 'report' }).items[0].name).toBe('quarterly-report.docx')
    expect(readdir).not.toHaveBeenCalled()
  })

  it('resumes a persisted directory frontier after shutdown without losing searchable rows', async () => {
    const root = fixture()
    for (let i = 0; i < 30; i++) {
      const folder = path.join(root, `part-${i}`)
      fs.mkdirSync(folder)
      fs.writeFileSync(path.join(folder, `resume-${i}.txt`), '')
    }
    const first = serviceFor(root)
    const started = await first.rebuild({ roots: [root] })
    await first.checkpoint(); await first.close()
    const second = serviceFor(root)
    const resumed = await second.rebuild({ roots: [root], resume: true })
    expect(resumed.generation).toBe(started.generation)
    await second.waitForIdle()
    expect(second.search({ query: 'resume-', limit: 100 }).items).toHaveLength(30)
  })

  it('keeps an existing session order stable while the index receives updates', async () => {
    const root = fixture()
    const older = path.join(root, 'Documents', 'stable-older.txt')
    const newer = path.join(root, 'Documents', 'stable-newer.txt')
    fs.writeFileSync(older, ''); fs.writeFileSync(newer, '')
    fs.utimesSync(older, new Date(1000), new Date(1000))
    fs.utimesSync(newer, new Date(2000), new Date(2000))
    const service = serviceFor(root)
    await service.rebuild({ roots: [root] }); await service.waitForIdle()
    const input = { query: 'stable-', sort: 'modified', limit: 1 }
    const first = service.search(input)
    expect(first.items[0].name).toBe('stable-newer.txt')
    fs.utimesSync(older, new Date(3000), new Date(3000))
    await service.rebuild({ roots: [root] }); await service.waitForIdle()
    const next = service.search({ ...input, sessionId: first.sessionId, offset: first.nextOffset })
    expect(next.items[0].name).toBe('stable-older.txt')
    expect(next.nextOffset).toBe(null)
    expect(service.search(input).items[0].name).toBe('stable-older.txt')
  })

  it('retains app destinations and personal files beyond the broad candidate window', async () => {
    const root = fixture()
    const internal = path.join(root, 'node_modules', 'demo')
    const application = path.join(root, 'zzzApp')
    const personal = path.join(root, 'Users', 'Test', 'Documents')
    fs.mkdirSync(internal, { recursive: true }); fs.mkdirSync(application, { recursive: true }); fs.mkdirSync(personal, { recursive: true })
    for (let index = 0; index < 1400; index++) fs.writeFileSync(path.join(internal, `library-project-part-${index}.txt`), 'internal')
    fs.writeFileSync(path.join(application, 'project.exe'), 'application')
    fs.writeFileSync(path.join(personal, 'project-plan.docx'), 'personal')
    const service = serviceFor(root)
    await service.rebuild({ roots: [root] }); await service.waitForIdle()
    const result = service.search({ query: 'project', limit: 50 })
    expect(result.items[0].name).toBe('project.exe')
    expect(result.items.some((item: any) => item.name === 'project-plan.docx')).toBe(true)
    expect(result.truncated).toBe(true)
  })

  it('combines path keywords, extensions, phrases and bounded fuzzy names', async () => {
    const root = fixture()
    fs.writeFileSync(path.join(root, 'Documents', 'Visual Studio Code.txt'), 'document')
    fs.writeFileSync(path.join(root, 'Pictures', 'Visual Studio Code.txt'), 'outside scope')
    const service = serviceFor(root)
    await service.rebuild({ roots: [root] }); await service.waitForIdle()
    const names = (input: any) => service.search(input).items.map((item: any) => item.name)
    expect(names({ query: 'Documents report' })).toContain('quarterly-report.docx')
    expect(names({ query: 'Documents/quarterly' })).toContain('quarterly-report.docx')
    expect(names({ query: 'Documents\\quarterly' })).toContain('quarterly-report.docx')
    expect(names({ query: 'Documents/*.docx' })).toContain('quarterly-report.docx')
    expect(names({ query: 'ext:docx' })).toEqual(['quarterly-report.docx'])
    expect(names({ query: 'folder:Nested' })).toEqual(['Nested'])
    expect(names({ query: '"Visual Studio" ext:txt', scope: 'directory', root: path.join(root, 'Documents') })).toEqual(['Visual Studio Code.txt'])
    const fuzzy = service.search({ query: 'vsc', scope: 'directory', root: path.join(root, 'Documents'), kind: 'document' })
    expect(fuzzy.items).toHaveLength(1)
    expect(fuzzy.items[0].name).toBe('Visual Studio Code.txt')
    expect(fuzzy.items[0].relevanceReason).toContain('模糊匹配')
    expect(service.search({ query: 'vsc ext:png' }).items).toHaveLength(0)
    expect(names({ query: '"%_"' })).toEqual([])
  })

  it('preserves inaccessible subtrees and removes deleted entries after access returns', async () => {
    const root = fixture()
    const blocked = path.join(root, 'Documents')
    const service = serviceFor(root)
    await service.rebuild({ roots: [root] }); await service.waitForIdle()
    const readdir = fs.promises.readdir.bind(fs.promises)
    const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation(((target: any, options: any) => {
      if (String(target) === blocked) return Promise.reject(Object.assign(new Error('access denied'), { code: 'EACCES' }))
      return readdir(target, options)
    }) as any)
    await service.rebuild({ roots: [root] }); await service.waitForIdle()
    expect(service.search({ query: 'holiday', scope: 'all' }).items).toHaveLength(1)
    expect(service.search({ query: 'quarterly-report', scope: 'all' }).items).toHaveLength(1)
    spy.mockRestore()
    fs.unlinkSync(path.join(blocked, 'quarterly-report.docx'))
    await service.rebuild({ roots: [root] }); await service.waitForIdle()
    expect(service.search({ query: 'quarterly-report', scope: 'all' }).items).toHaveLength(0)
  })
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
    expect(wildcardSearchesPath('*.docx')).toBe(false)
    expect(wildcardSearchesPath('D:\\Documents\\*.docx')).toBe(true)
    expect(wildcardKind('*.docx')).toBe('document')
    expect(wildcardKind('word*')).toBeNull()
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
