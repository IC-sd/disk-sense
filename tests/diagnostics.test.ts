import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
// @ts-expect-error CommonJS desktop module.
import { createDiagnostics, safeDetails } from '../desktop/diagnostics.cjs'
// @ts-expect-error CommonJS desktop module.
import { atomicWriteJson } from '../desktop/atomic-file.cjs'
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function root() { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-diagnostics-')); roots.push(value); return value }
describe('local diagnostics and durable writes', () => {
  it('redacts secrets before disk and paths from shareable snapshots', () => {
    const file = path.join(root(), 'diagnostics.jsonl'), diagnostics = createDiagnostics(file)
    diagnostics.log('error', 'provider-failed', { apiKey: 'private-key', message: 'Bearer secret-value token=private-token', path: 'C:\\Users\\Alice\\report.pdf' })
    const saved = fs.readFileSync(file, 'utf8')
    expect(saved).not.toContain('private-key'); expect(saved).not.toContain('secret-value'); expect(saved).not.toContain('private-token')
    const shared = JSON.stringify(diagnostics.snapshot({ dataPath: 'D:\\Data\\Disk Sense', password: 'private-password' }))
    expect(shared).not.toContain('Alice'); expect(shared).not.toContain('private-password'); expect(shared).toContain('[LOCAL_PATH]')
    expect(safeDetails({ count: 1n, huge: 'x'.repeat(20000) })).toHaveProperty('truncated', true)
  })
  it('preserves the previous primary and removes staging when replacement fails', () => {
    const file = path.join(root(), 'state.json')
    atomicWriteJson(file, { value: 'old' })
    const rename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => { if (target === file) throw new Error('disk-error'); return rename(source, target) })
    expect(() => atomicWriteJson(file, { value: 'new' }, { backup: true })).toThrow('disk-error')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ value: 'old' })
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'))).toEqual({ value: 'old' })
    expect(fs.readdirSync(path.dirname(file)).some(name => name.endsWith('.tmp'))).toBe(false)
  })
})
