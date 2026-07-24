import { describe, expect, it } from 'vitest'
// @ts-expect-error CommonJS desktop module is intentionally tested from TypeScript.
import { validateExclusion, historySummary } from '../desktop/handlers/cleaner-handlers.cjs'
// @ts-expect-error CommonJS desktop module is intentionally tested from TypeScript.
import { publicSnapshot, historyRecord } from '../desktop/handlers/change-handlers.cjs'
// @ts-expect-error CommonJS desktop module is intentionally tested from TypeScript.
import { createAiConfigService } from '../desktop/handlers/inspect-handlers.cjs'

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
})
