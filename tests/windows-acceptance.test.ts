import { describe, expect, it } from 'vitest'
// @ts-expect-error The acceptance guard is a CommonJS script.
import { acceptanceEnvironment } from '../scripts/windows-acceptance-guard.cjs'

describe('disposable Windows acceptance guard', () => {
  it('refuses a physical host even if virtualization is present or a VM flag is set', () => {
    expect(acceptanceEnvironment({ platform: 'win32', model: 'LENOVO 83QG', environment: {} }).allowed).toBe(false)
    expect(acceptanceEnvironment({ platform: 'win32', model: 'LENOVO 83QG', environment: { DISK_SENSE_DISPOSABLE_VM: '1' } }).allowed).toBe(false)
  })
  it('requires both a VM identity and an explicit disposable marker', () => {
    expect(acceptanceEnvironment({ platform: 'win32', model: 'Virtual Machine', environment: {} }).allowed).toBe(false)
    expect(acceptanceEnvironment({ platform: 'win32', model: 'Virtual Machine', environment: { DISK_SENSE_DISPOSABLE_VM: '1' } })).toMatchObject({ allowed: true, kind: 'explicit-disposable-windows-vm' })
  })
  it('accepts only the opted-in GitHub-hosted Windows job, not self-hosted or non-Windows runners', () => {
    const environment = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', DISK_SENSE_DISPOSABLE_ACCEPTANCE: '1' }
    expect(acceptanceEnvironment({ platform: 'win32', environment }).allowed).toBe(true)
    expect(acceptanceEnvironment({ platform: 'win32', environment: { ...environment, RUNNER_ENVIRONMENT: 'self-hosted' } }).allowed).toBe(false)
    expect(acceptanceEnvironment({ platform: 'linux', environment }).allowed).toBe(false)
    expect(acceptanceEnvironment({ platform: 'win32', environment: { ...environment, DISK_SENSE_DISPOSABLE_ACCEPTANCE: '' } }).allowed).toBe(false)
  })
})
