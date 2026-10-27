import { describe, expect, it } from 'vitest'
// @ts-expect-error Desktop matching is deliberately CommonJS.
import { matchName, createAbbreviationMatcher, abbreviationTokens, abbreviationQuery } from '../desktop/search-query.cjs'

describe('search word and pinyin matching', () => {
  it('matches word and camel prefixes without matching unrelated interior letters', () => {
    for (const name of ['Visual Studio Code.txt', 'VisualStudioCode.txt', 'Visual Small Code.txt']) {
      expect(createAbbreviationMatcher('vsc')(name)).toBe(true)
      expect(createAbbreviationMatcher('vsco')(name)).toBe(true)
    }
    expect(createAbbreviationMatcher('word')('WindowsOverlayRegistryData.txt')).toBe(true)
    expect(createAbbreviationMatcher('word')('lower-order.txt')).toBe(false)
    expect(createAbbreviationMatcher('vsc')('velocityspace.txt')).toBe(false)
    expect(createAbbreviationMatcher('aa')('AlphaArray.txt')).toBe(true)
    expect(createAbbreviationMatcher('a'.repeat(32))('A'.repeat(32))).toBe(true)
  })
  it('never drops valid abbreviation candidates through the pair postings', () => {
    const names = ['VisualStudioCode.txt', 'WindowsOverlayRegistryData.txt', 'AlphaBetaReport.txt', 'File99Data0.txt', '📁 Visual Code.txt']
    const queries = ['vsc', 'vsco', 'word', 'abr', 'f9d0', 'vc', 'f99']
    for (const name of names) for (const query of queries) if (createAbbreviationMatcher(query)(name)) {
      const tokens = new Set(abbreviationTokens(name).split(' '))
      for (const token of abbreviationQuery(query).replaceAll('"', '').split(' AND ')) expect(tokens.has(token)).toBe(true)
    }
  })
  it('uses the same fuzzy scores when title-position reconstruction is omitted', () => {
    for (const name of ['VisualStudioCode', 'AlphaBetaReport', 'WindowsOverlayRegistryData', '季度报告']) for (const query of ['vsc', 'abr', 'word', 'baogao', 'missing']) {
      expect(matchName(name, query, { scoreOnly: true })?.score).toBe(matchName(name, query)?.score)
    }
  })
  it('prefers application word boundaries over an earlier interior letter', () => {
    expect(matchName('OneNote', 'n', { preferBoundaries: true }).positions).toEqual([3])
    expect(matchName('OneNote', 'n').positions).toEqual([1])
  })
  it('recognizes camel-case acronyms and returns only the selected match positions', () => {
    expect(matchName('VisualStudioCode', 'vsc').positions).toEqual([0, 6, 12])
    expect(matchName('AlphaBetaReport', 'abr').positions).toEqual([0, 5, 9])
    expect(matchName('OneNote', 'on', { preferBoundaries: true }).positions).toHaveLength(2)
    expect(matchName('alpha', 'z')).toBe(null)
  })
})
