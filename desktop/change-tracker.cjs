const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')

const MAX_ENTRIES = 120000
const MAX_MS = 20000
const SKIP_NAMES = new Set(['System Volume Information', '$Recycle.Bin'])
const INVENTORY_SCHEMA_VERSION = 3
const INVENTORY_STAT_CONCURRENCY = 24

function key(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function volumes() {
  if (process.platform !== 'win32') return [path.parse(process.cwd()).root]
  const result = []
  for (let code = 65; code <= 90; code++) { const root = `${String.fromCharCode(code)}:\\`; try { if (fs.existsSync(root)) result.push(root) } catch {} }
  return result
}

async function inventory(options = {}, hooks = {}) {
  const started = Date.now()
  const roots = [...new Set((options.roots || volumes()).map(root => path.resolve(root)))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  const entries = []
  const scannedDirectories = []
  const signal = hooks.signal
  const maxEntries = options.maxEntries || MAX_ENTRIES
  const maxMs = options.maxMs || MAX_MS
  const perRootLimit = Math.max(1, Math.ceil(maxEntries / Math.max(roots.length, 1)))
  const rootStates = roots.map(root => ({
    root,
    queue: [root],
    queueIndex: 0,
    entries: 0,
    directories: 0,
    inaccessible: 0,
    skippedLinks: 0,
    truncated: false
  }))
  let visited = 0
  let rootCursor = 0

  const publicRootCoverage = () => rootStates.map(state => ({
    root: state.root,
    entries: state.entries,
    directories: state.directories,
    inaccessible: state.inaccessible,
    skippedLinks: state.skippedLinks,
    pendingDirectories: Math.max(0, state.queue.length - state.queueIndex),
    truncated: state.truncated || state.queueIndex < state.queue.length
  }))

  const snapshot = (cancelled, forcedTruncated = false) => ({
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    roots,
    entries,
    scannedDirectories,
    rootCoverage: publicRootCoverage(),
    cancelled,
    truncated: forcedTruncated || rootStates.some(state => state.truncated || state.queueIndex < state.queue.length),
    durationMs: Date.now() - started
  })

  while (entries.length < maxEntries && Date.now() - started < maxMs) {
    if (signal?.aborted) return snapshot(true)
    const availableStates = rootStates.filter(state => state.queueIndex < state.queue.length && state.entries < perRootLimit)
    if (!availableStates.length) break
    const state = availableStates[rootCursor % availableStates.length]
    rootCursor++
    const current = state.queue[state.queueIndex++]
    let children
    try {
      const currentStat = await fsp.lstat(current)
      if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) {
        if (currentStat.isSymbolicLink()) state.skippedLinks++
        continue
      }
      children = await fsp.readdir(current, { withFileTypes: true })
      scannedDirectories.push(current)
      state.directories++
    } catch {
      state.inaccessible++
      continue
    }
    const childDirectories = []
    const sortedChildren = children
      .filter(child => !(child.isDirectory() && SKIP_NAMES.has(child.name)))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
    const remainingForRoot = Math.max(0, perRootLimit - state.entries)
    const remainingGlobal = Math.max(0, maxEntries - entries.length)
    const candidates = sortedChildren.slice(0, Math.min(remainingForRoot, remainingGlobal))

    for (let offset = 0; offset < candidates.length; offset += INVENTORY_STAT_CONCURRENCY) {
      if (signal?.aborted) return snapshot(true)
      if (Date.now() - started >= maxMs) break
      const batch = candidates.slice(offset, offset + INVENTORY_STAT_CONCURRENCY)
      const inspected = await Promise.all(batch.map(async child => {
        const target = path.join(current, child.name)
        try {
          if (child.isSymbolicLink()) return { skippedLink: true }
          const stat = await fsp.lstat(target)
          if (stat.isSymbolicLink()) return { skippedLink: true }
          return {
            item: {
              path: target,
              kind: stat.isDirectory() ? 'directory' : 'file',
              size: stat.size,
              modifiedAt: stat.mtimeMs
            }
          }
        } catch {
          return { inaccessible: true }
        }
      }))

      for (const result of inspected) {
        if (result.skippedLink) {
          state.skippedLinks++
          continue
        }
        if (result.inaccessible) {
          state.inaccessible++
          continue
        }
        const item = result.item
        entries.push(item)
        state.entries++
        visited++
        if (item.kind === 'directory') childDirectories.push(item.path)
      }
    }

    if (candidates.length < sortedChildren.length) state.truncated = true
    if (state.entries >= perRootLimit && state.queueIndex < state.queue.length) state.truncated = true
    childDirectories.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))
    state.queue.push(...childDirectories)
    hooks.onProgress?.({
      roots,
      current,
      activeRoot: state.root,
      queued: rootStates.reduce((sum, item) => sum + Math.max(0, item.queue.length - item.queueIndex), 0),
      entries: entries.length,
      visited,
      rootCoverage: publicRootCoverage()
    })
    await new Promise(resolve => setImmediate(resolve))
  }

  if (entries.length >= maxEntries || Date.now() - started >= maxMs) {
    for (const state of rootStates) {
      if (state.queueIndex < state.queue.length) state.truncated = true
    }
  }
  return snapshot(false, entries.length >= maxEntries || Date.now() - started >= maxMs)
}

