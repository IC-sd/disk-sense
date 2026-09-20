import { describe, expect, it } from 'vitest'
// @ts-expect-error CommonJS desktop module is intentionally tested from TypeScript.
import { cleanRegistryPath, isSpecificApplicationRoot, matchInstalledApplication, parseRegistryOutput } from '../desktop/windows-app-inventory.cjs'

const registryFixture = String.raw`
HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Acme
    DisplayName    REG_SZ    Acme Editor
    Publisher    REG_SZ    Acme Software
    InstallLocation    REG_SZ    C:\Program Files\Acme Editor\
    DisplayIcon    REG_SZ    "C:\Program Files\Acme Editor\Acme.exe",0
    UninstallString    REG_SZ    "C:\Program Files\Acme Editor\uninstall.exe" /S

HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Hidden
    Publisher    REG_SZ    Internal only
`

describe('Windows installed application inventory', () => {
  it('parses useful application identity fields and ignores entries without a display name', () => {
    const applications = parseRegistryOutput(registryFixture)
    expect(applications).toHaveLength(1)
    expect(applications[0]).toMatchObject({
      displayName: 'Acme Editor',
      publisher: 'Acme Software',
      installLocation: 'C:\\Program Files\\Acme Editor',
      displayIcon: 'C:\\Program Files\\Acme Editor\\Acme.exe'
    })
  })

  it('extracts a quoted executable without retaining arguments or icon indexes', () => {
    expect(cleanRegistryPath('"C:\\Apps\\Tool\\tool.exe",-4')).toBe('C:\\Apps\\Tool\\tool.exe')
    expect(cleanRegistryPath('"C:\\Apps\\Tool\\remove.exe" /quiet')).toBe('C:\\Apps\\Tool\\remove.exe')
  })

  it('uses the deepest registered install path as strong ownership evidence', () => {
    const applications = parseRegistryOutput(registryFixture)
    expect(matchInstalledApplication('C:\\Program Files\\Acme Editor\\plugins\\formatter.dll', applications, '')).toMatchObject({
      matchType: 'install-path',
      confidence: .98,
      application: { displayName: 'Acme Editor' }
    })
  })

  it('correlates an application data folder with a registered display name conservatively', () => {
    const applications = parseRegistryOutput(registryFixture)
    expect(matchInstalledApplication('C:\\Users\\demo\\AppData\\Roaming\\AcmeEditor\\Cache', applications, 'AcmeEditor')).toMatchObject({
      matchType: 'directory-name',
      confidence: .84,
      application: { displayName: 'Acme Editor' }
    })
  })

  it('rejects registry roots that are too broad to prove application ownership', () => {
    expect(isSpecificApplicationRoot('C:\\')).toBe(false)
    expect(isSpecificApplicationRoot('C:\\Windows')).toBe(false)
    expect(isSpecificApplicationRoot('C:\\Program Files')).toBe(false)
    expect(isSpecificApplicationRoot('C:\\Program Files\\Acme Editor')).toBe(true)
    expect(matchInstalledApplication('C:\\Windows\\System32\\kernel32.dll', [{
      registryKey: 'bad',
      displayName: 'Bad Registry Entry',
      installLocation: 'C:\\Windows'
    }], '')).toBeNull()
  })
})
