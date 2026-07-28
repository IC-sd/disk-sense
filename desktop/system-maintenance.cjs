const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { normalizeRisk } = require('./risk.cjs')

const windows = process.env.WINDIR || 'C:\\Windows'
const MAX_STDOUT_CHARS = 12000
const MAX_STDERR_CHARS = 6000

const maintenanceActions = [
  {
    id: 'hibernation-disable',
    ruleId: 'hibernation',
    label: '关闭休眠',
    description: '关闭 Windows 休眠并由系统移除 hiberfil.sys。',
    kind: 'command',
    executable: 'powercfg.exe',
    args: ['/hibernate', 'off'],
    risk: 'elevated',
    requiresAdmin: true,
    irreversible: false,
    confirmationPhrase: '关闭休眠',
    successMessage: '休眠已关闭；如系统支持，hiberfil.sys 将由 Windows 移除。'
  },
  {
    id: 'hibernation-enable',
    ruleId: 'hibernation',
    label: '开启休眠',
    description: '重新开启 Windows 休眠；系统会重新创建 hiberfil.sys。',
    kind: 'command',
    executable: 'powercfg.exe',
    args: ['/hibernate', 'on'],
    risk: 'attention',
    requiresAdmin: true,
    irreversible: false,
    confirmationPhrase: '开启休眠',
    successMessage: '休眠已开启；Windows 会按需创建 hiberfil.sys。'
  },
  {
    id: 'component-analyze',
    ruleId: 'component-store',
    label: '分析组件存储',
    description: '使用 DISM 官方分析命令判断 WinSxS 是否建议清理。',
    kind: 'command',
    executable: 'Dism.exe',
    args: ['/Online', '/English', '/Cleanup-Image', '/AnalyzeComponentStore'],
    risk: 'low',
    requiresAdmin: true,
    irreversible: false,
    confirmationPhrase: '分析组件',
    readOnly: true,
    successMessage: '组件存储分析完成。'
  },
  {
    id: 'component-cleanup',
    ruleId: 'component-store',
    label: '执行常规清理',
    description: '使用 DISM StartComponentCleanup 清理已被替代的组件版本。',
    kind: 'command',
    executable: 'Dism.exe',
    args: ['/Online', '/English', '/Cleanup-Image', '/StartComponentCleanup', '/NoRestart'],
    risk: 'attention',
    requiresAdmin: true,
    irreversible: false,
    confirmationPhrase: '清理组件',
    successMessage: 'Windows 组件存储常规清理已完成。'
  },
  {
    id: 'component-reset-base',
    ruleId: 'component-reset-base',
    label: '执行 ResetBase',
    description: '清除所有已替代的组件版本，并把当前组件版本设为新基线。',
    kind: 'command',
    executable: 'Dism.exe',
    args: ['/Online', '/English', '/Cleanup-Image', '/StartComponentCleanup', '/ResetBase', '/NoRestart'],
    risk: 'danger',
    requiresAdmin: true,
    irreversible: true,
    confirmationPhrase: 'RESETBASE',
    successMessage: 'ResetBase 已完成；当前已安装的 Windows 更新将无法卸载。'
  },
  {
    id: 'virtual-memory-settings',
    ruleId: 'virtual-memory',
    label: '打开高级设置',
    description: '打开 Windows 高级系统设置，由用户在官方界面中调整虚拟内存。',
    kind: 'open-path',
    executable: 'SystemPropertiesAdvanced.exe',
    args: [],
    risk: 'low',
    requiresAdmin: false,
    irreversible: false,
    confirmationPhrase: '打开设置',
    readOnly: true,
    successMessage: '已打开 Windows 高级系统设置。'
  },
  {
    id: 'previous-windows-settings',
    ruleId: 'previous-windows',
    label: '打开存储设置',
    description: '打开 Windows 存储设置，由系统识别并处理以前的 Windows 安装。',
    kind: 'open-external',
    target: 'ms-settings:storage',
    risk: 'low',
    requiresAdmin: false,
    irreversible: false,
    confirmationPhrase: '打开设置',
    readOnly: true,
    successMessage: '已打开 Windows 存储设置。'
  }
].map(action => ({ ...action, risk: normalizeRisk(action.risk) }))

