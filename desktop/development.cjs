const DEFAULT_DEVELOPMENT_SERVER_URL = 'http://127.0.0.1:5173/'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

function normalizeDevelopmentServerUrl(value) {
  try {
    const parsed = new URL(String(value || DEFAULT_DEVELOPMENT_SERVER_URL))
    if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname)) {
      return DEFAULT_DEVELOPMENT_SERVER_URL
    }
    if (parsed.username || parsed.password) return DEFAULT_DEVELOPMENT_SERVER_URL
    parsed.pathname = '/'
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return DEFAULT_DEVELOPMENT_SERVER_URL
  }
}

module.exports = { DEFAULT_DEVELOPMENT_SERVER_URL, normalizeDevelopmentServerUrl }
