const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0

// Exact Top-K with O(K) retained rows. Only launch titles currently inside the
// heap need a deduplication entry: the admission threshold only improves.
function topPage(rows, limit, sort, { context, term, partial, choices, matchScore, locationScore, assertActive }) {
  const heap = [], titles = new Map()
  const identity = (a, b) => compare(a.pathKey ??= a.path.toLowerCase(), b.pathKey ??= b.path.toLowerCase()) || a.id - b.id
  const name = (a, b) => compare(a.nameKey ??= a.name.toLowerCase(), b.nameKey ??= b.name.toLowerCase()) || identity(a, b)
  const order = sort === 'name' ? name : sort === 'size' ? (a, b) => b.size - a.size || identity(a, b)
    : sort === 'modified' ? (a, b) => b.modified - a.modified || identity(a, b)
      : (a, b) => b.recent - a.recent || b.chosen - a.chosen || a.score - b.score
        || b.modified - a.modified || a.path.length - b.path.length || name(a, b)
  function swap(a, b) {
    ;[heap[a], heap[b]] = [heap[b], heap[a]]
    if (heap[a].title != null) titles.set(heap[a].title, a)
    if (heap[b].title != null) titles.set(heap[b].title, b)
  }
  function down(index) {
    while (index * 2 + 1 < heap.length) {
      let child = index * 2 + 1
      if (child + 1 < heap.length && order(heap[child + 1], heap[child]) > 0) child++
      if (order(heap[index], heap[child]) >= 0) break
      swap(index, child); index = child
    }
  }
  let checked = 0
  for (const row of rows) {
    const item = { id: row.id, path: row.path, name: row.name, size: row.size, modified: row.modified,
      nameKey: undefined, pathKey: undefined,
      title: null, score: 0, recent: 0, chosen: 0 }
    if (sort === 'relevance') {
      item.nameKey = row.name.toLowerCase()
      item.pathKey = row.path.toLowerCase()
      item.title = row.application ? item.nameKey.slice(0, item.nameKey.endsWith('.appref-ms') ? -10 : -4) : null
      const choice = choices.get(row.id)
      item.recent = Number(Boolean(choice?.exact)); item.chosen = choice?.exact ? choice.last_used : 0
      item.score = item.nameKey === term || item.nameKey.startsWith(term + '.') ? 0 : item.nameKey.startsWith(term) ? 100
        : item.nameKey.includes(term) ? 200 : item.pathKey.includes(term) ? 300 : matchScore(row.name, term, partial)
      item.score += locationScore(row.path, context) + (row.application ? -34 : row.directory ? -8 : 0) - (choice && !choice.exact ? 16 : 0)
    }
    const duplicate = item.title == null ? undefined : titles.get(item.title)
    if (duplicate !== undefined) {
      if (order(item, heap[duplicate]) < 0) { heap[duplicate] = item; down(duplicate) }
    } else if (heap.length < limit) {
      let index = heap.length
      heap.push(item)
      if (item.title != null) titles.set(item.title, index)
      while (index > 0) {
        const parent = (index - 1) >> 1
        if (order(heap[index], heap[parent]) <= 0) break
        swap(index, parent); index = parent
      }
    } else if (order(item, heap[0]) < 0) {
      if (heap[0].title != null) titles.delete(heap[0].title)
      heap[0] = item
      if (item.title != null) titles.set(item.title, 0)
      down(0)
    }
    if ((++checked & 255) === 0) assertActive()
  }
  assertActive()
  return heap.sort(order)
}

module.exports = { topPage }
