// @ts-expect-error CommonJS desktop module is intentionally tested from the TypeScript suite.
import { explain, listDirectory, pathSignals, inferFromName, summarizeDirectory, estimateDirectory } from '../desktop/explainer.cjs'
import { describe, expect, it } from 'vitest'

describe('explainer engine', () => {
  it('starts from the drive root and keeps directory listing bounded', async () => {
    const result = await listDirectory('C:\\')
    expect(result.path).toBe('C:\\')
    expect(result.items.length).toBeLessThanOrEqual(5000)
    expect(result.context.analyzed).toBe('path-name-parent')
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

  it('limits directory size estimation work', async () => {
    const result = await estimateDirectory('C:\\Windows')
    expect(result.sampledNodes).toBeLessThanOrEqual(300)
    expect(result.bytes).toBeGreaterThanOrEqual(0)
  })

  it('marks low-confidence results as candidates for optional AI review', () => {
    const stat = { size: 0, mtimeMs: Date.now(), isDirectory: () => true }
    const result = explain('D:\\mystery\\data', stat, [{ name: 'part-1.bin' }])
    expect(result.analysisMode).toBe('local-evidence')
    expect(result.needsReview).toBe(true)
    expect(result.aiEligible).toBe(true)
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
})
