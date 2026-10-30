// @ts-expect-error CommonJS desktop module is intentionally tested from the TypeScript suite.
import { createFileSearchWorkerService } from '../desktop/file-search-client.cjs'
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error CommonJS index builder.
import { createFileSearchService } from '../desktop/file-search.cjs'

const temporaryDirectories: string[] = []
const services: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  while (services.length) await services.pop()?.close()
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop()
    if (directory) fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('file search worker service', () => {
  it('searches the committed index while the writer event loop is blocked in publication', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-wal-reader-'))
    temporaryDirectories.push(root)
    fs.writeFileSync(path.join(root, 'reader-report.txt'), 'old')
    const databasePath = path.join(root, '.state', 'search.sqlite')
    const builder = createFileSearchService({ databasePath, nativeEnumeration: false })
    await builder.rebuild({ roots: [root] })
    await builder.waitForIdle()
    await builder.close()
    let publishing!: () => void
    const started = new Promise<void>(resolve => { publishing = resolve })
    const service = createFileSearchWorkerService({ databasePath,
      workerPath: path.resolve('tests/fixtures/blocked-search-writer.cjs'),
      onProgress: (state: any) => { if (state.phase === 'publishing') publishing() }
    })
    services.push(service)
    const publication = service.rebuild({ roots: [root] })
    await started
    const during = await service.search({ query: 'reader-report' })
    expect(during.items[0].size).toBe(3)
    await publication
    const after = await service.search({ query: 'reader-report' })
    expect(after.items[0].size).toBe(999)
  })
  it('builds and queries the persistent index outside the caller thread', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-worker-search-'))
    temporaryDirectories.push(root)
    fs.mkdirSync(path.join(root, 'Documents'), { recursive: true })
    fs.writeFileSync(path.join(root, 'Documents', 'worker-report.docx'), 'fixture')
    const service = createFileSearchWorkerService({
      databasePath: path.join(root, '.state', 'search.sqlite'),
      getVolumeRoots: async () => [root]
    })
    services.push(service)

    const started = await service.rebuild({ roots: [root] })
    expect(started.started).toBe(true)
    const status = await service.waitForIdle()
    expect(status).toMatchObject({ phase: 'ready', indexed: true })

    const result = await service.search({
      query: 'worker-report',
      scope: 'all',
      kind: 'document',
      modified: 'any',
      sort: 'relevance'
    })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ name: 'worker-report.docx', searchKind: 'document' })
    const overlapping = await Promise.allSettled([
      service.search({ query: 'worker' }),
      service.search({ query: 'report' }),
      service.search({ query: 'worker-report' })
    ])
    expect(overlapping[2].status).toBe('fulfilled')
    for (const previous of overlapping.slice(0, 2)) {
      if (previous.status === 'rejected') expect(previous.reason.code).toBe('SEARCH_SUPERSEDED')
    }
    await service.checkpoint()
    await expect(service.search({ query: 'worker-report' })).rejects.toMatchObject({ code: 'SEARCH_PAUSED' })
    await service.startAutomatic()
    expect((await service.search({ query: 'worker-report' })).items[0].name).toBe('worker-report.docx')
  })
})
