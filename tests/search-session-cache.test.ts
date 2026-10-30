import { describe, expect, it } from 'vitest'
// @ts-expect-error Desktop session cache is CommonJS.
import { createSessionCache, estimateSessionBytes } from '../desktop/search-session-cache.cjs'

describe('bounded search session retention', () => {
  const byBytes = (value: { bytes: number }) => value.bytes

  it('keeps useful sessions when an oversized one is used for the current request', () => {
    const cache = createSessionCache({ maxSessions: 4, maxBytes: 100, estimate: byBytes })
    const small = { bytes: 25 }, giant = { bytes: 1000, resultCount: 900000 }
    expect(cache.set('small', small)).toBe(true)
    expect(cache.set('giant', giant)).toBe(false)
    expect(giant.resultCount).toBe(900000)
    expect(cache.get('small')).toBe(small)
    expect(cache.get('giant')).toBeUndefined()
    expect(cache.stats()).toMatchObject({ size: 1, estimatedBytes: 25, rejected: 1 })
  })

  it('evicts least-recently-used sessions after both get and predicate lookup', () => {
    const cache = createSessionCache({ maxSessions: 2, maxBytes: 100, estimate: byBytes })
    cache.set('a', { bytes: 20, query: 'a' }); cache.set('b', { bytes: 20, query: 'b' })
    cache.get('a')
    cache.set('c', { bytes: 20, query: 'c' })
    expect(cache.get('b')).toBeUndefined()
    expect(cache.find((value: { query: string }) => value.query === 'a')).toMatchObject({ query: 'a' })
    cache.set('d', { bytes: 20, query: 'd' })
    expect(cache.get('c')).toBeUndefined()
    expect(cache.get('a')).toMatchObject({ query: 'a' })
    expect(cache.stats()).toMatchObject({ size: 2, estimatedBytes: 40, evictions: 2 })
  })

  it('remeasures growing sort views and removes only an individually oversized session', () => {
    const cache = createSessionCache({ maxBytes: 100, estimate: byBytes })
    const growing = { bytes: 30 }, steady = { bytes: 30 }
    cache.set('growing', growing); cache.set('steady', steady)
    growing.bytes = 120
    expect(cache.refresh('growing')).toBe(false)
    expect(cache.get('growing')).toBeUndefined()
    expect(cache.get('steady')).toBe(steady)
    expect(cache.stats().estimatedBytes).toBe(30)
    expect(cache.refresh('missing')).toBe(false)
  })

  it('enforces the total budget when a surviving view grows within its own budget', () => {
    const cache = createSessionCache({ maxBytes: 100, estimate: byBytes })
    const active = { bytes: 30 }
    cache.set('older', { bytes: 30 }); cache.set('active', active); cache.set('other', { bytes: 30 })
    active.bytes = 60
    expect(cache.refresh('active')).toBe(true)
    expect(cache.get('older')).toBeUndefined()
    expect(cache.get('other')).toMatchObject({ bytes: 30 })
    expect(cache.stats()).toMatchObject({ size: 2, estimatedBytes: 90 })
  })

  it('reaccounts shared buffers after evicting their original owner', () => {
    const shared = new ArrayBuffer(70)
    const estimate = (value: { buffer: ArrayBuffer; bytes: number }, accounting: { buffers: Set<ArrayBuffer> }) => {
      const bytes = accounting.buffers.has(value.buffer) ? 0 : value.buffer.byteLength
      accounting.buffers.add(value.buffer)
      return bytes + value.bytes
    }
    const cache = createSessionCache({ maxBytes: 100, estimate })
    cache.set('owner', { buffer: shared, bytes: 10 })
    cache.set('shared', { buffer: shared, bytes: 10 })
    expect(cache.stats().estimatedBytes).toBe(90)
    cache.set('fresh', { buffer: new ArrayBuffer(30), bytes: 0 })
    expect(cache.get('owner')).toBeUndefined()
    expect(cache.get('shared')).toBeUndefined()
    expect(cache.stats()).toMatchObject({ size: 1, estimatedBytes: 30 })
  })

  it('counts the whole retained ArrayBuffer once even when only short views are exposed', () => {
    const buffer = new ArrayBuffer(1024)
    const shared = { ids: new Uint8Array(buffer, 0, 8), ranks: new Uint8Array(buffer, 8, 8) }
    const separate = { ids: new Uint8Array(new ArrayBuffer(1024), 0, 8), ranks: new Uint8Array(new ArrayBuffer(1024), 8, 8) }
    expect(estimateSessionBytes(separate) - estimateSessionBytes(shared)).toBe(1024)
    const context = { buffers: new Set(), objects: new Set() }
    expect(estimateSessionBytes(shared, context)).toBeGreaterThanOrEqual(1024)
    expect(estimateSessionBytes(shared, context)).toBe(0)
  })

  it('includes hidden view storage and can release all retained references', () => {
    let mergedBytes = 0
    const session = { candidates: new Uint32Array(8), view: { estimatedBytes: () => mergedBytes } }
    const cache = createSessionCache({ maxBytes: 1000 })
    cache.set('session', session)
    const initial = cache.stats().estimatedBytes
    mergedBytes = 80
    cache.refresh('session')
    expect(cache.stats().estimatedBytes).toBe(initial + 80)
    expect(cache.delete('session')).toBe(true)
    expect(cache.stats().estimatedBytes).toBe(0)
    cache.set('session', session); cache.clear()
    expect(cache.get('session')).toBeUndefined()
    expect(cache.stats()).toMatchObject({ size: 0, estimatedBytes: 0 })
  })

  it('supports disabling retention and rejects invalid budget or estimator contracts', () => {
    for (const options of [{ maxSessions: 0 }, { maxBytes: 0 }]) {
      const cache = createSessionCache({ ...options, estimate: byBytes })
      expect(cache.set('request', { bytes: 1 })).toBe(false)
      expect(cache.stats().size).toBe(0)
    }
    expect(() => createSessionCache({ maxBytes: -1 })).toThrow(RangeError)
    expect(() => createSessionCache({ maxSessions: 1.5 })).toThrow(RangeError)
    const invalid = createSessionCache({ estimate: () => NaN })
    expect(() => invalid.set('invalid', {})).toThrow(RangeError)
  })

  it('rejects oversized snapshots even when pinned without evicting useful sessions', () => {
    const cache = createSessionCache({ maxBytes: 100, estimate: byBytes })
    const giant = { bytes: 1000 }
    cache.set('small', { bytes: 25 })
    expect(cache.set('giant', giant, { pin: true })).toBe(false)
    expect(cache.get('giant')).toBeUndefined()
    expect(cache.get('small')).toMatchObject({ bytes: 25 })
    expect(cache.stats()).toMatchObject({ size: 1, overBudget: false, oversizedPinned: false })
    cache.set('next', { bytes: 25 }, { pin: true })
    expect(cache.get('giant')).toBeUndefined()
    expect(cache.stats()).toMatchObject({ size: 2, estimatedBytes: 50, overBudget: false, oversizedPinned: false })
  })

  it('removes a pinned snapshot that grows beyond the hard retained budget', () => {
    const cache = createSessionCache({ maxBytes: 100, estimate: byBytes })
    const active = { bytes: 20 }
    cache.set('active', active, { pin: true })
    cache.set('other', { bytes: 20 })
    active.bytes = 200
    expect(cache.refresh('active', { pin: true })).toBe(false)
    expect(cache.get('active')).toBeUndefined()
    expect(cache.get('other')).toMatchObject({ bytes: 20 })
    expect(cache.stats().oversizedPinned).toBe(false)
  })
})
