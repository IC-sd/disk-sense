const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

// Read only the requested configuration key; credentials and other keys never leave this module.
function setting(file, key, section = '', onWarning = () => {}) {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) { onWarning('工具配置不是普通文件、指向链接或超过读取预算；未确认其中的缓存位置。'); return null }
    let active = ''
    let found = null
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/u)) {
      const line = raw.trim()
      if (!line || line.startsWith('#') || line.startsWith(';')) continue
      if (line.startsWith('[') && line.endsWith(']')) { active = line.slice(1, -1).toLowerCase(); continue }
      const split = line.indexOf('=')
      if (split < 0 || line.slice(0, split).trim().toLowerCase() !== key || (section && active !== section)) continue
      found = line.slice(split + 1).trim().replace(/^['"]|['"]$/gu, '')
      if (!found) onWarning('工具缓存配置为空；默认位置仍需工具确认。')
    }
    return found
  } catch (error) { if (error?.code !== 'ENOENT') onWarning('工具配置无法读取；默认位置仍需工具确认。'); return null }
}

function absoluteConfigured(value, environment, home) {
  if (!value) return null
  let missing = false
  const expanded = String(value).replace(/\$\{([^}]+)\}|%([^%]+)%/gu, (_, a, b) => {
    const result = environment[a || b]
    if (result == null) missing = true
    return result || ''
  })
    .replace(/^~(?=[\\/])/u, home)
  if (missing || !path.isAbsolute(expanded) || expanded.includes('\0')) return null
  const resolved = path.resolve(expanded)
  const broad = [home, environment.LOCALAPPDATA, environment.APPDATA, environment.PROGRAMDATA, environment.WINDIR, path.join(home, 'AppData')].filter(Boolean)
  return resolved === path.parse(resolved).root || broad.some(root => path.resolve(root).toLowerCase() === resolved.toLowerCase()) ? null : resolved
}

function packageLocations(options = {}) {
  const environment = options.environment || process.env
  const home = options.home || os.homedir()
  const local = options.local || environment.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  const roaming = options.roaming || environment.APPDATA || path.join(home, 'AppData', 'Roaming')
  const warningsById = new Map()
  const read = (id, file, key, section = '') => setting(file, key, section, message => {
    const warnings = warningsById.get(id) || []
    if (!warnings.includes(message)) warnings.push(message)
    warningsById.set(id, warnings)
  })
  const config = (value, fallback, source) => {
    const configured = absoluteConfigured(value, environment, home)
    return { path: configured || fallback, source: configured ? source : value ? '配置路径无法安全解析；仅观察默认位置' : '工具默认位置（未运行工具确认）', configured: Boolean(configured) }
  }
  const npmEnv = environment.npm_config_cache || environment.NPM_CONFIG_CACHE
  const npmFile = environment.NPM_CONFIG_USERCONFIG || environment.npm_config_userconfig || path.join(home, '.npmrc')
  let nodeDirectory = options.nodeDirectory
  if (!nodeDirectory) {
    const executable = process.platform === 'win32' ? 'node.exe' : 'node'
    const paths = String(environment.PATH || environment.Path || '').split(path.delimiter).filter(Boolean).slice(0, 64)
    nodeDirectory = paths.find(directory => { try { return fs.statSync(path.join(directory, executable)).isFile() } catch { return false } })
  }
  const prefix = absoluteConfigured(environment.npm_config_prefix || environment.NPM_CONFIG_PREFIX || read('npm', npmFile, 'prefix'), environment, home)
  const globalFile = environment.NPM_CONFIG_GLOBALCONFIG || environment.npm_config_globalconfig || (prefix || nodeDirectory ? path.join(prefix || nodeDirectory, 'etc', 'npmrc') : null)
  const userCache = read('npm', npmFile, 'cache'), globalCache = globalFile ? read('npm', globalFile, 'cache') : null
  const npm = config(npmEnv || userCache || globalCache, path.join(local, 'npm-cache'), npmEnv ? 'npm 缓存环境变量' : userCache ? 'npm 用户配置' : 'npm 全局配置')
  const pipFiles = [environment.PROGRAMDATA ? path.join(environment.PROGRAMDATA, 'pip', 'pip.ini') : null, path.join(home, 'pip', 'pip.ini'), path.join(roaming, 'pip', 'pip.ini'), environment.VIRTUAL_ENV ? path.join(environment.VIRTUAL_ENV, 'pip.ini') : null, environment.PIP_CONFIG_FILE].filter(Boolean)
  let pipValue = null
  for (const file of pipFiles) pipValue = read('pip', file, 'cache-dir', 'global') || pipValue
  const pip = config(environment.PIP_CACHE_DIR || pipValue, path.join(local, 'pip', 'Cache'), environment.PIP_CACHE_DIR ? 'PIP_CACHE_DIR' : 'pip 用户配置')
  const uv = config(environment.UV_CACHE_DIR, path.join(local, 'uv', 'cache'), 'UV_CACHE_DIR')
  const pnpmFile = path.join(local, 'pnpm', 'config', 'rc')
  const pnpm = config(environment.npm_config_store_dir || environment.NPM_CONFIG_STORE_DIR || read('pnpm', pnpmFile, 'store-dir') || read('pnpm', npmFile, 'store-dir'), path.join(local, 'pnpm', 'store'), 'pnpm 用户配置或存储环境变量')
  const definitions = [
    ['npm', npm, path.join(local, 'npm-cache')],
    ['pip', pip, path.join(local, 'pip', 'Cache')],
    ['uv', uv, path.join(local, 'uv', 'cache')],
    ['pnpm', pnpm, path.join(local, 'pnpm', 'store')],
    ['NuGet', config(environment.NUGET_HTTP_CACHE_PATH, path.join(local, 'NuGet', 'v3-cache'), 'NUGET_HTTP_CACHE_PATH'), path.join(local, 'NuGet', 'v3-cache')]
  ]
  return definitions.map(([id, location, defaultPath]) => ({
    id, ...location, defaultPath, warnings: warningsById.get(id) || [],
    locations: [
      { ...location, role: 'current-or-default' },
      ...(path.resolve(location.path).toLowerCase() !== path.resolve(defaultPath).toLowerCase()
        ? [{ path: defaultPath, source: '旧默认位置候选；未证明已废弃', configured: false, role: 'legacy-candidate' }] : [])
    ]
  }))
}

