import { describe, expect, it } from 'vitest'
// @ts-expect-error CommonJS desktop module is intentionally tested from TypeScript.
import { createOperationCoordinator } from '../desktop/operation-coordinator.cjs'

describe('foreground disk operation coordinator', () => {
  it('allows cleanup rules to scan together but blocks exclusive work', () => {
    const coordinator = createOperationCoordinator()
    const releaseOne = coordinator.acquire('cleanup-scan', 'one')
    const releaseTwo = coordinator.acquire('cleanup-scan', 'two')

    expect(coordinator.snapshot().cleanupScans).toHaveLength(2)
    expect(() => coordinator.acquire('change-scan', 'changes')).toThrow('垃圾扫描正在进行')
    expect(() => coordinator.acquire('cleanup-execute', 'cleanup')).toThrow('垃圾扫描正在进行')

    releaseOne()
    releaseTwo()
    expect(coordinator.snapshot().cleanupScans).toHaveLength(0)
  })

  it('keeps change scans, cleanup execution and maintenance mutually exclusive', () => {
    const coordinator = createOperationCoordinator()
    const releaseChange = coordinator.acquire('change-scan', 'changes')

    expect(() => coordinator.acquire('cleanup-scan', 'rule')).toThrow('空间变化扫描正在进行')
    expect(() => coordinator.acquire('maintenance', 'dism')).toThrow('空间变化扫描正在进行')
    expect(() => coordinator.acquire('data-migration', 'move')).toThrow('空间变化扫描正在进行')
    releaseChange()

    const releaseMaintenance = coordinator.acquire('maintenance', 'dism')
    expect(() => coordinator.acquire('cleanup-execute', 'cleanup')).toThrow('系统维护正在进行')
    releaseMaintenance()
    expect(coordinator.snapshot().exclusive).toBeNull()
  })

  it('returns idempotent release handles', () => {
    const coordinator = createOperationCoordinator()
    const release = coordinator.acquire('cleanup-execute', 'cleanup')
    release()
    release()
    expect(() => coordinator.acquire('change-scan', 'changes')).not.toThrow()
  })
})