const slimmingRules = [
  {
    id: 'hibernation',
    title: '休眠文件',
    category: '系统功能',
    risk: 'elevated',
    path: 'C:\\hiberfil.sys',
    description: 'hiberfil.sys 保存休眠所需的内存状态，通常也参与 Windows 快速启动。',
    impact: '关闭休眠会释放该文件占用，但休眠功能将不可用，部分设备的快速启动也可能受到影响。',
    action: '通过 Windows powercfg 官方命令调整',
    actionIds: ['hibernation-disable', 'hibernation-enable'],
    requiresAdmin: true
  },
  {
    id: 'component-store',
    title: '系统组件存储',
    category: 'WinSxS',
    risk: 'attention',
    path: path.join(windows, 'WinSxS'),
    description: 'WinSxS 保存 Windows 组件、更新和修复所需的数据，目录显示大小不能直接代表可释放空间。',
    impact: '绝不能直接删除 WinSxS 文件。Disk Sense 只调用 DISM 官方分析和 StartComponentCleanup。',
    action: 'DISM 官方分析与常规组件清理',
    actionIds: ['component-analyze', 'component-cleanup'],
    requiresAdmin: true
  },
  {
    id: 'component-reset-base',
    title: '组件基线压缩',
    category: 'WinSxS',
    risk: 'danger',
    path: path.join(windows, 'WinSxS'),
    description: 'ResetBase 会把当前 Windows 组件版本设为新基线，并清除所有已替代版本。',
    impact: '执行后当前已安装的 Windows 更新将无法卸载。这是不可逆系统维护，必须输入 RESETBASE 二次确认。',
    action: 'DISM ResetBase（不可逆）',
    actionIds: ['component-reset-base'],
    requiresAdmin: true
  },
  {
    id: 'virtual-memory',
    title: '虚拟内存',
    category: '系统功能',
    risk: 'danger',
    path: 'C:\\pagefile.sys',
    description: 'pagefile.sys 是 Windows 内存管理、应用稳定性和崩溃转储的重要组成部分。',
    impact: 'Disk Sense 不直接修改或删除分页文件，只打开 Windows 官方高级设置供用户决定。',
    action: '通过 Windows 高级系统设置调整',
    actionIds: ['virtual-memory-settings'],
    requiresAdmin: false
  },
  {
    id: 'previous-windows',
    title: '旧版 Windows 安装',
    category: '系统升级',
    risk: 'elevated',
    path: 'C:\\Windows.old',
    description: 'Windows.old 是系统大版本升级后保留的旧系统文件，可在有效期内用于回退。',
    impact: '删除后无法再依靠这些文件回退旧版本。Disk Sense 不直接删除，只打开 Windows 存储设置。',
    action: '使用 Windows 存储设置处理',
    actionIds: ['previous-windows-settings'],
    requiresAdmin: false
  }
].map(rule => ({ ...rule, risk: normalizeRisk(rule.risk), kind: 'slimming' }))

function systemExecutable(name, windowsDirectory = windows) {
  return path.join(windowsDirectory, 'System32', name)
}

function fileState(filePath) {
  try {
    const stat = fs.statSync(filePath)
    return { exists: true, bytes: stat.isFile() ? stat.size : null, unknown: false }
  } catch (error) {
    return {
      exists: false,
      bytes: 0,
      unknown: Boolean(error?.code && error.code !== 'ENOENT')
    }
  }
}

function actionAvailability(action, status = {}) {
  if (status.platform && status.platform !== 'win32') {
    return { enabled: false, disabledReason: '系统维护仅支持 Windows' }
  }
  if (status.commands && action.executable && status.commands[action.executable] === false) {
    return { enabled: false, disabledReason: `未找到 Windows 系统组件 ${action.executable}` }
  }
  if (action.requiresAdmin && !status.elevated) {
    return { enabled: false, disabledReason: '需要以管理员身份运行 Disk Sense' }
  }
  return { enabled: true, disabledReason: null }
}

function publicAction(action, status) {
  return {
    id: action.id,
    label: action.label,
    description: action.description,
    kind: action.kind,
    risk: action.risk,
    requiresAdmin: action.requiresAdmin,
    irreversible: action.irreversible,
    confirmationPhrase: action.confirmationPhrase,
    readOnly: Boolean(action.readOnly),
    ...actionAvailability(action, status)
  }
}

