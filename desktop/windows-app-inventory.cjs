const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)
const CACHE_TTL_MS = 10 * 60 * 1000
const REGISTRY_ROOTS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
]
const INVENTORY_PROVIDERS = Object.freeze(['uninstall-registry', 'appx-current-user'])
const APPX_QUERY = 'Get-AppxPackage | Select-Object Name,PackageFullName,PackageFamilyName,Publisher,InstallLocation,Version | ConvertTo-Json -Compress -Depth 3'

let cachedInventory = null
let cachedAt = 0
let activeLoad = null

function expandEnvironment(value, environment = process.env) {
  return String(value || '').replace(/%([^%]+)%/gu, (_match, name) => environment[name] || environment[name.toUpperCase()] || '')
}

function cleanRegistryPath(value, environment = process.env) {
  const expanded = expandEnvironment(value, environment).trim()
  if (!expanded) return ''
  const quoted = expanded.match(/^"([^"]+)"/u)
  const raw = quoted?.[1] || expanded.split(/\s+-[A-Za-z]/u, 1)[0]
  const cleaned = raw.replace(/,-?\d+$/u, '').trim()
  return cleaned === path.win32.parse(cleaned).root ? cleaned : cleaned.replace(/[\\/]+$/u, '')
}

function parseRegistryOutput(output, environment = process.env) {
  const applications = []
  let current = null
  const flush = () => {
    if (!current?.displayName) return
    current.installLocation = cleanRegistryPath(current.installLocation, environment)
    current.displayIcon = cleanRegistryPath(current.displayIcon, environment)
    current.uninstallExecutable = cleanRegistryPath(current.uninstallString, environment)
    applications.push(current)
  }
  for (const rawLine of String(output || '').split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (/^HKEY_/iu.test(line)) {
      flush()
      current = { registryKey: line, source: 'uninstall-registry', displayName: '', publisher: '', installLocation: '', displayIcon: '', uninstallString: '' }
      continue
    }
    if (!current) continue
    const match = rawLine.match(/^\s+(DisplayName|Publisher|InstallLocation|DisplayIcon|UninstallString)\s+REG_\w+\s+(.*)$/iu)
    if (!match) continue
    const property = {
      displayname: 'displayName',
      publisher: 'publisher',
      installlocation: 'installLocation',
      displayicon: 'displayIcon',
      uninstallstring: 'uninstallString'
    }[match[1].toLowerCase()]
    current[property] = match[2].trim()
  }
  flush()
  return applications
}

