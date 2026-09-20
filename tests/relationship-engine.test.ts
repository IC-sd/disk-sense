import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error CommonJS desktop module is intentionally tested from TypeScript.
import { catalogDirectory, conventionalApplicationContext, explainRelationship, findRelationshipLocations, roleForPath } from '../desktop/relationship-engine.cjs'

describe('space relationship engine', () => {
  it('catalogs projects from primary and supporting markers', () => {
    const result = catalogDirectory(['package.json', 'src', 'node_modules', 'pnpm-lock.yaml'])
    expect(result.id).toBe('node')
    expect(result.confidence).toBeGreaterThan(.9)
    expect(result.primaryMatches).toContain('package.json')
  })

  it('relates a generated child directory back to its project root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-relation-'))
    const cache = path.join(root, 'node_modules', '.cache')
    try {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true })
      fs.mkdirSync(cache, { recursive: true })
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'relation-fixture' }))
      const result = await explainRelationship(cache, { isDirectory: true })
      expect(result).toMatchObject({
        entityType: 'project',
        entityName: 'relation-fixture',
        rootPath: root
      })
      expect(result.role.id).toBe('cache')
      expect(result.evidence.join(' ')).toContain('package.json')
      const locations = await findRelationshipLocations(result, cache)
      expect(locations).toContainEqual(expect.objectContaining({ path: root }))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('distinguishes project source, build output and caches by their role', () => {
    expect(roleForPath('D:\\project\\src\\main.ts', 'D:\\project').id).toBe('source')
    expect(roleForPath('D:\\project\\dist\\app.js', 'D:\\project').id).toBe('build-output')
    expect(roleForPath('D:\\project\\Cache\\index.bin', 'D:\\project').id).toBe('cache')
  })

  it('infers an application owner from standard Windows data directories without claiming certainty', () => {
    const result = conventionalApplicationContext('C:\\Users\\demo\\AppData\\Roaming\\AcmeEditor\\Cache\\index')
    expect(result).toMatchObject({
      entityType: 'application',
      entityName: 'AcmeEditor',
      confidence: .66
    })
    expect(result.role.id).toBe('cache')
  })

  it('uses a known application signature before a generic folder guess', async () => {
    const result = await explainRelationship('C:\\Users\\demo\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache\\x')
    expect(result.entityName).toBe('Google Chrome')
    expect(result.confidence).toBeGreaterThan(.9)
  })

  it('uses Windows installation evidence to verify an application relationship', async () => {
    const result = await explainRelationship('C:\\Program Files\\Acme Editor\\plugins\\formatter.dll', {
      installedApplications: [{
        registryKey: 'HKEY_LOCAL_MACHINE\\Uninstall\\Acme',
        displayName: 'Acme Editor',
        publisher: 'Acme Software',
        installLocation: 'C:\\Program Files\\Acme Editor',
        displayIcon: 'C:\\Program Files\\Acme Editor\\Acme.exe'
      }]
    })
    expect(result).toMatchObject({
      entityName: 'Acme Editor',
      entityKind: 'Windows 已安装应用',
      confidence: .98,
      publisher: 'Acme Software'
    })
    expect(result.evidence.join(' ')).toContain('Windows 登记的安装目录')
  })
})
