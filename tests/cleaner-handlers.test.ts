// @ts-expect-error CommonJS module tested from TypeScript.
import { registerCleanerHandlers } from '../desktop/handlers/cleaner-handlers.cjs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const roots: string[] = []
function fixture(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-cleaner-ipc-')); roots.push(root)
  const handlers = new Map<string, (...args: any[]) => any>()
  const state: any = { cleanupJobs: [], maintenanceJobs: [], cleanupExclusions: [] }
  const shell = { trashItem: vi.fn(), openExternal: vi.fn(), openPath: vi.fn() }
  registerCleanerHandlers({
    ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) },
    db: { read: () => state, save: vi.fn() }, shell, sendToRenderer: vi.fn(), ...extra
  })
  return { root, state, shell, handlers, call: (name: string, input?: any) => handlers.get(name)!(null, input) }
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('cleaner IPC boundaries', () => {
  it('preserves an unconfirmed maintenance result when its durable completion fails after execution', async () => {
    const journal = { begin: vi.fn(), finish: vi.fn(() => { throw new Error('journal-full') }), interrupted: vi.fn(), list: () => [] }
    const runner = vi.fn(async (_input, options) => { options.onProgress({ phase: 'running' }); return { success: true, outcome: 'completed', exitCode: 0 } })
    const f = fixture({ journal, requireJournal: true, maintenanceRunner: runner, maintenanceStatusReader: async () => ({ actions: [] }) })
    await expect(f.call('cleaner:slimming-execute', { actionId: 'fixture' })).rejects.toThrow('journal-full')
    expect(runner).toHaveBeenCalledTimes(1)
    expect(journal.finish).toHaveBeenCalledTimes(1)
    expect(journal.interrupted).toHaveBeenCalledTimes(1)
    expect(f.state.maintenanceJobs).toEqual([])
  })
  it('uses the durable completed result when legacy history persistence fails', async () => {
    const journal = { begin: vi.fn(), finish: vi.fn(), interrupted: vi.fn(), list: () => [] }
    const f = fixture({ journal, requireJournal: true, maintenanceRunner: async () => ({ success: true, outcome: 'completed', exitCode: 0 }),
      maintenanceStatusReader: async () => ({ actions: [] }), db: { read: () => ({ maintenanceJobs: [] }), save: () => { throw new Error('legacy-full') } } })
    expect(await f.call('cleaner:slimming-execute', { actionId: 'fixture' })).toMatchObject({ success: true, outcome: 'completed' })
    expect(journal.finish).toHaveBeenCalledTimes(1)
    expect(journal.interrupted).not.toHaveBeenCalled()
  })
  it('refuses side effects when the required durable journal is unavailable', async () => {
    const f = fixture({ requireJournal: true })
    await expect(f.call('cleaner:execute', [{ candidateId: 'fixture' }])).rejects.toThrow('操作日志不可写')
    await expect(f.call('cleaner:slimming-execute', { actionId: 'fixture' })).rejects.toThrow('操作日志不可写')
    expect(f.shell.trashItem).not.toHaveBeenCalled()
    expect(f.shell.openPath).not.toHaveBeenCalled()
  })
  it('does not accept direct paths as cleanup permission', async () => {
    const f = fixture(), job = await f.call('cleaner:execute', [{ candidateId: 'forged', path: path.join(f.root, 'do-not-delete') }])
    expect(job.succeeded).toBe(0)
    expect(job.failed).toBe(1)
    expect(f.shell.trashItem).not.toHaveBeenCalled()
  })
  it('rejects removed and unknown cleanup modes before invoking file operations', async () => {
    const f = fixture()
    for (const mode of ['quarantine', 'delete', 'unsupported']) {
      await expect(f.call('cleaner:execute', { mode, confirmation: 'QUARANTINE', files: [{ candidateId: 'forged' }] })).rejects.toThrow('不支持的清理方式')
    }
    expect(f.shell.trashItem).not.toHaveBeenCalled()
    expect([...f.handlers.keys()].some(name => /governance|quarantine|package-docs/u.test(name))).toBe(false)
  })
  it('keeps legacy history readable and never removes legacy journals when clearing audit history', async () => {
    const f = fixture(), id = '12345678-1234-1234-1234-123456789012'
    const directory = path.join(f.root, 'cleanup-quarantine'); fs.mkdirSync(directory)
    const journal = path.join(directory, `${id}.jsonl`)
    const saved = `${JSON.stringify({ type: 'job', id, directory: path.join(f.root, 'isolated'), createdAt: '2026-01-01' })}\n`
    fs.writeFileSync(journal, saved)
    f.state.cleanupJobs.push({ id, executionMode: 'quarantine', quarantineId: id, isolatedBytes: 100, movedToTrashBytes: 0, results: [] })
    expect(await f.call('cleaner:history')).toEqual([expect.objectContaining({ id, executionMode: 'quarantine', isolatedBytes: 100, movedToTrashBytes: 0 })])
    expect(await f.call('cleaner:history-detail', id)).toMatchObject({ executionMode: 'quarantine', isolatedBytes: 100, results: [] })
    await f.call('cleaner:history-clear')
    expect(f.state.cleanupJobs).toEqual([])
    expect(fs.readFileSync(journal, 'utf8')).toBe(saved)
  })
})
