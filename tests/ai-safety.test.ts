import { describe, expect, it } from 'vitest'
// @ts-expect-error CommonJS module is tested from TypeScript.
import { redactSensitiveText } from '../desktop/ai-safety.cjs'

describe('sensitive evidence redaction', () => {
  it.each([
    '{"password":"alpha beta gamma"}',
    "password='alpha beta gamma'",
    'password="alpha \\"beta\\" gamma"',
    'secret="alpha\nbeta\ngamma"',
    'password="alpha beta gamma',
    'password=alpha beta gamma\npublic=yes',
    '{"access_token":"alpha,beta gamma"}',
    'secret: |\n  alpha\n  beta\n  gamma\npublic: yes',
    'password: >-\n  alpha beta\n  gamma',
    '-----BEGIN RSA PRIVATE KEY-----\nalpha beta gamma',
  ])('removes the complete secret from %s', input => {
    const redacted = redactSensitiveText(input)
    for (const word of ['alpha', 'beta', 'gamma']) expect(redacted).not.toContain(word)
    expect(redacted).toMatch(/\[REDACTED(?: PRIVATE KEY)?\]/)
  })
  it('preserves adjacent public fields', () => {
    expect(redactSensitiveText('{"password":"alpha beta","name":"public"}')).toBe('{"password":"[REDACTED]","name":"public"}')
  })
})
