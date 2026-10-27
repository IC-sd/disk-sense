'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

function replaceSynced(file, text) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, text, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, file)
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor) } catch {}
    try { fs.rmSync(temporary, { force: true }) } catch {}
  }
}

function atomicWriteJson(file, value, { backup = false, pretty = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const serialized = JSON.stringify(value, null, pretty ? 2 : 0)
  if (backup) {
    let previous
    try { previous = fs.readFileSync(file, 'utf8'); JSON.parse(previous) } catch { previous = undefined }
    if (previous !== undefined) replaceSynced(`${file}.bak`, previous)
  }
  replaceSynced(file, serialized)
}
module.exports = { atomicWriteJson, replaceSynced }
