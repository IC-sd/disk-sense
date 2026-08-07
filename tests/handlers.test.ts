import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error CommonJS desktop module is intentionally tested from TypeScript.
import { validateExclusion, historySummary } from '../desktop/handlers/cleaner-handlers.cjs'
// @ts-expect-error CommonJS desktop module is intentionally tested from TypeScript.
import { publicSnapshot, historyRecord } from '../desktop/handlers/change-handlers.cjs'
// @ts-expect-error CommonJS desktop module is intentionally tested from TypeScript.
import { createAiConfigService, findOfficeBrandIconAsync, resolveFilePresentation } from '../desktop/handlers/inspect-handlers.cjs'

describe('desktop handler boundaries', () => {
  it('validates exclusions before they enter persisted state', () => {
    expect(() => validateExclusion('relative/cache')).toThrow()
    const result = validateExclusion({ path: 'C:\\Users\\demo\\cache', mode: 'exact', reason: 'keep' })
    expect(result.path).toBe('C:\\Users\\demo\\cache')
    expect(result.mode).toBe('exact')
    expect(result.reason).toBe('keep')
    expect(result.id).toBeTruthy()
  })

  it('publishes snapshot metadata without exposing the full inventory', () => {
    const result = publicSnapshot({
      schemaVersion: 3,
      roots: ['C:\\'],
      entries: [{ path: 'C:\\one' }],
      scannedDirectories: ['C:\\'],
      rootCoverage: [{ root: 'C:\\', entries: 1 }]
    })
    expect(result.entryCount).toBe(1)
    expect(result.directoryCount).toBe(1)
    expect(result).not.toHaveProperty('entries')
  })

  it('compacts cleanup and change history into stable summaries', () => {
    expect(historySummary({
      id: 'cleanup-1',
      results: [{ success: true }, { success: false }],
      movedToTrashBytes: 20
    })).toMatchObject({ succeeded: 1, failed: 1, movedToTrashBytes: 20 })

    expect(historyRecord(
      'change-1',
      { createdAt: 'before' },
      { roots: ['C:\\'] },
      { summary: { added: 1 }, coverage: { partial: true } },
      'after'
    )).toMatchObject({ baselineCreatedAt: 'before', createdAt: 'after', partial: true })
  })

  it('encrypts persisted AI credentials and does not reuse them for another endpoint', () => {
    const state: any = { aiSettings: null }
    let saves = 0
    const database = { read: () => state, save: () => { saves++ } }
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
      decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, '')
    }
    const service = createAiConfigService({
      getDb: () => database,
      safeStorage,
      environment: {}
    })

    service.save({
      endpoint: 'https://api.example.com/v1',
      model: 'model-one',
      apiKey: 'secret'
    })
    expect(state.aiSettings.apiKeyEncrypted).not.toContain('secret')
    expect(service.runtime().apiKey).toBe('secret')
    expect(service.publicConfig().keyStored).toBe(true)

    service.save({
      endpoint: 'https://other.example.com/v1',
      model: 'model-two'
    })
    expect(state.aiSettings.apiKeyEncrypted).toBe('')
    expect(saves).toBe(2)
  })

  it('resolves Office shortcuts to their real application identity and icon target', () => {
    const presentation = resolveFilePresentation(
      'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Word.lnk',
      {
        readShortcutLink: () => ({
          target: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
          icon: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\wordicon.exe',
          description: 'Create and edit documents'
        })
      }
    )

    expect(presentation).toMatchObject({
      displayName: 'Microsoft Word',
      iconTarget: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\wordicon.exe',
      target: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE'
    })
    expect(resolveFilePresentation('C:\\Documents\\word-plan.docx', {})).toMatchObject({
      displayName: '',
      iconTarget: 'C:\\Documents\\word-plan.docx'
    })
  })

  it('finds a bounded Office brand icon beside the installed application tree without blocking the handler', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-office-'))
    try {
      const officeDirectory = path.join(root, 'Office16')
      const iconDirectory = path.join(officeDirectory, 'sdxs', 'package', 'OfflineFiles')
      fs.mkdirSync(iconDirectory, { recursive: true })
      const iconPath = path.join(iconDirectory, 'word-icon_fixture.png')
      fs.writeFileSync(iconPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      expect(await findOfficeBrandIconAsync(path.join(officeDirectory, 'WINWORD.EXE'))).toBe(iconPath)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
