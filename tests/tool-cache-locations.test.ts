// @ts-expect-error CommonJS module tested from TypeScript.
import { packageLocations, setting, absoluteConfigured, inspectToolCaches } from '../desktop/tool-cache-locations.cjs'
// @ts-expect-error CommonJS module tested from TypeScript.
import { rules } from '../desktop/cleaner.cjs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const roots: string[] = []
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-tool-cache-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('tool cache location discovery', () => {
  it('reads only the requested key and never exposes authentication settings', () => {
    const home = fixture()
    fs.writeFileSync(path.join(home, '.npmrc'), `//registry.example/:_authToken=private-secret\ncache=${path.join(home, 'cache')}\n`)
    const tools = packageLocations({ home, local: home, roaming: home, environment: {} })
    expect(tools[0].path).toBe(path.join(home, 'cache'))
    expect(tools[0].configured).toBe(true)
    expect(JSON.stringify(tools)).not.toContain('private-secret')
    expect(tools[0].locations[1].role).toBe('legacy-candidate')
  })
  it('prioritizes cache environment variables over user configuration', () => {
    const home = fixture(), cached = path.join(home, 'configured-cache')
    fs.writeFileSync(path.join(home, '.npmrc'), `cache=${path.join(home, 'old-cache')}`)
    expect(packageLocations({ home, local: home, roaming: home, environment: { NPM_CONFIG_CACHE: cached } })[0].path).toBe(cached)
  })
  it('discovers a global npm cache without running Node or Corepack tools', () => {
    const home = fixture(), nodeDirectory = path.join(home, 'toolchain')
    fs.mkdirSync(path.join(nodeDirectory, 'etc'), { recursive: true })
    fs.writeFileSync(path.join(nodeDirectory, 'etc', 'npmrc'), `cache=${path.join(home, 'global-cache')}`)
    const tool = packageLocations({ home, local: home, roaming: home, environment: {}, nodeDirectory })[0]
    expect(tool.path).toBe(path.join(home, 'global-cache'))
    expect(tool.source).toBe('npm 全局配置')
    expect(tool.locations[1].role).toBe('legacy-candidate')
  })
  it('resolves pip global cache-dir without leaking unrelated sections', () => {
    const home = fixture(), pip = path.join(home, 'pip')
    fs.mkdirSync(pip)
    fs.writeFileSync(path.join(pip, 'pip.ini'), `[global]\ncache-dir=${path.join(home, 'pip-cache')}\n[install]\nindex-url=https://secret.example/\n`)
    const result = packageLocations({ home, local: home, roaming: home, environment: {} })[1]
    expect(result.configured).toBe(true)
    expect(result.path).toBe(path.join(home, 'pip-cache'))
    expect(JSON.stringify(result)).not.toContain('secret.example')
  })
  it('does not invent effective paths from missing variables, relative or broad roots', () => {
    const home = fixture()
    expect(absoluteConfigured('${UNKNOWN}/cache', {}, home)).toBeNull()
    expect(absoluteConfigured('relative/cache', {}, home)).toBeNull()
    expect(absoluteConfigured(home, {}, home)).toBeNull()
    expect(absoluteConfigured(path.parse(home).root, {}, home)).toBeNull()
    expect(absoluteConfigured(path.join(home, '${UNKNOWN}', 'cache'), {}, home)).toBeNull()
  })
  it('keeps package stores out of the generic file cleanup executor', () => {
    for (const id of ['npm-cache', 'pip-cache', 'uv-cache', 'pnpm-cache', 'nuget-cache']) {
      expect(rules.find((rule: any) => rule.id === id).selectable).toBe(false)
    }
  })
  it('ignores excessively large configuration files', () => {
    const home = fixture(), file = path.join(home, '.npmrc')
    fs.writeFileSync(file, 'cache=secret\n' + 'x'.repeat(300000))
    expect(setting(file, 'cache')).toBeNull()
    const result = packageLocations({ home, local: home, roaming: home, environment: {} })
    expect(result[0].warnings.join()).toContain('超过读取预算')
    expect(JSON.stringify(result)).not.toContain('cache=secret')
  })

  it('queries a supported native tool version and effective cache path with fixed arguments only', async () => {
    const home = fixture(), bin = path.join(home, 'bin'), actual = path.join(home, 'uv-actual-cache')
    fs.mkdirSync(bin); fs.writeFileSync(path.join(bin, 'uv.exe'), '')
    const runQuery = vi.fn(async (_file: string, args: string[]) => ({ stdout: args[0] === '--version' ? 'uv 0.9.3\n' : `${actual}\n` }))
    const result = await inspectToolCaches({ home, local: home, roaming: home, platform: 'win32', environment: { PATH: bin }, queryCommands: true, runQuery })
    const uv = result.tools.find((tool: any) => tool.id === 'uv')
    expect(uv).toMatchObject({ status: 'confirmed', version: '0.9.3', effectivePath: actual, shared: true, automaticExecution: false,
      nativePreview: { args: ['cache', 'prune'], previewOnly: true, available: true } })
    expect(runQuery.mock.calls.map(call => call[1])).toEqual([['--version'], ['cache', 'dir']])
    expect(uv.warnings.join()).toContain('位置与配置推导不同')
  })

  it('does not launch Corepack shims or run maintenance while inspecting', async () => {
    const home = fixture(), bin = path.join(home, 'bin')
    fs.mkdirSync(bin); fs.writeFileSync(path.join(bin, 'pnpm.cmd'), '@corepack')
    const runQuery = vi.fn()
    const result = await inspectToolCaches({ home, local: home, roaming: home, platform: 'win32', environment: { PATH: bin }, queryCommands: true, runQuery })
    expect(result.tools.find((tool: any) => tool.id === 'pnpm')).toMatchObject({ status: 'shim-unqueried', version: null, effectivePath: null,
      nativePreview: { available: false } })
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('disables cache queries and native previews for versions outside supported capability range', async () => {
    const home = fixture(), bin = path.join(home, 'bin')
    fs.mkdirSync(bin); fs.writeFileSync(path.join(bin, 'pip.exe'), '')
    const runQuery = vi.fn(async () => ({ stdout: 'pip 19.3.1 from private-path' }))
    const result = await inspectToolCaches({ home, local: home, roaming: home, platform: 'win32', environment: { PATH: bin }, queryCommands: true, runQuery })
    expect(result.tools.find((tool: any) => tool.id === 'pip')).toMatchObject({ status: 'unsupported-version', version: '19.3.1', nativePreview: { available: false } })
    expect(runQuery).toHaveBeenCalledOnce()
  })

  it('does not expose stderr secrets or accept ambiguous CLI output as a confirmed cache', async () => {
    const home = fixture(), bin = path.join(home, 'bin')
    fs.mkdirSync(bin); fs.writeFileSync(path.join(bin, 'uv.exe'), '')
    const result = await inspectToolCaches({ home, local: home, roaming: home, platform: 'win32', environment: { PATH: bin }, queryCommands: true,
      runQuery: async (_: string, args: string[]) => { if (args[0] === '--version') return { stdout: 'uv 0.9.3' }; throw new Error('secret-token') }
    })
    expect(result.tools.find((tool: any) => tool.id === 'uv').status).toBe('query-failed')
    expect(JSON.stringify(result)).not.toContain('secret-token')
  })

  it('leaves command inspection disabled until explicitly requested', async () => {
    const home = fixture(), bin = path.join(home, 'bin')
    fs.mkdirSync(bin); fs.writeFileSync(path.join(bin, 'uv.exe'), '')
    const runQuery = vi.fn()
    await inspectToolCaches({ home, local: home, roaming: home, platform: 'win32', environment: { PATH: bin }, runQuery })
    expect(runQuery).not.toHaveBeenCalled()
  })
})
