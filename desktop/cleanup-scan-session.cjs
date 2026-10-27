'use strict'
const path = require('node:path')
function createScanSession({ maximumEntries = 100000, maximumDirectories = 2048 } = {}) {
  const cache = new Map(), wrappers = new WeakMap()
  let retainedEntries = 0, hits = 0, reads = 0, fileSystemId = 0
  function wrap(fileSystem) {
    if (wrappers.has(fileSystem)) return wrappers.get(fileSystem)
    const id = ++fileSystemId
    const wrapper = new Proxy(fileSystem, { get(target, name) {
      if (name !== 'readdir') { const value = target[name]; return typeof value === 'function' ? value.bind(target) : value }
      return (root, options) => {
        if (!options?.withFileTypes) return target.readdir(root, options)
        const key = `${id}:${path.resolve(root).toLowerCase()}`
        const cached = cache.get(key)
        if (cached) { hits++; return cached.promise }
        reads++
        if (cache.size >= maximumDirectories || retainedEntries >= maximumEntries) return target.readdir(root, options)
        const entry = { count: 0, promise: null }
        entry.promise = Promise.resolve().then(() => target.readdir(root, options)).then(items => {
          if (items.length + retainedEntries > maximumEntries) cache.delete(key)
          else { entry.count = items.length; retainedEntries += items.length }
          return items
        }, error => { cache.delete(key); throw error })
        cache.set(key, entry)
        return entry.promise
      }
    } })
    wrappers.set(fileSystem, wrapper)
    return wrapper
  }
  return { wrap, stats: () => ({ reads, hits, retainedEntries, directories: cache.size }) }
}
module.exports = { createScanSession }
