const fs = require('node:fs')
const path = require('node:path')

const REBUILDABLE_CACHE_DIRECTORIES = ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'GrShaderCache', 'ShaderCache', 'Media Cache']

function uniqueRoots(values) {
  return [...new Map(values.map(value => [process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value), value])).values()]
}

function report(options, location, error, expectedMissing = false) {
  if (error?.name === 'AbortError') throw error
  if (expectedMissing && ['ENOENT', 'ENOTDIR'].includes(error?.code)) options.onMissing?.(location)
  else options.onIssue?.(location, error)
}

function availableDirectory(location, options, expectedMissing = true) {
  if (options.shouldContinue?.(location) === false) return false
  if (options.isExcluded?.(location)) { options.onExcluded?.(location); return false }
  try {
    const stat = (options.fileSystemSync || fs).lstatSync(location)
    if (stat.isSymbolicLink()) { options.onLink?.(location); return false }
    if (!stat.isDirectory()) { options.onIssue?.(location, { code: 'UNSAFE_ROOT' }); return false }
    return true
  } catch (error) { report(options, location, error, expectedMissing); return false }
}

function directoryEntries(location, options) {
  if (!availableDirectory(location, options)) return []
  try {
    const entries = (options.fileSystemSync || fs).readdirSync(location, { withFileTypes: true })
    options.onDirectoryRead?.(location)
    return entries
  } catch (error) { report(options, location, error); return [] }
}

function existingRoots(values, options = {}) {
  const roots = []
  for (const value of values) {
    if (options.visit?.(value) === false) break
    if (availableDirectory(value, options)) roots.push(value)
  }
  return uniqueRoots(roots)
}

function browserCacheRoots(productRoot, includeProductRoot = false, options = {}) {
  const profileRoots = includeProductRoot && availableDirectory(productRoot, options) ? [productRoot] : []
  for (const entry of directoryEntries(productRoot, options)) {
    if (options.visit?.(productRoot) === false) break
    if (entry.isSymbolicLink()) { options.onLink?.(path.join(productRoot, entry.name)); continue }
    if (entry.isDirectory() && !entry.isSymbolicLink()) profileRoots.push(path.join(productRoot, entry.name))
  }
  const candidates = []
  for (const profileRoot of profileRoots) {
    if (options.shouldContinue?.(profileRoot) === false) break
    candidates.push(...REBUILDABLE_CACHE_DIRECTORIES.map(cache => path.join(profileRoot, cache)))
  }
  return existingRoots(candidates, options)
}

function electronCacheRoots(productRoots, options = {}) {
  return existingRoots(existingRoots(productRoots, options).flatMap(root => REBUILDABLE_CACHE_DIRECTORIES.map(cache => path.join(root, cache))), options)
}

async function findNamedCacheRoots(productRoots, options = {}) {
  const maxDepth = Math.max(0, Math.min(5, Number(options.maxDepth ?? 3)))
  const maxDirectories = Math.max(1, Math.min(10000, Number(options.maxDirectories ?? 2000)))
  const names = new Set((options.names || REBUILDABLE_CACHE_DIRECTORIES).map(name => String(name).toLowerCase()))
  const roots = []
  const products = existingRoots(productRoots, options)
  const perRoot = Math.max(1, Math.floor(maxDirectories / Math.max(1, products.length)))
  let visited = 0
  for (const productRoot of products) {
    const queue = [{ dir: productRoot, depth: 0 }]
    let rootVisited = 0
    let cursor = 0
    while (cursor < queue.length) {
      const current = queue[cursor++]
      if (options.shouldContinue?.(current.dir) === false) break
      if (rootVisited >= perRoot || visited >= maxDirectories) {
        options.onLimit?.(current.dir, 'DISCOVERY_DIRECTORY_LIMIT')
        break
      }
      if (!availableDirectory(current.dir, options, false)) continue
      let handle
      try {
        handle = await (options.fileSystem || fs.promises).opendir(current.dir)
        options.onDirectoryRead?.(current.dir)
        for await (const entry of handle) {
          if (options.shouldContinue?.(current.dir) === false || options.visit?.(current.dir) === false) break
          const candidate = path.join(current.dir, entry.name)
          if (entry.isSymbolicLink()) { options.onLink?.(candidate); continue }
          if (!entry.isDirectory()) continue
          if (options.isExcluded?.(candidate)) { options.onExcluded?.(candidate); continue }
          if (rootVisited >= perRoot || visited >= maxDirectories) {
            options.onLimit?.(current.dir, 'DISCOVERY_DIRECTORY_LIMIT')
            break
          }
          rootVisited++
          visited++
          if (names.has(entry.name.toLowerCase())) roots.push(candidate)
          else if (current.depth < maxDepth) queue.push({ dir: candidate, depth: current.depth + 1 })
          else options.onLimit?.(candidate, 'DISCOVERY_DEPTH_LIMIT')
        }
      } catch (error) { report(options, current.dir, error) }
      finally { try { await handle?.close() } catch { /* async iterator already closed */ } }
      await new Promise(resolve => setImmediate(resolve))
    }
  }
  return uniqueRoots(roots)
}

function profileCacheRoots(productRoot, names, options = {}) {
  const candidates = []
  for (const entry of directoryEntries(productRoot, options)) {
    if (options.visit?.(productRoot) === false) break
    if (entry.isSymbolicLink()) { options.onLink?.(path.join(productRoot, entry.name)); continue }
    if (entry.isDirectory() && !entry.isSymbolicLink()) candidates.push(...names.map(name => path.join(productRoot, entry.name, name)))
  }
  return existingRoots(candidates, options)
}

module.exports = { REBUILDABLE_CACHE_DIRECTORIES, uniqueRoots, existingRoots, browserCacheRoots, electronCacheRoots, findNamedCacheRoots, profileCacheRoots }
