import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error CommonJS desktop module is intentionally tested from TypeScript.
import { lockDownSession } from '../desktop/security.cjs'

describe('desktop permission boundary', () => {
  it('denies permission checks and renderer permission requests by default', () => {
    let checkHandler: (() => boolean) | undefined
    let requestHandler: ((webContents: unknown, permission: string, callback: (allowed: boolean) => void) => void) | undefined
    const electronSession = {
      setPermissionCheckHandler: vi.fn((handler: () => boolean) => { checkHandler = handler }),
      setPermissionRequestHandler: vi.fn((handler: typeof requestHandler) => { requestHandler = handler })
    }

    lockDownSession(electronSession)
    expect(checkHandler?.()).toBe(false)
    const callback = vi.fn()
    requestHandler?.({}, 'geolocation', callback)
    expect(callback).toHaveBeenCalledWith(false)
  })
})
