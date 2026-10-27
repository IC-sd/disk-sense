const { pinyin, polyphonic, match: pinyinMatch } = require('pinyin-pro')
const hasHan = value => /\p{Script=Han}/u.test(value)

// Build bounded, parameterized name/path queries; file contents are never searched.
function parseSearchQuery(value) {
  const extensions = []
  let kind = null
  const text = String(value || '').trim().replace(/\b(ext|file|folder):([^\s]*)/giu, (_match, prefix, argument) => {
    if (prefix.toLowerCase() === 'ext') {
      extensions.push(...argument.split(/[,;]/u).map(item => item.replace(/^\./u, '').toLowerCase()).filter(item => /^[\p{L}\p{N}]+$/u.test(item)))
      return ''
    }
    kind = prefix.toLowerCase() === 'folder' ? 'folder' : 'file'
    return argument
  }).trim()
  const terms = [...text.matchAll(/"([^"]+)"|([^\s"]+)/gu)].map(match => (match[1] || match[2]).toLowerCase()).slice(0, 12)
  return { text, terms, extensions: [...new Set(extensions)].slice(0, 12), kind, allowPartial: !/[ \t]$/u.test(String(value || '')) }
}

function fuzzyPattern(value) {
  return /^[\p{L}\p{N}]{2,32}$/u.test(value) ? `%${[...value].join('%')}%` : null
}

function fuzzyNameScore(name, value) {
  const result = matchName(name, value)
  return result && result.kind !== 'literal' ? result.score : null
}

function isBoundary(characters, index) {
  if (index === 0) return true
  const previous = characters[index - 1].charCodeAt(0), current = characters[index].charCodeAt(0)
  if (previous === 32 || (previous >= 9 && previous <= 13) || previous === 95 || previous === 46 || previous === 45 || previous === 92 || previous === 47) return true
  if (previous > 127 && /\s/u.test(characters[index - 1])) return true
  const next = characters[index + 1]?.charCodeAt(0) || 0
  return current >= 65 && current <= 90 && (previous < 65 || previous > 90 || (next >= 97 && next <= 122))
}

// A word abbreviation may continue within a word or jump to another word/camel
// boundary. It never turns arbitrary interior letters into thousands of weak hits.
function createAbbreviationMatcher(value) {
  const query = [...String(value).toLowerCase()]
  if (!query.length || query.length > 32) return () => false
  const masks = Object.create(null)
  query.forEach((character, index) => { masks[character] = (masks[character] || 0) | (1 << index) })
  const final = 1 << (query.length - 1)
  return name => {
    const characters = /[\uD800-\uDFFF]/u.test(name) ? [...name] : name
    let active = 0, seen = 0
    for (let index = 0; index < characters.length; index++) {
      const character = characters[index], code = character.charCodeAt(0)
      const matches = masks[code >= 65 && code <= 90 ? character.toLowerCase() : character] || 0
      if (!matches) { active = 0; continue }
      const boundary = isBoundary(characters, index)
      active = ((active << 1) | (boundary ? (seen << 1) | 1 : 0)) & matches
      if (active & final) return true
      seen |= active
    }
    return false
  }
}

const pairAlphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
const pairNames = Array.from({ length: 36 * 36 }, (_value, index) => pairAlphabet[Math.floor(index / 36)] + pairAlphabet[index % 36])
const pairLow = new Uint32Array(36), pairHigh = new Uint8Array(36)
function pairCharacter(character) {
  const code = character?.charCodeAt(0) || 0
  return code >= 97 && code <= 122 ? code - 97 : code >= 65 && code <= 90 ? code - 65 : code >= 48 && code <= 57 ? code - 48 + 26 : -1
}

function abbreviationTokens(name) {
  pairLow.fill(0); pairHigh.fill(0)
  const characters = /[\uD800-\uDFFF]/u.test(name) ? [...name] : name
  let laterLow = 0, laterHigh = 0, startsLow = 0, startsHigh = 0
  for (let index = characters.length - 1; index >= 0; index--) {
    const first = pairCharacter(characters[index])
    if (first < 0) continue
    pairLow[first] |= laterLow; pairHigh[first] |= laterHigh
    const second = pairCharacter(characters[index + 1])
    if (second >= 32) pairHigh[first] |= 1 << (second - 32)
    else if (second >= 0) pairLow[first] |= 1 << second
    if (isBoundary(characters, index)) {
      if (first >= 32) { laterHigh |= 1 << (first - 32); startsHigh |= 1 << (first - 32) }
      else { laterLow |= 1 << first; startsLow |= 1 << first }
    }
  }
  const tokens = []
  for (let first = 0; first < 36; first++) {
    if (first < 32 ? startsLow & (1 << first) : startsHigh & (1 << (first - 32))) tokens.push('start' + pairAlphabet[first])
    let low = pairLow[first], high = pairHigh[first]
    while (low) { const second = 31 - Math.clz32(low); tokens.push(pairNames[first * 36 + second]); low = (low & ~(1 << second)) >>> 0 }
    while (high) { const second = 31 - Math.clz32(high); tokens.push(pairNames[first * 36 + second + 32]); high &= ~(1 << second) }
  }
  return tokens.join(' ')
}

