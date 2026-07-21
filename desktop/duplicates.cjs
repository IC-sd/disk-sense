const path = require('node:path')
function candidates(items) {
  const groups = new Map()
  for (const item of items || []) {
    const key = `${item.size}:${path.extname(item.path).toLowerCase()}`
    const group = groups.get(key) || []
    group.push({ path: item.path, size: item.size, name: path.basename(item.path) })
    groups.set(key, group)
  }
  return [...groups.values()].filter(group => group.length > 1).map((files, index) => ({ id: `duplicate-${index}`, confidence: 'candidate', size: files[0].size, files, reclaimable: files[0].size * (files.length - 1) })).sort((a, b) => b.reclaimable - a.reclaimable)
}
module.exports = { candidates }
