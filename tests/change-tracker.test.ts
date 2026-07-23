// @ts-expect-error CommonJS desktop module is intentionally tested from the TypeScript suite.
import { diff } from '../desktop/change-tracker.cjs'
import { describe, expect, it } from 'vitest'

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
})
