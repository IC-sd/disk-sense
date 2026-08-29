// @ts-expect-error CommonJS desktop module is intentionally tested from the TypeScript suite.
import { store } from '../desktop/state.cjs'
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('local state durability', () => {
  it('recovers the previous valid state when the primary JSON is malformed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-state-'))
    temporaryRoots.push(root)
    const file = path.join(root, 'state.json')
    const first = store(file)
    first.read().cleanupJobs = [{ id: 'first' }]
    first.save()
    first.read().cleanupJobs = [{ id: 'second' }]
    first.save()
    fs.writeFileSync(file, '{invalid json', 'utf8')

    const recovered = store(file)
    expect(recovered.read().cleanupJobs).toEqual([{ id: 'second' }])
  })

  it('recovers operation history from its own valid backup', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-state-'))
    temporaryRoots.push(root)
    const file = path.join(root, 'state.json')
    const initial = store(file)
    initial.read().cleanupJobs = [{ id: 'safe' }]
    initial.save()
    initial.read().cleanupJobs = [{ id: 'newer' }]
    initial.save()
    const operationFile = `${file}.operations.json`
    fs.writeFileSync(operationFile, '{broken', 'utf8')

    const recovered = store(file)
    expect(recovered.read().cleanupJobs).toEqual([{ id: 'safe' }])
    recovered.save()
    fs.writeFileSync(operationFile, '{broken-again', 'utf8')

    expect(store(file).read().cleanupJobs).toEqual([{ id: 'safe' }])
  })

  it('migrates older state without losing cleanup history and initializes exclusions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-state-'))
    temporaryRoots.push(root)
    const file = path.join(root, 'state.json')
    fs.writeFileSync(file, JSON.stringify({ version: 1, cleanupJobs: [{ id: 'legacy' }] }), 'utf8')

    const migrated = store(file).read()

    expect(migrated.version).toBe(7)
    expect(migrated.cleanupJobs).toEqual([{ id: 'legacy' }])
    expect(migrated.maintenanceJobs).toEqual([])
    expect(migrated.aiAnalyses).toEqual([])
    expect(migrated.cleanupExclusions).toEqual([])
    expect(migrated.appearance).toEqual({ theme: 'dark' })
  })

  it('stores large change snapshots separately from frequently updated settings', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-state-'))
    temporaryRoots.push(root)
    const file = path.join(root, 'state.json')
    const database = store(file)
    database.read().changeBaseline = {
      createdAt: '2026-01-01',
      entries: Array.from({ length: 1000 }, (_, index) => ({ path: `C:\\file-${index}`, size: index }))
    }
    database.read().cleanupExclusions = [{ id: 'keep' }]
    database.save()

    const light = JSON.parse(fs.readFileSync(file, 'utf8'))
    const heavyFile = `${file}.changes.json`
    expect(light.changeBaseline).toBeUndefined()
    expect(fs.existsSync(heavyFile)).toBe(true)
    expect(fs.statSync(file).size).toBeLessThan(fs.statSync(heavyFile).size)

    const reloaded = store(file).read()
    expect(reloaded.changeBaseline.entries).toHaveLength(1000)
    expect(reloaded.cleanupExclusions).toEqual([{ id: 'keep' }])
  })

  it('stores operation history and AI analyses separately from frequently updated settings', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-state-'))
    temporaryRoots.push(root)
    const file = path.join(root, 'state.json')
    const database = store(file)
    database.read().cleanupJobs = [{ id: 'cleanup', results: Array.from({ length: 500 }, (_, index) => ({ path: `C:\\temp-${index}` })) }]
    database.read().maintenanceJobs = [{ id: 'maintenance' }]
    database.read().aiAnalyses = [{ path: 'C:\\sample', raw: 'analysis'.repeat(1000) }]
    database.read().cleanupExclusions = [{ id: 'keep' }]
    database.save()

    const light = JSON.parse(fs.readFileSync(file, 'utf8'))
    const operationFile = `${file}.operations.json`
    const analysisFile = `${file}.analyses.json`
    expect(light.cleanupJobs).toBeUndefined()
    expect(light.maintenanceJobs).toBeUndefined()
    expect(light.aiAnalyses).toBeUndefined()
    expect(fs.existsSync(operationFile)).toBe(true)
    expect(fs.existsSync(analysisFile)).toBe(true)
    expect(fs.statSync(file).size).toBeLessThan(fs.statSync(operationFile).size)
    expect(fs.statSync(file).size).toBeLessThan(fs.statSync(analysisFile).size)

    const reloaded = store(file).read()
    expect(reloaded.cleanupJobs[0].results).toHaveLength(500)
    expect(reloaded.maintenanceJobs).toEqual([{ id: 'maintenance' }])
    expect(reloaded.aiAnalyses[0].path).toBe('C:\\sample')
    expect(reloaded.cleanupExclusions).toEqual([{ id: 'keep' }])
  })

  it('persists the selected interface theme', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-state-'))
    temporaryRoots.push(root)
    const file = path.join(root, 'state.json')
    const database = store(file)
    database.read().appearance = { theme: 'light' }
    database.save()

    expect(store(file).read().appearance).toEqual({ theme: 'light' })
  })
})
