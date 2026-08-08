// @ts-expect-error CommonJS desktop module is intentionally tested from the TypeScript suite.
import { explain, explainPath, listDirectory, hydrateDirectoryItems, pathSignals, inferFromName, summarizeDirectory, estimateDirectory, readDirectoryEntries, readHeadAsync, MAX_CONTENT_BYTES, INITIAL_LIST_METADATA } from '../desktop/explainer.cjs'
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('explainer engine', () => {
  it('starts from the drive root and keeps directory listing bounded', async () => {
    const result = await listDirectory('C:\\')
    expect(result.path).toBe('C:\\')
    expect(result.items.length).toBeLessThanOrEqual(5000)
    expect(result.context.analyzed).toBe('path-name-parent-lazy-size')
    expect(result.items.filter((item: any) => item.isDirectory).every((item: any) => item.size === null)).toBe(true)
  })

  it('uses path context instead of treating all application data as junk', () => {
    const info = pathSignals('C:\\Users\\demo\\AppData\\Roaming\\Example\\Cache\\index.db')
    expect(info.classification).toBe('application-data')
    expect(info.risk).not.toBe('low')
  })

  it('includes parent, sibling and content evidence in an explanation', () => {
    const stat = { size: 24, mtimeMs: Date.now(), isDirectory: () => false }
    const result = explain('D:\\Projects\\demo\\package.json', stat, [{ name: 'src' }, { name: 'node_modules' }])
    expect(result.evidence.parent).toBe('demo')
    expect(result.evidence.pathSegments).toContain('package.json')
    expect(result.evidence.siblingNames).toContain('node_modules')
  })

  it('understands directory structure markers', () => {
    const result = summarizeDirectory([{ name: 'src' }, { name: 'package.json' }, { name: 'node_modules' }])
    expect(result.classification).toBe('development-project')
    expect(result.confidence).toBeGreaterThan(0.9)
  })

  it('recognizes Chromium and Edge profile data from directory children', () => {
    const result = summarizeDirectory([
      { name: 'Local State' },
      { name: 'Default' },
      { name: 'Crashpad' },
      { name: 'BrowserMetrics' },
      { name: 'GrShaderCache' }
    ])
    expect(result.classification).toBe('browser-profile-data')
    expect(result.confidence).toBeGreaterThan(0.9)
  })

  it('limits directory size estimation work', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-estimate-'))
    try {
      for (let index = 0; index < 220; index++) {
        fs.mkdirSync(path.join(temporary, `directory-${String(index).padStart(3, '0')}`))
      }
      const result = await estimateDirectory(temporary)
      expect(result.sampledNodes).toBeLessThanOrEqual(180)
      expect(result.complete).toBe(false)
      expect(result.bytes).toBeGreaterThanOrEqual(0)
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true })
    }
  })

  it('stops reading a large directory once the requested display limit is reached', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-list-'))
    try {
      for (let index = 0; index < 12; index++) {
        fs.writeFileSync(path.join(temporary, `${index}.tmp`), '')
      }
      const result = await readDirectoryEntries(temporary, 3)
      expect(result.entries).toHaveLength(3)
      expect(result.truncated).toBe(true)
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true })
    }
  })

  it('returns a large directory in stages and hydrates only requested rows', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-staged-list-'))
    try {
      for (let index = 0; index < INITIAL_LIST_METADATA + 20; index++) {
        fs.writeFileSync(path.join(temporary, `file-${String(index).padStart(3, '0')}.txt`), 'fixture')
      }
      const result = await listDirectory(temporary)
      const pending = result.items.filter((item: any) => item.metadataPending)
      expect(result.items).toHaveLength(INITIAL_LIST_METADATA + 20)
      expect(pending).toHaveLength(20)
      expect(result.context.metadataComplete).toBe(INITIAL_LIST_METADATA)

      const hydrated = await hydrateDirectoryItems(pending.slice(0, 5).map((item: any) => item.path))
      expect(hydrated).toHaveLength(5)
      expect(hydrated.every((item: any) => item.metadataPending === false)).toBe(true)
      expect(hydrated.every((item: any) => item.size === 7)).toBe(true)
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true })
    }
  })

  it('reads only a bounded file prefix for content evidence', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-explainer-'))
    const target = path.join(temporary, 'large.bin')
    try {
      const descriptor = fs.openSync(target, 'w')
      fs.writeSync(descriptor, Buffer.from('HEADER'))
      fs.ftruncateSync(descriptor, 32 * 1024 * 1024)
      fs.closeSync(descriptor)
      const prefix = await readHeadAsync(target, MAX_CONTENT_BYTES)
      expect(prefix.byteLength).toBe(MAX_CONTENT_BYTES)
      expect(prefix.subarray(0, 6).toString()).toBe('HEADER')
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true })
    }
  })

  it('loads selected-file content asynchronously and keeps the evidence bounded', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-async-evidence-'))
    const target = path.join(temporary, 'package.json')
    try {
      fs.writeFileSync(target, `${JSON.stringify({ name: 'disk-sense-fixture' })}\n${'x'.repeat(MAX_CONTENT_BYTES * 2)}`)
      const prefix = await readHeadAsync(target, MAX_CONTENT_BYTES)
      const result = await explainPath(target)

      expect(prefix.byteLength).toBe(MAX_CONTENT_BYTES)
      expect(result.evidence.content.bytes).toBe(MAX_CONTENT_BYTES)
      expect(result.contentPreview).toContain('disk-sense-fixture')
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true })
    }
  })

  it('marks low-confidence results as candidates for optional AI review', () => {
    const stat = { size: 0, mtimeMs: Date.now(), isDirectory: () => true }
    const result = explain('D:\\mystery\\data', stat, [{ name: 'part-1.bin' }])
    expect(result.analysisMode).toBe('local-evidence')
    expect(result.needsReview).toBe(true)
    expect(result.aiEligible).toBe(true)
    expect(result.isDirectory).toBe(true)
  })

  it('recognizes an installer file set from names and siblings', () => {
    const result = inferFromName('C:\\install.ini', [{ name: 'install.exe' }, { name: 'install.res.1028.dll' }])
    expect(result.classification).toBe('installer-residue')
    expect(result.confidence).toBeGreaterThan(0.9)
  })

  it('does not classify C:\\Users as a cache because another root folder is named tmp', () => {
    const stat = { size: 0, mtimeMs: Date.now(), isDirectory: () => true }
    const result = explain('C:\\Users', stat, [{ name: 'ExampleUser' }, { name: 'tmp' }, { name: 'Windows' }])
    expect(result.classification).toBe('user-profile-root')
    expect(result.what).toBe('Windows 用户配置根目录')
  })

  it('recognizes protected Windows root objects without asking AI to guess', () => {
    expect(pathSignals('C:\\$Recycle.Bin').classification).toBe('recycle-bin')
    expect(pathSignals('C:\\System Volume Information').classification).toBe('system-metadata')
    expect(pathSignals('C:\\Documents and Settings').classification).toBe('compatibility-junction')
    expect(pathSignals('C:\\pagefile.sys').classification).toBe('system-managed-file')
    expect(pathSignals('C:\\inetpub').classification).toBe('web-server-root')
    expect(pathSignals('C:\\Config.Msi').classification).toBe('windows-installer-rollback')
    expect(pathSignals('C:\\Boot').classification).toBe('boot-data')
    expect(pathSignals('C:\\$Windows.~BT').classification).toBe('installation-source')
    expect(pathSignals('D:\\FOUND.000').classification).toBe('recovered-file-fragments')
    const stat = { size: 0, mtimeMs: Date.now(), isDirectory: () => true }
    expect(explain('C:\\$Recycle.Bin', stat).whyHere).toContain('每个磁盘卷')
  })

  it('distinguishes an application shortcut from the real Windows system directory', () => {
    const shortcutPath = 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Word.lnk'
    const shortcut = pathSignals(shortcutPath)
    const systemFile = pathSignals('C:\\Windows\\System32\\kernel32.dll')

    expect(shortcut).toMatchObject({
      classification: 'application-shortcut',
      source: 'Word 应用快捷方式'
    })
    expect(systemFile.classification).toBe('system-component')
    expect(explain(shortcutPath, {
      size: 1024,
      mtimeMs: Date.now(),
      isDirectory: () => false
    }).purpose).toContain('启动对应应用')
  })

  it('identifies filesystem links without following them for content analysis', () => {
    const stat = {
      size: 0,
      mtimeMs: Date.now(),
      isDirectory: () => false,
      isSymbolicLink: () => true
    }
    const result = explain('C:\\legacy-link', stat)
    expect(result.classification).toBe('filesystem-link')
    expect(result.isLink).toBe(true)
    expect(result.contentPreview).toBeNull()
    expect(result.handling).toContain('链接目标')
  })
})
