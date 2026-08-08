const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { randomUUID } = require('node:crypto')
const { normalizeRisk } = require('./risk.cjs')
const { slimmingRules, inspectSlimming } = require('./system-maintenance.cjs')

const execFileAsync = promisify(execFile)
const home = os.homedir()
const windows = process.env.WINDIR || 'C:\\Windows'
const local = path.join(home, 'AppData', 'Local')
const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
const powershell = path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const tasklist = path.join(windows, 'System32', 'tasklist.exe')
const MAX_FILES_PER_RULE = 20000
const MAX_VISITED_PER_RULE = 100000
const MAX_SCAN_MS = 20000
const DAY_MS = 24 * 60 * 60 * 1000
const PROCESS_CHECK_FAILED = '__disk_sense_process_check_failed__'
const REBUILDABLE_CACHE_DIRECTORIES = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'GrShaderCache',
  'ShaderCache',
  'Media Cache'
]
const REBUILDABLE_CACHE_NAMES = new Set(REBUILDABLE_CACHE_DIRECTORIES.map(name => name.toLowerCase()))

function uniqueRoots(values) {
  const seen = new Set()
  return values.filter(value => {
    const key = path.resolve(value).toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function browserCacheRoots(productRoot, includeProductRoot = false) {
  if (!fs.existsSync(productRoot)) return []
  const roots = []
  let profiles = []
  try {
    profiles = fs.readdirSync(productRoot, { withFileTypes: true }).filter(item => item.isDirectory() && !item.isSymbolicLink())
  } catch {
    return roots
  }
  const profileRoots = profiles.map(profile => path.join(productRoot, profile.name))
  if (includeProductRoot) profileRoots.unshift(productRoot)
  for (const profileRoot of profileRoots) {
    for (const cache of REBUILDABLE_CACHE_DIRECTORIES) {
      const candidate = path.join(profileRoot, cache)
      if (fs.existsSync(candidate)) roots.push(candidate)
    }
  }
  return uniqueRoots(roots)
}

function existingRoots(values) {
  return values.filter(value => {
    try { return fs.existsSync(value) } catch { return false }
  })
}

function electronCacheRoots(productRoots) {
  return uniqueRoots(existingRoots(productRoots.flatMap(productRoot => (
    REBUILDABLE_CACHE_DIRECTORIES.map(cache => path.join(productRoot, cache))
  ))))
}

async function findNamedCacheRoots(productRoots, options = {}) {
  const maxDepth = Math.max(0, Math.min(5, Number(options.maxDepth ?? 3)))
  const maxDirectories = Math.max(1, Math.min(10000, Number(options.maxDirectories ?? 2000)))
  const names = new Set((options.names || REBUILDABLE_CACHE_DIRECTORIES).map(name => String(name).toLowerCase()))
  const roots = []
  const productRootsToScan = existingRoots(productRoots)
  const maximumPerRoot = Math.max(1, Math.floor(maxDirectories / Math.max(1, productRootsToScan.length)))
  let visited = 0

  for (const productRoot of productRootsToScan) {
    const queue = [{ dir: productRoot, depth: 0 }]
    let cursor = 0
    let rootVisited = 0
    while (cursor < queue.length && rootVisited < maximumPerRoot && visited < maxDirectories) {
      const current = queue[cursor++]
      let entries
      try {
        entries = await fsp.readdir(current.dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (rootVisited >= maximumPerRoot || visited >= maxDirectories) break
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        rootVisited++
        visited++
        const candidate = path.join(current.dir, entry.name)
        if (names.has(entry.name.toLowerCase())) {
          roots.push(candidate)
          continue
        }
        if (current.depth < maxDepth) queue.push({ dir: candidate, depth: current.depth + 1 })
      }
      if (visited % 100 === 0) await new Promise(resolve => setImmediate(resolve))
    }
  }
  return uniqueRoots(roots)
}

function jetbrainsCacheRoots() {
  const productRoot = path.join(local, 'JetBrains')
  if (!fs.existsSync(productRoot)) return []
  try {
    return existingRoots(fs.readdirSync(productRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .flatMap(entry => [
        path.join(productRoot, entry.name, 'caches'),
        path.join(productRoot, entry.name, 'tmp')
      ]))
  } catch {
    return []
  }
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

const RECYCLE_BIN_QUERY_SCRIPT = String.raw`
$source = @'
using System;
using System.Runtime.InteropServices;
public static class DiskSenseRecycleBinQuery {
  [StructLayout(LayoutKind.Sequential)]
  public struct SHQUERYRBINFO {
    public int cbSize;
    public long i64Size;
    public long i64NumItems;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern int SHQueryRecycleBin(string rootPath, ref SHQUERYRBINFO info);
}
'@
Add-Type -TypeDefinition $source
$roots = @(
  [System.IO.DriveInfo]::GetDrives() |
    Where-Object { $_.DriveType -eq [System.IO.DriveType]::Fixed -and $_.IsReady } |
    ForEach-Object { $_.Name }
)
$results = foreach ($root in $roots) {
  $info = New-Object DiskSenseRecycleBinQuery+SHQUERYRBINFO
  $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($info)
  $code = [DiskSenseRecycleBinQuery]::SHQueryRecycleBin($root, [ref]$info)
  [pscustomobject]@{
    root = $root
    code = $code
    items = if ($code -eq 0) { $info.i64NumItems } else { 0 }
    bytes = if ($code -eq 0) { $info.i64Size } else { 0 }
  }
}
[pscustomobject]@{
  items = [long](($results | Measure-Object -Property items -Sum).Sum)
  bytes = [long](($results | Measure-Object -Property bytes -Sum).Sum)
  volumes = @($results)
} | ConvertTo-Json -Compress -Depth 4
`

function parseRecycleBinOutput(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean)
  const parsed = JSON.parse(lines.at(-1) || '{}')
  const volumes = Array.isArray(parsed.volumes)
    ? parsed.volumes
    : parsed.volumes
      ? [parsed.volumes]
      : []
  return {
    items: Math.max(0, Number(parsed.items || 0)),
    bytes: Math.max(0, Number(parsed.bytes || 0)),
    volumes: volumes.map(item => ({
      root: String(item.root || ''),
      code: Number(item.code || 0),
      items: Math.max(0, Number(item.items || 0)),
      bytes: Math.max(0, Number(item.bytes || 0))
    }))
  }
}

async function queryRecycleBin() {
  if (process.platform !== 'win32') return { items: 0, bytes: 0, volumes: [] }
  const { stdout } = await execFileAsync(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    RECYCLE_BIN_QUERY_SCRIPT
  ], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024 * 1024
  })
  const result = parseRecycleBinOutput(stdout)
  if (!result.volumes.length) throw new Error('未找到可查询的本地磁盘')
  if (result.volumes.every(item => item.code !== 0)) {
    throw new Error('Windows 拒绝了回收站容量查询')
  }
  return result
}

const rules = [
  {
    id: 'recycle-bin',
    title: '回收站',
    category: 'Windows',
    roots: [],
    pattern: /.*/,
    risk: 'attention',
    reason: '统计各本地磁盘回收站中仍可恢复的文件数量和占用空间。',
    safetyNote: '当前只读取容量，不提供清空操作；清空回收站属于永久删除，需要单独设计确认和恢复边界。',
    minimumAgeDays: 0,
    selectable: false,
    probe: queryRecycleBin
  },
  {
    id: 'user-temp',
    title: '用户临时文件',
    category: 'Windows',
    roots: [path.join(local, 'Temp')],
    pattern: /.*/,
    risk: 'low',
    reason: '识别用户临时目录的完整占用；只有至少 7 天未修改的文件才进入清理候选。',
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
    reason: '识别 Windows 临时目录的完整占用；只有至少 7 天未修改且可访问的文件才进入清理候选。',
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
    reason: '识别程序崩溃诊断文件；最近 7 天的转储只统计并保留，便于排查刚发生的问题。',
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
    reason: '识别 Windows 错误报告和诊断队列；最近 14 天的内容只统计并保留。',
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
    id: 'icon-cache',
    title: '图标缓存',
    category: 'Windows',
    roots: [path.join(local, 'Microsoft', 'Windows', 'Explorer')],
    pattern: /^(iconcache|tilecache).*\.db$/i,
    risk: 'safe',
    reason: '资源管理器生成的文件和应用图标索引，损坏或删除后可由 Windows 自动重建。',
    safetyNote: '只匹配 Explorer 目录中的图标缓存数据库，不处理用户文件或其他数据库。',
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
    reason: '识别显卡着色器缓存；最近 3 天的内容保留，其余可由游戏和应用重新生成。',
    safetyNote: '首次重新运行相关游戏或应用时可能出现短暂编译等待。',
    minimumAgeDays: 3,
    selectable: true
  },
  {
    id: 'chrome-cache',
    title: 'Chrome 浏览器缓存',
    category: '浏览器',
    roots: () => uniqueRoots([
      ...browserCacheRoots(path.join(local, 'Google', 'Chrome', 'User Data')),
      ...browserCacheRoots(path.join(local, 'Google', 'Chrome SxS', 'User Data'))
    ]),
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
    id: 'chromium-family-cache',
    title: '其他 Chromium 浏览器缓存',
    category: '浏览器',
    roots: () => uniqueRoots([
      ...browserCacheRoots(path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')),
      ...browserCacheRoots(path.join(local, 'Vivaldi', 'User Data')),
      ...browserCacheRoots(path.join(local, 'Chromium', 'User Data')),
      ...browserCacheRoots(path.join(roaming, 'Opera Software', 'Opera Stable'), true),
      ...browserCacheRoots(path.join(roaming, 'Opera Software', 'Opera GX Stable'), true)
    ]),
    pattern: /.*/,
    risk: 'low',
    reason: '识别 Brave、Vivaldi、Chromium 与 Opera 各用户配置中的可重建页面、代码、媒体和图形缓存。',
    safetyNote: '不扫描 Cookie、登录数据、历史记录、书签、扩展、下载或站点数据库；相关浏览器运行时禁止执行。',
    minimumAgeDays: 3,
    selectable: true,
    processNames: ['brave.exe', 'vivaldi.exe', 'chromium.exe', 'opera.exe']
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
    id: 'dingtalk-cache',
    title: '钉钉界面缓存',
    category: '应用缓存',
    roots: () => findNamedCacheRoots([
      path.join(roaming, 'DingTalk'),
      path.join(local, 'DingTalk_108')
    ], { maxDepth: 4 }),
    pattern: /.*/,
    risk: 'low',
    reason: '只识别钉钉程序目录中名称明确的页面、代码和图形缓存目录。',
    safetyNote: '不处理聊天数据库、接收文件、下载、账号配置或用户文档；钉钉运行时禁止执行。',
    minimumAgeDays: 7,
    selectable: true,
    processNames: ['DingTalk.exe']
  },
  {
    id: 'qq-renderer-cache',
    title: 'QQ 界面渲染缓存',
    category: '应用缓存',
    roots: () => findNamedCacheRoots([
      path.join(roaming, 'QQ'),
      path.join(roaming, 'Tencent', 'QQ'),
      path.join(local, 'Tencent', 'QQ')
    ], {
      maxDepth: 4,
      names: ['Code Cache', 'GPUCache', 'DawnCache', 'GrShaderCache', 'ShaderCache']
    }),
    pattern: /.*/,
    risk: 'low',
    reason: '只识别 QQ 的代码与图形渲染缓存，不把名称含糊的 Cache 目录当作垃圾。',
    safetyNote: '不处理聊天记录、图片、视频、文件、账号数据或数据库；QQ 运行时禁止执行。',
    minimumAgeDays: 7,
    selectable: true,
    processNames: ['QQ.exe']
  },
  {
    id: 'wemeet-cache',
    title: '腾讯会议界面缓存',
    category: '应用缓存',
    roots: () => findNamedCacheRoots([
      path.join(roaming, 'WeMeetApp'),
      path.join(local, 'Tencent', 'WeMeet')
    ], { maxDepth: 4 }),
    pattern: /.*/,
    risk: 'low',
    reason: '识别腾讯会议客户端中可重新生成的页面、代码与图形缓存。',
    safetyNote: '不处理会议录制、下载、账号数据、配置或日志；腾讯会议运行时禁止执行。',
    minimumAgeDays: 7,
    selectable: true,
    processNames: ['wemeetapp.exe', 'wemeet.exe']
  },
  {
    id: 'teams-cache',
    title: 'Microsoft Teams 客户端缓存',
    category: '应用缓存',
    roots: async () => uniqueRoots([
      ...electronCacheRoots([path.join(roaming, 'Microsoft', 'Teams')]),
      ...await findNamedCacheRoots([
        path.join(local, 'Packages', 'MSTeams_8wekyb3d8bbwe', 'LocalCache', 'Microsoft', 'MSTeams')
      ], { maxDepth: 4 })
    ]),
    pattern: /.*/,
    risk: 'low',
    reason: '识别传统与新版 Teams 客户端中名称明确的可重建界面、代码和图形缓存。',
    safetyNote: '不处理登录状态、聊天数据库、下载文件、配置或其他应用数据；Teams 运行时禁止执行。',
    minimumAgeDays: 7,
    selectable: true,
    processNames: ['Teams.exe', 'ms-teams.exe']
  },
  {
    id: 'slack-cache',
    title: 'Slack 客户端缓存',
    category: '应用缓存',
    roots: () => electronCacheRoots([path.join(roaming, 'Slack')]),
    pattern: /.*/,
    risk: 'low',
    reason: '只扫描 Slack 的界面缓存、代码缓存和 GPU 缓存。',
    safetyNote: '不处理账号、工作区配置、数据库或下载文件；Slack 运行时禁止执行。',
    minimumAgeDays: 7,
    selectable: true,
    processNames: ['slack.exe']
  },
  {
    id: 'desktop-utility-cache',
    title: '常见桌面工具界面缓存',
    category: '应用缓存',
    roots: () => uniqueRoots([
      ...electronCacheRoots([
        path.join(roaming, 'Notion'),
        path.join(roaming, 'Postman'),
        path.join(roaming, 'Figma'),
        path.join(roaming, 'Obsidian'),
        path.join(roaming, 'Spotify'),
        path.join(roaming, 'io.github.clash-verge-rev.clash-verge-rev'),
        path.join(local, 'io.github.clash-verge-rev.clash-verge-rev')
      ])
    ]),
    pattern: /.*/,
    risk: 'low',
    reason: '识别 Notion、Postman、Figma、Obsidian、Spotify 与 Clash Verge 等桌面工具的标准可重建界面缓存。',
    safetyNote: '只接受明确的 Cache、Code Cache、GPUCache 等子目录；任何一个相关应用运行时都不会执行清理。',
    minimumAgeDays: 7,
    selectable: true,
    processNames: ['Notion.exe', 'Postman.exe', 'Figma.exe', 'Obsidian.exe', 'Spotify.exe', 'clash-verge.exe']
  },
  {
    id: 'jetbrains-cache',
    title: 'JetBrains IDE 可重建缓存',
    category: '开发工具',
    roots: jetbrainsCacheRoots,
    pattern: /.*/,
    risk: 'low',
    reason: '扫描 JetBrains IDE 各版本的索引缓存和临时目录，后续启动时会重新生成。',
    safetyNote: '不处理项目、配置、插件、Local History 或 Maven/Gradle 仓库；IDE 运行时禁止执行。',
    minimumAgeDays: 14,
    selectable: true,
    processNames: ['idea64.exe', 'webstorm64.exe', 'pycharm64.exe', 'rider64.exe']
  },
  {
    id: 'windows-minidumps',
    title: 'Windows 小型内存转储',
    category: '诊断',
    roots: [path.join(windows, 'Minidump')],
    pattern: /\.dmp$/i,
    risk: 'low',
    reason: '识别系统蓝屏小型转储；最近 14 天的内容保留用于故障诊断。',
    safetyNote: '如果仍在排查蓝屏问题应保留；无权限文件会跳过，不会自动提权。',
    minimumAgeDays: 14,
    selectable: true,
    requiresAdmin: true
  },
  {
    id: 'npm-cache',
    title: 'npm 下载缓存',
    category: '开发工具',
    roots: [path.join(local, 'npm-cache')],
    pattern: /.*/,
    risk: 'low',
    reason: '识别 npm 下载缓存；最近 14 天的内容保留，其余可在需要时重新下载。',
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
    reason: '识别 Python pip 下载与 wheel 缓存；最近 14 天的内容保留，其余可重新下载。',
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
    reason: '识别 NuGet HTTP 与插件下载缓存；最近 14 天的内容保留，其余可由 NuGet 重新获取。',
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
  maximumAgeDays: rule.maximumAgeDays == null ? null : Math.max(0, Number(rule.maximumAgeDays)),
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

async function resolvedRoots(rule) {
  const values = await (typeof rule.roots === 'function' ? rule.roots() : rule.roots)
  return [...new Set((values || []).map(value => path.resolve(String(value))))]
}

async function runningExecutableNames() {
  if (process.platform !== 'win32') return new Set()
  try {
    const { stdout } = await execFileAsync(tasklist, ['/FO', 'CSV', '/NH'], {
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
    maximumAgeDays: rule.maximumAgeDays,
    processNames: [...rule.processNames],
    summaryOnly: typeof rule.probe === 'function'
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
  const skipped = { recent: 0, older: 0, links: 0, inaccessible: 0, outsideRoot: 0, unsupported: 0, excluded: 0 }
  const observed = { items: 0, bytes: 0 }
  const retained = { recentItems: 0, recentBytes: 0, olderItems: 0, olderBytes: 0 }
  let visited = 0
  let truncated = false
  let limitReason = null

  for (const rootPath of await resolvedRoots(rule)) {
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
    } catch {
      skipped.inaccessible++
      continue
    }

    let handle
    try {
      handle = await fsp.opendir(current.dir)
      for await (const entry of handle) {
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
          if (rule.minimumAgeDays > 0 && stat.mtimeMs > minimumModifiedAt) {
            skipped.recent++
            if (rule.selectable) {
              observed.items++
              observed.bytes += stat.size
              retained.recentItems++
              retained.recentBytes += stat.size
            }
            continue
          }
          if (rule.maximumAgeDays != null && stat.mtimeMs <= now - rule.maximumAgeDays * DAY_MS) {
            skipped.older++
            if (rule.selectable) {
              observed.items++
              observed.bytes += stat.size
              retained.olderItems++
              retained.olderBytes += stat.size
            }
            continue
          }
          const canonicalPath = await fsp.realpath(filePath)
          if (!isWithinRoot(canonicalPath, current.canonicalRoot)) {
            skipped.outsideRoot++
            continue
          }
          observed.items++
          observed.bytes += stat.size
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
            maximumAgeDays: rule.maximumAgeDays,
            processNames: [...rule.processNames]
          })
        } catch {
          skipped.inaccessible++
        }
        if (visited % 200 === 0) {
          onProgress?.({ ruleId: rule.id, visited, found: observed.items, candidates: files.length, current: current.dir })
          await new Promise(resolve => setImmediate(resolve))
        }
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      skipped.inaccessible++
    } finally {
      try { await handle?.close() } catch { /* iterator already closed the handle */ }
    }
  }

  return { files, observed, retained, visited, skipped, truncated, limitReason, durationMs: Date.now() - startedAt }
}

function resultFor(rule, scan, guard) {
  const selectable = Boolean(rule.selectable && guard.blocked.length === 0 && !guard.checkFailed)
  const candidateItemCount = rule.selectable ? scan.files.length : 0
  const candidateTotal = rule.selectable ? scan.files.reduce((sum, item) => sum + item.size, 0) : 0
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
    itemCount: scan.observed.items,
    total: scan.observed.bytes,
    candidateItemCount,
    candidateTotal,
    retained: scan.retained,
    volumeBreakdown: [],
    summaryOnly: false,
    truncated: scan.truncated,
    limitReason: scan.limitReason,
    durationMs: scan.durationMs,
    visited: scan.visited,
    skipped: scan.skipped,
    scannedAt: Date.now()
  }
}

async function scanSummaryRule(rule, options = {}) {
  const startedAt = Date.now()
  if (options.signal?.aborted) throw abortError()
  try {
    const result = await rule.probe(options)
    if (options.signal?.aborted) throw abortError()
    return {
      ...publicRule(rule),
      selectable: false,
      configuredSelectable: false,
      blockedProcesses: [],
      processCheckFailed: false,
      blockedReason: null,
      files: [],
      itemCount: Math.max(0, Number(result.items || 0)),
      total: Math.max(0, Number(result.bytes || 0)),
      candidateItemCount: 0,
      candidateTotal: 0,
      retained: { recentItems: 0, recentBytes: 0, olderItems: 0, olderBytes: 0 },
      volumeBreakdown: Array.isArray(result.volumes) ? result.volumes : [],
      summaryOnly: true,
      truncated: false,
      limitReason: null,
      durationMs: Date.now() - startedAt,
      visited: Math.max(0, Number(result.items || 0)),
      skipped: { recent: 0, older: 0, links: 0, inaccessible: 0, outsideRoot: 0, unsupported: 0, excluded: 0 },
      scannedAt: Date.now()
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    return {
      ...publicRule(rule),
      selectable: false,
      configuredSelectable: false,
      blockedProcesses: [],
      processCheckFailed: false,
      blockedReason: `无法读取系统汇总：${error?.message || '未知错误'}`,
      files: [],
      itemCount: 0,
      total: 0,
      candidateItemCount: 0,
      candidateTotal: 0,
      retained: { recentItems: 0, recentBytes: 0, olderItems: 0, olderBytes: 0 },
      volumeBreakdown: [],
      summaryOnly: true,
      truncated: false,
      limitReason: null,
      durationMs: Date.now() - startedAt,
      visited: 0,
      skipped: { recent: 0, older: 0, links: 0, inaccessible: 1, outsideRoot: 0, unsupported: 0, excluded: 0 },
      scannedAt: Date.now()
    }
  }
}

async function scanRuleAsync(id, options = {}) {
  const rule = rules.find(item => item.id === id)
  if (!rule) throw new Error('rule-not-found')
  if (typeof rule.probe === 'function') return scanSummaryRule(rule, options)
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
    if (Number(candidate.minimumAgeDays || 0) > 0 && stat.mtimeMs > now - Number(candidate.minimumAgeDays) * DAY_MS) {
      return { ok: false, reason: '文件不再满足最短保留时间，已阻止处理' }
    }
    return { ok: true, canonicalPath, stat }
  } catch (error) {
    return { ok: false, reason: error?.code === 'ENOENT' ? '文件已经不存在' : '无法重新验证文件状态，已阻止处理' }
  }
}

module.exports = {
  rules,
  publicRule,
  scanRuleAsync,
  scanSummaryRule,
  collectRuleFiles,
  parseRecycleBinOutput,
  queryRecycleBin,
  validateCandidate,
  runningExecutableNames,
  processGuard,
  resultFor,
  browserCacheRoots,
  electronCacheRoots,
  findNamedCacheRoots,
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
