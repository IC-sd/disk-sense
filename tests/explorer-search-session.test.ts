import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, nextTick, ssrContextKey } from 'vue'
import ExplorerWorkspace from '../src/ui/ExplorerWorkspace.vue'
import type { FileExplanation, FileSearchItem, FileSearchResult } from '../src/domain/desktop'

const api = vi.hoisted(() => ({
  inspectSearch: vi.fn(),
  inspectList: vi.fn(),
  inspectExplain: vi.fn(),
  aiAnalysisGet: vi.fn(),
  inspectLocations: vi.fn(),
  inspectIndexStatus: vi.fn(),
  aiStatus: vi.fn()
  ,inspectListPage: vi.fn(), inspectListClose: vi.fn()
}))
vi.mock('../src/platform/api', () => ({ desktopApi: () => api }))

type HostNode = { children: HostNode[]; parent?: HostNode }
const node = (): HostNode => ({ children: [] })
const renderer = createRenderer<HostNode, HostNode>({
  insert(child, parent) { child.parent = parent; parent.children.push(child) },
  remove(child) { if (child.parent) child.parent.children = child.parent.children.filter(value => value !== child) },
  createElement: node,
  createText: node,
  createComment: node,
  setText() {},
  setElementText() {},
  parentNode: child => child.parent || null,
  nextSibling: () => null,
  patchProp() {}
})

type SearchOptions = { append?: boolean; resetPosition?: boolean; reuseSession?: boolean; background?: boolean }
type Workspace = {
  mode: string
  browsePath: string
  searchQuery: string
  searchScope: string
  searchKind: string
  searchModified: string
  searchSort: string
  searchItems: FileSearchItem[]
  searchResultMeta: Pick<FileSearchResult, 'sessionId' | 'total' | 'nextOffset'> | null
  searching: boolean
  selected: FileSearchItem | null
  scrollTop: number
  explanation: FileExplanation | null
  refreshingExplanation: boolean
  selectItem(item: FileSearchItem): Promise<void>
  stopActiveWork(): void
  setMode(mode: 'search' | 'browse'): void
  loadDirectory(path: string, addHistory?: boolean): Promise<void>
  directorySessionId: string
  directoryTruncated: boolean
  clearSearch(): void
  performSearch(options?: SearchOptions): Promise<void>
  scheduleSearch(): void
  moveSearchSelection(direction: 1 | -1): void
}

const index = { available: true, indexed: true, building: false } as FileSearchResult['index']
function item(name: string): FileSearchItem {
  return { name, displayName: name, path: `C:\\${name}`, size: 1, modifiedAt: 1 } as FileSearchItem
}
function result(names: string[], options: Partial<FileSearchResult> = {}): FileSearchResult {
  return { sessionId: 'candidate-1', items: names.map(item), total: 230, nextOffset: 100, tookMs: 1, truncated: false, index, ...options }
}
function deferred<T = FileSearchResult>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

let unmount: (() => void) | undefined
async function workspace() {
  // Execute the real component setup against Vue's host renderer; browser layout
  // is irrelevant to the search request and response lifecycle exercised here.
  const app = renderer.createApp({ ...ExplorerWorkspace, render: () => null })
  app.provide(ssrContextKey, { modules: new Set() })
  app.mount(node())
  unmount = () => app.unmount()
  await nextTick()
  const state = (app._instance as unknown as { setupState: Workspace }).setupState
  state.mode = 'search'
  state.browsePath = 'C:\\'
  state.searchQuery = 'report'
  return state
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('localStorage', { getItem: () => null })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(performance.now()); return 1 })
  api.inspectList.mockResolvedValue({ path: 'C:\\', items: [], truncated: false })
  api.inspectLocations.mockResolvedValue([])
  api.inspectIndexStatus.mockResolvedValue(index)
  api.aiStatus.mockResolvedValue({ configured: false })
  api.aiAnalysisGet.mockResolvedValue({ status: 'missing' })
  api.inspectSearch.mockResolvedValue(result(['report-a.txt', 'report-b.txt']))
  api.inspectListClose.mockResolvedValue({ closed: true })
})

