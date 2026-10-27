import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error Prefix parser is a CommonJS desktop module.
import { identifyPrefix, MAX_PREFIX_BYTES } from '../desktop/file-evidence.cjs'
// @ts-expect-error Explainer is a CommonJS desktop module.
import { explain, readContentAsync, readHeadAsync } from '../desktop/explainer.cjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture(name: string, content: Buffer) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-signature-'))
  roots.push(root)
  const target = path.join(root, name)
  fs.writeFileSync(target, content)
  return target
}
function zipEntry(name: string) {
  const encoded = Buffer.from(name)
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50)
  header.writeUInt16LE(encoded.length, 26)
  return Buffer.concat([header, encoded])
}

describe('bounded independent file format evidence', () => {
  it('detects a SQLite database even when its extension claims text', async () => {
    const target = fixture('harmless.txt', Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4096)]))
    const stat = fs.statSync(target)
    const content = await readContentAsync(target, stat)
    const result = explain(target, stat, [], null, [], content)
    expect(content.fileType).toMatchObject({ format: 'sqlite', source: 'file-header', extensionConflict: true })
    expect(result.risk).toBe('danger')
    expect(result.contentPreview).toBeNull()
    expect(result.evidence.observations).toContainEqual(expect.objectContaining({ source: 'file-header', extensionConflict: true }))
  })

  it('requires a valid PE header offset instead of trusting two MZ bytes', () => {
    const truncated = identifyPrefix(Buffer.from('MZ'), 'app.exe')
    expect(truncated).toMatchObject({ format: 'mz', status: 'incomplete' })
    const header = Buffer.alloc(256)
    header.write('MZ')
    header.writeUInt32LE(128, 60)
    header.write('PE\0\0', 128)
    expect(identifyPrefix(header, 'app.log')).toMatchObject({ format: 'pe', status: 'matched', extensionConflict: true })
    header.writeUInt32LE(MAX_PREFIX_BYTES + 1, 60)
    expect(identifyPrefix(header, 'app.exe', 100000)).toMatchObject({ format: 'mz', status: 'prefix-limited' })
  })

  it('does not present damaged MZ data as a confirmed executable', async () => {
    const target = fixture('damaged.txt', Buffer.from('MZ'))
    const stat = fs.statSync(target)
    const result = explain(target, stat, [], null, [], await readContentAsync(target, stat))
    expect(result.confidence).toBeLessThan(.8)
    expect(result.classification).toBe('unclassified')
    expect(result.evidence.fileType.details.join(' ')).toContain('仅发现 MZ')
  })

  it('identifies Office only when structural ZIP entries support that subtype', () => {
    const office = Buffer.concat([zipEntry('[Content_Types].xml'), zipEntry('word/document.xml')])
    expect(identifyPrefix(office, 'renamed.zip')).toMatchObject({ format: 'docx', extensionConflict: true })
    expect(identifyPrefix(zipEntry('word/document.xml'), 'report.docx')).toMatchObject({ format: 'zip' })
    expect(identifyPrefix(Buffer.from('504b0304', 'hex'), 'report.docx')).toMatchObject({ format: 'zip' })
  })

  it.each([
    ['89504e470d0a1a0a', 'png'], ['474946383961', 'gif'], ['1f8b08', 'gzip'],
    ['377abcaf271c', '7z'], ['4f676753', 'ogg'], ['d0cf11e0a1b11ae1', 'ole']
  ])('recognizes signature %s without executing or decoding payloads', (hex, format) => {
    expect(identifyPrefix(Buffer.from(hex, 'hex'), 'unknown.bin').format).toBe(format)
  })

  it('keeps known system risk when a signature suggests user media', () => {
    const stat = { size: 12, mtimeMs: 1, isDirectory: () => false }
    const fileType = identifyPrefix(Buffer.from('89504e470d0a1a0a', 'hex'), 'C:\\Windows\\system.png')
    const result = explain('C:\\Windows\\system.png', stat, [], null, [], { kind: 'binary-signature', signature: fileType.type, fileType })
    expect(result.risk).toBe('danger')
  })

  it('bounds reads for a huge file and for an excessive requested limit', async () => {
    const target = fixture('huge.txt', Buffer.from('bounded text'))
    const descriptor = fs.openSync(target, 'r+')
    fs.ftruncateSync(descriptor, 512 * 1024 * 1024)
    fs.closeSync(descriptor)
    expect((await readHeadAsync(target, Number.MAX_SAFE_INTEGER)).length).toBe(MAX_PREFIX_BYTES)
    expect((await readContentAsync(target, fs.statSync(target))).bytes).toBeLessThanOrEqual(MAX_PREFIX_BYTES)
  })

  it('does not turn unknown binary bytes with a text extension into an AI text preview', async () => {
    const target = fixture('binary.json', Buffer.alloc(128, 0))
    expect(await readContentAsync(target, fs.statSync(target))).toMatchObject({ kind: 'unrecognized-binary', preview: null })
  })
})
