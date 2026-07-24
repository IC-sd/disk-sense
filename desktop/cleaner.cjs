const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { randomUUID } = require('node:crypto')
const { normalizeRisk } = require('./risk.cjs')

const execFileAsync = promisify(execFile)
const home = os.homedir()
const windows = process.env.WINDIR || 'C:\\Windows'
const local = path.join(home, 'AppData', 'Local')
const MAX_FILES_PER_RULE = 20000
const MAX_VISITED_PER_RULE = 100000
const MAX_SCAN_MS = 20000
const DAY_MS = 24 * 60 * 60 * 1000
const PROCESS_CHECK_FAILED = '__disk_sense_process_check_failed__'

function browserCacheRoots(productRoot) {
  if (!fs.existsSync(productRoot)) return []
  const roots = []
  let profiles = []
  try {
    profiles = fs.readdirSync(productRoot, { withFileTypes: true }).filter(item => item.isDirectory() && !item.isSymbolicLink())
  } catch {
    return roots
  }
  for (const profile of profiles) {
    const profileRoot = path.join(productRoot, profile.name)
    for (const cache of ['Cache', 'Code Cache', 'GPUCache']) {
      const candidate = path.join(profileRoot, cache)
      if (fs.existsSync(candidate)) roots.push(candidate)
    }
  }
  return roots
}

function existingRoots(values) {
  return values.filter(value => {
    try { return fs.existsSync(value) } catch { return false }
  })
}

function firefoxCacheRoots() {
  const profilesRoot = path.join(local, 'Mozilla', 'Firefox', 'Profiles')
  if (!fs.existsSync(profilesRoot)) return []
  try {
    return fs.readdirSync(profilesRoot, { withFileTypes: true })
      .filter(item => item.isDirectory() && !item.isSymbolicLink())
      .map(item => path.join(profilesRoot, item.name, 'cache2'))
      .filter(root => fs.existsSync(root))
  } catch {
    return []
  }
}

