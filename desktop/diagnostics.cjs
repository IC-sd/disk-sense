const fs = require('node:fs')
const path = require('node:path')

const MAX_LOG_BYTES = 2 * 1024 * 1024
const MAX_DETAIL_CHARS = 12000
const SECRET_KEY = /api.?key|access.?token|refresh.?token|secret|password|authorization|credential/i

function redactText(value) {
  return String(value).replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[a-z0-9_-]{12,}/gi, '[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|token|password|secret)\s*["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]')
}

function safeDetails(value) {
  if (value instanceof Error) {
    value = {
      name: value.name,
      message: value.message,
      stack: String(value.stack || '').slice(0, MAX_DETAIL_CHARS)
    }
  }
  try {
    const serialized = JSON.stringify(value, (key, item) => SECRET_KEY.test(key) ? '[REDACTED]'
      : typeof item === 'string' ? redactText(item).slice(0, MAX_DETAIL_CHARS) : typeof item === 'bigint' ? String(item) : item)
    if (serialized === undefined) return null
    if (serialized.length > MAX_DETAIL_CHARS) return { summary: serialized.slice(0, Math.floor((MAX_DETAIL_CHARS - 100) / 2)), truncated: true }
    return JSON.parse(serialized)
  } catch {
    return { value: redactText(value).slice(0, MAX_DETAIL_CHARS) }
  }
}

function redactForShare(value) {
  const safe = safeDetails(value)
  return JSON.parse(JSON.stringify(safe, (_key, item) => typeof item === 'string'
    ? item.replace(/\b[A-Za-z]:[\\/][^\r\n"'<>]*/g, '[LOCAL_PATH]').replace(/\\\\[^\\\s]+\\[^\r\n"'<>]*/g, '[LOCAL_PATH]') : item))
}

function createDiagnostics(file) {
  let monitorsInstalled = false

  const rotate = () => {
    try {
      if (!fs.existsSync(file) || fs.statSync(file).size < MAX_LOG_BYTES) return
      const previous = `${file}.previous`
      if (fs.existsSync(previous)) fs.rmSync(previous, { force: true })
      fs.renameSync(file, previous)
    } catch {
      // Diagnostics must never interrupt the application.
    }
  }

  const log = (level, event, details = null) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      rotate()
      fs.appendFileSync(file, `${JSON.stringify({
        at: new Date().toISOString(),
        level,
        event,
        details: safeDetails(details)
      })}\n`, 'utf8')
    } catch {
      // Diagnostics must never interrupt the application.
    }
  }

  const installProcessMonitors = () => {
    if (monitorsInstalled) return
    monitorsInstalled = true
    process.on('uncaughtExceptionMonitor', error => log('fatal', 'uncaught-exception', error))
    process.on('unhandledRejection', reason => log('error', 'unhandled-rejection', reason))
  }

  function snapshot(context = {}) {
    let descriptor
    const records = []
    try {
      descriptor = fs.openSync(file, 'r')
      const size = fs.fstatSync(descriptor).size
      const buffer = Buffer.alloc(Math.min(size, 64 * 1024))
      fs.readSync(descriptor, buffer, 0, buffer.length, Math.max(0, size - buffer.length))
      for (const line of buffer.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-40)) {
        try { records.push(JSON.parse(line)) } catch {}
      }
    } catch {} finally { if (descriptor !== undefined) fs.closeSync(descriptor) }
    return { generatedAt: new Date().toISOString(), context: redactForShare(context), records: records.map(redactForShare), redacted: true }
  }
  return { log, installProcessMonitors, file, snapshot }
}

module.exports = {
  createDiagnostics,
  safeDetails,
  redactForShare,
  MAX_LOG_BYTES,
  MAX_DETAIL_CHARS
}
