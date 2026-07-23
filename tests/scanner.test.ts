// @ts-expect-error CommonJS desktop module is intentionally tested from the TypeScript suite.
import { scanAsync } from '../desktop/scanner.cjs'
import { describe, expect, it } from 'vitest'

describe('async scanner', () => {
  it('reports progress and respects a small candidate budget', async () => {
    const progress: any[] = []
    const result = await scanAsync({ roots: ['C:\\Users'], limit: 2, minBytes: 1 }, { onProgress: (item: any) => progress.push(item) })
    expect(result.items.length).toBeLessThanOrEqual(2)
    expect(progress.length).toBeGreaterThan(0)
    expect(result.cancelled).toBe(false)
  })

  it('can be cancelled before traversal starts', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await scanAsync({ roots: ['C:\\'] }, { signal: controller.signal })
    expect(result.cancelled).toBe(true)
  })
})