const toolProviders = {
  npm: { executable: 'npm', versionArgs: ['--version'], locationArgs: ['config', 'get', 'cache'], minimum: [6, 0], previewArgs: ['cache', 'verify'],
    impact: '校验 npm 缓存并回收无用数据；共享缓存可能被多个项目使用，后续安装可能需要重新下载。' },
  pip: { executable: 'pip', versionArgs: ['--version'], locationArgs: ['cache', 'dir'], minimum: [20, 1], previewArgs: ['cache', 'purge'],
    impact: '清除 pip 的 HTTP 和 wheel 缓存；其他 Python 环境也可能共享，后续安装可能重新下载或构建。' },
  uv: { executable: 'uv', versionArgs: ['--version'], locationArgs: ['cache', 'dir'], minimum: [0, 4], previewArgs: ['cache', 'prune'],
    impact: '由 uv 识别缓存引用并处理旧条目；可能移除集中管理的项目环境，后续运行由工具重建。不要直接删除存储目录。' },
  pnpm: { executable: 'pnpm', versionArgs: ['--version'], locationArgs: ['store', 'path'], minimum: [6, 0], previewArgs: ['store', 'prune'],
    impact: '由 pnpm 管理内容寻址共享存储；保留项目文件，未来切换依赖版本时可能重新下载。' },
  NuGet: { executable: 'dotnet', versionArgs: ['--version'], locationArgs: ['nuget', 'locals', 'http-cache', '--list'], minimum: [6, 0], previewArgs: ['nuget', 'locals', 'http-cache', '--clear'],
    impact: '仅预览 NuGet HTTP 缓存管理；不清除 global-packages 中的包，也不影响项目源文件。' }
}

function parseVersion(output) {
  const m = String(output || '').trim().match(/^(?:(?:pip|uv)\s+)?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+][\w.-]+)?(?:\s|$)/u)
  return m ? { text: `${m[1]}.${m[2]}${m[3] == null ? '' : `.${m[3]}`}`, major: Number(m[1]), minor: Number(m[2]) } : null
}

function findToolExecutable(name, options = {}) {
  const platform = options.platform || process.platform, environment = options.environment || process.env
  const separators = platform === 'win32' ? ';' : path.delimiter
  for (const directory of String(environment.PATH || environment.Path || '').split(separators).slice(0, 64)) {
    // Do not search the current directory or relative PATH entries.
    if (!directory || !path.isAbsolute(directory)) continue
    for (const extension of platform === 'win32' ? ['.exe', '.cmd', '.bat'] : ['']) {
      const executable = path.join(directory, `${name}${extension}`)
      try {
        const stat = fs.lstatSync(executable)
        if (stat.isFile() && !stat.isSymbolicLink()) {
          if (platform !== 'win32' || extension === '.exe') return { path: executable, queryable: true, prefixArgs: [] }
          // npm/pnpm installations ship JS CLIs next to node.exe. Invoke these directly;
          // do not interpret a cmd shim or execute Corepack's package download launcher.
          if (name === 'npm' || name === 'pnpm') {
            const node = path.join(directory, 'node.exe')
            const files = name === 'npm' ? ['node_modules/npm/bin/npm-cli.js'] : ['node_modules/pnpm/bin/pnpm.cjs', 'node_modules/pnpm/bin/pnpm.js']
            for (const file of files) {
              const cli = path.join(directory, file)
              try { if (fs.lstatSync(node).isFile() && fs.lstatSync(cli).isFile()) return { path: node, queryable: true, prefixArgs: [cli], shimPath: executable } } catch {}
            }
          }
          return { path: executable, queryable: false, prefixArgs: [] }
        }
      } catch { /* Missing executable. */ }
    }
  }
  return null
}

