// @ts-expect-error CommonJS desktop module is intentionally tested from the TypeScript suite.
import { DEFAULT_DEVELOPMENT_SERVER_URL, normalizeDevelopmentServerUrl } from '../desktop/development.cjs'
import { describe, expect, it } from 'vitest'

describe('desktop development server boundary', () => {
  it('accepts dynamically selected loopback ports used by Vite', () => {
    expect(normalizeDevelopmentServerUrl('http://127.0.0.1:5187/')).toBe('http://127.0.0.1:5187/')
    expect(normalizeDevelopmentServerUrl('http://localhost:6199/path?debug=1')).toBe('http://localhost:6199/')
  })

  it('rejects remote, credentialed and non-http renderer origins', () => {
    expect(normalizeDevelopmentServerUrl('https://example.com')).toBe(DEFAULT_DEVELOPMENT_SERVER_URL)
    expect(normalizeDevelopmentServerUrl('http://user:secret@localhost:5173')).toBe(DEFAULT_DEVELOPMENT_SERVER_URL)
    expect(normalizeDevelopmentServerUrl('file:///tmp/index.html')).toBe(DEFAULT_DEVELOPMENT_SERVER_URL)
  })
})
