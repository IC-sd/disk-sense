// @ts-expect-error CommonJS desktop module is intentionally tested from the TypeScript suite.
import { explain, listDirectory, pathSignals, inferFromName, summarizeDirectory, estimateDirectory, readHead, MAX_CONTENT_BYTES } from '../desktop/explainer.cjs'
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
    const result = await estimateDirectory('C:\\Windows')
    expect(result.sampledNodes).toBeLessThanOrEqual(300)
    expect(result.bytes).toBeGreaterThanOrEqual(0)
  })

  it('reads only a bounded file prefix for content evidence', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-explainer-'))
    const target = path.join(temporary, 'large.bin')
    try {
      const descriptor = fs.openSync(target, 'w')
      fs.writeSync(descriptor, Buffer.from('HEADER'))
      fs.ftruncateSync(descriptor, 32 * 1024 * 1024)
      fs.closeSync(descriptor)
      const prefix = readHead(target, MAX_CONTENT_BYTES)
      expect(prefix.byteLength).toBe(MAX_CONTENT_BYTES)
      expect(prefix.subarray(0, 6).toString()).toBe('HEADER')
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
    const result = explain('C:\\Users', stat, [{ name: '12285' }, { name: 'tmp' }, { name: 'Windows' }])
    expect(result.classification).toBe('user-profile-root')
    expect(result.what).toBe('Windows 用户配置根目录')
  })

  it('recognizes protected Windows root objects without asking AI to guess', () => {
    expect(pathSignals('C:\\$Recycle.Bin').classification).toBe('recycle-bin')
    expect(pathSignals('C:\\System Volume Information').classification).toBe('system-metadata')
    expect(pathSignals('C:\\Documents and Settings').classification).toBe('compatibility-junction')
    expect(pathSignals('C:\\pagefile.sys').classification).toBe('system-managed-file')
    expect(pathSignals('C:\\inetpub').classification).toBe('web-server-root')
    const stat = { size: 0, mtimeMs: Date.now(), isDirectory: () => true }
    expect(explain('C:\\$Recycle.Bin', stat).whyHere).toContain('每个磁盘卷')
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