async function runToolQuery(executable, args, options) {
  return promisify(execFile)(executable, args, {
    windowsHide: true, shell: false, timeout: 2500, maxBuffer: 32768, encoding: 'utf8', cwd: options.home,
    env: { ...options.environment, COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_PROJECT_SPEC: '0',
      NO_UPDATE_NOTIFIER: '1', npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false',
      PIP_DISABLE_PIP_VERSION_CHECK: '1', UV_OFFLINE: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' }
  })
}

async function inspectToolCaches(options = {}) {
  const environment = options.environment || process.env, home = options.home || os.homedir()
  const runQuery = options.runQuery || runToolQuery
  const locations = packageLocations({ ...options, environment, home })
  // Bounded provider count and sequential execution avoid spawning a burst of tools.
  const result = []
  for (const location of locations) {
    const definition = toolProviders[location.id], executable = findToolExecutable(definition.executable, { ...options, environment })
    const tool = { ...location, checkedAt: new Date().toISOString(), executablePath: executable?.path || null,
      version: null, status: !executable ? 'not-found' : !executable.queryable ? 'shim-unqueried' : 'query-disabled',
      effectivePath: null, warnings: [...location.warnings], shared: true, automaticExecution: false,
      nativePreview: { command: definition.executable, args: [...definition.previewArgs], previewOnly: true, available: false,
        impact: definition.impact, scope: 'user-cache' } }
    if (location.source.startsWith('配置路径无法')) tool.warnings.push('缓存配置无法安全解析，默认路径尚未由工具确认。')
    if (tool.status === 'shim-unqueried') tool.warnings.push('检测到命令脚本或 Corepack shim；未通过 shell 运行，也未触发下载，实际工具版本和位置尚未确认。')
    if (executable?.queryable && options.queryCommands === true) {
      try {
        const versionResult = await runQuery(executable.path, [...executable.prefixArgs, ...definition.versionArgs], { environment, home, purpose: 'version' })
        const version = parseVersion(versionResult.stdout)
        if (!version) throw new Error('unrecognized-version')
        tool.version = version.text
        if (version.major < definition.minimum[0] || (version.major === definition.minimum[0] && version.minor < definition.minimum[1])) {
          tool.status = 'unsupported-version'; tool.warnings.push('此版本的缓存命令未在支持范围内，未查询或推荐执行维护。')
        } else {
          const response = await runQuery(executable.path, [...executable.prefixArgs, ...definition.locationArgs], { environment, home, purpose: 'cache-location' })
          const lines = String(response.stdout || '').trim().split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
          const value = location.id === 'NuGet' && lines.length === 1 ? lines[0].replace(/^http-cache:\s*/iu, '') : lines.length === 1 ? lines[0] : null
          const resolved = absoluteConfigured(value, environment, home)
          if (!resolved) throw new Error('unrecognized-cache-path')
          tool.status = 'confirmed'; tool.effectivePath = resolved
          tool.nativePreview.available = true
          if (path.resolve(location.path).toLowerCase() !== resolved.toLowerCase()) tool.warnings.push('工具返回的位置与配置推导不同；以本次工具查询为准，原位置保留为未确认候选。')
          tool.locations = [{ path: resolved, source: '工具只读查询确认（用户主目录上下文）', configured: true, role: 'confirmed-current' },
            ...location.locations.filter(item => path.resolve(item.path).toLowerCase() !== resolved.toLowerCase())]
        }
      } catch {
        tool.status = 'query-failed'
        // Never echo CLI stderr or the full command environment: it may include secrets.
        tool.warnings.push('工具只读查询失败、超时或返回无法确认的路径；未执行缓存清理。')
      }
    }
    result.push(tool)
  }
  return { generatedAt: new Date().toISOString(), context: 'user-home', tools: result, previewOnly: true }
}

module.exports = { packageLocations, setting, absoluteConfigured, inspectToolCaches, toolProviders, parseVersion, findToolExecutable }
