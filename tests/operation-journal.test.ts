import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error CommonJS desktop module.
import { createOperationJournal } from '../desktop/operation-journal.cjs'
// @ts-expect-error CommonJS desktop module.
import { atomicWriteJson } from '../desktop/atomic-file.cjs'

const roots: string[] = []
function file() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-journal-')); roots.push(root); return path.join(root, 'operations.sqlite') }
const item = { candidateId: 'candidate', path: 'C:\\fixture\\cache.tmp', size: 40, ruleId: 'user-temp', modifiedAt: 1 }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('durable operation journal', () => {
  it('keeps all unreviewed interrupted jobs visible beyond ordinary history retention', () => {
    const journal = createOperationJournal(file())
    try {
      for (let i = 0; i < 105; i++) { journal.begin(`job-${i}`, []); journal.interrupted(`job-${i}`) }
      expect(journal.list().filter((job: any) => job.recoveryRequired)).toHaveLength(105)
      expect(journal.clearCompleted()).toEqual({ retained: 105 })
      expect(journal.acknowledge('job-0')).toEqual({ acknowledged: true })
      journal.clearCompleted()
      expect(journal.detail('job-0')).toBeNull()
      expect(journal.list()).toHaveLength(104)
    } finally { journal.close() }
  })
  it('recovers confirmed, uncertain and unstarted items without retrying any side effect', () => {
    const location = file()
    let journal = createOperationJournal(location)
    journal.begin('job', [item, item, item])
    journal.attempted('job', 0, item)
    journal.recorded('job', 0, { ...item, success: true })
    journal.attempted('job', 1, item)
    journal.close()
    journal = createOperationJournal(location)
    try {
      expect(journal.recover()).toEqual([expect.objectContaining({ state: 'interrupted', succeeded: 1, uncertainCount: 1, requested: 3, movedToTrashBytes: 40 })])
      const result = journal.detail('job')
      expect(result.results.map((value: any) => value.operationState)).toEqual(['confirmed', 'uncertain', 'planned'])
      expect(result.results[1].error).toContain('未确认')
      expect(journal.recover()[0].uncertainCount).toBe(1)
      expect(journal.clearCompleted()).toEqual({ retained: 1 })
      expect(journal.detail('job').results).toHaveLength(3)
    } finally { journal.close() }
  })

  it('paginates the complete audit instead of silently discarding results above the display cap', () => {
    const journal = createOperationJournal(file())
    try {
      const items = Array.from({ length: 1201 }, (_, index) => ({ ...item, candidateId: String(index) }))
      journal.begin('job', items)
      journal.recorded('job', 1200, { ...items[1200], success: false, error: 'blocked' })
      journal.finish('job', { cancelled: false })
      const pages = []
      let offset: number | null = 0
      while (offset !== null) { const page: { results: any[]; nextOffset: number | null } = journal.detail('job', { offset }); pages.push(...page.results); offset = page.nextOffset }
      expect(pages).toHaveLength(1201)
      expect(pages.at(-1)).toMatchObject({ candidateId: '1200', error: 'blocked' })
      expect(new Set(pages.map(value => value.ordinal)).size).toBe(1201)
      journal.clearCompleted()
      expect(journal.list()).toEqual([])
    } finally { journal.close() }
  })

  it('keeps a valid backup when recovering from a malformed primary state', () => {
    const target = path.join(path.dirname(file()), 'state.json')
    atomicWriteJson(target, { value: 1 }, { backup: true })
    atomicWriteJson(target, { value: 2 }, { backup: true })
    fs.writeFileSync(target, '{invalid')
    atomicWriteJson(target, { value: 3 }, { backup: true })
    expect(JSON.parse(fs.readFileSync(`${target}.bak`, 'utf8'))).toEqual({ value: 1 })
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ value: 3 })
    expect(fs.readdirSync(path.dirname(target)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
})