const rules = [
  {
    id: 'user-temp',
    title: '用户临时文件',
    category: 'Windows',
    roots: [path.join(local, 'Temp')],
    pattern: /.*/,
    risk: 'low',
    reason: '只列出至少 7 天未修改的用户临时文件；近期文件会保留，避免影响正在安装或运行的应用。',
    safetyNote: '不会跟随符号链接或目录联接，执行前会再次校验文件身份。',
    minimumAgeDays: 7,
    selectable: true
  },
  {
    id: 'windows-temp',
    title: 'Windows 临时文件',
    category: 'Windows',
    roots: [path.join(windows, 'Temp')],
    pattern: /.*/,
    risk: 'low',
    reason: '只列出至少 7 天未修改的系统临时文件；无权限或仍被占用的内容会跳过。',
    safetyNote: '部分文件需要管理员权限，本版本不会自动提权或强制删除。',
    minimumAgeDays: 7,
    selectable: true,
    requiresAdmin: true
  },
  {
    id: 'crash-dumps',
    title: '程序崩溃转储',
    category: '诊断',
    roots: [path.join(local, 'CrashDumps')],
    pattern: /\.dmp$/i,
    risk: 'low',
    reason: '至少 7 天前的崩溃诊断文件；近期转储会保留，便于排查刚发生的问题。',
    safetyNote: '删除后不影响程序运行，但会失去对应崩溃的调试信息。',
    minimumAgeDays: 7,
    selectable: true
  },
  {
    id: 'error-reports',
    title: 'Windows 错误报告',
    category: '诊断',
    roots: [path.join(local, 'Microsoft', 'Windows', 'WER')],
    pattern: /.*/,
    risk: 'low',
    reason: '至少 14 天前的 Windows 错误报告和诊断队列。',
    safetyNote: '如果正在排查系统或应用故障，应先取消选择。',
    minimumAgeDays: 14,
    selectable: true
  },
  {
    id: 'thumbnail-cache',
    title: '缩略图缓存',
    category: 'Windows',
    roots: [path.join(local, 'Microsoft', 'Windows', 'Explorer')],
    pattern: /^thumbcache.*\.db$/i,
    risk: 'safe',
    reason: '资源管理器生成的图片和视频缩略图，可由 Windows 自动重新生成。',
    safetyNote: '只匹配 thumbcache 数据库，不处理该目录中的其他文件。',
    minimumAgeDays: 1,
    selectable: true
  },
  {
    id: 'directx-cache',
    title: 'DirectX Shader 缓存',
    category: '图形',
    roots: [path.join(local, 'D3DSCache')],
    pattern: /.*/,
    risk: 'safe',
    reason: '至少 3 天前的显卡着色器缓存；游戏和应用后续可重新生成。',
    safetyNote: '首次重新运行相关游戏或应用时可能出现短暂编译等待。',
    minimumAgeDays: 3,
    selectable: true
  },
  {
    id: 'chrome-cache',
    title: 'Chrome 浏览器缓存',
    category: '浏览器',
    roots: () => browserCacheRoots(path.join(local, 'Google', 'Chrome', 'User Data')),
    pattern: /.*/,
    risk: 'low',
    reason: '只扫描各 Profile 的 Cache、Code Cache 和 GPUCache，不触碰 Cookie、密码、历史记录和书签。',
    safetyNote: 'Chrome 运行时禁止执行，防止与正在写入的缓存发生竞争。',
    minimumAgeDays: 3,
    selectable: true,
    processNames: ['chrome.exe']
  },
  {
    id: 'edge-cache',
    title: 'Edge 浏览器缓存',
    category: '浏览器',
    roots: () => browserCacheRoots(path.join(local, 'Microsoft', 'Edge', 'User Data')),
    pattern: /.*/,
    risk: 'low',
    reason: '只扫描各 Profile 的可重建缓存，不触碰登录状态和用户资料。',
    safetyNote: 'Edge 运行时禁止执行，关闭浏览器并重新扫描后才可选择。',
    minimumAgeDays: 3,
    selectable: true,
    processNames: ['msedge.exe']
  },
  {
    id: 'firefox-cache',
    title: 'Firefox 浏览器缓存',
    category: '浏览器',
    roots: firefoxCacheRoots,
    pattern: /.*/,
    risk: 'low',
    reason: '只扫描各 Firefox Profile 的 cache2 可重建缓存，不触碰书签、历史、扩展和登录数据。',
    safetyNote: 'Firefox 运行时禁止执行，关闭浏览器并重新扫描后才可选择。',
    minimumAgeDays: 3,
    selectable: true,
    processNames: ['firefox.exe']
  },
  {
    id: 'vscode-cache',
    title: 'Visual Studio Code 缓存',
    category: '开发工具',
    roots: () => existingRoots([
      path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code', 'Cache'),
      path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code', 'Code Cache'),
      path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code', 'GPUCache')
    ]),
    pattern: /.*/,
    risk: 'low',
    reason: '只扫描 VS Code 的界面和代码缓存，不处理扩展、用户设置、工作区状态或项目文件。',
    safetyNote: 'VS Code 运行时禁止执行，避免与缓存写入发生竞争。',
    minimumAgeDays: 7,
    selectable: true,
    processNames: ['Code.exe']
  },
  {
    id: 'discord-cache',
    title: 'Discord 客户端缓存',
    category: '应用缓存',
    roots: () => existingRoots([
      path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'discord', 'Cache'),
      path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'discord', 'Code Cache'),
      path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'discord', 'GPUCache')
    ]),
    pattern: /.*/,
    risk: 'low',
    reason: '只扫描 Discord 的可重建界面缓存，不处理账号、数据库、下载或聊天内容。',
    safetyNote: 'Discord 运行时禁止执行。',
    minimumAgeDays: 7,
    selectable: true,
    processNames: ['Discord.exe']
  },
  {
    id: 'npm-cache',
    title: 'npm 下载缓存',
    category: '开发工具',
    roots: [path.join(local, 'npm-cache')],
    pattern: /.*/,
    risk: 'low',
    reason: '至少 14 天前的 npm 下载缓存，后续需要时可重新下载。',
    safetyNote: '不处理项目中的 node_modules、配置文件或全局安装包。',
    minimumAgeDays: 14,
    selectable: true
  },
  {
    id: 'pip-cache',
    title: 'pip 下载缓存',
    category: '开发工具',
    roots: [path.join(local, 'pip', 'Cache')],
    pattern: /.*/,
    risk: 'low',
    reason: '至少 14 天前的 Python pip 下载与 wheel 缓存，后续需要时可重新下载。',
    safetyNote: '不处理虚拟环境、Python 包安装目录或项目文件。',
    minimumAgeDays: 14,
    selectable: true
  },
  {
    id: 'nuget-cache',
    title: 'NuGet HTTP 缓存',
    category: '开发工具',
    roots: () => existingRoots([
      path.join(local, 'NuGet', 'v3-cache'),
      path.join(local, 'NuGet', 'plugins-cache')
    ]),
    pattern: /.*/,
    risk: 'low',
    reason: '至少 14 天前的 NuGet HTTP 与插件下载缓存，可由 NuGet 重新获取。',
    safetyNote: '不处理全局包目录、项目依赖和离线包源。',
    minimumAgeDays: 14,
    selectable: true
  },
  {
    id: 'windows-update-cache',
    title: 'Windows 更新下载缓存',
    category: 'Windows 更新',
    roots: [path.join(windows, 'SoftwareDistribution', 'Download')],
    pattern: /.*/,
    risk: 'attention',
    reason: '可能包含正在使用的更新文件，必须先确认更新状态并通过 Windows 官方维护流程处理。',
    safetyNote: '当前只检测，不提供文件级删除。',
    minimumAgeDays: 30,
    selectable: false,
    requiresAdmin: true,
    processNames: ['TiWorker.exe', 'MoUsoCoreWorker.exe', 'TrustedInstaller.exe']
  }
].map(rule => ({
  ...rule,
  risk: normalizeRisk(rule.risk),
  kind: 'junk',
  minimumAgeDays: Math.max(0, Number(rule.minimumAgeDays || 0)),
  processNames: rule.processNames || []
}))

