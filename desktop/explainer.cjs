const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const os = require('node:os')

const TEXT_EXTENSIONS = new Set(['.txt', '.log', '.md', '.json', '.jsonc', '.xml', '.ini', '.cfg', '.conf', '.yml', '.yaml', '.toml', '.csv', '.env', '.js', '.ts', '.jsx', '.tsx', '.vue', '.py', '.java', '.cs', '.cpp', '.h', '.bat', '.cmd', '.ps1', '.sql', '.html', '.css'])
const MAX_CONTENT_BYTES = 32768
const MAX_ITEMS = 5000
const MAX_CONTEXT_SIBLINGS = 80
const DIRECTORY_SAMPLE_NODES = 180
const DIRECTORY_SAMPLE_MS = 60
const MAX_ESTIMATED_DIRECTORIES = 48
const MAX_CACHE_ENTRIES = 400
const explanationCache = new Map()
const estimateCache = new Map()
function cacheRead(cache, key) { const value = cache.get(key); if (!value) return null; cache.delete(key); cache.set(key, value); return value }
function cacheWrite(cache, key, value) { cache.delete(key); cache.set(key, value); while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value); return value }

function normalize(value) { return String(value || '').replaceAll('/', '\\').replace(/[\\]+/g, '\\').toLowerCase() }
function labels(filePath) { return normalize(filePath).split('\\').filter(Boolean) }
function humanBytes(bytes) { if (bytes < 1024) return `${bytes} B`; const units = ['KB', 'MB', 'GB', 'TB']; let i = -1; let value = bytes; do { value /= 1024; i++ } while (value >= 1024 && i < units.length - 1); return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[i]}` }

function pathSignals(filePath) {
  const p = normalize(filePath)
  const name = path.basename(p)
  const signals = []
  const add = (classification, source, risk, confidence, reason) => ({ classification, source, risk, confidence, reason })
  if (/(^|\\)(windows|system32|syswow64|winsxs|servicing|driverstore)(\\|$)/.test(p)) return add('system-component', 'Windows 系统组件', 'high', .96, '路径位于 Windows 系统组件区域，文件可能参与系统启动、更新或硬件驱动。')
  if (/(^|\\)users$/.test(p)) return add('user-profile-root', 'Windows 用户配置根目录', 'high', .98, '这是 Windows 保存用户配置、桌面、下载和应用数据的根目录，不是单一用户文件夹。')
  if (/(^|\\)users\\[^\\]+$/.test(p)) return add('user-profile', 'Windows 用户配置目录', 'unknown', .94, '这是一个 Windows 用户配置目录，里面同时包含个人文件、应用数据和系统配置，不能整体清理。')
  if (/(^|\\)(programdata)$/.test(p)) return add('shared-application-data', '应用共享数据目录', 'unknown', .9, 'ProgramData 用于保存多个用户共享的应用数据、许可、索引和更新内容，不能按缓存目录整体删除。')
  if (/(^|\\)program files( \(x86\))?$/.test(p)) return add('application-install-root', '应用安装根目录', 'high', .98, '这是 Windows 应用安装目录，里面通常是程序本体和运行依赖，不应直接删除。')
  if (/(^|\\)(appdata\\(local|roaming)|programdata)(\\|$)/.test(p)) signals.push(add('application-data', '应用运行数据', 'unknown', .72, '路径位于应用数据区域，可能包含缓存、配置、登录状态或用户数据。'))
  if (/(^|\\)(cache|code cache|gpuCache|temp|tmp|crashdumps?|minidump|logs?)(\\|$)/.test(p)) signals.push(add('rebuildable-cache', '可重建缓存或日志', 'low', .9, '目录名称和路径符合应用缓存、临时文件或日志的常见模式。'))
  if (/(node_modules|\\.gradle|\\.m2|\\.nuget|__pycache__|\\target|\\.npm|\\.pnpm-store)/.test(p)) signals.push(add('development-data', '开发工具数据', 'low', .88, '路径包含开发工具依赖或构建缓存，通常可以由工具重新生成，但正在使用的项目可能需要它。'))
  if (/(^|\\)(desktop|downloads|documents|pictures|videos|music)(\\|$)/.test(p)) signals.push(add('user-content', '用户内容', 'unknown', .9, '路径位于用户常用内容目录，应结合文件名、内容和最近使用时间判断，不能直接当作垃圾。'))
  if (/\.(zip|rar|7z|iso|img|msi|exe|dmg)$/.test(name)) signals.push(add('archive-or-installer', '压缩包或安装程序', 'medium', .8, '文件类型可能是安装包、镜像或归档，既可能遗忘，也可能仍有用途。'))
  if (/\.(lnk|url|website)$/.test(name)) signals.push(add('shortcut', '快捷方式', 'low', .8, '这是快捷方式文件，真正内容需要查看它指向的目标。'))
  if (/\.(db|sqlite|sqlite3|dat)$/.test(name)) signals.push(add('application-database', '应用数据库', 'high', .78, '文件可能保存应用配置、索引、会话或用户数据，不应按缓存直接删除。'))
  return signals[0] || add('unclassified', '暂未确定', 'unknown', .25, '仅凭当前路径还不足以判断用途，需要结合名称、内容和上下文进一步分析。')
}

function readContent(filePath, stat) {
  const ext = path.extname(filePath).toLowerCase()
  if (stat.isDirectory()) return null
  if (!TEXT_EXTENSIONS.has(ext)) {
    try {
      const header = fs.readFileSync(filePath).subarray(0, 16).toString('hex').toUpperCase()
      const signatures = [{ starts: '4D5A', type: 'Windows PE 可执行文件' }, { starts: '25504446', type: 'PDF 文档' }, { starts: '504B0304', type: 'ZIP/Office/归档容器' }, { starts: '53514C69746520666F726D6174203300', type: 'SQLite 数据库' }, { starts: '89504E470D0A1A0A', type: 'PNG 图片' }, { starts: 'FFD8FF', type: 'JPEG 图片' }]
      const match = signatures.find(item => header.startsWith(item.starts))
      return match ? { kind: 'binary-signature', signature: match.type, preview: null } : null
    } catch { return null }
  }
  if (stat.size > 10 * 1024 * 1024) return null
  try {
    const buffer = fs.readFileSync(filePath, { encoding: 'utf8', flag: 'r' }).slice(0, MAX_CONTENT_BYTES)
    const printable = buffer.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim()
    if (!printable) return null
    return { kind: 'text-preview', bytes: Math.min(stat.size, MAX_CONTENT_BYTES), preview: printable.slice(0, 1200) }
  } catch { return null }
}

function inferFromContent(filePath, content) {
  if (!content) return null
  if (content.kind === 'binary-signature') {
    const type = content.signature
    if (type.includes('SQLite')) return { source: '应用数据库', classification: 'application-database', confidence: .9, risk: 'high', reason: '文件头符合 SQLite 数据库特征，不能当作普通缓存删除。' }
    if (type.includes('PE')) return { source: 'Windows 可执行文件', classification: 'executable', confidence: .96, risk: 'high', reason: '文件头符合 Windows 可执行文件特征，应结合所在目录和签名判断来源。' }
    if (type.includes('PDF') || type.includes('图片')) return { source: '用户文档或媒体', classification: 'user-content', confidence: .92, risk: 'unknown', reason: '文件签名表明它是用户文档或媒体内容，应由用户决定是否保留。' }
    return { source: '归档或容器文件', classification: 'archive-or-container', confidence: .85, risk: 'medium', reason: '文件签名表明它可能是压缩包、Office 文档或其他容器。' }
  }
  const text = content.preview.toLowerCase()
  if (text.includes('package.json') || text.includes('node_modules')) return { source: 'Node.js 项目或工具', classification: 'development-data', confidence: .92, reason: '文件内容出现 Node.js 项目特征，结合所在路径判断它属于开发工具或项目数据。' }
  if (text.includes('sqlite') || text.includes('database')) return { source: '应用数据库或索引', classification: 'application-database', confidence: .86, reason: '文件内容出现数据库特征，可能保存应用状态、索引或用户数据。' }
  if (text.includes('cache') || text.includes('temporary')) return { source: '缓存或临时数据', classification: 'rebuildable-cache', confidence: .82, reason: '文件内容出现缓存或临时数据特征，但删除前仍需确认所属应用。' }
  if (/^\s*[<{[]/.test(content.preview)) return { source: '结构化配置或数据', classification: 'configuration', confidence: .7, reason: '内容呈现 JSON、XML 或其他结构化数据特征，可能是配置或应用数据。' }
  return null
}

function inferFromName(filePath, siblings = []) {
  const name = path.basename(filePath).toLowerCase()
  const siblingNames = siblings.map(item => String(item.name || '').toLowerCase())
  const hasInstallerSet = siblingNames.some(item => /^install(\.exe|\.ini|\.res\.|\.dll$)/.test(item)) && siblingNames.some(item => item === 'install.exe' || item === 'setup.exe')
  if (name === 'desktop.ini') return { source: 'Windows 文件夹显示配置', classification: 'folder-view-metadata', risk: 'low', confidence: .96, reason: 'desktop.ini 是 Windows 用来保存文件夹显示方式和图标配置的隐藏系统文件，通常很小，不是用户文档。' }
  if (/^(pagefile|hiberfil|swapfile)\.sys$/.test(name)) return { source: 'Windows 系统管理文件', classification: 'system-managed-file', risk: 'high', confidence: .99, reason: '这是 Windows 管理的分页、休眠或交换文件，不能按普通大文件删除，应通过系统设置调整。' }
  if (/^(ntuser|usrclass)\.dat$/.test(name)) return { source: 'Windows 用户配置数据库', classification: 'user-profile-database', risk: 'high', confidence: .98, reason: '这是 Windows 用户配置和注册表数据，删除可能导致用户配置损坏。' }
  if (/^(thumbcache|iconcache).*\.(db|idx)$/.test(name)) return { source: 'Windows 缩略图或图标缓存', classification: 'rebuildable-cache', risk: 'low', confidence: .97, reason: '这是 Windows 生成的缩略图或图标缓存，系统通常可以重新生成。' }
  if (/^(dumpstack|memory|wer)\.log|\.dmp$/.test(name)) return { source: '系统诊断或崩溃记录', classification: 'diagnostic-data', risk: 'low', confidence: .9, reason: '这是系统诊断日志或崩溃转储，主要用于排查问题，通常可以在确认不再需要后处理。' }
  if (hasInstallerSet && (/^install(\.ini|\.exe|\.res\.|\.dll)/.test(name) || /^setup(\.ini|\.exe)/.test(name))) return { source: '安装程序及安装资源', classification: 'installer-residue', risk: 'medium', confidence: .95, reason: '同级目录同时存在安装程序、INI 和资源 DLL，说明它们属于一个安装包或安装介质，而不是独立配置文件。' }
  return null
}

function summarizeDirectory(siblings) {
  const names = siblings.map(item => String(item.name || '').toLowerCase())
  const has = (...values) => values.some(value => names.includes(value) || names.some(name => name.includes(value)))
  if (has('node_modules', 'package.json', 'pnpm-lock', 'yarn.lock')) return { source: 'Node.js 项目目录', classification: 'development-project', risk: 'unknown', confidence: .94, reason: '目录中同时出现 Node.js 项目标记，说明它可能是项目源代码和依赖目录。' }
  if (has('.git', 'src', 'tests', 'readme')) return { source: '软件或代码项目', classification: 'development-project', risk: 'unknown', confidence: .86, reason: '同级结构包含源代码、测试或版本控制标记，可能是用户项目。' }
  if (has('cache', 'code cache', 'gpu cache', '__pycache__')) return { source: '应用项目或数据目录', classification: 'application-context', risk: 'unknown', confidence: .68, reason: '目录中包含缓存子目录，说明它可能是某个应用的数据根目录，需要结合当前路径判断。' }
  if (has('bin', 'lib', 'config', 'resources')) return { source: '应用安装或运行目录', classification: 'application-runtime', risk: 'high', confidence: .74, reason: '目录具有应用运行时结构，不应按普通文件夹整体删除。' }
  return null
}

function meaningFor(info, filePath, isDirectory) {
  const meanings = {
    'system-component': ['Windows 系统组件', '为系统启动、更新、硬件驱动或系统功能提供基础能力。', '不要直接删除；需要通过 Windows 设置或专用维护工具处理。'],
    'user-profile-root': ['Windows 用户配置根目录', '组织本机用户的个人文件、桌面、下载、应用配置和用户数据库。', '不能整体删除；应进入具体用户目录和具体数据类别判断。'],
    'user-profile': ['Windows 用户配置目录', '同时承载个人文件、应用运行数据和用户配置。', '不能整体删除；应分别查看 Desktop、Downloads、AppData 等子目录。'],
    'shared-application-data': ['应用共享数据目录', '保存多个用户共用的应用配置、索引、许可和更新数据。', '不能整体删除；只能处理已经确认属于可重建缓存的子目录。'],
    'application-install-root': ['应用安装目录', '保存程序本体、运行库和卸载所需文件。', '不要直接删除；应使用应用卸载程序。'],
    'application-data': ['应用运行数据', '保存应用配置、缓存、索引、登录状态或用户数据。', '必须区分缓存和用户数据，不能整目录删除。'],
    'rebuildable-cache': ['可重建缓存或临时数据', '帮助应用加快启动、减少重复计算或保存临时结果。', '确认所属应用已关闭后通常可以清理，但不应误删同目录中的数据库和配置。'],
    'development-project': ['开发项目目录', '保存源代码、依赖、构建产物和项目配置。', '不能按垃圾处理；可单独分析 node_modules、构建目录和源代码。'],
    'development-data': ['开发工具数据', '保存依赖、构建缓存或包管理器下载内容。', '确认没有正在使用的项目后，可优先处理缓存，不要删除源代码。'],
    'installer-residue': ['安装程序及安装资源', '为软件安装、修复、语言包或组件注册提供配置和资源文件。', '如果对应程序仍需修复或卸载应保留；确认是遗留安装包后再归档或清理。'],
    'folder-view-metadata': ['Windows 文件夹显示配置', '保存文件夹图标、视图和显示方式。', '通常可以由 Windows 重新生成，但不必专门清理。'],
    'system-managed-file': ['Windows 系统管理文件', '用于分页、休眠或系统内存管理。', '不要直接删除，应通过系统设置调整。'],
    'application-database': ['应用数据库或索引', '保存应用状态、索引、会话或用户数据。', '不要按缓存处理；必须先确认所属应用和数据用途。'],
    'diagnostic-data': ['系统诊断或崩溃记录', '帮助定位系统或应用故障。', '确认不再需要排查问题后通常可以归档或清理。'],
    'user-content': ['用户内容', '可能是文档、图片、视频、项目或个人资料。', '不能自动删除，应由用户决定保留、移动或归档。'],
    'archive-or-installer': ['压缩包、镜像或安装程序', '可能是下载的安装介质、备份或归档文件。', '结合来源和最近使用时间判断，不要仅凭扩展名删除。']
  }
  const fallback = [isDirectory ? '暂未识别的目录' : '暂未识别的文件', '当前证据不足以确定它的具体用途。', '建议保留并进一步分析，不要自动删除。']
  const [what, purpose, handling] = meanings[info.classification] || fallback
  return { what, purpose, handling, reason: `它是${what}。用途：${purpose}处理建议：${handling}` }
}

async function estimateDirectory(dir) {
  const cacheKey = path.resolve(dir).toLowerCase()
  const cached = cacheRead(estimateCache, cacheKey)
  if (cached) return cached
  const started = Date.now()
  const queue = [dir]
  let nodes = 0
  let files = 0
  let bytes = 0
  while (queue.length && nodes < DIRECTORY_SAMPLE_NODES && Date.now() - started < DIRECTORY_SAMPLE_MS) {
    const current = queue.pop()
    let entries
    try { entries = await fsp.readdir(current, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (nodes >= DIRECTORY_SAMPLE_NODES || Date.now() - started >= DIRECTORY_SAMPLE_MS) break
      nodes++
      const child = path.join(current, entry.name)
      try {
        if (entry.isDirectory()) queue.push(child)
        else { const stat = await fsp.stat(child); files++; bytes += stat.size }
      } catch { /* inaccessible items are part of the estimate uncertainty */ }
    }
  }
  return cacheWrite(estimateCache, cacheKey, { bytes, fileCount: files, sampledNodes: nodes, complete: queue.length === 0 })
}

function explain(filePath, stat, siblings = [], directoryContext = null) {
  const pathInfo = pathSignals(filePath)
  const content = readContent(filePath, stat)
  const nameInfo = inferFromName(filePath, siblings)
  const contentInfo = inferFromContent(filePath, content)
  const name = path.basename(filePath)
  const parent = path.basename(path.dirname(filePath))
  const siblingNames = siblings.slice(0, 12).map(item => item.name).filter(Boolean)
  const strongerInfo = nameInfo || contentInfo
  const merged = strongerInfo ? { ...pathInfo, ...strongerInfo, risk: strongerInfo.risk || (strongerInfo.classification === 'application-database' ? 'high' : pathInfo.risk) } : directoryContext && pathInfo.classification === 'unclassified' ? { ...pathInfo, ...directoryContext } : pathInfo
  const meaning = meaningFor(merged, filePath, stat.isDirectory())
  return { path: filePath, name, parent, size: stat.size, modifiedAt: stat.mtimeMs, ...merged, ...meaning, analysisMode: 'local-evidence', needsReview: merged.confidence < .6, aiEligible: merged.confidence < .6, evidence: { pathSegments: labels(filePath).slice(-8), parent, siblingNames, content, directoryContext }, contentPreview: content?.preview || null }
}

async function listDirectory(dir) {
  const root = path.resolve(dir || 'C:\\')
  const entries = await fsp.readdir(root, { withFileTypes: true })
  const items = []
  const visibleEntries = entries.slice(0, MAX_ITEMS)
  for (const entry of visibleEntries) {
    const filePath = path.join(root, entry.name)
    try {
      const stat = await fsp.stat(filePath)
      const info = pathSignals(filePath)
      items.push({ name: entry.name, path: filePath, isDirectory: entry.isDirectory(), size: entry.isDirectory() ? null : stat.size, fileCount: entry.isDirectory() ? null : 1, sizeEstimated: entry.isDirectory(), modifiedAt: stat.mtimeMs, extension: entry.isDirectory() ? '' : path.extname(entry.name).toLowerCase(), ...info })
    } catch { /* inaccessible entries are omitted without aborting the directory */ }
  }
  const directories = items.filter(item => item.isDirectory).slice(0, MAX_ESTIMATED_DIRECTORIES)
  const estimates = await Promise.all(directories.map(item => estimateDirectory(item.path).then(value => [item.path, value])))
  const byPath = new Map(estimates)
  for (const item of items) if (item.isDirectory) { const estimate = byPath.get(item.path); if (estimate) { item.size = estimate.bytes; item.fileCount = estimate.fileCount; item.sizeEstimated = !estimate.complete } }
  const siblings = items.map(item => ({ name: item.name }))
  return { path: root, items: items.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name)), truncated: entries.length > visibleEntries.length, context: { siblingCount: siblings.length, analyzed: 'path-name-parent' } }
}

async function explainPath(filePath) {
  const target = path.resolve(filePath)
  const stat = await fsp.stat(target)
  const cacheKey = `${target.toLowerCase()}|${stat.size}|${stat.mtimeMs}`
  const cached = cacheRead(explanationCache, cacheKey)
  if (cached) return cached
  let siblings = []
  try { siblings = (await fsp.readdir(path.dirname(target), { withFileTypes: true })).slice(0, MAX_CONTEXT_SIBLINGS) } catch { /* parent may be protected */ }
  const directoryContext = stat.isDirectory() ? summarizeDirectory(siblings) : null
  return cacheWrite(explanationCache, cacheKey, explain(target, stat, siblings, directoryContext))
}

module.exports = { listDirectory, explainPath, explain, pathSignals, readContent, inferFromName, summarizeDirectory, estimateDirectory, humanBytes, MAX_CONTENT_BYTES }