afterEach(() => { unmount?.(); unmount = undefined; vi.unstubAllGlobals() })

describe('explorer candidate sessions and sorting', () => {
  it('closes a stale first directory page when a newer navigation wins', async () => {
    const state = await workspace()
    const oldPage = deferred<any>()
    api.inspectList.mockReturnValueOnce(oldPage.promise).mockResolvedValueOnce({ path: 'D:\\new', items: [], truncated: false })
    const old = state.loadDirectory('C:\\old')
    await state.loadDirectory('D:\\new')
    oldPage.resolve({ path: 'C:\\old', items: [], truncated: true, sessionId: 'old-session', nextOffset: 5000 })
    await old
    expect(state.browsePath).toBe('D:\\new')
    expect(state.directorySessionId).toBe('')
    expect(api.inspectListClose).toHaveBeenCalledWith({ sessionId: 'old-session' })
  })
  it('closes a partial directory when switching to search and reloads it on return', async () => {
    const state = await workspace()
    state.mode = 'browse'
    state.directorySessionId = 'partial-session'
    state.directoryTruncated = true
    state.setMode('search')
    expect(api.inspectListClose).toHaveBeenCalledWith({ sessionId: 'partial-session' })
    state.setMode('browse')
    await nextTick(); await nextTick()
    expect(api.inspectList).toHaveBeenCalledWith('C:\\')
  })
  const explained = (name: string) => ({ path: `C:\\${name}`, name, size: 1, modifiedAt: 1, risk: 'low', reason: 'test evidence', source: 'test' }) as FileExplanation

  it('releases loading when hidden and discards the invalidated explanation response', async () => {
    const state = await workspace()
    const pending = deferred<FileExplanation>()
    api.inspectExplain.mockReturnValueOnce(pending.promise)
    const request = state.selectItem(item('pending.txt'))
    expect(state.refreshingExplanation).toBe(true)
    state.stopActiveWork()
    expect(state.refreshingExplanation).toBe(false)
    pending.resolve(explained('pending.txt'))
    await request
    expect(state.refreshingExplanation).toBe(false)
    expect(state.explanation).toBeNull()
  })

  it('does not let an old explanation clear a newer selection loading state', async () => {
    const state = await workspace()
    const first = deferred<FileExplanation>(), second = deferred<FileExplanation>()
    api.inspectExplain.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const old = state.selectItem(item('first.txt'))
    state.setMode('browse')
    expect(state.refreshingExplanation).toBe(false)
    const current = state.selectItem(item('second.txt'))
    first.resolve(explained('first.txt'))
    await old
    expect(state.refreshingExplanation).toBe(true)
    expect(state.explanation).toBeNull()
    second.resolve(explained('second.txt'))
    await current
    expect(state.refreshingExplanation).toBe(false)
    expect(state.explanation?.path).toBe('C:\\second.txt')
  })

  it('releases pending analysis when the search query is cleared', async () => {
    const state = await workspace()
    const pending = deferred<FileExplanation>()
    api.inspectExplain.mockReturnValueOnce(pending.promise)
    const request = state.selectItem(item('old-query.txt'))
    state.clearSearch()
    expect(state.refreshingExplanation).toBe(false)
    pending.resolve(explained('old-query.txt'))
    await request
    expect(state.explanation).toBeNull()
  })
  it('restarts the visible page at zero while reusing candidates and then pages the new order', async () => {
    const state = await workspace()
    await state.performSearch()
    api.inspectSearch.mockResolvedValueOnce(result(['report-c.txt'], { nextOffset: 200 }))
    await state.performSearch({ append: true })
    state.selected = state.searchItems[1]
    state.scrollTop = 500

    const sorted = deferred()
    api.inspectSearch.mockReturnValueOnce(sorted.promise)
    state.searchSort = 'name'
    const request = state.performSearch({ resetPosition: true, reuseSession: true })
    expect(api.inspectSearch.mock.lastCall?.[0]).toMatchObject({ sessionId: 'candidate-1', offset: 0, sort: 'name' })
    expect(state.searchItems).toEqual([])
    expect(state.searchResultMeta).toBeNull()
    expect(state.selected).toBeNull()
    expect(state.scrollTop).toBe(0)
    expect(state.searching).toBe(true)
    state.moveSearchSelection(1)
    expect(state.selected).toBeNull()

    sorted.resolve(result(['report-z.txt', 'report-y.txt'], { total: 231 }))
    await request
    expect(state.searchResultMeta).toMatchObject({ total: 231, nextOffset: 100 })
    state.moveSearchSelection(1)
    expect(state.selected?.name).toBe('report-z.txt')

    api.inspectSearch.mockResolvedValueOnce(result(['report-x.txt'], { nextOffset: 200 }))
    await state.performSearch({ append: true })
    expect(api.inspectSearch.mock.lastCall?.[0]).toMatchObject({ sessionId: 'candidate-1', offset: 100, sort: 'name' })
    expect(state.searchItems.map(row => row.name)).toEqual(['report-z.txt', 'report-y.txt', 'report-x.txt'])
  })

  it('keeps the candidate session across rapid sorting and ignores older page or sort responses', async () => {
    const state = await workspace()
    await state.performSearch()
    const page = deferred(), byName = deferred(), byDate = deferred()
    api.inspectSearch.mockReturnValueOnce(page.promise).mockReturnValueOnce(byName.promise).mockReturnValueOnce(byDate.promise)
    const pendingPage = state.performSearch({ append: true })
    state.searchSort = 'name'
    const pendingName = state.performSearch({ resetPosition: true, reuseSession: true })
    state.searchSort = 'modified'
    const pendingDate = state.performSearch({ resetPosition: true, reuseSession: true })
    expect(api.inspectSearch.mock.lastCall?.[0]).toMatchObject({ sessionId: 'candidate-1', offset: 0, sort: 'modified' })

    page.resolve(result(['old-page.txt']))
    byName.resolve(result(['old-name-order.txt']))
    await Promise.all([pendingPage, pendingName])
    expect(state.searchItems).toEqual([])
    expect(state.searching).toBe(true)
    byDate.resolve(result(['new-date-order.txt']))
    await pendingDate
    expect(state.searchItems.map(row => row.name)).toEqual(['new-date-order.txt'])
    expect(state.searching).toBe(false)
  })

  it.each([
    ['searchQuery', 'budget'], ['searchScope', 'directory'], ['browsePath', 'D:\\'],
    ['searchKind', 'document'], ['searchModified', 'week']
  ] as const)('rejects an old candidate session after changing %s', async (field, value) => {
    const state = await workspace()
    await state.performSearch()
    state[field] = value
    await state.performSearch({ resetPosition: true, reuseSession: true })
    expect(api.inspectSearch.mock.lastCall?.[0]).not.toHaveProperty('sessionId')
    expect(api.inspectSearch.mock.lastCall?.[0]).not.toHaveProperty('offset')
  })

  it('invalidates the previous input immediately and refreshes candidates after index changes', async () => {
    const state = await workspace()
    await state.performSearch()
    state.searchQuery = 'report-new'
    state.scheduleSearch()
    state.searchQuery = 'report'
    await state.performSearch({ resetPosition: true, reuseSession: true })
    expect(api.inspectSearch.mock.lastCall?.[0]).not.toHaveProperty('sessionId')
    await state.performSearch({ background: true })
    expect(api.inspectSearch.mock.lastCall?.[0]).not.toHaveProperty('sessionId')
  })

  it('discards failed sort pagination and lets the next request establish fresh candidates', async () => {
    const state = await workspace()
    await state.performSearch()
    api.inspectSearch.mockRejectedValueOnce(new Error('search unavailable'))
    state.searchSort = 'size'
    await state.performSearch({ resetPosition: true, reuseSession: true })
    expect(state.searchItems).toEqual([])
    expect(state.searchResultMeta).toBeNull()
    expect(state.searching).toBe(false)
    await state.performSearch({ resetPosition: true, reuseSession: true })
    expect(api.inspectSearch.mock.lastCall?.[0]).not.toHaveProperty('sessionId')
  })
})