function pathKey(value) {
  const resolved = path.resolve(String(value || ''))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isWithinRoot(candidate, root) {
  const candidateKey = pathKey(candidate)
  const rootKey = pathKey(root)
  const relative = path.relative(rootKey, candidateKey)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function isPathExcluded(candidate, exclusions = []) {
  const candidateKey = pathKey(candidate)
  return exclusions.some(exclusion => {
    if (!exclusion?.path) return false
    const exclusionKey = pathKey(exclusion.path)
    if (exclusion.mode === 'exact') return candidateKey === exclusionKey
    return isWithinRoot(candidateKey, exclusionKey)
  })
}

function resolvedRoots(rule) {
  const values = typeof rule.roots === 'function' ? rule.roots() : rule.roots
  return [...new Set((values || []).map(value => path.resolve(String(value))))]
}

async function runningExecutableNames() {
  if (process.platform !== 'win32') return new Set()
  try {
    const { stdout } = await execFileAsync('tasklist.exe', ['/FO', 'CSV', '/NH'], {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024
    })
    const names = new Set()
    for (const line of String(stdout).split(/\r?\n/)) {
      const match = line.match(/^"([^"]+)"/)
      if (match) names.add(match[1].toLowerCase())
    }
    return names
  } catch {
    return new Set([PROCESS_CHECK_FAILED])
  }
}

async function processGuard(rule, processNames = null) {
  if (!rule.processNames.length) return { blocked: [], checkFailed: false }
  const running = processNames || await runningExecutableNames()
  if (running.has(PROCESS_CHECK_FAILED)) return { blocked: [], checkFailed: true }
  return { blocked: rule.processNames.filter(name => running.has(name.toLowerCase())), checkFailed: false }
}

function publicRule(rule) {
  return {
    id: rule.id,
    title: rule.title,
    category: rule.category,
    risk: rule.risk,
    reason: rule.reason,
    safetyNote: rule.safetyNote,
    selectable: rule.selectable,
    requiresAdmin: Boolean(rule.requiresAdmin),
    minimumAgeDays: rule.minimumAgeDays,
    processNames: [...rule.processNames]
  }
}

function abortError() {
  const error = new Error('扫描已取消')
  error.name = 'AbortError'
  return error
}

async function collectRuleFiles(rule, options = {}) {
  const {
    signal,
    onProgress,
    now = Date.now(),
    maxFiles = MAX_FILES_PER_RULE,
    maxVisited = MAX_VISITED_PER_RULE,
    maxMs = MAX_SCAN_MS
  } = options
  const startedAt = Date.now()
  const files = []
  const queue = []
  const skipped = { recent: 0, links: 0, inaccessible: 0, outsideRoot: 0, unsupported: 0, excluded: 0 }
  let visited = 0
  let truncated = false
  let limitReason = null

  for (const rootPath of resolvedRoots(rule)) {
    if (signal?.aborted) throw abortError()
    if (isPathExcluded(rootPath, options.exclusions)) {
      skipped.excluded++
      continue
    }
    try {
      const rootStat = await fsp.lstat(rootPath)
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        skipped.links++
        continue
      }
      const canonicalRoot = await fsp.realpath(rootPath)
      queue.push({ dir: rootPath, rootPath, canonicalRoot })
    } catch {
      skipped.inaccessible++
    }
  }

  while (queue.length) {
    if (signal?.aborted) throw abortError()
    if (files.length >= maxFiles || visited >= maxVisited || Date.now() - startedAt >= maxMs) {
      truncated = true
      limitReason = files.length >= maxFiles ? 'max-files' : visited >= maxVisited ? 'max-visited' : 'max-time'
      break
    }
    const current = queue.pop()
    if (isPathExcluded(current.dir, options.exclusions)) {
      skipped.excluded++
      continue
    }
    let canonicalDir
    let entries
    try {
      const dirStat = await fsp.lstat(current.dir)
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
        skipped.links++
        continue
      }
      canonicalDir = await fsp.realpath(current.dir)
      if (!isWithinRoot(canonicalDir, current.canonicalRoot)) {
        skipped.outsideRoot++
        continue
      }
      entries = await fsp.readdir(current.dir, { withFileTypes: true })
    } catch {
      skipped.inaccessible++
      continue
    }

    for (const entry of entries) {
      if (signal?.aborted) throw abortError()
      if (files.length >= maxFiles || visited >= maxVisited || Date.now() - startedAt >= maxMs) {
        truncated = true
        limitReason = files.length >= maxFiles ? 'max-files' : visited >= maxVisited ? 'max-visited' : 'max-time'
        break
      }
      const filePath = path.join(current.dir, entry.name)
      visited++
      if (isPathExcluded(filePath, options.exclusions)) {
        skipped.excluded++
        continue
      }
      if (entry.isSymbolicLink()) {
        skipped.links++
        continue
      }
      if (entry.isDirectory()) {
        queue.push({ ...current, dir: filePath })
        continue
      }
      if (!entry.isFile() || !rule.pattern.test(entry.name)) {
        if (!entry.isFile()) skipped.unsupported++
        continue
      }
      try {
        const stat = await fsp.lstat(filePath)
        if (!stat.isFile() || stat.isSymbolicLink()) {
          skipped.links++
          continue
        }
        const minimumModifiedAt = now - rule.minimumAgeDays * DAY_MS
        if (stat.mtimeMs > minimumModifiedAt) {
          skipped.recent++
          continue
        }
        const canonicalPath = await fsp.realpath(filePath)
        if (!isWithinRoot(canonicalPath, current.canonicalRoot)) {
          skipped.outsideRoot++
          continue
        }
        files.push({
          candidateId: randomUUID(),
          path: filePath,
          canonicalPath,
          rootPath: current.rootPath,
          canonicalRoot: current.canonicalRoot,
          name: entry.name,
          size: stat.size,
          modifiedAt: stat.mtimeMs,
          birthtimeMs: stat.birthtimeMs,
          dev: stat.dev,
          ino: stat.ino,
          ruleId: rule.id,
          risk: rule.risk,
          minimumAgeDays: rule.minimumAgeDays,
          processNames: [...rule.processNames]
        })
      } catch {
        skipped.inaccessible++
      }
      if (visited % 200 === 0) {
        onProgress?.({ ruleId: rule.id, visited, found: files.length, current: current.dir })
        await new Promise(resolve => setImmediate(resolve))
      }
    }
  }

  return { files, visited, skipped, truncated, limitReason, durationMs: Date.now() - startedAt }
}

