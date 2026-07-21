import { describe, expect, it } from 'vitest'
// @ts-expect-error CommonJS desktop adapter is type-checked separately.
import { candidates } from '../desktop/duplicates.cjs'

describe('duplicate candidates', () => {
  it('groups same-size same-extension files as candidates', () => {
    const result = candidates([{ path: 'C:/a.zip', size: 100 }, { path: 'D:/b.zip', size: 100 }, { path: 'C:/c.txt', size: 30 }])
    expect(result).toHaveLength(1); expect(result[0].reclaimable).toBe(100)
  })
})
