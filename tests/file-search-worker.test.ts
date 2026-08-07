// @ts-expect-error CommonJS desktop module is intentionally tested from the TypeScript suite.
import { createFileSearchWorkerService } from '../desktop/file-search-client.cjs'
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
  })
})
