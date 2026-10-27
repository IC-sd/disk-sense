import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error CommonJS desktop module is intentionally tested from TypeScript.
import { coordinateDataMigration, directoryUsage, finalizePendingMigration, migrateDataDirectory, migrationTarget, normalizeTheme, resolveDataLocation } from '../desktop/app-settings.cjs'

const temporaryRoots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-settings-'))
  temporaryRoots.push(root)
  return root
}

describe('application settings and data placement', () => {
  it('attempts to resume search when checkpoint preparation itself fails', async () => {
    const resume = vi.fn()
    await expect(coordinateDataMigration({
      checkpoint: async () => { throw new Error('checkpoint failed') },
      saveState: vi.fn(),
      migrate: vi.fn(),
      resume
    })).rejects.toThrow('checkpoint failed')
    expect(resume).toHaveBeenCalledOnce()
  })

  it('resumes automatic search when saving state fails after the index checkpoint', async () => {
    const calls: string[] = []
    await expect(coordinateDataMigration({
      checkpoint: async () => { calls.push('checkpoint') },
      saveState: () => { calls.push('save'); throw new Error('save failed') },
      migrate: async () => { calls.push('migrate'); return { changed: true } },
      resume: async () => { calls.push('resume') }
    })).rejects.toThrow('save failed')
    expect(calls).toEqual(['checkpoint', 'save', 'resume'])
  })

  it('keeps search paused after a successful migration that requires restart', async () => {
    const resume = vi.fn()
    const result = await coordinateDataMigration({
      checkpoint: vi.fn(),
      saveState: vi.fn(),
      migrate: async () => ({ changed: true, restartRequired: true }),
      resume
    })
    expect(result.changed).toBe(true)
    expect(resume).not.toHaveBeenCalled()
  })

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
    fs.writeFileSync(path.join(source, 'disk-sense-state.json'), JSON.stringify({ version: 7 }))
    fs.writeFileSync(path.join(source, 'disk-sense-state.json.changes.json'), JSON.stringify({ version: 1 }))
    fs.writeFileSync(path.join(source, 'disk-sense-state.json.operations.json'), JSON.stringify({ version: 1, cleanupJobs: [], maintenanceJobs: [] }))
    fs.writeFileSync(path.join(source, 'disk-sense-state.json.analyses.json'), JSON.stringify({ version: 1, aiAnalyses: [] }))
    fs.writeFileSync(path.join(source, 'disk-sense-search.sqlite'), 'sqlite-index-fixture')
    const journalId = '12345678-1234-1234-1234-123456789012'
    fs.mkdirSync(path.join(source, 'cleanup-quarantine'))
    fs.writeFileSync(path.join(source, 'cleanup-quarantine', `${journalId}.jsonl`), '{"type":"job"}\n')

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
    expect(JSON.parse(fs.readFileSync(path.join(target, 'disk-sense-state.json'), 'utf8'))).toMatchObject({ version: 7 })
    expect(JSON.parse(fs.readFileSync(path.join(target, 'disk-sense-state.json.operations.json'), 'utf8'))).toMatchObject({ version: 1 })
    expect(JSON.parse(fs.readFileSync(path.join(target, 'disk-sense-state.json.analyses.json'), 'utf8'))).toMatchObject({ version: 1 })
    expect(fs.readFileSync(path.join(target, 'disk-sense-search.sqlite'), 'utf8')).toBe('sqlite-index-fixture')
    expect(fs.readFileSync(path.join(target, 'cleanup-quarantine', `${journalId}.jsonl`), 'utf8')).toBe('{"type":"job"}\n')
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

  async function pendingMigration() {
    const root = temporaryRoot()
    const source = path.join(root, 'source')
    const pointerFile = path.join(root, 'Disk Sense', 'data-location.json')
    fs.mkdirSync(source)
    const stateName = 'disk-sense-state.json'
    const operationsName = `${stateName}.operations.json`
    fs.writeFileSync(path.join(source, stateName), JSON.stringify({ appearance: { theme: 'dark' } }))
    fs.writeFileSync(path.join(source, operationsName), JSON.stringify({ cleanupJobs: [{ id: 'before' }] }))
    const { target } = await migrateDataDirectory({ source, selectedDirectory: path.join(root, 'destination'), pointerFile })
    fs.writeFileSync(path.join(source, stateName), JSON.stringify({ appearance: { theme: 'light' } }))
    fs.writeFileSync(path.join(source, operationsName), JSON.stringify({ cleanupJobs: [{ id: 'after' }] }))
    return { root, source, target, pointerFile, stateName, operationsName }
  }

  it.each(['EACCES', 'ENOSPC'])('keeps the original directory active after a partial handoff fails with %s and retries safely', async code => {
    const fixture = await pendingMigration()
    const { root, source, target, pointerFile, stateName, operationsName } = fixture
    const rename = fs.renameSync
    const failure = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === path.join(target, operationsName)) throw Object.assign(new Error(code), { code })
      return rename(from, to)
    })
    const fallback = resolveDataLocation({ appDataPath: root, environment: {} })
    expect(fallback.userDataPath).toBe(source)
    expect(fallback.migrationRecovery).toMatchObject({ source, target })
    expect(fallback.migrationRecovery.detail).toContain(code)
    expect(fallback.migrationRecovery.message).toContain(code === 'ENOSPC' ? '可用空间不足' : '没有写入权限')
    expect(JSON.parse(fs.readFileSync(path.join(source, operationsName), 'utf8')).cleanupJobs).toEqual([{ id: 'after' }])
    expect(JSON.parse(fs.readFileSync(path.join(target, stateName), 'utf8')).appearance.theme).toBe('light')
    expect(JSON.parse(fs.readFileSync(path.join(target, operationsName), 'utf8')).cleanupJobs).toEqual([{ id: 'before' }])
    expect(fs.existsSync(path.join(target, `${operationsName}.handoff`))).toBe(false)
    expect(JSON.parse(fs.readFileSync(pointerFile, 'utf8')).path).toBe(target)
    expect(JSON.parse(fs.readFileSync(path.join(target, 'migration.json'), 'utf8')).finalizedAt).toBeUndefined()
    failure.mockRestore()

    // Activity continues against the original data until the next startup.
    fs.writeFileSync(path.join(source, operationsName), JSON.stringify({ cleanupJobs: [{ id: 'latest-on-retry' }] }))
    const retry = resolveDataLocation({ appDataPath: root, environment: {} })
    expect(retry.userDataPath).toBe(target)
    expect(retry.migrationRecovery).toBeNull()
    expect(JSON.parse(fs.readFileSync(path.join(target, operationsName), 'utf8')).cleanupJobs).toEqual([{ id: 'latest-on-retry' }])
    expect(JSON.parse(fs.readFileSync(path.join(target, 'migration.json'), 'utf8')).finalizedAt).toBeTruthy()
  })

  it('falls back even if the last completion-marker write fails', async () => {
    const { root, source, target } = await pendingMigration()
    const rename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === path.join(target, 'migration.json')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      return rename(from, to)
    })
    const result = resolveDataLocation({ appDataPath: root, environment: {} })
    expect(result.userDataPath).toBe(source)
    expect(result.migrationRecovery.detail).toContain('EACCES')
  })

  it('refuses to open an unfinished target when its original directory is unavailable', async () => {
    const { root, source, target, pointerFile } = await pendingMigration()
    expect(path.dirname(source)).toBe(root)
    fs.rmSync(source, { recursive: true, force: true })
    expect(() => resolveDataLocation({ appDataPath: root, environment: {} })).toThrow('原目录不可用')
    expect(fs.existsSync(target)).toBe(true)
    expect(JSON.parse(fs.readFileSync(pointerFile, 'utf8')).path).toBe(target)
  })

  it('refuses an unreadable migration state instead of assuming a handoff completed', async () => {
    const { root, target } = await pendingMigration()
    fs.writeFileSync(path.join(target, 'migration.json'), '{invalid')
    expect(() => resolveDataLocation({ appDataPath: root, environment: {} })).toThrow('已停止打开目标目录')
  })

  it('does not create a new empty data directory when the saved location has disappeared', async () => {
    const { root, target } = await pendingMigration()
    expect(path.dirname(path.dirname(target))).toBe(root)
    fs.rmSync(target, { recursive: true, force: true })
    expect(() => resolveDataLocation({ appDataPath: root, environment: {} })).toThrow('保存的数据目录当前不可访问')
    expect(fs.existsSync(target)).toBe(false)
  })

  it('keeps a finalized destination usable after the retained source is removed', async () => {
    const { root, source, target } = await pendingMigration()
    expect(finalizePendingMigration(target).finalized).toBe(true)
    expect(path.dirname(source)).toBe(root)
    fs.rmSync(source, { recursive: true, force: true })
    expect(resolveDataLocation({ appDataPath: root, environment: {} }).userDataPath).toBe(target)
  })
})
