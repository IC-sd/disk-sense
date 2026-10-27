import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error CommonJS desktop module.
import { executeFileAction, fileActionTarget } from '../desktop/file-actions.cjs'

describe('file action boundary', () => {
  it('remembers only a successfully opened target, while history failure never turns the open into an error', async () => {
    const shell = { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() }, clipboard = { writeText: vi.fn() }
    const stat = vi.fn(async () => ({})), onOpened = vi.fn(async () => { throw new Error('Index closed') })
    for (const action of ['copy', 'reveal']) await executeFileAction({ path: 'C:\\Files\\report.txt', query: 'report', action }, { shell, clipboard, stat, onOpened })
    expect(onOpened).not.toHaveBeenCalled()
    await expect(executeFileAction({ path: 'C:/Files/report.txt', query: 'report', action: 'open' }, { shell, stat, onOpened })).resolves.toMatchObject({ ok: true })
    expect(onOpened).toHaveBeenCalledExactlyOnceWith({ query: 'report', path: 'C:\\Files\\report.txt' })
    onOpened.mockClear(); shell.openPath.mockResolvedValue('No default program')
    await expect(executeFileAction({ path: 'C:\\Files\\report.txt', query: 'report', action: 'open' }, { shell, stat, onOpened })).rejects.toThrow('无法打开')
    expect(onOpened).not.toHaveBeenCalled()
  })
  it('rejects URLs, relative paths, device namespaces and alternate streams', () => {
    for (const target of ['https://example.test', 'file:///C:/test', 'relative.txt', '\\\\?\\C:\\test', 'C:\\test:stream', 'C:\\test\n']) {
      expect(() => fileActionTarget(target)).toThrow()
    }
    expect(fileActionTarget('C:/Files/report.txt')).toBe('C:\\Files\\report.txt')
  })
  it('routes an explicit open, reveal or copy without running a shell command', async () => {
    const shell = { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() }
    const clipboard = { writeText: vi.fn() }
    const stat = vi.fn(async () => ({}))
    for (const action of ['open', 'reveal', 'copy']) await executeFileAction({ path: 'C:\\Files\\report.txt', action }, { shell, clipboard, stat })
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith('C:\\Files\\report.txt')
    expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith('C:\\Files\\report.txt')
    expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith('C:\\Files\\report.txt')
    await expect(executeFileAction({ path: 'C:\\Files', action: 'delete' }, { shell, clipboard, stat })).rejects.toThrow()
  })
  it('reports a stale index entry and does not open the missing target', async () => {
    const shell = { openPath: vi.fn() }
    const stat = vi.fn(async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) })
    await expect(executeFileAction({ path: 'C:\\missing.txt', action: 'open' }, { shell, stat })).rejects.toThrow('已移动或删除')
    expect(shell.openPath).not.toHaveBeenCalled()
  })
})