function abbreviationQuery(value) {
  const query = value.toLowerCase()
  if (!/^[a-z0-9]{2,32}$/u.test(query)) return null
  return [...new Set(['start' + query[0], ...Array.from({ length: query.length - 1 }, (_value, index) => query.slice(index, index + 2))])].map(token => `"${token}"`).join(' AND ')
}

// Dynamic programming chooses the best sequence, retaining the same positions
// for ranking and rendering. Contiguous runs and camel/word boundaries win.
function matchName(name, value, { allowPartial = true, fuzzy = true, preferBoundaries = false, scoreOnly = false } = {}) {
  const characters = [...String(name || '')]
  const text = characters.map(character => character.toLowerCase())
  const query = [...String(value || '').toLowerCase()]
  if (!query.length || query.length > 128) return null
  const literal = text.findIndex((_character, index) => query.every((character, offset) => text[index + offset] === character))
  if (literal >= 0 && (!preferBoundaries || !fuzzy)) return { kind: 'literal', score: literal === 0 ? 100 : 200, positions: query.map((_c, i) => literal + i) }
  if (hasHan(name) && /^[a-z\d\p{Script=Han}]+$/u.test(value)) {
    const positions = pinyinMatch(name, value, { continuous: !fuzzy, precision: 'start', lastPrecision: allowPartial ? 'start' : 'every' })
    if (positions?.length) {
      const utf16Positions = new Set(positions)
      let offset = 0
      const mapped = []
      characters.forEach((character, index) => { if (utf16Positions.has(offset)) mapped.push(index); offset += character.length })
      return { kind: 'pinyin', score: 245 + mapped[0] * 2 + Math.max(0, mapped.at(-1) - mapped[0] + 1 - mapped.length) * 5, positions: mapped }
    }
  }
  if (!fuzzy || query.length > text.length) return null
  let previous = Array(text.length).fill(-Infinity)
  const parents = []
  for (let q = 0; q < query.length; q++) {
    const current = Array(text.length).fill(-Infinity)
    const row = scoreOnly ? null : Array(text.length).fill(-1)
    let best = -Infinity, bestIndex = -1
    for (let i = 0; i < text.length; i++) {
      if (i > 0 && previous[i - 1] + (i - 1) * 8 > best) { best = previous[i - 1] + (i - 1) * 8; bestIndex = i - 1 }
      if (text[i] !== query[q]) continue
      const boundary = isBoundary(characters, i) ? 110 : 0
      if (q === 0) current[i] = 100 + boundary - i * 3
      else {
        const separated = best - (i - 1) * 8 + 35 + boundary
        const contiguous = i > 0 ? previous[i - 1] + 100 + boundary : -Infinity
        if (contiguous >= separated) { current[i] = contiguous; if (row) row[i] = i - 1 }
        else { current[i] = separated; if (row) row[i] = bestIndex }
      }
    }
    if (row) parents.push(row)
    previous = current
  }
  let end = -1, best = -Infinity
  for (let i = 0; i < previous.length; i++) if (previous[i] > best) { best = previous[i]; end = i }
  if (end < 0 || !Number.isFinite(best)) return null
  if (scoreOnly) return { kind: 'fuzzy', score: 370 - Math.min(110, best / query.length * .55) + text.length * .15, positions: [] }
  const positions = []
  for (let q = query.length - 1; q >= 0; q--) { positions.unshift(end); end = parents[q][end] }
  const continuous = positions.every((position, index) => !index || position === positions[index - 1] + 1)
  return { kind: literal >= 0 && continuous ? 'literal' : 'fuzzy', score: 370 - Math.min(110, best / query.length * .55) + text.length * .15, positions }
}

function phoneticAliases(name) {
  if (!hasHan(name)) return []
  const primary = pinyin(name, { toneType: 'none', type: 'array', nonZh: 'spaced' })
  const alternatives = polyphonic(name, { toneType: 'none', type: 'array', nonZh: 'spaced' })
  let variants = [primary]
  for (let i = 0; i < alternatives.length && variants.length < 16; i++) {
    for (const pronunciation of alternatives[i]) {
      if (pronunciation === primary[i]) continue
      variants.push(primary.map((part, index) => index === i ? pronunciation : part))
      if (variants.length === 16) break
    }
  }
  return [...new Map(variants.map(parts => {
    const alias = parts.join('').toLowerCase()
    return [alias, { alias, initials: parts.map(part => part[0] || '').join('').toLowerCase() }]
  })).values()]
}

module.exports = { parseSearchQuery, fuzzyPattern, fuzzyNameScore, matchName, phoneticAliases, isBoundary, createAbbreviationMatcher, abbreviationTokens, abbreviationQuery }
