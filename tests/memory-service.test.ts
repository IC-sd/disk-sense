import { describe, expect, it } from 'vitest'
import { detectGrowth, memorySearch, suggestMemory } from '../src/application/memory-service'
import type { StorageSnapshot } from '../src/domain/storage'
import type { UserMemory } from '../src/domain/memory'

const snapshot = (bytes: number): StorageSnapshot => ({ id: String(bytes), createdAt: new Date().toISOString(), durationMs: 1, volumes: ['C:'], skipped: 0, errors: [], sources: [{ id: 'app:Cache', title: 'App Cache', classification: 'rebuildable-cache', bytes, count: 2, risk: 'low', observations: [] }] })

describe('memory service', () => {
  it('detects recurring growth between snapshots', () => {
    const changes = detectGrowth(snapshot(100), snapshot(300))
    expect(changes[0].kind).toBe('growth'); expect(changes[0].beforeSize).toBe(100); expect(changes[0].afterSize).toBe(300)
  })
  it('turns growth into an explicit memory suggestion', () => {
    const suggestion = suggestMemory(detectGrowth(snapshot(100), snapshot(300))[0])
    expect(suggestion?.accepted).toBe(false); expect(suggestion?.proposedContent).toContain('growing')
  })
  it('searches user memories by subject, content, and tags', () => {
    const memory: UserMemory = { id: '1', subject: 'Downloads', content: 'Move installers after one month.', tags: ['installer'], source: 'user', createdAt: '', updatedAt: '', confidence: 1 }
    expect(memorySearch([memory], 'installer')).toHaveLength(1)
  })
})
