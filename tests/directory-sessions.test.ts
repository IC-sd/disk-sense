import { describe, expect, it } from 'vitest'
// @ts-expect-error CommonJS desktop module.
import { createDirectorySessions } from '../desktop/directory-sessions.cjs'

function fixture(count: number, extra = {}) {
  let reads = 0, closes = 0
  const service = createDirectorySessions({
    validate: (value: string) => value,
    present: async (root: string, entries: any[], truncated: boolean) => ({ path: root, items: entries, truncated }),
    openDirectory: async () => ({ read: async () => reads < count ? { name: `file-${reads++}` } : null, close: async () => { closes++ } }),
    ...extra
  })
  return { service, get closes() { return closes } }
}
describe('directory continuation sessions', () => {
  it('closes an opening handle when its owner cancels before open resolves', async () => {
    let resolveOpen!: (value: any) => void
    let closes = 0
    const f = fixture(1, { openDirectory: () => new Promise(resolve => { resolveOpen = resolve }) })
    const opening = f.service.start('C:\\fixture', 9)
    await Promise.resolve(); await Promise.resolve()
    await f.service.closeOwner(9)
    resolveOpen({ read: async () => null, close: async () => { closes++ } })
    await expect(opening).rejects.toThrow('取消')
    expect(closes).toBe(1)
  })
  it('releases an abandoned idle handle without another request', async () => {
    const f = fixture(6000, { idleMs: 20 })
    await f.service.start('C:\\fixture')
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(f.closes).toBe(1)
  })
  it('enumerates all 50001 entries with stable offsets and no fixed display truncation', async () => {
    const f = fixture(50001)
    let page = await f.service.start('C:\\fixture', 7)
    const names = page.items.map((item: any) => item.name)
    while (page.nextOffset !== null) { page = await f.service.page({ sessionId: page.sessionId, offset: page.nextOffset }, 7); names.push(...page.items.map((item: any) => item.name)) }
    expect(names).toHaveLength(50001)
    expect(new Set(names).size).toBe(50001)
    expect(page.complete).toBe(true)
    expect(f.closes).toBe(1)
  })
  it('binds continuation and cancellation to the originating renderer', async () => {
    const f = fixture(6000)
    const page = await f.service.start('C:\\fixture', 7)
    await expect(f.service.page({ sessionId: page.sessionId, offset: 5000 }, 8)).rejects.toThrow('已失效')
    await f.service.close(page.sessionId, 8)
    expect(f.closes).toBe(0)
    expect((await f.service.page({ sessionId: page.sessionId, offset: 5000 }, 7)).items).toHaveLength(1000)
  })
  it('rejects duplicate pages and expires idle handles', async () => {
    let time = 1
    const f = fixture(6000, { now: () => time, idleMs: 10 })
    const page = await f.service.start('C:\\fixture')
    await expect(f.service.page({ sessionId: page.sessionId, offset: 0 })).rejects.toThrow('批次')
    time = 20
    await expect(f.service.page({ sessionId: page.sessionId, offset: 5000 })).rejects.toThrow('失效')
    expect(f.closes).toBe(1)
  })
})