function identity(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function normalizeWindowsPath(value) {
  if (!value) return ''
  return path.win32.resolve(value).replace(/[\\/]+$/u, '').toLowerCase()
}

function pathContains(root, candidate) {
  const normalizedRoot = normalizeWindowsPath(root)
  const normalizedCandidate = normalizeWindowsPath(candidate)
  return Boolean(normalizedRoot && normalizedCandidate && (
    normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}\\`)
  ))
}

function isSpecificApplicationRoot(value, environment = process.env) {
  if (!/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/iu.test(String(value || ''))) return false
  const normalized = normalizeWindowsPath(value)
  if (!normalized || normalized === normalizeWindowsPath(path.win32.parse(normalized).root)) return false
  // Registry data is not necessarily trustworthy: shared user/system roots are not owners.
  const relative = normalized.slice(path.win32.parse(normalized).root.length)
  if (/^(?:users(?:\\[^\\]+(?:\\appdata(?:\\(?:local|locallow|roaming))?)?)?|program files(?: \(x86\))?(?:\\common files)?|programdata|windows(?:\\(?:system32|syswow64))?)$/iu.test(relative)) return false
  const broadRoots = [
    environment.SystemRoot || environment.WINDIR || 'C:\\Windows',
    environment.ProgramFiles || 'C:\\Program Files',
    environment['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    environment.ProgramData || 'C:\\ProgramData',
    environment.USERPROFILE, environment.LOCALAPPDATA, environment.APPDATA,
    environment.CommonProgramFiles, environment['CommonProgramFiles(x86)']
  ].filter(Boolean).flatMap(root => [root, path.win32.join(root, 'System32'), path.win32.join(root, 'SysWOW64')])
  return !broadRoots.some(root => normalizeWindowsPath(root) === normalized)
}

function applicationRoots(application) {
  return [
    { root: application.installLocation, matchType: application.source === 'appx-current-user' ? 'package-install-path' : 'install-path', confidence: .98 },
    { root: application.dataLocation, matchType: 'package-data-path', confidence: .97 },
    { root: application.displayIcon && path.win32.dirname(application.displayIcon), matchType: 'icon-path', confidence: .86 }
  ].filter(candidate => isSpecificApplicationRoot(candidate.root))
}

function matchInstalledApplication(filePath, applications = [], inferredOwner = '') {
  const exact = applications
    .flatMap(application => applicationRoots(application).map(candidate => ({ application, ...candidate })))
    .filter(candidate => pathContains(candidate.root, filePath))
    .sort((left, right) => normalizeWindowsPath(right.root).length - normalizeWindowsPath(left.root).length || right.confidence - left.confidence)
  if (exact.length) {
    const best = exact[0]
    const tied = exact.filter(candidate => normalizeWindowsPath(candidate.root) === normalizeWindowsPath(best.root))
    // Several products can share one runtime directory. Do not choose whichever was enumerated first.
    if (new Set(tied.map(candidate => candidate.application.packageFamilyName || candidate.application.registryKey || candidate.application.installLocation)).size > 1) return null
    return best
  }

  const ownerIdentity = identity(inferredOwner)
  if (ownerIdentity.length < 3) return null
  const named = applications.filter(application => {
    const name = identity(application.displayName)
    if (name === ownerIdentity) return true
    if (!name.startsWith(ownerIdentity)) return false
    return /^[v\d.]+$/u.test(name.slice(ownerIdentity.length))
  })
  return named.length === 1 ? { application: named[0], root: '', matchType: 'directory-name', confidence: .84 } : null
}

function dedupeApplications(applications) {
  const seen = new Set()
  return applications.filter(application => {
    const key = [application.source || 'uninstall-registry', application.packageFamilyName || '', identity(application.displayName), normalizeWindowsPath(application.installLocation), identity(application.publisher)].join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function parseAppxOutput(output, environment = process.env) {
  let decoded
  try { decoded = JSON.parse(String(output || '').replace(/^\uFEFF/, '').trim()) } catch { return [] }
  const rows = Array.isArray(decoded) ? decoded : decoded && typeof decoded === 'object' ? [decoded] : []
  return rows.slice(0, 20000).flatMap(item => {
    const family = String(item?.PackageFamilyName || '')
    const name = String(item?.Name || '').trim().slice(0, 240)
    if (!name || !/^[A-Za-z0-9._-]+_[A-Za-z0-9]+$/.test(family)) return []
    const installLocation = cleanRegistryPath(item.InstallLocation, environment)
    const localData = environment.LOCALAPPDATA || (environment.USERPROFILE ? path.win32.join(environment.USERPROFILE, 'AppData', 'Local') : '')
    return [{
      registryKey: `appx:${String(item.PackageFullName || family).slice(0, 500)}`,
      source: 'appx-current-user', displayName: name, packageFamilyName: family,
      packageFullName: String(item.PackageFullName || '').slice(0, 500),
      version: String(item.Version || '').slice(0, 80), publisher: String(item.Publisher || '').slice(0, 500),
      installLocation, dataLocation: localData ? path.win32.join(localData, 'Packages', family) : '', displayIcon: ''
    }]
  })
}

async function queryCurrentUserPackages() {
  try {
    const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const { stdout } = await execFileAsync(executable, ['-NoProfile', '-NonInteractive', '-Command', APPX_QUERY], {
      windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8'
    })
    return parseAppxOutput(stdout)
  } catch { return [] }
}

async function queryRegistryRoot(root) {
  try {
    const { stdout } = await execFileAsync('reg.exe', ['QUERY', root, '/S'], {
      windowsHide: true,
      timeout: 12000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8'
    })
    return parseRegistryOutput(stdout)
  } catch {
    return []
  }
}

async function loadInstalledApplications() {
  if (process.platform !== 'win32') return []
  const groups = await Promise.all([...REGISTRY_ROOTS.map(queryRegistryRoot), queryCurrentUserPackages()])
  return dedupeApplications(groups.flat())
}

async function getInstalledApplications({ force = false } = {}) {
  if (!force && cachedInventory && Date.now() - cachedAt < CACHE_TTL_MS) return cachedInventory
  if (!activeLoad) {
    activeLoad = loadInstalledApplications()
      .then(applications => {
        cachedInventory = applications
        cachedAt = Date.now()
        return applications
      })
      .finally(() => { activeLoad = null })
  }
  return activeLoad
}

function peekInstalledApplications() {
  // Refresh expired evidence without blocking every file selection on a registry walk.
  void getInstalledApplications().catch(() => {})
  return cachedInventory || []
}

module.exports = {
  INVENTORY_PROVIDERS,
  REGISTRY_ROOTS,
  cleanRegistryPath,
  parseRegistryOutput,
  parseAppxOutput,
  isSpecificApplicationRoot,
  pathContains,
  matchInstalledApplication,
  getInstalledApplications,
  peekInstalledApplications
}
