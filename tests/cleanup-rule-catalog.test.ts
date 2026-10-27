import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error CommonJS desktop module.
import { loadRuleCatalog } from '../desktop/cleanup-rule-catalog.cjs'
// @ts-expect-error CommonJS desktop module.
import { createScanSession } from '../desktop/cleanup-scan-session.cjs'
import definitions from '../desktop/cleanup-rules.json'

const provider = { id: 'fixture', risk: 'low', selectable: true, minimumAgeDays: 7, processNames: ['owner.exe'] }
const definition = { ...provider, version: 1, source: 'fixture evidence', title: 'fixture', category: 'fixture', reason: 'rebuildable', safetyNote: 'keep recent files' }
describe('declarative cleanup rule boundaries', () => {
  it.each([
    { minimumAgeDays: 0 }, { risk: 'safe' }, { risk: 'constructor' }, { risk: 'toString' },
    { id: 'unregistered' }, { version: 0 }, { source: '' }, { processNames: ['../arbitrary.exe'] }, { processNames: 'owner.exe' }
  ])('rejects definitions that weaken or bypass a registered capability: %j', change => {
    expect(() => loadRuleCatalog({ schemaVersion: 1, rules: [{ ...definition, ...change }] }, [provider])).toThrow()
  })
  it('retains mandatory processes and disallows enabling a detection-only rule', () => {
    expect(loadRuleCatalog({ schemaVersion: 1, rules: [{ ...definition, processNames: [] }] }, [provider])[0].processNames).toEqual(['owner.exe'])
    expect(() => loadRuleCatalog({ schemaVersion: 1, rules: [definition] }, [{ ...provider, selectable: false }])).toThrow('未授权')
    expect(new Set(definitions.rules.map(rule => rule.id)).size).toBe(28)
  })
  it('coalesces concurrent reads without sharing errors as empty successful scans', async () => {
    const readdir = vi.fn().mockResolvedValueOnce([{ name: 'cache' }]).mockRejectedValueOnce(new Error('EACCES')).mockResolvedValueOnce([])
    const session = createScanSession(), filesystem = session.wrap({ readdir })
    const options = { withFileTypes: true }
    const [first, second] = await Promise.all([filesystem.readdir('C:\\fixture', options), filesystem.readdir('C:\\fixture', options)])
    expect(first).toBe(second)
    expect(readdir).toHaveBeenCalledTimes(1)
    await expect(filesystem.readdir('C:\\unavailable', options)).rejects.toThrow('EACCES')
    expect(await filesystem.readdir('C:\\unavailable', options)).toEqual([])
    expect(readdir).toHaveBeenCalledTimes(3)
  })
  it('falls back to fresh reads when the shared entry budget is exhausted', async () => {
    const readdir = vi.fn().mockResolvedValue([{ name: 'one' }, { name: 'two' }])
    const session = createScanSession({ maximumEntries: 1 }), filesystem = session.wrap({ readdir })
    await filesystem.readdir('C:\\fixture', { withFileTypes: true })
    await filesystem.readdir('C:\\fixture', { withFileTypes: true })
    expect(readdir).toHaveBeenCalledTimes(2)
    expect(session.stats().retainedEntries).toBe(0)
  })
})
