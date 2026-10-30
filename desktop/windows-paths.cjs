const path = require('node:path')

/** @param {string | undefined} value */
function normalizeWindowsPath(value) {
  if (!value) return ''
  const resolved = path.win32.resolve(value)
  const root = path.win32.parse(resolved).root
  return (resolved === root ? root : resolved.replace(/[\\/]+$/u, '')).toLowerCase()
}

/** @param {string | undefined} root @param {string} candidate */
function pathContains(root, candidate) {
  const normalizedRoot = normalizeWindowsPath(root)
  const normalizedCandidate = normalizeWindowsPath(candidate)
  return Boolean(normalizedRoot && normalizedCandidate && (
    normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}\\`)
  ))
}

/** @param {string | undefined} value @param {NodeJS.ProcessEnv} [environment] */
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
  ].flatMap(root => root ? [root, path.win32.join(root, 'System32'), path.win32.join(root, 'SysWOW64')] : [])
  return !broadRoots.some(root => normalizeWindowsPath(root) === normalized)
}

module.exports = { normalizeWindowsPath, pathContains, isSpecificApplicationRoot }