function resultFor(rule, scan, guard) {
  const selectable = Boolean(rule.selectable && guard.blocked.length === 0 && !guard.checkFailed)
  return {
    ...publicRule(rule),
    selectable,
    configuredSelectable: Boolean(rule.selectable),
    blockedProcesses: guard.blocked,
    processCheckFailed: guard.checkFailed,
    blockedReason: guard.checkFailed
      ? '无法确认相关应用是否正在运行；为安全起见，本次结果不可清理'
      : guard.blocked.length
        ? `请先关闭 ${guard.blocked.join('、')}，然后重新扫描`
        : null,
    files: scan.files,
    total: scan.files.reduce((sum, item) => sum + item.size, 0),
    truncated: scan.truncated,
    limitReason: scan.limitReason,
    durationMs: scan.durationMs,
    visited: scan.visited,
    skipped: scan.skipped,
    scannedAt: Date.now()
  }
}

async function scanRuleAsync(id, options = {}) {
  const rule = rules.find(item => item.id === id)
  if (!rule) throw new Error('rule-not-found')
  const processNames = options.processNames || await runningExecutableNames()
  const [scan, guard] = await Promise.all([
    collectRuleFiles(rule, options),
    processGuard(rule, processNames)
  ])
  return resultFor(rule, scan, guard)
}

