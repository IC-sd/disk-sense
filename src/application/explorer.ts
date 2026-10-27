import type { DirectoryItem } from '../domain/desktop'

export type BrowseSort = 'name' | 'size' | 'modified'
const directoryNameCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
export function browseItems(items: DirectoryItem[], filter: string, sort: BrowseSort): DirectoryItem[] {
  const query = filter.trim().toLocaleLowerCase()
  return items.filter(item => !query || item.name.toLocaleLowerCase().includes(query)).slice().sort((left, right) => {
    const folders = Number(right.isDirectory) - Number(left.isDirectory)
    if (folders) return folders
    const measure = sort === 'size' ? (right.size ?? -1) - (left.size ?? -1)
      : sort === 'modified' ? (right.modifiedAt ?? -1) - (left.modifiedAt ?? -1) : 0
    return measure || directoryNameCollator.compare(left.name, right.name)
  })
}

export function searchEnterAction(event: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey'>): 'open' | 'reveal' | 'analyze' {
  return event.altKey ? 'analyze' : event.ctrlKey ? 'reveal' : 'open'
}

export function highlightSearchName(name: string, query: string, positions?: number[]): Array<{ text: string; match: boolean }> {
  const needles = query.replace(/\bext:[^\s]+/giu, '').replace(/\b(?:folder|file):/giu, '').replace(/["*?]/gu, '').toLocaleLowerCase().split(/\s+/u).filter(Boolean)
  const characters = [...name]
  const lowered = characters.map(character => character.toLocaleLowerCase())
  const marked = new Set<number>()
  if (positions) positions.forEach(position => marked.add(position))
  for (const needle of positions ? [] : needles) {
    const term = [...needle]
    const exact = lowered.findIndex((_character, index) => term.every((value, offset) => lowered[index + offset] === value))
    if (exact >= 0) { term.forEach((_character, offset) => marked.add(exact + offset)); continue }
    const positions: number[] = []
    const boundaries = lowered.map((character, index) => ({ character, index }))
      .filter(({ index }) => index === 0 || /[\s_.\-]/u.test(characters[index - 1]) || (/[A-Z]/u.test(characters[index]) && /[a-z]/u.test(characters[index - 1])))
    let wordCursor = 0
    for (const character of term) {
      const index = boundaries.findIndex((entry, offset) => offset >= wordCursor && entry.character === character)
      if (index < 0) { positions.length = 0; break }
      positions.push(boundaries[index].index); wordCursor = index + 1
    }
    if (positions.length === term.length) { positions.forEach(index => marked.add(index)); continue }
    positions.length = 0
    let cursor = 0
    for (const character of term) {
      const index = lowered.indexOf(character, cursor)
      if (index < 0) { positions.length = 0; break }
      positions.push(index); cursor = index + 1
    }
    positions.forEach(index => marked.add(index))
  }
  return characters.reduce<Array<{ text: string; match: boolean }>>((segments, character, index) => {
    const match = marked.has(index)
    const previous = segments.at(-1)
    if (previous?.match === match) previous.text += character
    else segments.push({ text: character, match })
    return segments
  }, [])
}

export function readFavoritePaths(value: string | null): string[] {
  try {
    const input = JSON.parse(value || '[]')
    if (!Array.isArray(input)) return []
    return [...new Set(input.filter((item): item is string => typeof item === 'string' && /^[a-z]:[\\/]/iu.test(item) && !/[\0\r\n]/u.test(item)))].slice(0, 12)
  } catch { return [] }
}
