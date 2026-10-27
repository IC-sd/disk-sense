import { describe, expect, it } from 'vitest'
import { browseItems, highlightSearchName, readFavoritePaths, searchEnterAction } from '../src/application/explorer'
import type { DirectoryItem } from '../src/domain/desktop'

describe('explorer interaction', () => {
  const items = [
    { name: 'file10.txt', size: 20, isDirectory: false },
    { name: 'folder', size: 2, isDirectory: true },
    { name: 'file2.txt', size: 80, isDirectory: false },
    { name: 'file1.txt', size: null, isDirectory: false }
  ] as DirectoryItem[]
  it('keeps folders first, sorts naturally, and places unknown sizes after known ones', () => {
    expect(browseItems(items, '', 'name').map(item => item.name)).toEqual(['folder', 'file1.txt', 'file2.txt', 'file10.txt'])
    expect(browseItems(items, ' FILE ', 'size').map(item => item.name)).toEqual(['file2.txt', 'file10.txt', 'file1.txt'])
    expect(items[0].name).toBe('file10.txt')
  })
  it('distinguishes opening, locating and analysis with keyboard modifiers', () => {
    expect(searchEnterAction({ ctrlKey: false, altKey: false, shiftKey: false })).toBe('open')
    expect(searchEnterAction({ ctrlKey: true, altKey: false, shiftKey: false })).toBe('reveal')
    expect(searchEnterAction({ ctrlKey: false, altKey: true, shiftKey: false })).toBe('analyze')
  })
  it('recovers from damaged or invalid saved favorites', () => {
    expect(readFavoritePaths('{bad')).toEqual([])
    expect(readFavoritePaths(JSON.stringify(['C:\\Projects', 'C:\\Projects', 'https://example.test', 4]))).toEqual(['C:\\Projects'])
  })
  it('highlights exact words and fuzzy characters without highlighting filter syntax', () => {
    expect(highlightSearchName('Visual Studio Code.txt', 'vsc ext:txt').filter(segment => segment.match).map(segment => segment.text).join('')).toBe('VSC')
    const segments = highlightSearchName('季度报告📁.docx', '季度 报告 ext:docx')
    expect(segments.map(segment => segment.text).join('')).toBe('季度报告📁.docx')
    expect(segments.filter(segment => segment.match).map(segment => segment.text).join('')).toBe('季度报告')
  })
  it('renders the exact pinyin positions returned by the search engine', () => {
    const segments = highlightSearchName('重庆报告📁.txt', 'bg', [2, 3])
    expect(segments.filter(segment => segment.match).map(segment => segment.text).join('')).toBe('报告')
  })
})
