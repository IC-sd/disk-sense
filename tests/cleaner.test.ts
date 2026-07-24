// @ts-expect-error CommonJS desktop module is intentionally tested from the TypeScript suite.
import { inspectSlimming, rules, slimmingRules } from '../desktop/cleaner.cjs'
import { describe, expect, it } from 'vitest'

describe('cleanup center design', () => {
  it('uses the unified five-level risk model for every cleanup item', () => {
    const allowed = new Set(['danger', 'elevated', 'attention', 'low', 'safe'])
    expect(rules.length).toBeGreaterThanOrEqual(14)
    expect([...rules, ...slimmingRules].every((item: any) => allowed.has(item.risk))).toBe(true)
    expect(rules.filter((item: any) => item.selectable).every((item: any) => ['safe', 'low'].includes(item.risk))).toBe(true)
    expect(rules.filter((item: any) => item.selectable).every((item: any) => item.minimumAgeDays >= 1)).toBe(true)
    expect(rules.find((item: any) => item.id === 'windows-update-cache')?.selectable).toBe(false)
    expect(rules.find((item: any) => item.id === 'firefox-cache')?.processNames).toContain('firefox.exe')
    expect(rules.find((item: any) => item.id === 'vscode-cache')?.roots().every((root: string) => /(?:Cache|GPUCache)$/i.test(root))).toBe(true)
    expect(rules.find((item: any) => item.id === 'nuget-cache')?.roots().every((root: string) => !/global-packages/i.test(root))).toBe(true)
  })

  it('detects system slimming state without executing system changes', () => {
    const result = inspectSlimming()
    expect(result.map((item: any) => item.id)).toContain('hibernation')
    expect(result.map((item: any) => item.id)).toContain('component-store')
    expect(result.map((item: any) => item.id)).toContain('virtual-memory')
    expect(result.every((item: any) => typeof item.detected === 'boolean')).toBe(true)
  })
})
