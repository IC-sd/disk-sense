'use strict'

function accountingContext() {
  return { buffers: new Set(), objects: new Set() }
}

function validEstimate(value) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('session estimate must be finite and nonnegative')
  return Math.ceil(value)
}

// A conservative represented-storage estimate, not an RSS measurement. Views
// with hidden closure storage can report its additional bytes via estimatedBytes.
// A production caller can cache its static candidate estimate and supply a fast
// custom estimator; recursively walking every path on every page is unnecessary.
function estimateSessionBytes(value, accounting = accountingContext()) {
  accounting.buffers ||= new Set()
  accounting.objects ||= new Set()
  const { buffers, objects } = accounting
  function walk(item) {
    if (item === null || item === undefined || typeof item === 'function') return 0
    if (typeof item === 'string') return 24 + item.length * 2
    if (typeof item !== 'object') return 8
    if (objects.has(item)) return 0
    objects.add(item)
    if (ArrayBuffer.isView(item)) {
      const bytes = buffers.has(item.buffer) ? 0 : item.buffer.byteLength
      buffers.add(item.buffer)
      return 48 + bytes
    }
    if (item instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && item instanceof SharedArrayBuffer)) {
      const bytes = buffers.has(item) ? 0 : item.byteLength
      buffers.add(item)
      return 32 + bytes
    }
    if (Array.isArray(item)) return 32 + item.length * 8 + item.reduce((bytes, entry) => bytes + walk(entry), 0)
    if (item instanceof Map) {
      let bytes = 56 + item.size * 48
      for (const [key, entry] of item) bytes += walk(key) + walk(entry)
      return bytes
    }
    if (item instanceof Set) {
      let bytes = 48 + item.size * 24
      for (const entry of item) bytes += walk(entry)
      return bytes
    }
    const values = Object.values(item)
    const hidden = typeof item.estimatedBytes === 'function' ? validEstimate(item.estimatedBytes(accounting)) : 0
    return 32 + values.length * 8 + hidden + values.reduce((bytes, entry) => bytes + walk(entry), 0)
  }
  return walk(value)
}

function createSessionCache({ maxSessions = 4, maxBytes = 64 * 1024 * 1024, estimate = estimateSessionBytes, dispose = () => {} } = {}) {
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 0) throw new RangeError('maxSessions must be a nonnegative integer')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes must be a nonnegative integer')
  if (typeof estimate !== 'function') throw new TypeError('estimate must be a function')
  const entries = new Map()
  let estimatedBytes = 0, evictions = 0, rejected = 0, pinnedId
  function measure(values) {
    const accounting = accountingContext()
    let bytes = 0
    for (const value of values) bytes += validEstimate(estimate(value, accounting))
    return bytes
  }
  function remeasure() { estimatedBytes = measure(entries.values()) }
  function touch(id) {
    if (!entries.has(id)) return undefined
    const value = entries.get(id)
    entries.delete(id); entries.set(id, value)
    return value
  }
  function remove(id) {
    const value = entries.get(id)
    const removed = entries.delete(id)
    if (pinnedId === id) pinnedId = undefined
    if (removed) { dispose(value); remeasure() }
    return removed
  }
  function set(id, value, { pin = false } = {}) {
    // Reject an oversized query before it can flush all useful small sessions.
    // The caller still owns this value and can answer its current request fully.
    if (!maxSessions || !maxBytes || measure([value]) > maxBytes) {
      remove(id)
      rejected++
      return false
    }
    if (pin) pinnedId = id
    entries.delete(id); entries.set(id, value)
    remeasure()
    while (entries.size > maxSessions || estimatedBytes > maxBytes) {
      const oldest = [...entries.keys()].find(key => key !== pinnedId)
      if (oldest === undefined) break
      const value = entries.get(oldest)
      entries.delete(oldest)
      dispose(value)
      evictions++
      // Removing an owner need not free a buffer shared by a surviving session.
      remeasure()
    }
    return entries.has(id)
  }
  return {
    get: touch,
    // Prefer the most recently used eligible candidate snapshot.
    find(predicate) {
      for (const [id, value] of [...entries].reverse()) if (predicate(value, id)) return touch(id)
      return undefined
    },
    set,
    // Call after adding a sort view or expanding its retained merged prefix.
    refresh(id, options) { return entries.has(id) ? set(id, entries.get(id), options) : false },
    delete: remove,
    clear() { for (const value of entries.values()) dispose(value); entries.clear(); estimatedBytes = 0; pinnedId = undefined },
    stats() { return { size: entries.size, estimatedBytes, maxSessions, maxBytes, evictions, rejected,
      overBudget: estimatedBytes > maxBytes,
      oversizedPinned: pinnedId !== undefined && entries.has(pinnedId) && measure([entries.get(pinnedId)]) > maxBytes } }
  }
}

module.exports = { createSessionCache, estimateSessionBytes }
