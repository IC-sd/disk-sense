import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error CommonJS desktop module is intentionally tested from TypeScript.
import { createDiagnostics, safeDetails } from '../desktop/diagnostics.cjs'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('local diagnostics', () => {
  it('records structured failures without throwing into the application', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-log-'))
    roots.push(root)
    const file = path.join(root, 'disk-sense.log')
    const diagnostics = createDiagnostics(file)
    diagnostics.log('error', 'test-failure', new Error('example'))

    const record = JSON.parse(fs.readFileSync(file, 'utf8').trim())
    expect(record.event).toBe('test-failure')
    expect(record.details.message).toBe('example')
  })

  it('turns non-cloneable details into bounded diagnostic text', () => {
    const circular: any = {}
    circular.self = circular
    expect(safeDetails(circular).value).toBe('[object Object]')
  })
})
