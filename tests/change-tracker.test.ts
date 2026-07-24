// @ts-expect-error CommonJS desktop module is intentionally tested from the TypeScript suite.
import { diff, inventory, INVENTORY_SCHEMA_VERSION } from '../desktop/change-tracker.cjs'
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('change tracker', () => {
  it('detects added, removed, modified and moved entries', () => {
    const before = { entries: [{ path: 'C:/old.txt', kind: 'file', size: 2, modifiedAt: 1 }, { path: 'C:/same.txt', kind: 'file', size: 2, modifiedAt: 1 }, { path: 'C:/move.txt', kind: 'file', size: 3, modifiedAt: 2 }] }
    const after = { entries: [{ path: 'C:/new.txt', kind: 'file', size: 4, modifiedAt: 3 }, { path: 'C:/same.txt', kind: 'file', size: 5, modifiedAt: 4 }, { path: 'D:/move.txt', kind: 'file', size: 3, modifiedAt: 2 }] }
    const result = diff(before, after)
    expect(result.summary.added).toBe(1)
    expect(result.summary.removed).toBe(1)
    expect(result.summary.modified).toBe(1)
    expect(result.summary.moved).toBe(1)
    expect(result.moved[0].from).toBe('C:/move.txt')
  })

  it('does not guess a move when duplicate fingerprints are ambiguous', () => {
    const before = {
      entries: [
        { path: 'C:/one.bin', kind: 'file', size: 8, modifiedAt: 2 },
        { path: 'C:/two.bin', kind: 'file', size: 8, modifiedAt: 2 }
      ]
    }
    const after = {
      entries: [{ path: 'D:/one.bin', kind: 'file', size: 8, modifiedAt: 2 }]
    }
    const result = diff(before, after)
    expect(result.moved).toHaveLength(0)
    expect(result.added).toHaveLength(1)
    expect(result.removed).toHaveLength(2)
  })

  it('does not classify directories as moved from size and timestamp alone', () => {
    const before = { entries: [{ path: 'C:/old', kind: 'directory', size: 0, modifiedAt: 2 }] }
    const after = { entries: [{ path: 'D:/new', kind: 'directory', size: 0, modifiedAt: 2 }] }
    const result = diff(before, after)
    expect(result.moved).toHaveLength(0)
    expect(result.added).toHaveLength(1)
    expect(result.removed).toHaveLength(1)
  })

  it('does not report additions or removals outside the overlap of two partial scans', () => {
    const before = {
      truncated: true,
      scannedDirectories: ['C:/covered'],
      entries: [
        { path: 'C:/covered/removed.txt', kind: 'file', size: 8, modifiedAt: 2 },
        { path: 'C:/not-covered/unknown.txt', kind: 'file', size: 8, modifiedAt: 2 }
      ]
    }
    const after = {
      truncated: true,
      scannedDirectories: ['C:/covered'],
      entries: [
        { path: 'C:/covered/added.txt', kind: 'file', size: 8, modifiedAt: 3 },
        { path: 'C:/another-uncovered/unknown.txt', kind: 'file', size: 8, modifiedAt: 3 }
      ]
    }
    const result = diff(before, after)
    expect(result.added.map((item: any) => item.path)).toEqual(['C:/covered/added.txt'])
    expect(result.removed.map((item: any) => item.path)).toEqual(['C:/covered/removed.txt'])
    expect(result.coverage.partial).toBe(true)
  })

  it('aggregates descendant bytes when a whole directory appears or disappears', () => {
    const before = {
      scannedDirectories: ['C:/'],
      entries: []
    }
    const after = {
      scannedDirectories: ['C:/', 'C:/new-folder'],
      entries: [
        { path: 'C:/new-folder', kind: 'directory', size: 0, modifiedAt: 1 },
        { path: 'C:/new-folder/one.bin', kind: 'file', size: 8, modifiedAt: 1 },
        { path: 'C:/new-folder/two.bin', kind: 'file', size: 12, modifiedAt: 1 }
      ]
    }
    const added = diff(before, after)
    expect(added.added).toHaveLength(1)
    expect(added.added[0]).toMatchObject({ treeBytes: 20, treeFileCount: 2 })
    expect(added.summary.addedBytes).toBe(20)

    const removed = diff(after, before)
    expect(removed.removed).toHaveLength(1)
    expect(removed.summary.removedBytes).toBe(20)
  })

  it('does not report a directory as modified only because its timestamp changed', () => {
    const before = { entries: [{ path: 'C:/folder', kind: 'directory', size: 0, modifiedAt: 1 }] }
    const after = { entries: [{ path: 'C:/folder', kind: 'directory', size: 0, modifiedAt: 2 }] }
    expect(diff(before, after).modified).toHaveLength(0)
  })

  it('gives every requested root a fair inventory budget', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-change-'))
    const first = path.join(temporary, 'first')
    const second = path.join(temporary, 'second')
    fs.mkdirSync(first)
    fs.mkdirSync(second)
    try {
      for (let index = 0; index < 20; index++) {
        fs.writeFileSync(path.join(first, `first-${index}.txt`), 'a')
        fs.writeFileSync(path.join(second, `second-${index}.txt`), 'b')
      }
      const snapshot = await inventory({ roots: [first, second], maxEntries: 10, maxMs: 5000 })
      expect(snapshot.schemaVersion).toBe(INVENTORY_SCHEMA_VERSION)
      expect(snapshot.rootCoverage).toHaveLength(2)
      expect(snapshot.rootCoverage.every((root: any) => root.entries > 0)).toBe(true)
      expect(snapshot.rootCoverage.map((root: any) => root.entries)).toEqual([5, 5])
      expect(snapshot.truncated).toBe(true)
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true })
    }
  })
})
