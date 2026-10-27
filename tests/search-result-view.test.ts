import { describe, expect, it } from 'vitest'
// @ts-expect-error Desktop result views are CommonJS.
import { createResultView } from '../desktop/search-result-view.cjs'

function random(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 0x100000000
  }
}

describe('exact paged result view', () => {
  it('matches a complete stable sort for shuffled candidates and every page', () => {
    const next = random(42)
    for (const count of [0, 1, 17, 257, 4103]) {
      const keys = Array.from({ length: count }, () => Math.floor(next() * 23))
      const indices = Array.from({ length: count }, (_, index) => index)
      for (let index = count - 1; index > 0; index--) {
        const other = Math.floor(next() * (index + 1))
        ;[indices[index], indices[other]] = [indices[other], indices[index]]
      }
      const compare = (a: number, b: number) => keys[a]! - keys[b]!
      const expected = [...indices].sort(compare)
      const view = createResultView(indices, compare, { runSize: 31 })
      expect(view.total).toBe(count)
      const all: number[] = []
      for (let start = 0; start < count; start += 19) {
        const page = Array.from(view.range(start, start + 19)) as number[]
        expect(page).toEqual(expected.slice(start, start + 19))
        all.push(...page)
      }
      expect(all).toEqual(expected)
      expect(Array.from(view.range(count, count + 100))).toEqual([])
    }
  })

  it('supports sequential candidates, singleton data and input-stable ties', () => {
    const ties = [90, 8, 20, 2, 77, 1, 20]
    const view = createResultView(ties, () => 0, { runSize: 2 })
    expect(Array.from(view.range(0, 100))).toEqual(ties)
    expect(view.indexAt(0)).toBe(90)
    expect(view.indexAt(ties.length)).toBeUndefined()
    const sequential = createResultView(4097, (a: number, b: number) => b - a)
    expect(Array.from(sequential.range(0, 4))).toEqual([4096, 4095, 4094, 4093])
    expect(Array.from(createResultView(1, () => 0).range(0, 10))).toEqual([0])
    expect(createResultView(0, () => 0).indexAt(0)).toBeUndefined()
  })

  it('merges only the requested prefix and reuses it for repeated or overlapping pages', () => {
    let comparisons = 0
    const view = createResultView(10000, (a: number, b: number) => { comparisons++; return b - a }, { runSize: 32 })
    comparisons = 0
    expect(Array.from(view.range(0, 10))).toEqual(Array.from({ length: 10 }, (_, index) => 9999 - index))
    // An eager merge would need to select all 10000 results.
    expect(comparisons).toBeLessThan(500)
    comparisons = 0
    expect(Array.from(view.range(3, 8))).toEqual([9996, 9995, 9994, 9993, 9992])
    expect(comparisons).toBe(0)
    expect(Array.from(view.range(9990, 10050))).toEqual(Array.from({ length: 10 }, (_, index) => 9 - index))
    comparisons = 0
    expect(view.indexAt(9995)).toBe(4)
    expect(comparisons).toBe(0)
  })

  it('owns candidate indices and does not expose mutable internal page storage', () => {
    const indices = new Uint32Array([2, 0, 1])
    const view = createResultView(indices, () => 0, { runSize: 1 })
    indices.fill(100)
    const page = view.range(0, 2)
    expect(Array.from(page)).toEqual([2, 0])
    page.fill(200)
    expect(Array.from(view.range(0, 3))).toEqual([2, 0, 1])
  })

  it('checks cancellation while preparing runs and merging a distant page', () => {
    let checks = 0
    expect(() => createResultView(10000, (a: number, b: number) => b - a, {
      assertActive() { if (++checks === 3) throw new Error('cancel sort') },
    })).toThrow('cancel sort')
    let cancelled = false
    checks = 0
    const view = createResultView(10000, (a: number, b: number) => b - a, {
      assertActive() { if (cancelled && ++checks === 3) throw new Error('cancel merge') },
    })
    cancelled = true
    expect(() => view.range(9000, 9100)).toThrow('cancel merge')
    cancelled = false
    expect(() => view.range(0, 100)).toThrow('cancel merge')
  })

  it('rejects invalid counts, indices, run sizes and page positions', () => {
    for (const count of [-1, 0.1, NaN]) expect(() => createResultView(count, () => 0)).toThrow(RangeError)
    expect(() => createResultView([-1], () => 0)).toThrow(RangeError)
    expect(() => createResultView(1, () => 0, { runSize: 0 })).toThrow(RangeError)
    const view = createResultView(10, () => 0)
    expect(() => view.range(3, 2)).toThrow(RangeError)
    expect(() => view.indexAt(-1)).toThrow(RangeError)
    expect(() => view.ensure(0.5)).toThrow(RangeError)
  })
})
