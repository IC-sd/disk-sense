const path = require('node:path')
const { createResultView } = require('./search-result-view.cjs')

const DIRECTORY = 1, APPLICATION = 2
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0

// A session keeps matching/ranking columns, not presentation rows. Exact raw
// basenames are interned: lowercasing alone would lose camel-case boundaries.
function createCandidateSet(rows, { context = '', assertActive = () => {}, ids = [...rows.keys()], previous } = {}) {
  const count = ids.length, names = [], nameIndex = new Map()
  const set = { count, names, ids: new Float64Array(count), nameIds: new Uint32Array(count),
    paths: Array(count), pathLengths: new Uint32Array(count), flags: new Uint8Array(count),
    modified: new Float64Array(count), sizes: new Float64Array(count), locations: new Int16Array(count), idIndex: null }
  let textBytes = 256 + count * 32
  let index = 0
  for (const id of ids) {
    const prior = previous?.idIndex?.get(id)
    const row = prior === undefined ? rows.get(id) : null
    const oldName = prior === undefined ? null : previous.names[previous.nameIds[prior]]
    const name = oldName ? oldName.text : row.name
    let nameId = nameIndex.get(name)
    if (nameId === undefined) {
      nameId = names.length; nameIndex.set(name, nameId)
      const key = oldName?.key ?? name.toLowerCase(), applicationTitle = oldName?.applicationTitle ?? key.slice(0, key.endsWith('.appref-ms') ? -10 : -4)
      names.push(oldName || { text: name, key, applicationTitle })
      textBytes += 128 + 2 * (name.length + key.length + applicationTitle.length)
    }
    set.ids[index] = id; set.nameIds[index] = nameId
    if (prior !== undefined) {
      set.paths[index] = previous.paths[prior]; set.pathLengths[index] = previous.pathLengths[prior]
      set.flags[index] = previous.flags[prior]; set.modified[index] = previous.modified[prior]
      set.sizes[index] = previous.sizes[prior]; set.locations[index] = previous.locations[prior]
    } else {
      const pathKey = row.path.toLowerCase()
      set.paths[index] = pathKey; set.pathLengths[index] = row.path.length
      set.flags[index] = (row.is_directory ? DIRECTORY : 0) | (row.kind === 'application' ? APPLICATION : 0)
      set.modified[index] = row.modified_at; set.sizes[index] = row.size
      let location = /\\(?:node_modules|appdata|windows|lib)\\/u.test(pathKey) ? 32 : 0
      if (pathKey.includes('\\start menu\\programs\\')) location -= 24
      if (context && path.dirname(row.path).toLowerCase() === context) location -= 20
      else if (context && pathKey.startsWith(context + path.sep)) location -= 6
      set.locations[index] = location
    }
    textBytes += 2 * set.paths[index].length
    if ((++index & 255) === 0) assertActive()
  }
  // Cache static text accounting once. Shared text between sessions is counted
  // conservatively twice; refresh never rescans every filename on a page read.
  const columns = Object.values(set).filter(value => ArrayBuffer.isView(value))
  set.estimatedBytes = accounting => textBytes + (set.idIndex?.size || 0) * 48
    + columns.reduce((bytes, column) => bytes + bufferBytes(column, accounting), 0)
  assertActive()
  return set
}

function bufferBytes(column, accounting) {
  const buffer = column.buffer
  if (accounting?.buffers?.has(buffer)) return 0
  accounting?.buffers?.add(buffer)
  return 48 + buffer.byteLength
}

function indexCandidates(set, assertActive) {
  if (set.idIndex) return set.idIndex
  const index = new Map()
  for (let ordinal = 0; ordinal < set.count; ordinal++) {
    index.set(set.ids[ordinal], ordinal)
    if ((ordinal & 1023) === 0) assertActive()
  }
  assertActive()
  set.idIndex = index
  return index
}

function createCandidateView(set, sort, { term, partial, choices, matchScore, assertActive, profile = () => {} }) {
  const identityOrder = (a, b) => compare(set.paths[a], set.paths[b]) || a - b
  const nameOrder = (a, b) => compare(set.names[set.nameIds[a]].key, set.names[set.nameIds[b]].key) || identityOrder(a, b)
  let order, recent
  const rankingBuffers = []
  let indices = new Uint32Array(set.count)
  for (let index = 0; index < set.count; index++) indices[index] = index
  if (sort === 'relevance') {
    const scoreStarted = performance.now()
    const scores = new Float64Array(set.count), chosenAt = new Float64Array(set.count)
    recent = new Uint8Array(set.count)
    rankingBuffers.push(scores, chosenAt, recent)
    const literal = new Float64Array(set.names.length).fill(NaN)
    const fuzzy = new Float64Array(set.names.length).fill(NaN)
    for (let index = 0; index < set.count; index++) {
      const nameId = set.nameIds[index], name = set.names[nameId]
      if (Number.isNaN(literal[nameId])) literal[nameId] = name.key === term || name.key.startsWith(term + '.') ? 0
        : name.key.startsWith(term) ? 100 : name.key.includes(term) ? 200 : Infinity
      let score = literal[nameId]
      if (!Number.isFinite(score)) {
        if (set.paths[index].includes(term)) score = 300
        else {
          if (Number.isNaN(fuzzy[nameId])) fuzzy[nameId] = matchScore(name.text, term, partial)
          score = fuzzy[nameId]
        }
      }
      score += set.flags[index] & APPLICATION ? -34 : set.flags[index] & DIRECTORY ? -8 : 0
      score += set.locations[index]
      const choice = choices.get(set.ids[index])
      if (choice) score -= choice.exact ? 0 : 16
      if (choice?.exact) { recent[index] = 1; chosenAt[index] = choice.last_used }
      scores[index] = score
      if ((index & 255) === 0) assertActive()
    }
    profile('score', performance.now() - scoreStarted, { count: set.count, uniqueNames: set.names.length })
    order = (a, b) => recent[b] - recent[a] || chosenAt[b] - chosenAt[a] || scores[a] - scores[b]
      || set.modified[b] - set.modified[a] || set.pathLengths[a] - set.pathLengths[b] || nameOrder(a, b)
    const applications = new Map()
    let count = 0
    for (let index = 0; index < set.count; index++) {
      if (!(set.flags[index] & APPLICATION)) indices[count++] = index
      else {
        const title = set.names[set.nameIds[index]].applicationTitle, previous = applications.get(title)
        if (previous === undefined || order(index, previous) < 0) applications.set(title, index)
      }
      if ((index & 255) === 0) assertActive()
    }
    for (const index of applications.values()) indices[count++] = index
    indices = indices.subarray(0, count)
  } else {
    order = sort === 'modified' ? (a, b) => set.modified[b] - set.modified[a] || identityOrder(a, b)
      : sort === 'size' ? (a, b) => set.sizes[b] - set.sizes[a] || identityOrder(a, b) : nameOrder
  }
  const sortStarted = performance.now()
  const view = createResultView(indices, order, { assertActive })
  profile('sort', performance.now() - sortStarted, { count: indices.length })
  return { ...view, recent, estimatedBytes: accounting => view.estimatedBytes(accounting)
    + rankingBuffers.reduce((bytes, column) => bytes + bufferBytes(column, accounting), 0) }
}

module.exports = { createCandidateSet, createCandidateView, indexCandidates }
