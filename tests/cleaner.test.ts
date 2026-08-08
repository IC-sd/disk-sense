// @ts-expect-error CommonJS desktop module is intentionally tested from the TypeScript suite.
import { inspectSlimming, parseRecycleBinOutput, rules, slimmingRules } from '../desktop/cleaner.cjs'
import { describe, expect, it } from 'vitest'

describe('cleanup center design', () => {
  it('uses the unified five-level risk model for every cleanup item', async () => {
    const allowed = new Set(['danger', 'elevated', 'attention', 'low', 'safe'])
    expect(rules.length).toBeGreaterThanOrEqual(20)
    expect([...rules, ...slimmingRules].every((item: any) => allowed.has(item.risk))).toBe(true)
    expect(rules.filter((item: any) => item.selectable).every((item: any) => ['safe', 'low'].includes(item.risk))).toBe(true)
    expect(rules.filter((item: any) => item.selectable).every((item: any) => item.minimumAgeDays >= 1)).toBe(true)
    expect(rules.find((item: any) => item.id === 'windows-update-cache')?.selectable).toBe(false)
    expect(rules.find((item: any) => item.id === 'firefox-cache')?.processNames).toContain('firefox.exe')
    expect(rules.find((item: any) => item.id === 'vscode-cache')?.roots().every((root: string) => /(?:Cache|GPUCache)$/i.test(root))).toBe(true)
    expect(rules.find((item: any) => item.id === 'nuget-cache')?.roots().every((root: string) => !/global-packages/i.test(root))).toBe(true)
    expect(rules.find((item: any) => item.id === 'recycle-bin')).toMatchObject({
      risk: 'attention',
      selectable: false
    })
    expect(rules.find((item: any) => item.id === 'recycle-bin')?.probe).toBeTypeOf('function')
    expect(rules.find((item: any) => item.id === 'recent-temp-activity')).toBeUndefined()
    expect((await rules.find((item: any) => item.id === 'teams-cache')?.roots()).every((root: string) => /(?:Cache|Code Cache|GPUCache|DawnCache|GrShaderCache|ShaderCache|Media Cache)$/i.test(root))).toBe(true)
    expect(rules.find((item: any) => item.id === 'slack-cache')?.roots().every((root: string) => /(?:Cache|Code Cache|GPUCache|DawnCache|GrShaderCache|ShaderCache|Media Cache)$/i.test(root))).toBe(true)
    expect(rules.find((item: any) => item.id === 'jetbrains-cache')?.roots().every((root: string) => /(?:caches|tmp)$/i.test(root))).toBe(true)
    expect(rules.find((item: any) => item.id === 'chromium-family-cache')).toMatchObject({ category: '浏览器', selectable: true })
    expect((await rules.find((item: any) => item.id === 'qq-renderer-cache')?.roots()).every((root: string) => !/[\\/]Cache$/i.test(root))).toBe(true)
  })

  it('normalizes recycle-bin capacity from one or many Windows volumes', () => {
    expect(parseRecycleBinOutput('{"items":102,"bytes":9065033159,"volumes":[{"root":"C:\\\\","code":0,"items":43,"bytes":376977625},{"root":"D:\\\\","code":0,"items":59,"bytes":8688055534}]}')).toEqual({
      items: 102,
      bytes: 9065033159,
      volumes: [
        { root: 'C:\\', code: 0, items: 43, bytes: 376977625 },
        { root: 'D:\\', code: 0, items: 59, bytes: 8688055534 }
      ]
    })
    expect(parseRecycleBinOutput('{"items":1,"bytes":7,"volumes":{"root":"C:\\\\","code":0,"items":1,"bytes":7}}').volumes).toHaveLength(1)
  })

  it('detects system slimming state and exposes only gated maintenance actions', () => {
    const result = inspectSlimming({
      platform: 'win32',
      elevated: false,
      commands: {
        'powercfg.exe': true,
        'Dism.exe': true,
        'SystemPropertiesAdvanced.exe': true,
        'fltmc.exe': true
      }
    })
    expect(result.map((item: any) => item.id)).toContain('hibernation')
    expect(result.map((item: any) => item.id)).toContain('component-store')
    expect(result.map((item: any) => item.id)).toContain('virtual-memory')
    expect(result.every((item: any) => typeof item.detected === 'boolean')).toBe(true)
    expect(result.flatMap((item: any) => item.actions).filter((action: any) => action.requiresAdmin).every((action: any) => !action.enabled)).toBe(true)
    expect(result.find((item: any) => item.id === 'component-reset-base')?.actions[0]).toMatchObject({
      irreversible: true,
      confirmationPhrase: 'RESETBASE'
    })
  })
})
