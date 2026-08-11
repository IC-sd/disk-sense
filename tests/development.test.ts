// @ts-expect-error CommonJS desktop module is intentionally tested from the TypeScript suite.
import { DEFAULT_DEVELOPMENT_SERVER_URL, normalizeDevelopmentServerUrl } from '../desktop/development.cjs'
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

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

  it('keeps HMR same-origin and allows Vite to select a free loopback port', () => {
    const root = path.resolve(import.meta.dirname, '..')
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    const vite = fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf8')
    expect(html).toContain("connect-src 'self'")
    expect(html).not.toContain('ws://127.0.0.1:5173')
    expect(vite).toContain('strictPort: false')
    expect(vite).toContain('disk-sense-development-csp')
    expect(vite).toContain('ws://127.0.0.1:${String(address.port)}')
  })
})
