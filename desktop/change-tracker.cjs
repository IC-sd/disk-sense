const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')

const MAX_ENTRIES = 120000
const MAX_MS = 20000
const SKIP_NAMES = new Set(['System Volume Information', '$Recycle.Bin'])

function volumes() {
  if (process.platform !== 'win32') return [path.parse(process.cwd()).root]
  const result = []
  for (let code = 65; code <= 90; code++) { const root = `${String.fromCharCode(code)}:\\`; try { if (fs.existsSync(root)) result.push(root) } catch {} }
  return result
}

async function inventory(options = {}, hooks = {}) {
  const started = Date.now()
  const roots = options.roots || volumes()
  const queue = [...roots]
  const entries = []
  const signal = hooks.signal
  let visited = 0
  while (queue.length && entries.length < (options.maxEntries || MAX_ENTRIES) && Date.now() - started < (options.maxMs || MAX_MS)) {
    if (signal?.aborted) return { roots, entries, cancelled: true, truncated: false, durationMs: Date.now() - started }
    const current = queue.pop()
    let children
    try { children = await fsp.readdir(current, { withFileTypes: true }) } catch { continue }
    for (const child of children) {
      if (entries.length >= (options.maxEntries || MAX_ENTRIES)) break
      if (signal?.aborted) return { roots, entries, cancelled: true, truncated: false, durationMs: Date.now() - started }
      if (child.isDirectory() && SKIP_NAMES.has(child.name)) continue
      const target = path.join(current, child.name)
      try {
        const stat = await fsp.stat(target)
        entries.push({ path: target, kind: child.isDirectory() ? 'directory' : 'file', size: stat.size, modifiedAt: stat.mtimeMs })
        if (child.isDirectory()) queue.push(target)
      } catch {}
      visited++
    }
    hooks.onProgress?.({ roots, current, queued: queue.length, entries: entries.length, visited })
    await new Promise(resolve => setImmediate(resolve))
  }
  return { roots, entries, cancelled: false, truncated: Boolean(queue.length), durationMs: Date.now() - started }
}

function diff(before, after) {
  const oldMap = new Map((before?.entries || []).map(item => [item.path.toLowerCase(), item]))
  const newMap = new Map((after?.entries || []).map(item => [item.path.toLowerCase(), item]))
  const added = []; const removed = []; const modified = []
  for (const [key, item] of newMap) {
    const previous = oldMap.get(key)
    if (!previous) added.push(item)
    else if (previous.size !== item.size || previous.modifiedAt !== item.modifiedAt || previous.kind !== item.kind) modified.push({ ...item, beforeSize: previous.size, beforeModifiedAt: previous.modifiedAt })
  }
  for (const [key, item] of oldMap) if (!newMap.has(key)) removed.push(item)
  const additionsByFingerprint = new Map()
  for (const item of added) additionsByFingerprint.set(`${item.kind}|${item.size}|${item.modifiedAt}`, item)
  const moved = []; const movedRemoved = new Set(); const movedAdded = new Set()
  for (const item of removed) { const match = additionsByFingerprint.get(`${item.kind}|${item.size}|${item.modifiedAt}`); if (match) { moved.push({ from: item.path, to: match.path, kind: item.kind, size: item.size }); movedRemoved.add(item.path.toLowerCase()); movedAdded.add(match.path.toLowerCase()) } }
  const actualAdded = added.filter(item => !movedAdded.has(item.path.toLowerCase()))
  const actualRemoved = removed.filter(item => !movedRemoved.has(item.path.toLowerCase()))
  return { added: actualAdded, removed: actualRemoved, modified, moved, summary: { added: actualAdded.length, removed: actualRemoved.length, modified: modified.length, moved: moved.length, addedBytes: actualAdded.reduce((sum, item) => sum + item.size, 0), removedBytes: actualRemoved.reduce((sum, item) => sum + item.size, 0) } }
}

module.exports = { volumes, inventory, diff, MAX_ENTRIES, MAX_MS }
