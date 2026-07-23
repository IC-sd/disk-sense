const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

function classify(filePath, stat) {
  const p = filePath.toLowerCase(); const home = os.homedir().toLowerCase(); const ext = path.extname(p)
  const cache = /[\\/](cache|code cache|temp|tmp|crashdumps?|minidump|logs?)[\\/]/.test(p)
  const dev = /[\\/](node_modules|\.gradle|\.m2|\.nuget|__pycache__|target)[\\/]/.test(p)
  const personal = p.startsWith(home) && !p.includes(`${path.sep}appdata${path.sep}`)
  const stale = Date.now() - stat.mtimeMs > 180 * 86400000
  if (cache) return { classification: 'rebuildable-cache', source: '可重建缓存', risk: 'low', confidence: .9, reason: '路径符合可重建缓存特征。' }
  if (dev) return { classification: 'rebuildable-cache', source: '开发工具缓存', risk: 'low', confidence: .86, reason: '常见开发工具生成内容，通常可以重新生成。' }
  if (personal && stale) return { classification: 'stale', source: '长期未使用内容', risk: 'medium', confidence: .72, reason: '位于用户目录且超过 180 天未修改。' }
  if (personal) return { classification: 'personal', source: '个人文件', risk: 'unknown', confidence: .55, reason: '位于用户目录，不能自动判断是否有价值。' }
  if (['.zip','.rar','.7z','.iso','.msi','.exe'].includes(ext)) return { classification: 'unknown', source: '安装包或压缩包', risk: 'medium', confidence: .65, reason: '可能是遗留下载内容，也可能仍有用途。' }
  return { classification: 'unknown', source: '未分类空间', risk: 'unknown', confidence: .3, reason: '没有足够证据判断用途。' }
}

function roots() { const h = os.homedir(); return [path.join(h,'Desktop'), path.join(h,'Downloads'), path.join(h,'Documents'), path.join(h,'AppData','Local','Temp')].filter(fs.existsSync) }
function scan(options = {}) {
  const limit = options.limit || 50000; const minBytes = options.minBytes || 1024 * 1024; const items = []; const errors = []; let files = 0; let dirs = 0
  for (const root of options.roots || roots()) {
    const queue = [root]
    while (queue.length && items.length < limit) {
      const current = queue.pop(); let entries
      try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch (e) { errors.push({ path: current, reason: e.code || e.message }); continue }
      for (const entry of entries) {
        const full = path.join(current, entry.name)
        try {
          const stat = fs.statSync(full)
          if (entry.isDirectory()) {
            dirs++
            queue.push(full)
          } else {
            files++
            if (stat.size >= minBytes) {
              const c = classify(full, stat)
              items.push({ id: full, path: full, volume: path.parse(full).root, size: stat.size, fileCount: 1, modifiedAt: new Date(stat.mtimeMs).toISOString(), accessedAt: new Date(stat.atimeMs).toISOString(), ...c, evidence: [{ type: 'path', value: full }, { type: 'size', value: String(stat.size) }], actions: c.risk === 'low' ? ['inspect', 'trash'] : ['inspect', 'open', 'move', 'archive', 'ignore'] })
            }
          }
        } catch (e) { errors.push({ path: full, reason: e.code || e.message }) }
      }
    }
  }
  return { items: items.sort((a,b)=>b.size-a.size), errors, files, dirs, limited: items.length >= limit, roots: options.roots || roots() }
}

async function scanAsync(options = {}, hooks = {}) {
  const limit = options.limit || 50000
  const minBytes = options.minBytes || 1024 * 1024
  const items = []
  const errors = []
  const queue = [...(options.roots || roots())]
  let files = 0
  let dirs = 0
  let visited = 0
  const signal = hooks.signal
  while (queue.length && items.length < limit) {
    if (signal?.aborted) return { items, errors, files, dirs, limited: false, cancelled: true, roots: options.roots || roots() }
    const current = queue.pop()
    let entries
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch (error) { errors.push({ path: current, reason: error.code || error.message }); continue }
    dirs++; visited++
    for (const entry of entries) {
      if (items.length >= limit) break
      if (signal?.aborted) return { items, errors, files, dirs, limited: false, cancelled: true, roots: options.roots || roots() }
      const full = path.join(current, entry.name)
      try {
        const stat = fs.statSync(full)
        if (entry.isDirectory()) queue.push(full)
        else {
          files++
          if (stat.size >= minBytes) {
            const c = classify(full, stat)
            items.push({ id: full, path: full, volume: path.parse(full).root, size: stat.size, fileCount: 1, modifiedAt: new Date(stat.mtimeMs).toISOString(), accessedAt: new Date(stat.atimeMs).toISOString(), ...c, evidence: [{ type: 'path', value: full }, { type: 'size', value: String(stat.size) }], actions: c.risk === 'low' ? ['inspect', 'trash'] : ['inspect', 'open', 'move', 'archive', 'ignore'] })
          }
        }
      } catch (error) { errors.push({ path: full, reason: error.code || error.message }) }
    }
    hooks.onProgress?.({ visited, queued: queue.length, files, dirs, candidates: items.length, current })
    await new Promise(resolve => setImmediate(resolve))
  }
  return { items: items.sort((a, b) => b.size - a.size), errors, files, dirs, limited: items.length >= limit, cancelled: false, roots: options.roots || roots() }
}
module.exports = { scan, scanAsync, roots, classify }
