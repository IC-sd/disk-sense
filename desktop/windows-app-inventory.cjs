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
      current = { registryKey: line, displayName: '', publisher: '', installLocation: '', displayIcon: '', uninstallString: '' }
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
  const normalized = normalizeWindowsPath(value)
  if (!normalized || normalized === normalizeWindowsPath(path.win32.parse(normalized).root)) return false
  const broadRoots = [
    environment.SystemRoot || environment.WINDIR || 'C:\\Windows',
    environment.ProgramFiles || 'C:\\Program Files',
    environment['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    environment.ProgramData || 'C:\\ProgramData'
  ].flatMap(root => [root, path.win32.join(root, 'System32'), path.win32.join(root, 'SysWOW64')])
  return !broadRoots.some(root => normalizeWindowsPath(root) === normalized)
}

function applicationRoots(application) {
  return [
    application.installLocation,
    application.displayIcon && path.win32.dirname(application.displayIcon)
  ].filter(root => isSpecificApplicationRoot(root))
}

function matchInstalledApplication(filePath, applications = [], inferredOwner = '') {
  const exact = applications
    .flatMap(application => applicationRoots(application).map(root => ({ application, root })))
    .filter(candidate => pathContains(candidate.root, filePath))
    .sort((left, right) => normalizeWindowsPath(right.root).length - normalizeWindowsPath(left.root).length)[0]
  if (exact) return { ...exact, matchType: 'install-path', confidence: .98 }

  const ownerIdentity = identity(inferredOwner)
  if (ownerIdentity.length < 3) return null
  const named = applications.find(application => {
    const name = identity(application.displayName)
    if (name === ownerIdentity) return true
    if (!name.startsWith(ownerIdentity)) return false
    return /^[v\d.]+$/u.test(name.slice(ownerIdentity.length))
  })
  return named ? { application: named, root: named.installLocation || '', matchType: 'directory-name', confidence: .84 } : null
}

function dedupeApplications(applications) {
  const seen = new Set()
  return applications.filter(application => {
    const key = [identity(application.displayName), normalizeWindowsPath(application.installLocation), identity(application.publisher)].join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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
  const groups = await Promise.all(REGISTRY_ROOTS.map(queryRegistryRoot))
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
  return cachedInventory || []
}

module.exports = {
  REGISTRY_ROOTS,
  cleanRegistryPath,
  parseRegistryOutput,
  isSpecificApplicationRoot,
  matchInstalledApplication,
  getInstalledApplications,
  peekInstalledApplications
}
