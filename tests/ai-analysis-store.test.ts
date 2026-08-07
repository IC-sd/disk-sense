// @ts-expect-error CommonJS desktop module is intentionally tested from the TypeScript suite.
import { createAiAnalysisStore } from '../desktop/ai-analysis-store.cjs'
// @ts-expect-error CommonJS desktop module is intentionally tested from the TypeScript suite.
import { store as createStateStore } from '../desktop/state.cjs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function database(initial: Record<string, unknown> = {}) {
  const data = { aiAnalyses: [], ...initial }
  return {
    data,
    read: () => data,
    save: vi.fn()
  }
}

describe('persistent AI analysis store', () => {
  it('restores unchanged results and marks changed files as stale', () => {
    const db = database()
    const store = createAiAnalysisStore({ getDb: () => db })
    store.save({
      path: 'C:\\Users\\test\\report.docx',
      fingerprint: '100:2048',
      parsed: { what: 'Microsoft Word 文档', handling: '确认内容后保留或归档' },
      result: '{"what":"Microsoft Word 文档"}',
      analysisMode: 'deep',
      evidence: { contentPreview: 'must not be persisted' },
      apiKey: 'must-not-be-persisted'
    })

    const current = store.get({ path: 'c:/users/test/report.docx', fingerprint: '100:2048' })
    expect(current.status).toBe('current')
    expect(current.record.parsed.what).toBe('Microsoft Word 文档')
    expect(store.get({ path: 'C:\\Users\\test\\report.docx', fingerprint: '101:2048' }).status).toBe('stale')
    expect(JSON.stringify(db.data)).not.toContain('must not be persisted')
    expect(JSON.stringify(db.data)).not.toContain('must-not-be-persisted')
    expect(db.save).toHaveBeenCalledOnce()
  })

  it('keeps only the configured number of recent paths', () => {
    const db = database()
    const store = createAiAnalysisStore({ getDb: () => db, maximumRecords: 2 })
    store.save({ path: 'C:\\one', fingerprint: '1', result: 'one' })
    store.save({ path: 'C:\\two', fingerprint: '2', result: 'two' })
    store.save({ path: 'C:\\three', fingerprint: '3', result: 'three' })

    expect(db.data.aiAnalyses).toHaveLength(2)
    expect(store.get({ path: 'C:\\one', fingerprint: '1' }).status).toBe('missing')
    expect(store.get({ path: 'C:\\three', fingerprint: '3' }).status).toBe('current')
  })

  it('survives closing and reopening the application state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-ai-analysis-'))
    temporaryRoots.push(root)
    const stateFile = path.join(root, 'state.json')
    const firstDatabase = createStateStore(stateFile)
    createAiAnalysisStore({ getDb: () => firstDatabase }).save({
      path: 'D:\\Documents\\plan.docx',
      fingerprint: '200:4096',
      parsed: { what: '项目计划文档', purpose: '保存项目时间与任务安排' },
      result: '{"what":"项目计划文档"}'
    })

    const reopenedDatabase = createStateStore(stateFile)
    const restored = createAiAnalysisStore({ getDb: () => reopenedDatabase })
      .get({ path: 'D:\\Documents\\plan.docx', fingerprint: '200:4096' })

    expect(restored.status).toBe('current')
    expect(restored.record.parsed.purpose).toBe('保存项目时间与任务安排')
  })

  it('rejects records without an absolute path', () => {
    const db = database()
    const store = createAiAnalysisStore({ getDb: () => db })
    expect(() => store.save({ path: '', fingerprint: '1', result: 'invalid' })).toThrow('无效')
    expect(() => store.save({ path: 'relative.txt', fingerprint: '1', result: 'invalid' })).toThrow('无效')
  })
})