async function validateCandidate(candidate, options = {}) {
  const now = options.now || Date.now()
  if (!candidate?.path || !candidate.canonicalPath || !candidate.rootPath || !candidate.canonicalRoot) {
    return { ok: false, reason: '候选文件缺少安全校验信息，请重新扫描' }
  }
  try {
    const rootStat = await fsp.lstat(candidate.rootPath)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { ok: false, reason: '扫描根目录已经变化，请重新扫描' }
    const canonicalRoot = await fsp.realpath(candidate.rootPath)
    if (pathKey(canonicalRoot) !== pathKey(candidate.canonicalRoot)) return { ok: false, reason: '扫描根目录指向已经变化，请重新扫描' }

    const stat = await fsp.lstat(candidate.path)
    if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, reason: '文件类型已经变化，已阻止处理' }
    const canonicalPath = await fsp.realpath(candidate.path)
    if (pathKey(canonicalPath) !== pathKey(candidate.canonicalPath) || !isWithinRoot(canonicalPath, canonicalRoot)) {
      return { ok: false, reason: '文件路径指向已经变化，已阻止处理' }
    }
    if (
      stat.size !== candidate.size ||
      stat.mtimeMs !== candidate.modifiedAt ||
      stat.birthtimeMs !== candidate.birthtimeMs ||
      stat.dev !== candidate.dev ||
      stat.ino !== candidate.ino
    ) {
      return { ok: false, reason: '文件在扫描后发生变化，请重新扫描' }
    }
    if (stat.mtimeMs > now - Number(candidate.minimumAgeDays || 0) * DAY_MS) {
      return { ok: false, reason: '文件不再满足最短保留时间，已阻止处理' }
    }
    return { ok: true, canonicalPath, stat }
  } catch (error) {
    return { ok: false, reason: error?.code === 'ENOENT' ? '文件已经不存在' : '无法重新验证文件状态，已阻止处理' }
  }
}

function fileState(filePath) {
  try {
    const stat = fs.statSync(filePath)
    return { exists: true, bytes: stat.isFile() ? stat.size : null }
  } catch {
    return { exists: false, bytes: 0 }
  }
}

const slimmingRules = [
  { id: 'hibernation', title: '休眠文件', category: '系统功能', risk: 'elevated', path: 'C:\\hiberfil.sys', description: 'Windows 休眠功能会在 C 盘保存与内存容量相关的 hiberfil.sys。', impact: '关闭休眠会同时影响休眠功能，并可能影响快速启动。', action: '通过系统电源设置调整', requiresAdmin: true },
  { id: 'component-store', title: '系统组件存储', category: 'WinSxS', risk: 'attention', path: path.join(windows, 'WinSxS'), description: '可通过 DISM 分析和清理已被替代的组件版本。', impact: '不得直接删除 WinSxS 中的文件；只应使用 Windows 官方维护命令。', action: 'DISM 常规组件清理', requiresAdmin: true },
  { id: 'component-reset-base', title: '组件基线压缩', category: 'WinSxS', risk: 'danger', path: path.join(windows, 'WinSxS'), description: 'ResetBase 会进一步清理所有已替代组件版本。', impact: '执行后当前已安装的 Windows 更新将无法卸载，属于不可逆系统维护。', action: '仅展示风险，不自动执行', requiresAdmin: true },
  { id: 'virtual-memory', title: '虚拟内存', category: '系统功能', risk: 'danger', path: 'C:\\pagefile.sys', description: 'pagefile.sys 是 Windows 内存管理和崩溃转储的重要组成部分。', impact: '不建议直接删除；调整不当可能导致程序崩溃、内存不足或无法生成转储。', action: '通过 Windows 高级系统设置调整', requiresAdmin: true },
  { id: 'previous-windows', title: '旧版 Windows 安装', category: '系统升级', risk: 'elevated', path: 'C:\\Windows.old', description: '系统大版本升级后保留的旧系统文件，用于在期限内回退。', impact: '清理后将无法通过这些文件回退到旧版本。', action: '使用 Windows 存储设置处理', requiresAdmin: true }
].map(rule => ({ ...rule, risk: normalizeRisk(rule.risk), kind: 'slimming' }))

function inspectSlimming() {
  return slimmingRules.map(rule => {
    const state = fileState(rule.path)
    return {
      ...rule,
      detected: state.exists,
      bytes: state.bytes,
      status: state.exists ? (state.bytes ? '已检测到占用' : '已检测到系统组件') : '当前未检测到'
    }
  })
}

module.exports = {
  rules,
  publicRule,
  scanRuleAsync,
  collectRuleFiles,
  validateCandidate,
  runningExecutableNames,
  processGuard,
  pathKey,
  isWithinRoot,
  isPathExcluded,
  slimmingRules,
  inspectSlimming,
  MAX_FILES_PER_RULE,
  MAX_VISITED_PER_RULE,
  MAX_SCAN_MS,
  DAY_MS,
  PROCESS_CHECK_FAILED
}
