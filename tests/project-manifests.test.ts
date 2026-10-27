import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error CommonJS catalogers are intentionally tested from TypeScript.
import { parseProjectManifest, MAX_MANIFEST_BYTES } from '../desktop/project-manifests.cjs'
// @ts-expect-error CommonJS relationship engine is intentionally tested from TypeScript.
import { explainRelationship, portableApplicationContext } from '../desktop/relationship-engine.cjs'
// @ts-expect-error CommonJS inventory is intentionally tested from TypeScript.
import { parseAppxOutput, matchInstalledApplication } from '../desktop/windows-app-inventory.cjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function directory() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-manifest-')); roots.push(root); return root }

describe('application and project source evidence', () => {
  it.each([
    ['python', '[build-system]\nname="wrong"\n[project]\nname="actual-python"\nversion="1.2"', 'pyproject.toml', 'actual-python'],
    ['rust', '[package]\nname="actual-rust"\nversion="1.2"\n[dependencies]\nname="wrong"', 'Cargo.toml', 'actual-rust'],
    ['go', 'module example.test/team/service\n\ngo 1.25', 'go.mod', 'example.test/team/service'],
    ['php', '{"name":"team/service","version":"1.2"}', 'composer.json', 'team/service'],
    ['java', '<project><parent><artifactId>wrong</artifactId></parent><artifactId>actual-java</artifactId></project>', 'pom.xml', 'actual-java']
  ])('parses %s identity without running package tools', (ecosystem, body, file, name) => {
    expect(parseProjectManifest(ecosystem, body, file).name).toBe(name)
  })

  it('does not execute setup.py and marks an oversized manifest as incomplete evidence', async () => {
    const root = directory()
    fs.writeFileSync(path.join(root, 'setup.py'), 'raise Exception("must never execute")')
    const first = await explainRelationship(root, { isDirectory: true })
    expect(first.provenance.manifest.note).toContain('不执行')
    fs.writeFileSync(path.join(root, 'pyproject.toml'), 'x'.repeat(MAX_MANIFEST_BYTES + 1))
    const second = await explainRelationship(root, { isDirectory: true })
    expect(second.provenance.manifest).toMatchObject({ status: 'oversized', bytes: 0 })
    expect(second.entityName).toBe(path.basename(root))
  })

  it('uses manifest digest to retain changes even with restored size and timestamps', async () => {
    const root = directory()
    const manifest = path.join(root, 'package.json')
    fs.writeFileSync(manifest, '{"name":"first"}')
    const stat = fs.statSync(manifest)
    const first = await explainRelationship(root, { isDirectory: true })
    fs.writeFileSync(manifest, '{"name":"other"}')
    fs.utimesSync(manifest, stat.atime, stat.mtime)
    const second = await explainRelationship(root, { isDirectory: true })
    expect(first.provenance.manifest.digest).not.toBe(second.provenance.manifest.digest)
  })

  it('relates Store data to the registered package family instead of a display-name guess', () => {
    const apps = parseAppxOutput(JSON.stringify({ Name: 'Acme.Editor', PackageFamilyName: 'Acme.Editor_123abc', PackageFullName: 'Acme.Editor_1.0_x64__123abc', InstallLocation: 'D:\\WindowsApps\\Acme.Editor_1.0_x64__123abc', Publisher: 'CN=Acme', Version: '1.0' }), { LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' })
    expect(matchInstalledApplication('C:\\Users\\demo\\AppData\\Local\\Packages\\Acme.Editor_123abc\\LocalCache\\x', apps)).toMatchObject({ matchType: 'package-data-path', application: { source: 'appx-current-user' } })
    expect(matchInstalledApplication('D:\\WindowsApps\\Acme.Editor_1.0_x64__123abc\\app.exe', apps)).toMatchObject({ matchType: 'package-install-path' })
    expect(matchInstalledApplication('C:\\Users\\demo\\AppData\\Local\\Packages\\Acme.Editor_123abc-other\\x', apps)).toBeNull()
    expect(parseAppxOutput('{bad')).toEqual([])
    expect(parseAppxOutput(JSON.stringify({ Name: 'Bad', PackageFamilyName: '..\\other' }))).toEqual([])
  })

  it('identifies a supported portable app at a custom location while qualifying its local identity', async () => {
    const root = directory()
    fs.mkdirSync(path.join(root, 'App', 'AppInfo'), { recursive: true })
    fs.mkdirSync(path.join(root, 'Data'))
    fs.writeFileSync(path.join(root, 'AcmePortable.exe'), '')
    fs.writeFileSync(path.join(root, 'App', 'AppInfo', 'appinfo.ini'), '[Details]\nName=Acme Portable\nAppID=AcmePortable\nPublisher=Acme\n[Control]\nStart=AcmePortable.exe')
    const result = await explainRelationship(path.join(root, 'Data'), { isDirectory: true })
    expect(result).toMatchObject({ entityName: 'Acme Portable', basis: 'portable-manifest', rootPath: root })
    expect(result.evidence.join(' ')).toContain('未经发布者签名验证')
    fs.unlinkSync(path.join(root, 'AcmePortable.exe'))
    expect(await portableApplicationContext(path.join(root, 'Data'), true)).toBeNull()
  })
})
