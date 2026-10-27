// @ts-expect-error CommonJS desktop module is intentionally tested from the TypeScript suite.
import { executeMaintenanceAction, inspectSlimming, maintenanceActions, parseDismAnalysis, systemExecutable, spawnCommand } from '../desktop/system-maintenance.cjs'
// @ts-expect-error CommonJS desktop handler helper is intentionally tested from the TypeScript suite.
import { failedMaintenanceJob } from '../desktop/handlers/cleaner-handlers.cjs'
import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const elevatedStatus = {
  platform: 'win32',
  elevated: true,
  commands: {
    'powercfg.exe': true,
    'Dism.exe': true,
    'SystemPropertiesAdvanced.exe': true,
    'fltmc.exe': true
  }
}

describe('Windows system maintenance safety boundary', () => {
  it('builds a durable failure record when an approved maintenance action cannot start', () => {
    const job = failedMaintenanceJob({
      id: 'maintenance-test',
      actionId: 'component-cleanup',
      startedAt: '2026-01-01T00:00:00.000Z'
    }, new Error('DISM 启动失败'))

    expect(job).toMatchObject({
      id: 'maintenance-test',
      actionId: 'component-cleanup',
      ruleId: 'component-store',
      success: false,
      exitCode: -1,
      reclaimedBytes: 0,
      message: 'DISM 启动失败'
    })
    expect(job.finishedAt).toBeTruthy()
  })

  it('publishes actions without exposing executable paths or command arguments', () => {
    const items = inspectSlimming(elevatedStatus)
    const actions = items.flatMap((item: any) => item.actions)

    expect(maintenanceActions.map((item: any) => item.id)).toEqual([
      'hibernation-disable',
      'hibernation-enable',
      'component-analyze',
      'component-cleanup',
      'component-reset-base',
      'virtual-memory-settings',
      'previous-windows-settings'
    ])
    expect(actions.length).toBeGreaterThan(0)
    expect(actions.every((action: any) => !('args' in action) && !('executable' in action))).toBe(true)
  })

  it('fails closed without administrator rights before invoking a command', async () => {
    const runCommand = vi.fn()

    await expect(executeMaintenanceAction({
      actionId: 'component-cleanup',
      confirmation: '清理组件'
    }, {
      status: { ...elevatedStatus, elevated: false },
      runCommand,
      existsSync: () => true,
      readAvailableBytes: () => 100
    })).rejects.toThrow('管理员')

    expect(runCommand).not.toHaveBeenCalled()
  })

  it('requires the dedicated irreversible confirmation phrase for ResetBase', async () => {
    const runCommand = vi.fn()

    await expect(executeMaintenanceAction({
      actionId: 'component-reset-base',
      confirmation: '清理组件'
    }, {
      status: elevatedStatus,
      runCommand,
      existsSync: () => true
    })).rejects.toThrow('RESETBASE')

    expect(runCommand).not.toHaveBeenCalled()
  })

  it('ignores renderer supplied command fields and executes only the fixed DISM allowlist', async () => {
    const calls: Array<{ executable: string; args: string[]; purpose?: string }> = []
    const progress: unknown[] = []
    const freeSpace = [100, 175]

    const result = await executeMaintenanceAction({
      actionId: 'component-cleanup',
      confirmation: '清理组件',
      executable: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/c', 'whoami']
    }, {
      status: elevatedStatus,
      windowsDirectory: 'C:\\Windows',
      existsSync: () => true,
      readAvailableBytes: () => freeSpace.shift() ?? 175,
      onProgress: (value: unknown) => progress.push(value),
      runCommand: async (executable: string, args: string[], options: any) => {
        calls.push({ executable, args, purpose: options.purpose })
        options.onProgress({ percent: 42, message: '42.0%' })
        return { exitCode: 0, signal: null, stdout: 'The operation completed successfully.', stderr: '' }
      }
    })

    expect(path.basename(calls[0].executable).toLowerCase()).toBe('dism.exe')
    expect(calls[0].args).toEqual([
      '/Online',
      '/English',
      '/Cleanup-Image',
      '/StartComponentCleanup',
      '/NoRestart'
    ])
    expect(calls[0].purpose).toBe('component-cleanup')
    expect(result).toMatchObject({ success: true, reclaimedBytes: 0, observedAvailableDeltaBytes: 75,
      spaceMeasurement: 'volume-delta-not-attributed', outcome: 'completed', irreversible: false })
    expect(progress).not.toHaveLength(0)
  })

  it('uses Windows-owned settings surfaces instead of changing pagefile or Windows.old directly', async () => {
    const openedPaths: string[] = []
    const openedTargets: string[] = []
    const runCommand = vi.fn()
    const options = {
      status: elevatedStatus,
      windowsDirectory: 'C:\\Windows',
      readAvailableBytes: () => 100,
      runCommand,
      existsSync: () => true,
      openPath: async (value: string) => {
        openedPaths.push(value)
        return ''
      },
      openExternal: async (value: string) => {
        openedTargets.push(value)
      }
    }

    await executeMaintenanceAction({
      actionId: 'virtual-memory-settings',
      confirmation: '打开设置'
    }, options)
    await executeMaintenanceAction({
      actionId: 'previous-windows-settings',
      confirmation: '打开设置'
    }, options)

    expect(openedPaths).toEqual([systemExecutable('SystemPropertiesAdvanced.exe', 'C:\\Windows')])
    expect(openedTargets).toEqual(['ms-settings:storage'])
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('parses the official DISM analysis without inventing reclaimable bytes', () => {
    expect(parseDismAnalysis(`
      Number of Reclaimable Packages : 4
      Component Store Cleanup Recommended : Yes
    `)).toEqual({
      reclaimablePackages: 4,
      cleanupRecommended: true
    })
    expect(parseDismAnalysis('unrecognized output')).toEqual({
      reclaimablePackages: null,
      cleanupRecommended: null
    })
  })

  it.each([3010, 1641])('preserves successful DISM exit %i as pending restart, without triggering restart', async exitCode => {
    const runCommand = vi.fn(async () => ({ exitCode, stdout: '', stderr: '' }))
    const result = await executeMaintenanceAction({ actionId: 'component-cleanup', confirmation: '清理组件' }, {
      status: elevatedStatus, existsSync: () => true, runCommand, readAvailableBytes: () => 100
    })
    expect(result).toMatchObject({ success: true, exitCode, outcome: 'restart-required', restartRequired: true, reclaimedBytes: 0 })
    expect(result.message).toContain('不会自动重启')
    expect(runCommand).toHaveBeenCalledOnce()
    expect(runCommand.mock.calls[0]).toBeDefined()
  })

  it('marks killed commands interrupted, even if a runner supplies exit code zero', async () => {
    const result = await executeMaintenanceAction({ actionId: 'component-cleanup', confirmation: '清理组件' }, {
      status: elevatedStatus, existsSync: () => true,
      runCommand: async () => ({ exitCode: 0, signal: 'SIGTERM', stdout: '', stderr: '' }),
      readAvailableBytes: () => 100
    })
    expect(result).toMatchObject({ success: false, outcome: 'interrupted', signal: 'SIGTERM', restartRequired: false, reclaimedBytes: 0 })
  })

  it('does not attribute free volume space to a failed maintenance job', async () => {
    let bytes = 100
    const result = await executeMaintenanceAction({ actionId: 'component-cleanup', confirmation: '清理组件' }, {
      status: elevatedStatus, existsSync: () => true,
      runCommand: async () => { bytes = 200; return { exitCode: 87, stdout: '', stderr: 'invalid option' } }, readAvailableBytes: () => bytes
    })
    expect(result).toMatchObject({ success: false, outcome: 'failed', reclaimedBytes: 0, observedAvailableDeltaBytes: 100 })
  })

  it('waits for output drain and parses percentages split over stdout chunks', async () => {
    const child: any = new EventEmitter()
    child.stdout = new PassThrough(); child.stderr = new PassThrough()
    const progress: any[] = []
    let settled = false
    const promise = spawnCommand('fixture.exe', [], { spawn: () => child, onProgress: (p: any) => progress.push(p) }).then((r: any) => { settled = true; return r })
    child.stdout.write('42.'); child.stdout.write('5%\n')
    child.emit('exit', 0, null)
    await Promise.resolve()
    expect(settled).toBe(false)
    child.stdout.write('The operation completed successfully.\n')
    child.emit('close', 0, null)
    const result = await promise
    expect(result.stdout).toContain('completed successfully')
    expect(progress.some(p => p.percent === 42.5)).toBe(true)
  })

  it('can cancel before launch while exposing running maintenance as non-cancellable', async () => {
    const runCommand = vi.fn()
    await expect(executeMaintenanceAction({ actionId: 'component-cleanup', confirmation: '清理组件' }, {
      status: elevatedStatus, signal: AbortSignal.abort(), runCommand
    })).rejects.toThrow('启动前已取消')
    expect(runCommand).not.toHaveBeenCalled()
  })
})
