// @ts-expect-error Desktop CommonJS modules are exercised directly.
import { collectRuleFiles, resultFor, rules, scanRuleAsync, scanSummaryRule } from '../desktop/cleaner.cjs'
// @ts-expect-error Desktop CommonJS modules are exercised directly.
import { CandidateVault, executeCleanupPlan, MAX_EXECUTE_FILES } from '../desktop/cleanup-executor.cjs'
// @ts-expect-error Desktop CommonJS discovery helpers retain filesystem guards.
import { browserCacheRoots, findNamedCacheRoots } from '../desktop/cleanup-discovery.cjs'
import { cleanerCoverageLabel, uniqueCleanerFiles } from '../src/application/cleaner'
import type { CleanerFile, CleanerScanResult } from '../src/domain/desktop'
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ownedRoots: string[] = []
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-scan-quality-'))
  ownedRoots.push(root)
  return root
}
function rule(root: string, overrides: Record<string, unknown> = {}) {
  return { id: 'scan-quality', title: 'Scan fixture', category: 'test', roots: [root], pattern: /.*/, risk: 'safe',
    minimumAgeDays: 7, maximumAgeDays: null, processNames: [], selectable: true, ...overrides }
}
function write(root: string, name: string, ageDays = 30) {
  const file = path.join(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'owned-fixture')
  const date = new Date(Date.now() - ageDays * 86400000)
  fs.utimesSync(file, date, date)
  return file
}
const failure = (code: string) => Object.assign(new Error(code), { code })
afterEach(() => {
  for (const root of ownedRoots.splice(0)) {
    if (!path.basename(root).startsWith('disk-sense-scan-quality-')) throw new Error('unowned-fixture')
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('cleanup scan accuracy and coverage', () => {
  it.each([false, true])('counts old and retained files once with overlapping roots (reverse=%s)', async reverse => {
    const root = fixture()
    write(root, 'root.tmp')
    write(root, 'nested/old.tmp')
    write(root, 'nested/recent.tmp', 1)
    const roots = [root, path.join(root, 'nested'), root]
    const scan = await collectRuleFiles(rule(root, { roots: reverse ? roots.reverse() : roots }))
    expect(scan.files).toHaveLength(2)
    expect(new Set(scan.files.map((file: CleanerFile) => file.canonicalPath)).size).toBe(2)
    expect(scan.observed.items).toBe(3)
    expect(scan.observed.bytes).toBe(Buffer.byteLength('owned-fixture') * 3)
    expect(scan.retained.recentItems).toBe(1)
    expect(scan.coverage).toMatchObject({ status: 'complete', roots: 2, directoriesRead: 2, errorCount: 0 })
    expect(scan.visited).toBe(4)
  })

  it('preserves different directory entries for hard-linked files', async () => {
    const root = fixture()
    const first = write(root, 'first.tmp')
    fs.linkSync(first, path.join(root, 'second.tmp'))
    const scan = await collectRuleFiles(rule(root))
    expect(scan.files).toHaveLength(2)
    expect(scan.files[0].ino).toBe(scan.files[1].ino)
  })

  it('distinguishes an absent rule location, an empty directory, and an explicit exclusion', async () => {
    const root = fixture()
    const missing = await collectRuleFiles(rule(path.join(root, 'not-installed')))
    expect(missing.coverage).toMatchObject({ status: 'not-found', missingRoots: 1, errorCount: 0 })
    expect(missing.skipped.inaccessible).toBe(0)
    expect((await collectRuleFiles(rule(root))).coverage.status).toBe('complete')
    const excluded = await collectRuleFiles(rule(root), { exclusions: [{ path: root, mode: 'prefix' }] })
    expect(excluded.coverage).toMatchObject({ status: 'excluded', excludedRoots: 1, errorCount: 0 })
  })

  it('does not treat an optional missing location as a failed scan of an existing root', async () => {
    const root = fixture()
    write(root, 'cache.tmp')
    const scan = await collectRuleFiles(rule(root, { roots: [root, path.join(root, 'missing')] }))
    expect(scan.coverage).toMatchObject({ status: 'complete', missingRoots: 1, errorCount: 0 })
    expect(scan.files).toHaveLength(1)
  })

  it('reports an unreadable root instead of a successful empty result', async () => {
    const root = fixture()
    const scan = await collectRuleFiles(rule(root), {
      fileSystem: { ...fs.promises, opendir: async () => { throw failure('EACCES') } }
    })
    expect(scan.coverage).toMatchObject({ status: 'unavailable', errorCount: 1, directoriesRead: 0,
      diagnostics: [{ path: root, stage: 'directory', code: 'EACCES' }] })
  })

  it('preserves usable candidates while reporting a denied subtree and bounded error samples', async () => {
    const root = fixture()
    write(root, 'good.tmp')
    for (let i = 0; i < 25; i++) fs.mkdirSync(path.join(root, `denied-${i}`))
    const scan = await collectRuleFiles(rule(root), { fileSystem: { ...fs.promises,
      opendir: async (dir: string) => {
        if (dir !== root) throw failure('EACCES')
        return fs.promises.opendir(dir)
      }
    } })
    expect(scan.files).toHaveLength(1)
    expect(scan.coverage).toMatchObject({ status: 'partial', errorCount: 25, omittedDiagnostics: 5 })
    expect(scan.coverage.diagnostics).toHaveLength(20)
    expect(resultFor(rule(root), scan, { blocked: [], checkFailed: false }).selectable).toBe(true)
  })

  it('does not count a recent file whose canonical path disappears during inspection', async () => {
    const root = fixture()
    const file = write(root, 'vanished.tmp', 1)
    const scan = await collectRuleFiles(rule(root), { fileSystem: { ...fs.promises,
      realpath: async (value: string) => {
        if (value === file) throw failure('ENOENT')
        return fs.promises.realpath(value)
      }
    } })
    expect(scan.observed.items).toBe(0)
    expect(scan.retained.recentItems).toBe(0)
    expect(scan.coverage).toMatchObject({ status: 'partial', diagnostics: [{ path: file, stage: 'file', code: 'ENOENT' }] })
  })

  it('reports a directory iterator failure after keeping files already inspected', async () => {
    const root = fixture()
    write(root, 'first.tmp')
    const [entry] = await fs.promises.readdir(root, { withFileTypes: true })
    const scan = await collectRuleFiles(rule(root), { fileSystem: { ...fs.promises,
      opendir: async () => ({ async *[Symbol.asyncIterator]() { yield entry; throw failure('EIO') }, close: async () => undefined })
    } })
    expect(scan.files).toHaveLength(1)
    expect(scan.coverage).toMatchObject({ status: 'partial', errorCount: 1 })
  })

  it('yields progress and honors cancellation when no filenames match', async () => {
    const root = fixture()
    const controller = new AbortController()
    let visited = 0
    await expect(collectRuleFiles(rule(root, { pattern: /^never$/ }), {
      signal: controller.signal,
      onProgress: (progress: { visited: number }) => { visited = progress.visited; controller.abort() },
      fileSystem: { ...fs.promises, opendir: async () => ({
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < 1000; i++) yield { name: `${i}.tmp`, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }
        }, close: async () => undefined
      }) }
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(visited).toBe(200)
  })

  it('marks resource-limited results as partial rather than complete', async () => {
    const root = fixture()
    write(root, 'first.tmp')
    write(root, 'second.tmp')
    const scan = await collectRuleFiles(rule(root), { maxVisited: 1 })
    expect(scan.coverage.status).toBe('partial')
    expect(scan.limitReason).toBe('max-visited')
  })

  it('resolves dynamic rule locations once and returns the same locations that were scanned', async () => {
    const root = fixture()
    let calls = 0
    const dynamicRule = rule(root, { id: 'quality-dynamic-root', roots: () => { calls++; return [root] } })
    rules.push(dynamicRule)
    try {
      const result = await scanRuleAsync(dynamicRule.id, { processNames: new Set() })
      expect(calls).toBe(1)
      expect(result.locations).toEqual([root])
    } finally { rules.splice(rules.indexOf(dynamicRule), 1) }
  })

  it('reports partial and wholly unreadable system summaries truthfully', async () => {
    const volumes = [{ root: 'C:', code: 0, items: 1, bytes: 8 }, { root: 'D:', code: 5, items: 0, bytes: 0 }]
    const partial = await scanSummaryRule(rule('', { probe: async () => ({ items: 1, bytes: 8, volumes }) }))
    expect(partial.coverage).toMatchObject({ status: 'partial', errorCount: 1 })
    const unavailable = await scanSummaryRule(rule('', { probe: async () => ({ volumes: volumes.slice(1) }) }))
    expect(unavailable.coverage.status).toBe('unavailable')
    expect(unavailable.selectable).toBe(false)
  })
})

describe('application cache discovery reporting', () => {
  it('reports denied Chromium profile discovery without treating it as an absent installation', async () => {
    const root = fixture()
    const scan = await collectRuleFiles(rule(root, { roots: (context: unknown) => browserCacheRoots(root, false, context) }), {
      fileSystemSync: { ...fs, readdirSync: () => { throw failure('EACCES') } }
    })
    expect(scan.coverage).toMatchObject({ status: 'unavailable', errorCount: 1,
      diagnostics: [{ path: root, stage: 'discovery', code: 'EACCES' }] })
    expect(scan.coverage.discovery.missingLocations).toBe(0)
  })

  it('retains readable caches when another product cannot be discovered', async () => {
    const denied = fixture()
    const readable = fixture()
    write(readable, 'Default/Cache/data.tmp')
    const scan = await collectRuleFiles(rule(readable, { roots: (context: unknown) => [
      ...browserCacheRoots(denied, false, context), ...browserCacheRoots(readable, false, context)
    ] }), { fileSystemSync: { ...fs, readdirSync: (location: string, options: { withFileTypes: true }) => {
      if (location === denied) throw failure('EPERM')
      return fs.readdirSync(location, options)
    } } })
    expect(scan.files).toHaveLength(1)
    expect(scan.coverage.status).toBe('partial')
    expect(scan.coverage.discovery.directoriesRead).toBe(1)
  })

  it('reports a discovery directory limit while reserving a search budget for another product', async () => {
    const first = fixture()
    const second = fixture()
    fs.mkdirSync(path.join(first, 'ordinary-data'))
    write(second, 'Code Cache/data.tmp')
    const scan = await collectRuleFiles(rule(first, { roots: (context: object) => findNamedCacheRoots([first, second], { ...context, maxDirectories: 2 }) }))
    expect(scan.files).toHaveLength(1)
    expect(scan.coverage.status).toBe('partial')
    expect(scan.coverage.discovery.limited).toBe(true)
    expect(scan.coverage.diagnostics.some((issue: { code: string }) => issue.code === 'DISCOVERY_DIRECTORY_LIMIT')).toBe(true)
  })

  it('reports a depth cutoff instead of claiming that no cache exists', async () => {
    const root = fixture()
    write(root, 'deep/Cache/data.tmp')
    const scan = await collectRuleFiles(rule(root, { roots: (context: object) => findNamedCacheRoots([root], { ...context, maxDepth: 0 }) }))
    expect(scan.files).toHaveLength(0)
    expect(scan.coverage).toMatchObject({ status: 'unavailable', discovery: { limited: true },
      diagnostics: [{ path: path.join(root, 'deep'), stage: 'discovery', code: 'DISCOVERY_DEPTH_LIMIT' }] })
  })

  it('bounds discovery work even when entries are ordinary files', async () => {
    const root = fixture()
    for (let i = 0; i < 30; i++) write(root, `${i}.tmp`)
    const scan = await collectRuleFiles(rule(root, { roots: (context: object) => findNamedCacheRoots([root], context) }), { maxDiscoveryEntries: 5 })
    expect(scan.coverage.discovery.entriesVisited).toBe(5)
    expect(scan.coverage).toMatchObject({ status: 'unavailable', diagnostics: [{ stage: 'discovery', code: 'DISCOVERY_ENTRY_LIMIT' }] })
  })

  it('honors exclusions before reading discovery directories', async () => {
    const root = fixture()
    let opened = 0
    const scan = await collectRuleFiles(rule(root, { roots: (context: object) => findNamedCacheRoots([root], context) }), {
      exclusions: [{ path: root, mode: 'prefix' }],
      fileSystem: { ...fs.promises, opendir: async (location: string) => { opened++; return fs.promises.opendir(location) } }
    })
    expect(opened).toBe(0)
    expect(scan.coverage).toMatchObject({ status: 'excluded', discovery: { excludedLocations: 1 } })
  })

  it('does not traverse a linked product directory', async () => {
    const root = fixture()
    const target = path.join(root, 'target')
    write(target, 'Cache/data.tmp')
    const link = path.join(root, 'alias')
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    const scan = await collectRuleFiles(rule(root, { roots: (context: object) => findNamedCacheRoots([link], context) }))
    expect(scan.files).toHaveLength(0)
    expect(scan.coverage.discovery).toMatchObject({ linksSkipped: 1, directoriesRead: 0 })
  })

  it('reports an exception from a dynamic root resolver rather than losing the rule result', async () => {
    const scan = await collectRuleFiles(rule('', { roots: () => { throw failure('EIO') } }))
    expect(scan.coverage).toMatchObject({ status: 'unavailable', errorCount: 1, diagnostics: [{ stage: 'discovery', code: 'EIO' }] })
  })

  it('can cancel during application discovery before candidate collection starts', async () => {
    const root = fixture()
    const controller = new AbortController()
    let phase = ''
    await expect(collectRuleFiles(rule(root, { roots: (context: object) => findNamedCacheRoots([root], context) }), {
      signal: controller.signal,
      onProgress: (progress: { phase: string }) => { phase = progress.phase; controller.abort() },
      fileSystem: { ...fs.promises, opendir: async () => ({
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < 500; i++) yield { name: `${i}.tmp`, isDirectory: () => false, isSymbolicLink: () => false }
        }, close: async () => undefined
      }) }
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(phase).toBe('discovery')
  })

  it('includes discovery in the shared scan time budget', async () => {
    const root = fixture()
    const scan = await collectRuleFiles(rule(root, { roots: (context: object) => findNamedCacheRoots([root], context) }), { maxMs: 0 })
    expect(scan.coverage).toMatchObject({ status: 'unavailable', discovery: { limited: true },
      diagnostics: [{ stage: 'discovery', code: 'DISCOVERY_TIME_LIMIT' }] })
  })

  it('reports a location disappearing after discovery has verified it', async () => {
    const root = fixture()
    const scan = await collectRuleFiles(rule(root, { roots: (context: object) => findNamedCacheRoots([root], context) }), {
      fileSystem: { ...fs.promises, opendir: async () => { throw failure('ENOENT') } }
    })
    expect(scan.coverage).toMatchObject({ status: 'unavailable', errorCount: 1,
      diagnostics: [{ stage: 'discovery', code: 'ENOENT' }] })
    expect(scan.coverage.discovery.missingLocations).toBe(0)
  })

  it('keeps discovery diagnostics separate for concurrent rules', async () => {
    const unreadable = fixture()
    const readable = fixture()
    write(readable, 'Cache/data.tmp')
    const [failed, complete] = await Promise.all([
      collectRuleFiles(rule(unreadable, { roots: (context: object) => findNamedCacheRoots([unreadable], context) }), {
        fileSystem: { ...fs.promises, opendir: async () => { throw failure('EACCES') } }
      }),
      collectRuleFiles(rule(readable, { roots: (context: object) => findNamedCacheRoots([readable], context) }))
    ])
    expect(failed.coverage.status).toBe('unavailable')
    expect(complete.files).toHaveLength(1)
    expect(complete.coverage).toMatchObject({ status: 'complete', errorCount: 0 })
  })
})

describe('cleanup plan uniqueness', () => {
  async function candidates() {
    const root = fixture()
    write(root, 'shared.tmp')
    const first = (await collectRuleFiles(rule(root, { id: 'first-rule' }))).files[0]
    const second = (await collectRuleFiles(rule(root, { id: 'second-rule' }))).files[0]
    const vault = new CandidateVault()
    for (const file of [first, second]) vault.registerScan({ id: file.ruleId, selectable: true, configuredSelectable: true, files: [file] })
    return { first, second, vault }
  }

  it('moves a path at most once even with different candidate IDs in different execution batches', async () => {
    const { first, second, vault } = await candidates()
    const requests = [{ candidateId: first.candidateId }, ...Array.from({ length: MAX_EXECUTE_FILES - 1 }, () => ({ candidateId: 'invalid' })), { candidateId: second.candidateId }]
    let calls = 0
    const result = await executeCleanupPlan({ requests, vault, trashItem: async () => { calls++ }, getRunningProcesses: async () => new Set() })
    expect(calls).toBe(1)
    expect(result.succeeded).toBe(1)
    expect(result.movedToTrashBytes).toBe(first.size)
    expect(result.results.at(-1).error).toContain('同一路径')
  })

  it('allows another valid candidate to retry a path after a failed transfer', async () => {
    const { first, second, vault } = await candidates()
    let calls = 0
    const result = await executeCleanupPlan({ requests: [first, second], vault,
      trashItem: async () => { if (++calls === 1) throw failure('EBUSY') }, getRunningProcesses: async () => new Set() })
    expect(calls).toBe(2)
    expect(result.succeeded).toBe(1)
    expect(result.failed).toBe(1)
  })

  it('deduplicates selection by canonical name while preserving different hard-link names', () => {
    const file = (candidateId: string, pathname: string, canonicalPath?: string): CleanerFile => ({ candidateId, path: pathname, canonicalPath, size: 8, modifiedAt: 1, ruleId: candidateId })
    const first = file('first', 'C:/SHORT~1/cache.tmp', 'C:\\Long Name\\cache.tmp')
    const second = file('second', 'c:/long name/CACHE.tmp')
    const distinctName = file('link', 'C:/Long Name/other.tmp')
    expect(uniqueCleanerFiles([first, second, first, distinctName])).toEqual([first, distinctName])
  })

  it('does not label unreadable or missing scans as a successful empty scan', () => {
    const label = (status: string) => cleanerCoverageLabel({ coverage: { status } } as CleanerScanResult)
    expect(label('unavailable')).toBe('未能读取')
    expect(label('not-found')).toBe('未发现规则位置')
    expect(label('partial')).toBe('部分扫描')
  })
})
