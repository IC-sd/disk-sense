import { describe, expect, it } from 'vitest'
import { aggregateSources, recommend, snapshotDelta } from '../src/application/space-service'
import type { SpaceObservation, StorageSnapshot } from '../src/domain/storage'

const item = (overrides: Partial<SpaceObservation> = {}): SpaceObservation => ({ id: '1', path: 'C:/x', volume: 'C:', size: 100, fileCount: 1, classification: 'rebuildable-cache', source: 'Cache', risk: 'low', confidence: .9, evidence: [], actions: ['trash'], ...overrides })

describe('space service', () => {
  it('aggregates observations by classification and source', () => {
    const result = aggregateSources([item(), item({ id: '2', size: 200 })])
    expect(result).toHaveLength(1); expect(result[0].bytes).toBe(300); expect(result[0].count).toBe(2)
  })
  it('recommends cleanup only for low-risk rebuildable cache', () => {
    const source = aggregateSources([item()])[0]
    expect(recommend(source)?.defaultAction).toBe('trash')
    expect(recommend(aggregateSources([item({ classification: 'unknown', source: 'Unknown', risk: 'unknown' })])[0])).toBeNull()
  })
  it('reports growth between snapshots', () => {
    const make = (bytes: number): StorageSnapshot => ({ id: String(bytes), createdAt: '', durationMs: 1, volumes: ['C:'], skipped: 0, errors: [], sources: [{ id: 'cache:Cache', title: 'Cache', classification: 'rebuildable-cache', bytes, count: 1, risk: 'low', observations: [] }] })
    expect(snapshotDelta(make(100), make(250))[0].delta).toBe(150)
  })
})
