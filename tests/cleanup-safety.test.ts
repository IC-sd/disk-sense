// @ts-expect-error CommonJS desktop module is intentionally tested from the TypeScript suite.
import { collectRuleFiles, isPathExcluded, isWithinRoot, PROCESS_CHECK_FAILED, validateCandidate } from '../desktop/cleaner.cjs'
// @ts-expect-error CommonJS desktop module is intentionally tested from the TypeScript suite.
import { CandidateVault, compactCleanupJob, executeCleanup } from '../desktop/cleanup-executor.cjs'
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const temporaryRoots: string[] = []

function createRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-safety-'))
  temporaryRoots.push(root)
  return root
}

function ruleFor(root: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-cache',
    title: '测试缓存',
    category: '测试',
    roots: [root],
    pattern: /.*/,
    risk: 'safe',
    minimumAgeDays: 7,
    processNames: [],
    selectable: true,
    ...overrides
  }
}

function makeOld(filePath: string, days = 30) {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  fs.utimesSync(filePath, date, date)
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('cleanup safety boundary', () => {
  it('only generates candidates older than the rule retention window', async () => {
    const root = createRoot()
    const oldFile = path.join(root, 'old.tmp')
    const recentFile = path.join(root, 'recent.tmp')
    fs.writeFileSync(oldFile, 'old')
    fs.writeFileSync(recentFile, 'recent')
    makeOld(oldFile)

    const result = await collectRuleFiles(ruleFor(root))

    expect(result.files.map((item: { path: string }) => item.path)).toEqual([oldFile])
    expect(result.skipped.recent).toBe(1)
  })

  it('bounds traversal even when files do not match a cleanup rule', async () => {
    const root = createRoot()
    for (let index = 0; index < 30; index++) fs.writeFileSync(path.join(root, `ignored-${index}.txt`), 'x')

    const result = await collectRuleFiles(ruleFor(root, { pattern: /\.cache$/ }), {
      maxVisited: 10,
      maxMs: 5000
    })

    expect(result.files).toHaveLength(0)
    expect(result.visited).toBe(10)
    expect(result.truncated).toBe(true)
    expect(result.limitReason).toBe('max-visited')
  })

  it('rejects paths outside the canonical scan root', () => {
    const root = path.resolve('C:\\safe-root')
    expect(isWithinRoot(path.join(root, 'cache', 'a.tmp'), root)).toBe(true)
    expect(isWithinRoot(path.resolve(root, '..', 'Windows', 'a.tmp'), root)).toBe(false)
  })

  it('honors exact and recursive user exclusions during candidate collection', async () => {
    const root = createRoot()
    const protectedDirectory = path.join(root, 'protected')
    const protectedFile = path.join(root, 'single.tmp')
    const includedFile = path.join(root, 'included.tmp')
    fs.mkdirSync(protectedDirectory)
    fs.writeFileSync(path.join(protectedDirectory, 'nested.tmp'), 'protected')
    fs.writeFileSync(protectedFile, 'protected')
    fs.writeFileSync(includedFile, 'included')
    makeOld(path.join(protectedDirectory, 'nested.tmp'))
    makeOld(protectedFile)
    makeOld(includedFile)

    const exclusions = [
      { path: protectedDirectory, mode: 'prefix' },
      { path: protectedFile, mode: 'exact' }
    ]
    const result = await collectRuleFiles(ruleFor(root), { exclusions })

    expect(isPathExcluded(path.join(protectedDirectory, 'nested.tmp'), exclusions)).toBe(true)
    expect(isPathExcluded(`${protectedFile}.other`, exclusions)).toBe(false)
    expect(result.files.map((item: { path: string }) => item.path)).toEqual([includedFile])
    expect(result.skipped.excluded).toBeGreaterThanOrEqual(2)
  })

  it('revalidates file identity and blocks content changed after scanning', async () => {
    const root = createRoot()
    const filePath = path.join(root, 'cache.tmp')
    fs.writeFileSync(filePath, 'original')
    makeOld(filePath)
    const scan = await collectRuleFiles(ruleFor(root))
    const candidate = scan.files[0]

    expect((await validateCandidate(candidate)).ok).toBe(true)
    fs.appendFileSync(filePath, '-changed')
    expect(await validateCandidate(candidate)).toMatchObject({ ok: false })
  })

  it('executes only opaque registered candidates and reports recycle-bin bytes honestly', async () => {
    const root = createRoot()
    const filePath = path.join(root, 'cache.tmp')
    fs.writeFileSync(filePath, 'cache-data')
    makeOld(filePath)
    const scan = await collectRuleFiles(ruleFor(root))
    const candidate = scan.files[0]
    const vault = new CandidateVault()
    vault.registerScan({
      id: 'test-cache',
      selectable: true,
      configuredSelectable: true,
      files: [candidate]
    })
    const trashed: string[] = []

    const result = await executeCleanup({
      requests: [{ candidateId: candidate.candidateId }],
      vault,
      trashItem: async (value: string) => { trashed.push(value) },
      getRunningProcesses: async () => new Set()
    })

    expect(trashed).toEqual([filePath])
    expect(result.succeeded).toBe(1)
    expect(result.movedToTrashBytes).toBe(Buffer.byteLength('cache-data'))
    expect(result.reclaimedBytes).toBe(0)
  })

  it('blocks cleanup while a guarded application is running', async () => {
    const root = createRoot()
    const filePath = path.join(root, 'cache.tmp')
    fs.writeFileSync(filePath, 'cache')
    makeOld(filePath)
    const scan = await collectRuleFiles(ruleFor(root, { processNames: ['browser.exe'] }))
    const candidate = scan.files[0]
    const vault = new CandidateVault()
    vault.registerScan({ id: 'test-cache', selectable: true, configuredSelectable: true, files: [candidate] })

    const result = await executeCleanup({
      requests: [{ candidateId: candidate.candidateId }],
      vault,
      trashItem: async () => { throw new Error('must not run') },
      getRunningProcesses: async () => new Set(['browser.exe'])
    })

    expect(result.succeeded).toBe(0)
    expect(result.results[0].error).toContain('正在运行')
  })

  it('rechecks user exclusions immediately before moving a file to the recycle bin', async () => {
    const root = createRoot()
    const filePath = path.join(root, 'cache.tmp')
    fs.writeFileSync(filePath, 'cache')
    makeOld(filePath)
    const scan = await collectRuleFiles(ruleFor(root))
    const candidate = scan.files[0]
    const vault = new CandidateVault()
    vault.registerScan({ id: 'test-cache', selectable: true, configuredSelectable: true, files: [candidate] })
    let trashCalls = 0

    const result = await executeCleanup({
      requests: [{ candidateId: candidate.candidateId }],
      vault,
      trashItem: async () => { trashCalls++ },
      getRunningProcesses: async () => new Set(),
      isExcluded: (value: string) => value === filePath
    })

    expect(trashCalls).toBe(0)
    expect(result.succeeded).toBe(0)
    expect(result.results[0].error).toContain('排除项')
  })

  it('fails closed when the guarded-process check is unavailable', async () => {
    const root = createRoot()
    const filePath = path.join(root, 'cache.tmp')
    fs.writeFileSync(filePath, 'cache')
    makeOld(filePath)
    const scan = await collectRuleFiles(ruleFor(root, { processNames: ['browser.exe'] }))
    const candidate = scan.files[0]
    const vault = new CandidateVault()
    vault.registerScan({ id: 'test-cache', selectable: true, configuredSelectable: true, files: [candidate] })

    const result = await executeCleanup({
      requests: [{ candidateId: candidate.candidateId }],
      vault,
      trashItem: async () => { throw new Error('must not run') },
      getRunningProcesses: async () => new Set([PROCESS_CHECK_FAILED])
    })

    expect(result.succeeded).toBe(0)
    expect(result.results[0].error).toContain('无法确认')
  })

  it('fails closed when process enumeration throws', async () => {
    const root = createRoot()
    const filePath = path.join(root, 'cache.tmp')
    fs.writeFileSync(filePath, 'cache')
    makeOld(filePath)
    const scan = await collectRuleFiles(ruleFor(root, { processNames: ['browser.exe'] }))
    const candidate = scan.files[0]
    const vault = new CandidateVault()
    vault.registerScan({ id: 'test-cache', selectable: true, configuredSelectable: true, files: [candidate] })
    let trashCalls = 0

    const result = await executeCleanup({
      requests: [{ candidateId: candidate.candidateId }],
      vault,
      trashItem: async () => { trashCalls++ },
      getRunningProcesses: async () => { throw new Error('tasklist failed') }
    })

    expect(trashCalls).toBe(0)
    expect(result.succeeded).toBe(0)
  })

  it('keeps a candidate available for retry when recycle-bin transfer fails', async () => {
    const root = createRoot()
    const filePath = path.join(root, 'cache.tmp')
    fs.writeFileSync(filePath, 'cache')
    makeOld(filePath)
    const scan = await collectRuleFiles(ruleFor(root))
    const candidate = scan.files[0]
    const vault = new CandidateVault()
    vault.registerScan({ id: 'test-cache', selectable: true, configuredSelectable: true, files: [candidate] })

    const first = await executeCleanup({
      requests: [{ candidateId: candidate.candidateId }],
      vault,
      trashItem: async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) },
      getRunningProcesses: async () => new Set()
    })
    expect(first.failed).toBe(1)
    expect(vault.get(candidate.candidateId)).toBeTruthy()

    const second = await executeCleanup({
      requests: [{ candidateId: candidate.candidateId }],
      vault,
      trashItem: async () => undefined,
      getRunningProcesses: async () => new Set()
    })
    expect(second.succeeded).toBe(1)
    expect(vault.get(candidate.candidateId)).toBeUndefined()
  })

  it('rejects duplicate opaque candidate identifiers within one plan', async () => {
    const root = createRoot()
    const filePath = path.join(root, 'cache.tmp')
    fs.writeFileSync(filePath, 'cache')
    makeOld(filePath)
    const scan = await collectRuleFiles(ruleFor(root))
    const candidate = scan.files[0]
    const vault = new CandidateVault()
    vault.registerScan({ id: 'test-cache', selectable: true, configuredSelectable: true, files: [candidate] })
    let trashCalls = 0

    const result = await executeCleanup({
      requests: [{ candidateId: candidate.candidateId }, { candidateId: candidate.candidateId }],
      vault,
      trashItem: async () => { trashCalls++ },
      getRunningProcesses: async () => new Set()
    })

    expect(trashCalls).toBe(1)
    expect(result.succeeded).toBe(1)
    expect(result.failed).toBe(1)
  })

  it('bounds persisted audit detail while keeping failures first and summary fields intact', () => {
    const results = Array.from({ length: 20 }, (_, index) => ({
      candidateId: String(index),
      path: `C:\\cache\\${index}.tmp`,
      size: 1,
      modifiedAt: 0,
      ruleId: 'test-cache',
      success: index >= 4
    }))
    const compacted = compactCleanupJob({ id: 'job', succeeded: 16, failed: 4, results }, 10)

    expect(compacted.results).toHaveLength(10)
    expect(compacted.results.slice(0, 4).every((item: { success: boolean }) => !item.success)).toBe(true)
    expect(compacted.omittedResults).toBe(10)
    expect(compacted.succeeded).toBe(16)
    expect(compacted.failed).toBe(4)
  })
})
