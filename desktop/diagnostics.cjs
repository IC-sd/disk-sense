const fs = require('node:fs')
const path = require('node:path')

const MAX_LOG_BYTES = 2 * 1024 * 1024
const MAX_DETAIL_CHARS = 12000

function safeDetails(value) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: String(value.stack || '').slice(0, MAX_DETAIL_CHARS)
    }
  }
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return { value: String(value).slice(0, MAX_DETAIL_CHARS) }
  }
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

  return { log, installProcessMonitors, file }
}

module.exports = {
  createDiagnostics,
  safeDetails,
  MAX_LOG_BYTES,
  MAX_DETAIL_CHARS
}
