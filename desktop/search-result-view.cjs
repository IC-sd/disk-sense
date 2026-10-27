'use strict'

// Keep the complete order reproducible while merging only the requested prefix.
// Runs contain input ordinals, so equal keys preserve the caller's input order.
function createResultView(indicesOrLength, compare, { assertActive = () => {}, runSize = 2048 } = {}) {
  if (typeof compare !== 'function') throw new TypeError('compare must be a function')
  if (!Number.isInteger(runSize) || runSize < 1) throw new RangeError('runSize must be a positive integer')
  assertActive()

  const sequential = typeof indicesOrLength === 'number'
  const total = sequential ? indicesOrLength : indicesOrLength?.length
  if (!Number.isInteger(total) || total < 0 || total > 0xffffffff) throw new RangeError('invalid candidate count')
  let source = null
  if (!sequential) {
    source = new Uint32Array(total)
    for (let ordinal = 0; ordinal < total; ordinal++) {
      if ((ordinal & 1023) === 0) assertActive()
      const index = indicesOrLength[ordinal]
      if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) throw new RangeError('invalid candidate index')
      source[ordinal] = index
    }
  }
  const externalIndex = source ? ordinal => source[ordinal] : ordinal => ordinal
  const order = (a, b) => compare(externalIndex(a), externalIndex(b)) || a - b
  let comparisons = 0
  const sortOrder = (a, b) => {
    if ((++comparisons & 1023) === 0) assertActive()
    return order(a, b)
  }
  const runs = []
  for (let start = 0; start < total; start += runSize) {
    assertActive()
    const run = new Uint32Array(Math.min(runSize, total - start))
    for (let offset = 0; offset < run.length; offset++) run[offset] = start + offset
    run.sort(sortOrder)
    runs.push(run)
  }

  const cursors = new Uint32Array(runs.length)
  const heap = new Uint32Array(runs.length)
  let heapLength = runs.length
  const runOrder = (a, b) => order(runs[a][cursors[a]], runs[b][cursors[b]])
  function siftDown(position) {
    const run = heap[position]
    while (position * 2 + 1 < heapLength) {
      let child = position * 2 + 1
      if (child + 1 < heapLength && runOrder(heap[child + 1], heap[child]) < 0) child++
      if (runOrder(run, heap[child]) <= 0) break
      heap[position] = heap[child]
      position = child
    }
    heap[position] = run
  }
  for (let index = 0; index < heapLength; index++) heap[index] = index
  for (let index = Math.floor(heapLength / 2) - 1; index >= 0; index--) {
    assertActive()
    siftDown(index)
  }
  assertActive()

  let merged = new Uint32Array(0)
  let mergedLength = 0
  let failure
  function validPosition(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('position must be a nonnegative integer')
  }
  function ensure(end) {
    validPosition(end)
    if (failure) throw failure
    assertActive()
    const target = Math.min(total, end)
    if (target <= mergedLength) return mergedLength
    if (target > merged.length) {
      const buffer = new Uint32Array(Math.min(total, Math.max(target, 16, merged.length * 2)))
      buffer.set(merged.subarray(0, mergedLength))
      merged = buffer
    }
    try {
      while (mergedLength < target) {
        if ((mergedLength & 127) === 0) assertActive()
        const run = heap[0]
        const ordinal = runs[run][cursors[run]++]
        merged[mergedLength++] = externalIndex(ordinal)
        if (cursors[run] === runs[run].length) heap[0] = heap[--heapLength]
        if (heapLength) siftDown(0)
      }
      assertActive()
    } catch (error) {
      // A failed merge must never expose a potentially partial heap as a session.
      failure = error
      throw error
    }
    return mergedLength
  }
  function indexAt(position) {
    validPosition(position)
    if (position >= total) return undefined
    ensure(position + 1)
    return merged[position]
  }
  function range(start, end) {
    validPosition(start)
    validPosition(end)
    if (end < start) throw new RangeError('range end must not precede start')
    ensure(end)
    return merged.slice(Math.min(start, total), Math.min(end, total))
  }
  function estimatedBytes(accounting) {
    let bytes = 256 + runs.length * 8
    for (const array of [source, ...runs, cursors, heap, merged]) {
      if (!array) continue
      if (!accounting?.buffers?.has(array.buffer)) {
        accounting?.buffers?.add(array.buffer)
        bytes += 48 + array.buffer.byteLength
      }
    }
    return bytes
  }
  return { total, ensure, indexAt, range, estimatedBytes }
}

module.exports = { createResultView }
