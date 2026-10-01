import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error CommonJS desktop module is intentionally tested from TypeScript.
import { catalogDirectory, conventionalApplicationContext, explainRelationship, explanationFingerprint, findRelationshipLocations, roleForPath } from '../desktop/relationship-engine.cjs'

describe('space relationship engine', () => {
  it('keeps dependency manifests as components of the consuming project', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-component-'))
    const dependency = path.join(root, 'node_modules', 'widget')
    try {
      fs.mkdirSync(path.join(dependency, 'dist'), { recursive: true })
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'actual-project' }))
      fs.writeFileSync(path.join(dependency, 'package.json'), JSON.stringify({ name: 'widget' }))
      const result = await explainRelationship(path.join(dependency, 'dist', 'index.js'))
      expect(result.entityName).toBe('actual-project')
      expect(result.rootPath).toBe(root)
      expect(result.components[0].entityName).toBe('widget')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('uses the local data root for an application installed on another drive', async () => {
    const result = await explainRelationship('C:\\Users\\demo\\AppData\\Local\\AcmeEditor\\Cache\\index', {
      installedApplications: [{ registryKey: 'acme', displayName: 'Acme Editor', installLocation: 'D:\\Long\\Installation\\Path\\For\\Acme' }]
    })
    expect(result.rootPath).toBe('C:\\Users\\demo\\AppData\\Local\\AcmeEditor')
    expect(result.role.id).toBe('cache')
    expect(result.installLocation).toBe('D:\\Long\\Installation\\Path\\For\\Acme')
    expect(roleForPath('C:\\Acme\\Cache\\index', 'D:\\Long\\Unrelated\\Path').id).toBe('cache')
  })

  it('invalidates the analysis fingerprint when a parent manifest changes but the file does not', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-fingerprint-'))
    try {
      fs.mkdirSync(path.join(root, 'src'))
      const target = path.join(root, 'src', 'main.js')
      fs.writeFileSync(target, 'fixed')
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'first' }))
      const base = { path: target, size: 5, modifiedAt: 1 }
      const first = { ...base, relationship: await explainRelationship(target) }
      expect(explanationFingerprint(first)).toBe(explanationFingerprint({ ...base, relationship: await explainRelationship(target) }))
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'second-project' }))
      expect(explanationFingerprint(first)).not.toBe(explanationFingerprint({ ...base, relationship: await explainRelationship(target) }))
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('keeps installation ownership ahead of a bundled package manifest', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-installed-'))
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'internal-package' }))
      const result = await explainRelationship(path.join(root, 'index.js'), {
        installedApplications: [{ registryKey: 'installed', displayName: 'Actual Application', installLocation: root }]
      })
      expect(result.entityName).toBe('Actual Application')
      expect(result.components[0].entityName).toBe('internal-package')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
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
