// @ts-expect-error CommonJS desktop module is intentionally tested from the TypeScript suite.
import { stateSummary, volumeMetrics } from '../desktop/system-info.cjs'
import { describe, expect, it } from 'vitest'

describe('system overview', () => {
  it('calculates volume usage from filesystem blocks', () => {
    const result = volumeMetrics('C:\\', { bsize: 4096n, blocks: 1000n, bavail: 250n }, 'C:')
    expect(result.totalBytes).toBe(4_096_000)
    expect(result.freeBytes).toBe(1_024_000)
    expect(result.usagePercent).toBe(75)
    expect(result.isSystem).toBe(true)
  })

  it('summarizes cleanup activity without treating recycle-bin bytes as already reclaimed', () => {
    const result = stateSummary({
      cleanupJobs: [
        { createdAt: '2026-01-02', succeeded: 2, movedToTrashBytes: 500 },
        { createdAt: '2026-01-01', succeeded: 1, movedToTrashBytes: 250 }
      ],
      cleanupExclusions: [{ id: 'one' }]
    })
    expect(result.movedToTrashBytes).toBe(750)
    expect(result.movedToTrashFiles).toBe(3)
    expect(result.exclusionCount).toBe(1)
  })
})
