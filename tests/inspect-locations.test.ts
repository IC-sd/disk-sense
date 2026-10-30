import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
// @ts-expect-error CommonJS desktop module.
import { availableLocations } from '../desktop/handlers/inspect-handlers.cjs'

it('keeps accessible folders and drive roots when a Windows known folder cannot be resolved', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'disk-sense-locations-'))
  try {
    const documents = path.join(root, 'Documents')
    const drive = path.join(root, 'Drive')
    const file = path.join(root, 'not-a-directory')
    await mkdir(documents)
    await mkdir(drive)
    await writeFile(file, '')
    const app = { getPath(key: string) {
      if (key === 'desktop') throw new Error("Failed to get 'desktop' path")
      return { home: root, documents, downloads: file }[key]
    } }
    await expect(availableLocations(app, [root, drive, path.join(root, 'missing')])).resolves.toEqual([
      { name: '个人文件', path: root },
      { name: '文档', path: documents },
      { name: drive, path: drive }
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
