const os = require('node:os')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)

function normalizeList(value) {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

async function windowsDetails() {
  if (process.platform !== 'win32') return null
  const command = [
    '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();',
    '$OutputEncoding=[Console]::OutputEncoding;',
    '$os=Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber;',
    '$gpu=@(Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM);',
    '$cs=Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model;',
    '[pscustomobject]@{os=$os;gpu=$gpu;computer=$cs}|ConvertTo-Json -Compress -Depth 4'
  ].join('')
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', command
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 6_000,
      maxBuffer: 512 * 1024
    })
    return JSON.parse(String(stdout).trim())
  } catch {
    return null
  }
}

async function collectDeviceInfo({ app, installPath, dataPath }) {
  const [details, gpuInfo] = await Promise.all([
    windowsDetails(),
    app.getGPUInfo('basic').catch(() => null)
  ])
  const cpus = os.cpus()
  const graphics = normalizeList(details?.gpu)
    .map(item => ({ name: String(item?.Name || '').trim(), memoryBytes: Number(item?.AdapterRAM || 0) }))
    .filter(item => item.name)
  const fallbackGraphics = normalizeList(gpuInfo?.gpuDevice)
    .map(item => ({ name: `GPU ${item.vendorId || ''}:${item.deviceId || ''}`, memoryBytes: 0 }))
    .filter(item => item.name)
  return {
    deviceName: os.hostname(),
    manufacturer: String(details?.computer?.Manufacturer || '').trim(),
    model: String(details?.computer?.Model || '').trim(),
    operatingSystem: String(details?.os?.Caption || `${os.type()} ${os.release()}`).trim(),
    osVersion: String(details?.os?.Version || os.release()),
    osBuild: String(details?.os?.BuildNumber || ''),
    architecture: os.arch(),
    processor: cpus[0]?.model?.trim() || '无法读取',
    logicalProcessors: cpus.length,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    uptimeSeconds: os.uptime(),
    graphics: graphics.length ? graphics : fallbackGraphics,
    installPath,
    dataPath
  }
}

module.exports = { collectDeviceInfo, windowsDetails, normalizeList }