function actionsForRule(rule, state, status) {
  let ids = rule.actionIds
  if (rule.id === 'hibernation') ids = [state.exists ? 'hibernation-disable' : 'hibernation-enable']
  return ids
    .map(id => maintenanceActions.find(action => action.id === id))
    .filter(Boolean)
    .map(action => {
      const result = publicAction(action, status)
      if (state.unknown) {
        return { ...result, enabled: false, disabledReason: '无法可靠读取当前系统状态，已阻止操作' }
      }
      if (!state.exists && ['component-store', 'component-reset-base', 'previous-windows'].includes(rule.id)) {
        return { ...result, enabled: false, disabledReason: '当前未检测到可处理内容' }
      }
      return result
    })
}

function itemStatus(rule, state) {
  if (state.unknown) return '无法可靠读取当前状态'
  if (rule.id === 'hibernation') return state.exists ? '休眠已启用' : '休眠已关闭'
  if (rule.id === 'component-store') return state.exists ? '可进行 DISM 官方分析' : '未检测到组件存储'
  if (rule.id === 'component-reset-base') return state.exists ? '不可逆高级维护' : '未检测到组件存储'
  if (rule.id === 'virtual-memory') return state.exists ? 'Windows 正在使用分页文件' : '未检测到分页文件'
  if (rule.id === 'previous-windows') return state.exists ? '检测到旧系统回退文件' : '当前没有旧系统安装'
  return state.exists ? '已检测' : '未检测到'
}

function inspectSlimming(status = {}) {
  return slimmingRules.map(rule => {
    const state = fileState(rule.path)
    return {
      ...rule,
      detected: state.exists,
      bytes: state.bytes,
      status: itemStatus(rule, state),
      actions: actionsForRule(rule, state, status)
    }
  })
}

function appendBounded(current, chunk, limit) {
  const next = `${current}${String(chunk || '')}`
  return next.length > limit ? next.slice(-limit) : next
}

function progressFromChunk(chunk) {
  const value = String(chunk || '')
  const matches = [...value.matchAll(/(\d+(?:\.\d+)?)\s*%/g)]
  const lastPercent = matches.at(-1)
  const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  return {
    percent: lastPercent ? Math.max(0, Math.min(100, Number(lastPercent[1]))) : null,
    message: (lines.at(-1) || 'Windows 正在处理…').slice(0, 240)
  }
}

function spawnCommand(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: false,
      windowsVerbatimArguments: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout = appendBounded(stdout, chunk, MAX_STDOUT_CHARS)
      options.onProgress?.(progressFromChunk(chunk))
    })
    child.stderr.on('data', chunk => {
      stderr = appendBounded(stderr, chunk, MAX_STDERR_CHARS)
      options.onProgress?.({ ...progressFromChunk(chunk), percent: null })
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({
      exitCode: Number.isInteger(code) ? code : -1,
      signal: signal || null,
      stdout,
      stderr
    }))
  })
}

async function detectElevation(options = {}) {
  const platform = options.platform || process.platform
  if (platform !== 'win32') return false
  const windowsDirectory = options.windowsDirectory || windows
  const runCommand = options.runCommand || spawnCommand
  const fltmc = systemExecutable('fltmc.exe', windowsDirectory)
  const existsSync = options.existsSync || fs.existsSync
  if (!existsSync(fltmc)) return false
  try {
    const result = await runCommand(fltmc, [], { purpose: 'elevation-check' })
    return result.exitCode === 0
  } catch {
    return false
  }
}

async function maintenanceStatus(options = {}) {
  const platform = options.platform || process.platform
  const windowsDirectory = options.windowsDirectory || windows
  const existsSync = options.existsSync || fs.existsSync
  const commands = Object.fromEntries(
    ['powercfg.exe', 'Dism.exe', 'SystemPropertiesAdvanced.exe', 'fltmc.exe']
      .map(name => [name, platform === 'win32' && existsSync(systemExecutable(name, windowsDirectory))])
  )
  const elevated = await detectElevation({ ...options, platform, windowsDirectory, existsSync })
  return { platform, elevated, commands }
}

function readAvailableBytes(root = 'C:\\') {
  try {
    const stat = fs.statfsSync(root)
    return Number(stat.bavail) * Number(stat.bsize)
  } catch {
    return null
  }
}

function parseDismAnalysis(stdout) {
  const text = String(stdout || '')
  const packageMatch = text.match(/Number of Reclaimable Packages\s*:\s*(\d+)/i)
  const recommendationMatch = text.match(/Component Store Cleanup Recommended\s*:\s*(Yes|No)/i)
  return {
    reclaimablePackages: packageMatch ? Number(packageMatch[1]) : null,
    cleanupRecommended: recommendationMatch ? recommendationMatch[1].toLowerCase() === 'yes' : null
  }
}

