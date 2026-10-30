const { execFileSync } = require('node:child_process')

function acceptanceEnvironment({ environment = process.env, platform = process.platform, model = '' } = {}) {
  if (platform !== 'win32') return { allowed: false, reason: 'Windows is required' }
  const hosted = environment.GITHUB_ACTIONS === 'true'
    && environment.RUNNER_ENVIRONMENT === 'github-hosted' && environment.RUNNER_OS === 'Windows'
  if (hosted && environment.DISK_SENSE_DISPOSABLE_ACCEPTANCE === '1') {
    return { allowed: true, kind: 'github-hosted-disposable-windows' }
  }
  const virtualMachine = /virtual machine|vmware|virtualbox|kvm|qemu|hvm domu|parallels/iu.test(model)
  if (environment.DISK_SENSE_DISPOSABLE_VM === '1' && virtualMachine) {
    return { allowed: true, kind: 'explicit-disposable-windows-vm' }
  }
  return { allowed: false, reason: 'Use an explicitly disposable Windows VM or the dedicated GitHub-hosted acceptance job; a hypervisor/VBS flag alone is insufficient' }
}

function machineModel() {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).Model'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 10000 }).trim()
  } catch { return '' }
}

function requireDisposableWindows() {
  const state = acceptanceEnvironment({ model: machineModel() })
  if (!state.allowed) throw new Error(`Windows acceptance refused: ${state.reason}`)
  return state
}

if (require.main === module) {
  try {
    const state = process.argv.includes('--require') ? requireDisposableWindows() : acceptanceEnvironment({ model: machineModel() })
    process.stdout.write(`${JSON.stringify(state)}\n`)
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}

module.exports = { acceptanceEnvironment, requireDisposableWindows }
