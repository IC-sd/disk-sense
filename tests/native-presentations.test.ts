import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DirectoryItem } from '../src/domain/desktop'
import { useNativePresentations } from '../src/application/native-presentations'
const api = vi.hoisted(() => ({ inspectFilePresentations: vi.fn() }))
vi.mock('../src/platform/api', () => ({ desktopApi: () => api }))
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks() })
describe('native file presentation lifecycle', () => {
  it('discards results arriving after deactivation and permits a fresh request', async () => {
    vi.useFakeTimers()
    let complete!: (value: unknown) => void
    api.inspectFilePresentations.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const item = { path: 'C:\\Fixture\\Report.txt' } as DirectoryItem
    let active = true
    const presentation = useNativePresentations(() => active, () => [item])
    presentation.scheduleNativeIconLoad()
    await vi.advanceTimersByTimeAsync(45)
    active = false
    presentation.stop()
    complete({ [item.path]: { displayName: 'stale' } })
    await Promise.resolve()
    expect(presentation.nativePresentation(item.path)).toBeUndefined()
    active = true
    api.inspectFilePresentations.mockResolvedValueOnce({ [item.path]: { displayName: 'fresh' } })
    presentation.scheduleNativeIconLoad()
    await vi.advanceTimersByTimeAsync(45)
    expect(presentation.nativePresentation(item.path)?.displayName).toBe('fresh')
    presentation.stop()
  })
})