function resultMessage(action, result) {
  if (result.exitCode !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1)
    return detail ? `Windows 返回错误：${detail.slice(0, 300)}` : `Windows 命令执行失败（代码 ${result.exitCode}）`
  }
  if (action.id === 'component-analyze') {
    const analysis = parseDismAnalysis(result.stdout)
    if (analysis.cleanupRecommended === true) {
      const packages = analysis.reclaimablePackages == null ? '' : `，发现 ${analysis.reclaimablePackages} 个可回收组件包`
      return `Windows 建议执行组件存储清理${packages}。`
    }
    if (analysis.cleanupRecommended === false) return 'Windows 判断当前组件存储无需清理。'
  }
  return action.successMessage
}

function assertConfirmation(action, confirmation) {
  if (String(confirmation || '').trim() !== action.confirmationPhrase) {
    throw new Error(`请输入“${action.confirmationPhrase}”确认此操作`)
  }
}

async function executeMaintenanceAction(input = {}, options = {}) {
  const action = maintenanceActions.find(item => item.id === String(input.actionId || ''))
  if (!action) throw new Error('不支持的系统维护操作')
  assertConfirmation(action, input.confirmation)

  const status = options.status || await maintenanceStatus(options)
  const availability = actionAvailability(action, status)
  if (!availability.enabled) throw new Error(availability.disabledReason)

  const startedAt = new Date().toISOString()
  const beforeAvailableBytes = (options.readAvailableBytes || readAvailableBytes)()
  const emit = payload => options.onProgress?.({
    actionId: action.id,
    phase: 'running',
    percent: null,
    message: action.label,
    ...payload
  })
  emit({ message: action.readOnly ? '正在调用 Windows 官方检测…' : '正在调用 Windows 官方维护命令…' })

  let commandResult
  if (action.kind === 'open-path') {
    const executable = systemExecutable(action.executable, options.windowsDirectory || windows)
    const openPath = options.openPath
    if (typeof openPath !== 'function') throw new Error('系统设置打开器不可用')
    const error = await openPath(executable)
    commandResult = { exitCode: error ? 1 : 0, signal: null, stdout: '', stderr: error || '' }
  } else if (action.kind === 'open-external') {
    const openExternal = options.openExternal
    if (typeof openExternal !== 'function') throw new Error('系统设置打开器不可用')
    await openExternal(action.target)
    commandResult = { exitCode: 0, signal: null, stdout: '', stderr: '' }
  } else {
    const executable = systemExecutable(action.executable, options.windowsDirectory || windows)
    const existsSync = options.existsSync || fs.existsSync
    if (!existsSync(executable)) throw new Error(`未找到 Windows 系统组件 ${action.executable}`)
    const runCommand = options.runCommand || spawnCommand
    commandResult = await runCommand(executable, [...action.args], {
      purpose: action.id,
      onProgress: progress => emit(progress)
    })
  }

  const afterAvailableBytes = (options.readAvailableBytes || readAvailableBytes)()
  const reclaimedBytes = action.readOnly || beforeAvailableBytes == null || afterAvailableBytes == null
    ? 0
    : Math.max(0, afterAvailableBytes - beforeAvailableBytes)
  const success = commandResult.exitCode === 0
  const result = {
    id: `maintenance-${Date.now()}`,
    actionId: action.id,
    ruleId: action.ruleId,
    title: action.label,
    risk: action.risk,
    readOnly: Boolean(action.readOnly),
    irreversible: action.irreversible,
    requiresAdmin: action.requiresAdmin,
    success,
    exitCode: commandResult.exitCode,
    startedAt,
    finishedAt: new Date().toISOString(),
    reclaimedBytes,
    message: resultMessage(action, commandResult),
    stdoutTail: String(commandResult.stdout || '').slice(-4000),
    stderrTail: String(commandResult.stderr || '').slice(-2000)
  }
  options.onProgress?.({
    actionId: action.id,
    phase: success ? 'completed' : 'failed',
    percent: success ? 100 : null,
    message: result.message
  })
  return result
}

module.exports = {
  maintenanceActions,
  slimmingRules,
  systemExecutable,
  inspectSlimming,
  spawnCommand,
  detectElevation,
  maintenanceStatus,
  parseDismAnalysis,
  executeMaintenanceAction,
  assertConfirmation,
  actionAvailability,
  readAvailableBytes,
  MAX_STDOUT_CHARS,
  MAX_STDERR_CHARS
}