function diff(before, after) {
  const oldMap = new Map((before?.entries || []).map(item => [item.path.toLowerCase(), item]))
  const newMap = new Map((after?.entries || []).map(item => [item.path.toLowerCase(), item]))
  const oldCoverage = before?.scannedDirectories ? new Set(before.scannedDirectories.map(key)) : null
  const newCoverage = after?.scannedDirectories ? new Set(after.scannedDirectories.map(key)) : null
  const parentCovered = (coverage, item) => !coverage || coverage.has(key(path.dirname(item.path)))
  const added = []; const removed = []; const modified = []
  for (const [entryKey, item] of newMap) {
    const previous = oldMap.get(entryKey)
    if (!previous) {
      if (parentCovered(oldCoverage, item)) added.push(item)
      continue
    }
    if (previous.kind !== item.kind) {
      modified.push({ ...item, beforeSize: previous.size, beforeModifiedAt: previous.modifiedAt })
      continue
    }
    if (item.kind === 'file' && (previous.size !== item.size || previous.modifiedAt !== item.modifiedAt)) {
      modified.push({ ...item, beforeSize: previous.size, beforeModifiedAt: previous.modifiedAt })
    }
  }
  for (const [entryKey, item] of oldMap) if (!newMap.has(entryKey) && parentCovered(newCoverage, item)) removed.push(item)
  const groupByFileFingerprint = items => {
    const groups = new Map()
    for (const item of items) {
      if (item.kind !== 'file') continue
      const fingerprint = `${item.size}|${item.modifiedAt}`
      const matches = groups.get(fingerprint) || []
      matches.push(item)
      groups.set(fingerprint, matches)
    }
    return groups
  }
  const additionsByFingerprint = groupByFileFingerprint(added)
  const removalsByFingerprint = groupByFileFingerprint(removed)
  const moved = []; const movedRemoved = new Set(); const movedAdded = new Set()
  for (const [fingerprint, removedMatches] of removalsByFingerprint) {
    const addedMatches = additionsByFingerprint.get(fingerprint)
    if (removedMatches.length !== 1 || addedMatches?.length !== 1) continue
    const item = removedMatches[0]
    const match = addedMatches[0]
    moved.push({ from: item.path, to: match.path, kind: item.kind, size: item.size })
    movedRemoved.add(item.path.toLowerCase())
    movedAdded.add(match.path.toLowerCase())
  }
  const withTreeStats = (items, inventoryEntries) => {
    const output = items.map(item => item.kind === 'directory'
      ? { ...item, treeBytes: 0, treeFileCount: 0 }
      : item)
    const directories = new Map(output
      .filter(item => item.kind === 'directory')
      .map(item => [key(item.path), item]))
    if (!directories.size) return output
    for (const entry of inventoryEntries) {
      if (entry.kind !== 'file') continue
      let ancestor = key(path.dirname(entry.path))
      while (ancestor) {
        const owner = directories.get(ancestor)
        if (owner) {
          owner.treeBytes += Number(entry.size || 0)
          owner.treeFileCount++
          break
        }
        const parent = key(path.dirname(ancestor))
        if (parent === ancestor) break
        ancestor = parent
      }
    }
    return output
  }
  const actualAdded = withTreeStats(
    added.filter(item => !movedAdded.has(item.path.toLowerCase())),
    after?.entries || []
  )
  const actualRemoved = withTreeStats(
    removed.filter(item => !movedRemoved.has(item.path.toLowerCase())),
    before?.entries || []
  )
  const effectiveBytes = item => item.kind === 'directory'
    ? Number(item.treeBytes || 0)
    : Number(item.size || 0)
  return {
    added: actualAdded,
    removed: actualRemoved,
    modified,
    moved,
    coverage: {
      baselineDirectories: oldCoverage?.size || 0,
      currentDirectories: newCoverage?.size || 0,
      baselineTruncated: Boolean(before?.truncated),
      currentTruncated: Boolean(after?.truncated),
      partial: Boolean(before?.truncated || after?.truncated),
      baselineRoots: before?.rootCoverage || [],
      currentRoots: after?.rootCoverage || []
    },
    summary: {
      added: actualAdded.length,
      removed: actualRemoved.length,
      modified: modified.length,
      moved: moved.length,
      addedBytes: actualAdded.reduce((sum, item) => sum + effectiveBytes(item), 0),
      removedBytes: actualRemoved.reduce((sum, item) => sum + effectiveBytes(item), 0)
    }
  }
}

module.exports = { volumes, inventory, diff, MAX_ENTRIES, MAX_MS, INVENTORY_SCHEMA_VERSION, INVENTORY_STAT_CONCURRENCY }
