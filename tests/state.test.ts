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
    expect(recovered.read().cleanupJobs).toEqual([{ id: 'first' }])
  })

  it('preserves a valid backup after recovering from malformed primary state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-state-'))
    temporaryRoots.push(root)
    const file = path.join(root, 'state.json')
    const initial = store(file)
    initial.read().cleanupJobs = [{ id: 'safe' }]
    initial.save()
    initial.read().cleanupJobs = [{ id: 'newer' }]
    initial.save()
    fs.writeFileSync(file, '{broken', 'utf8')

    const recovered = store(file)
    expect(recovered.read().cleanupJobs).toEqual([{ id: 'safe' }])
    recovered.save()
    fs.writeFileSync(file, '{broken-again', 'utf8')

    expect(store(file).read().cleanupJobs).toEqual([{ id: 'safe' }])
  })

  it('migrates older state without losing cleanup history and initializes exclusions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-state-'))
    temporaryRoots.push(root)
    const file = path.join(root, 'state.json')
    fs.writeFileSync(file, JSON.stringify({ version: 1, cleanupJobs: [{ id: 'legacy' }] }), 'utf8')

    const migrated = store(file).read()

    expect(migrated.version).toBe(4)
    expect(migrated.cleanupJobs).toEqual([{ id: 'legacy' }])
    expect(migrated.cleanupExclusions).toEqual([])
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
})
