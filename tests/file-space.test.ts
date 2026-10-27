// @ts-expect-error CommonJS desktop module tested from TypeScript.
import { inspectPathSpace, nativeMetadata } from '../desktop/file-space.cjs'
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const roots: string[] = []
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-file-space-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('on-demand file data allocation accounting', () => {
  it('deduplicates allocated bytes by file identity and reports external links separately', async () => {
    const root = fixture()
    for (const file of ['a', 'b', 'c']) fs.writeFileSync(path.join(root, file), 'x')
    const provider = async (files: string[]) => files.map(file => file === root ? { directory: true } : {
      identity: path.basename(file) === 'c' ? 'other' : 'shared', logicalBytes: 1000, allocatedBytes: 4096,
      linkCount: path.basename(file) === 'c' ? 1 : 3
    })
    const result = await inspectPathSpace(root, { metadataProvider: provider })
    expect(result).toMatchObject({ state: 'complete', files: 3, logicalBytes: 3000, uniqueLogicalBytes: 2000,
      allocatedBytes: 8192, hardLinkDuplicates: 1, sharedOutsideBytes: 4096, reclaimableBytes: null })
  })

  it('keeps sparse and compressed allocation independent from logical length', async () => {
    const root = fixture()
    const result = await inspectPathSpace(root, { metadataProvider: async () => [{ logicalBytes: 1_000_000, allocatedBytes: 4096,
      identity: 'sparse-compressed', linkCount: 1, attributes: 512 | 2048 }] })
    expect(result).toMatchObject({ logicalBytes: 1_000_000, allocatedBytes: 4096, sparseFiles: 1, compressedFiles: 1 })
  })

  it('does not enumerate cloud directories or follow reparse points', async () => {
    const root = fixture()
    fs.writeFileSync(path.join(root, 'must-not-be-seen'), 'secret')
    const result = await inspectPathSpace(root, { metadataProvider: async () => [{ directory: true, cloudPlaceholder: true, skipped: 'cloud-placeholder' }] })
    expect(result).toMatchObject({ state: 'partial', files: 0, cloudPlaceholders: 1, allocatedBytes: null })
    const link = await inspectPathSpace(root, { metadataProvider: async () => [{ logicalBytes: 20, skipped: 'reparse-point' }] })
    expect(link).toMatchObject({ state: 'partial', files: 1, skippedReparsePoints: 1, unknownFiles: 1, knownAllocatedBytes: 0 })
  })

  it('keeps unknown allocation unknown instead of rounding logical bytes', async () => {
    const result = await inspectPathSpace(fixture(), { metadataProvider: async () => [{ logicalBytes: 7, allocatedBytes: null, identity: 'unknown' }] })
    expect(result).toMatchObject({ state: 'partial', logicalBytes: 7, allocatedBytes: null, knownAllocatedBytes: 0, unknownFiles: 1 })
  })

  it('bounds traversal without claiming completion and respects cancellation before reads', async () => {
    const root = fixture()
    for (const name of ['a', 'b', 'c']) fs.writeFileSync(path.join(root, name), 'x')
    let calls = 0
    const provider = async (files: string[]) => { calls++; return files.map(file => ({ directory: file === root, logicalBytes: 1, allocatedBytes: 4096, linkCount: 1 })) }
    const result = await inspectPathSpace(root, { maxEntries: 2, metadataProvider: provider })
    expect(result).toMatchObject({ state: 'partial', stopReason: 'entry-budget' })
    expect(calls).toBeLessThanOrEqual(2)
    const cancelled = await inspectPathSpace(root, { signal: AbortSignal.abort(), metadataProvider: () => { throw new Error('must not read') } })
    expect(cancelled).toMatchObject({ state: 'partial', stopReason: 'cancelled', files: 0 })
  })

  it('treats unavailable metadata and directory errors as incomplete coverage', async () => {
    const result = await inspectPathSpace(path.join(fixture(), 'missing'), { metadataProvider: async () => { throw new Error('denied') } })
    expect(result).toMatchObject({ state: 'partial', errors: 1, allocatedBytes: null })
  })

  it('rejects relative paths before consulting metadata', async () => {
    await expect(inspectPathSpace('../relative')).rejects.toThrow('绝对路径')
  })

  it('measures real local metadata and hard links without opening file contents', async () => {
    const root = fixture(), file = path.join(root, '中文-file.dat'), linked = path.join(root, '中文-linked.dat')
    fs.writeFileSync(file, Buffer.alloc(65536, 5))
    fs.linkSync(file, linked)
    const rows = await nativeMetadata([file, linked], { cacheDirectory: path.join(root, 'native') })
    expect(rows[0].identity).toBe(rows[1].identity)
    expect(rows[0].logicalBytes).toBe(65536)
    expect(rows[0].allocatedBytes).toBeGreaterThan(0)
    expect(rows[0].linkCount).toBe(2)
    expect(fs.readFileSync(file).length).toBe(65536)
  }, 15000)

  it.skipIf(process.platform !== 'win32')('measures real sparse and compressed fixture allocations', async () => {
    const root = fixture(), sparse = path.join(root, 'sparse.dat'), compressed = path.join(root, 'compressed.dat')
    const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
    fs.writeFileSync(sparse, '')
    // These fixed commands affect only newly-created, owned fixture files.
    await promisify(execFile)(path.join(system, 'fsutil.exe'), ['sparse', 'setflag', sparse], { windowsHide: true })
    fs.truncateSync(sparse, 8 * 1024 * 1024)
    fs.writeFileSync(compressed, Buffer.alloc(256 * 1024, 65))
    await promisify(execFile)(path.join(system, 'compact.exe'), ['/C', '/I', '/Q', compressed], { windowsHide: true })
    const rows = await nativeMetadata([sparse, compressed], { cacheDirectory: path.join(root, 'native') })
    expect(rows[0].attributes & 512).toBe(512)
    expect(rows[0].logicalBytes).toBe(8 * 1024 * 1024)
    expect(rows[0].allocatedBytes).toBeLessThan(rows[0].logicalBytes)
    expect(rows[1].attributes & 2048).toBe(2048)
    expect(rows[1].allocatedBytes).toBeLessThan(rows[1].logicalBytes)
  }, 15000)
})
