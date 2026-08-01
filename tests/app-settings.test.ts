import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error CommonJS desktop module is intentionally tested from TypeScript.
import { directoryUsage, finalizePendingMigration, migrateDataDirectory, migrationTarget, normalizeTheme, resolveDataLocation } from '../desktop/app-settings.cjs'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-settings-'))
  temporaryRoots.push(root)
  return root
}

describe('application settings and data placement', () => {
  it('accepts only supported themes', () => {
    expect(normalizeTheme('light')).toBe('light')
    expect(normalizeTheme('system')).toBe('dark')
    expect(normalizeTheme(null)).toBe('dark')
  })

  it('uses an external data directory without reading a persistent pointer', () => {
    const root = temporaryRoot()
    const external = path.join(root, 'isolated')
    const result = resolveDataLocation({
      appDataPath: path.join(root, 'app-data'),
      environment: { DISK_SENSE_USER_DATA: external }
    })
    expect(result.userDataPath).toBe(path.resolve(external))
    expect(result.externallyManaged).toBe(true)
    expect(result.pointerFile).toBeNull()
  })

  it('counts local data without following symbolic links', async () => {
    const root = temporaryRoot()
    fs.mkdirSync(path.join(root, 'nested'))
    fs.writeFileSync(path.join(root, 'state.json'), '1234')
    fs.writeFileSync(path.join(root, 'nested', 'changes.json'), '123456')
    const result = await directoryUsage(root)
    expect(result.bytes).toBe(10)
    expect(result.files).toBe(2)
    expect(result.truncated).toBe(false)
  })

  it('copies and validates owned data before switching the startup pointer', async () => {
    const root = temporaryRoot()
    const source = path.join(root, 'source')
    const destinationParent = path.join(root, 'destination')
    const defaultDirectory = path.join(root, 'Disk Sense')
    const pointerFile = path.join(defaultDirectory, 'data-location.json')
    fs.mkdirSync(source, { recursive: true })
    fs.mkdirSync(destinationParent, { recursive: true })
    fs.writeFileSync(path.join(source, 'disk-sense-state.json'), JSON.stringify({ version: 6, cleanupJobs: [] }))
    fs.writeFileSync(path.join(source, 'disk-sense-state.json.changes.json'), JSON.stringify({ version: 1 }))
    fs.writeFileSync(path.join(source, 'disk-sense-search.sqlite'), 'sqlite-index-fixture')

    const result = await migrateDataDirectory({
      source,
      selectedDirectory: destinationParent,
      pointerFile
    })

    const target = migrationTarget(destinationParent)
    expect(result).toMatchObject({
      changed: true,
      target,
      restartRequired: true,
      sourceRetained: true
    })
    expect(fs.existsSync(path.join(source, 'disk-sense-state.json'))).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(target, 'disk-sense-state.json'), 'utf8'))).toMatchObject({ version: 6 })
    expect(fs.readFileSync(path.join(target, 'disk-sense-search.sqlite'), 'utf8')).toBe('sqlite-index-fixture')
    expect(JSON.parse(fs.readFileSync(pointerFile, 'utf8')).path).toBe(target)
    expect(resolveDataLocation({ appDataPath: root, environment: {} }).userDataPath).toBe(target)
  })

  it('rejects a target nested inside the current data directory', async () => {
    const root = temporaryRoot()
    const source = path.join(root, 'source')
    fs.mkdirSync(path.join(source, 'nested'), { recursive: true })
    await expect(migrateDataDirectory({
      source,
      selectedDirectory: path.join(source, 'nested'),
      pointerFile: path.join(root, 'default', 'data-location.json')
    })).rejects.toThrow('不能互相包含')
  })

  it('does not overwrite a non-empty destination or update the pointer', async () => {
    const root = temporaryRoot()
    const source = path.join(root, 'source')
    const destinationParent = path.join(root, 'destination')
    const target = migrationTarget(destinationParent)
    const pointerFile = path.join(root, 'Disk Sense', 'data-location.json')
    fs.mkdirSync(source, { recursive: true })
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(source, 'disk-sense-state.json'), JSON.stringify({ version: 6 }))
    fs.writeFileSync(path.join(target, 'existing.txt'), 'keep')

    await expect(migrateDataDirectory({
      source,
      selectedDirectory: destinationParent,
      pointerFile
    })).rejects.toThrow('已包含文件')
    expect(fs.readFileSync(path.join(target, 'existing.txt'), 'utf8')).toBe('keep')
    expect(fs.existsSync(pointerFile)).toBe(false)
  })

  it('synchronizes the latest state once on the first launch from the new directory', async () => {
    const root = temporaryRoot()
    const source = path.join(root, 'source')
    const destinationParent = path.join(root, 'destination')
    const pointerFile = path.join(root, 'Disk Sense', 'data-location.json')
    fs.mkdirSync(source, { recursive: true })
    fs.mkdirSync(destinationParent, { recursive: true })
    const stateFile = path.join(source, 'disk-sense-state.json')
    fs.writeFileSync(stateFile, JSON.stringify({ version: 6, cleanupJobs: [{ id: 'before' }] }))
    const migration = await migrateDataDirectory({ source, selectedDirectory: destinationParent, pointerFile })
    fs.writeFileSync(stateFile, JSON.stringify({ version: 6, cleanupJobs: [{ id: 'after' }] }))

    const finalized = finalizePendingMigration(migration.target)

    expect(finalized.finalized).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(migration.target, 'disk-sense-state.json'), 'utf8')).cleanupJobs)
      .toEqual([{ id: 'after' }])
    expect(finalizePendingMigration(migration.target).synchronized).toBeUndefined()
  })
})
