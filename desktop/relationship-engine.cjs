const path = require('node:path')
const fsp = require('node:fs/promises')
const os = require('node:os')
const { attribute } = require('./app-attribution.cjs')
const { matchInstalledApplication } = require('./windows-app-inventory.cjs')

const MAX_ANCESTORS = 8
const MAX_DIRECTORY_ENTRIES = 600
const GENERIC_OWNERS = new Set(['appdata', 'local', 'locallow', 'roaming', 'programdata', 'program files', 'program files (x86)', 'packages', 'applications', 'apps', 'common files', 'microsoft', 'google', 'tencent', 'alibaba'])

const PROJECT_CATALOGERS = [
  { id: 'node', label: 'Node.js 项目', primary: ['package.json'], support: ['src', 'node_modules', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'vite.config.ts', 'vite.config.js'] },
  { id: 'python', label: 'Python 项目', primary: ['pyproject.toml', 'setup.py', 'requirements.txt'], support: ['src', 'tests', '.venv', 'venv', '__pycache__', 'poetry.lock'] },
  { id: 'dotnet', label: '.NET 项目', primarySuffixes: ['.sln', '.csproj', '.fsproj'], support: ['src', 'tests', 'bin', 'obj', 'packages'] },
  { id: 'java', label: 'Java/Gradle 项目', primary: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'], support: ['src', 'target', 'build', '.gradle', 'gradlew'] },
  { id: 'rust', label: 'Rust 项目', primary: ['cargo.toml'], support: ['src', 'target', 'cargo.lock'] },
  { id: 'go', label: 'Go 项目', primary: ['go.mod'], support: ['cmd', 'internal', 'pkg', 'vendor', 'go.sum'] },
  { id: 'php', label: 'PHP/Composer 项目', primary: ['composer.json'], support: ['src', 'vendor', 'composer.lock'] },
  { id: 'unity', label: 'Unity 项目', primary: ['projectsettings'], support: ['assets', 'library', 'packages', 'temp', 'logs'] },
  { id: 'unreal', label: 'Unreal Engine 项目', primarySuffixes: ['.uproject'], support: ['content', 'config', 'source', 'saved', 'intermediate', 'deriveddatacache'] },
  { id: 'git', label: '软件或代码项目', primary: ['.git'], support: ['src', 'tests', 'readme.md', 'docs'] }
]

const ROLE_RULES = [
  { id: 'dependency', label: '项目依赖', risk: 'attention', names: ['node_modules', 'vendor', 'packages', '.venv', 'venv'] },
  { id: 'build-output', label: '构建产物', risk: 'attention', names: ['dist', 'build', 'out', 'target', 'bin', 'obj', 'intermediate'] },
  { id: 'cache', label: '可重建缓存', risk: 'low', names: ['cache', '.cache', 'code cache', 'gpucache', 'gpu cache', 'shadercache', 'grshadercache', '__pycache__', '.gradle', '.vite', '.turbo', '.parcel-cache', 'deriveddatacache'] },
  { id: 'log', label: '日志或诊断数据', risk: 'low', names: ['log', 'logs', 'crashpad', 'crashes', 'dumps', 'diagnostics'] },
  { id: 'temporary', label: '临时工作数据', risk: 'attention', names: ['temp', 'tmp', 'temporary', 'staging'] },
  { id: 'configuration', label: '配置与状态', risk: 'elevated', names: ['config', 'configuration', 'settings', 'preferences', 'user data', 'local state'] },
  { id: 'user-data', label: '用户或业务数据', risk: 'elevated', names: ['documents', 'profiles', 'profile', 'default', 'workspace', 'workspaces', 'databases', 'indexeddb', 'local storage'] },
  { id: 'source', label: '项目源代码', risk: 'elevated', names: ['src', 'source', 'assets', 'content', 'tests', 'docs'] },
  { id: 'runtime', label: '程序本体或运行组件', risk: 'elevated', names: ['resources', 'runtime', 'lib', 'libs', 'plugins', 'extensions'] }
]

function normalizedSegments(filePath) {
  return path.resolve(filePath).replaceAll('/', '\\').split('\\').filter(Boolean)
}

function roleForPath(filePath, rootPath = '') {
  const full = normalizedSegments(filePath)
  const root = rootPath ? normalizedSegments(rootPath) : []
  const relevant = full.slice(Math.min(root.length, full.length)).map(value => value.toLowerCase())
  const leaf = relevant[relevant.length - 1] || path.basename(filePath).toLowerCase()
  const matches = []
  for (const rule of ROLE_RULES) {
    for (const name of rule.names) {
      const index = relevant.lastIndexOf(name)
      const leafMatch = leaf === name || leaf.startsWith(`${name}.`)
      if (index >= 0 || leafMatch) matches.push({ rule, name, depth: leafMatch ? relevant.length : index })
    }
  }
  const selected = matches.sort((left, right) => right.depth - left.depth)[0]
  if (selected) return {
    id: selected.rule.id,
    label: selected.rule.label,
    risk: selected.rule.risk,
    evidence: `最接近当前对象的路径层级包含“${selected.name}”`
  }
  return { id: 'member', label: '组成内容', risk: 'unknown', evidence: '位于已识别实体的目录范围内' }
}

async function directoryNames(directory) {
  let handle
  try {
    handle = await fsp.opendir(directory)
    const names = []
    for await (const entry of handle) {
      names.push(entry.name)
      if (names.length >= MAX_DIRECTORY_ENTRIES) break
    }
    return names
  } catch {
    return []
  } finally {
    try { await handle?.close() } catch { /* iterator may already close the handle */ }
  }
}

function catalogDirectory(names) {
  const lowered = names.map(name => name.toLowerCase())
  for (const cataloger of PROJECT_CATALOGERS) {
    const primary = (cataloger.primary || []).filter(marker => lowered.includes(marker))
    const suffix = (cataloger.primarySuffixes || []).filter(marker => lowered.some(name => name.endsWith(marker)))
    const primaryMatches = [...primary, ...suffix]
    if (!primaryMatches.length) continue
    const support = cataloger.support.filter(marker => lowered.includes(marker))
    const confidence = Math.min(.98, .82 + Math.min(support.length, 4) * .035)
    return { ...cataloger, primaryMatches, supportMatches: support, confidence }
  }
  return null
}

async function projectName(rootPath, catalog) {
  if (catalog.id !== 'node') return path.basename(rootPath)
  let handle
  try {
    handle = await fsp.open(path.join(rootPath, 'package.json'), 'r')
    const buffer = Buffer.alloc(64 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const body = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
    return String(body?.productName || body?.name || path.basename(rootPath)).trim() || path.basename(rootPath)
  } catch {
    return path.basename(rootPath)
  } finally {
    try { await handle?.close() } catch { /* ignore close failures */ }
  }
}

async function findProjectContext(filePath, isDirectory = false) {
  let current = isDirectory ? path.resolve(filePath) : path.dirname(path.resolve(filePath))
  for (let depth = 0; depth <= MAX_ANCESTORS; depth += 1) {
    const names = await directoryNames(current)
    const catalog = catalogDirectory(names)
    if (catalog) {
      const name = await projectName(current, catalog)
      const role = roleForPath(filePath, current)
      return {
        entityType: 'project',
        entityId: `project:${catalog.id}:${current.toLowerCase()}`,
        entityName: name,
        entityKind: catalog.label,
        rootPath: current,
        role,
        confidence: catalog.confidence,
        evidence: [
          `项目根目录包含 ${catalog.primaryMatches.join('、')}`,
          ...(catalog.supportMatches.length ? [`同时发现 ${catalog.supportMatches.slice(0, 4).join('、')} 等结构标记`] : []),
          role.evidence
        ]
      }
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

function conventionalApplicationContext(filePath) {
  const resolved = path.resolve(filePath)
  const segments = normalizedSegments(resolved)
  const lowered = segments.map(value => value.toLowerCase())
  let rootIndex = -1
  for (const marker of ['appdata', 'programdata', 'program files', 'program files (x86)', 'apps', 'applications']) {
    const index = lowered.indexOf(marker)
    if (index >= 0) { rootIndex = index; break }
  }
  if (rootIndex < 0) return null
  let ownerIndex = rootIndex + 1
  if (lowered[rootIndex] === 'appdata' && ['local', 'locallow', 'roaming'].includes(lowered[ownerIndex])) ownerIndex += 1
  while (ownerIndex < segments.length && GENERIC_OWNERS.has(lowered[ownerIndex])) ownerIndex += 1
  const owner = segments[ownerIndex]
  if (!owner || owner.length < 2) return null
  const rootPath = segments.slice(0, ownerIndex + 1).join('\\')
  return {
    entityType: 'application',
    entityId: `application-folder:${owner.toLowerCase()}`,
    entityName: owner,
    entityKind: '应用足迹（根据标准目录推断）',
    rootPath,
    role: roleForPath(resolved, rootPath),
    confidence: .66,
    evidence: [`位于 Windows 约定的应用目录 ${segments[rootIndex]}`, `目录层级指向“${owner}”`]
  }
}

async function explainRelationship(filePath, options = {}) {
  const project = await findProjectContext(filePath, Boolean(options.isDirectory))
  if (project) return project
  const conventionalOwner = conventionalApplicationContext(filePath)
  const installedApplication = matchInstalledApplication(
    filePath,
    options.installedApplications,
    conventionalOwner?.entityName
  )
  if (installedApplication) {
    const { application, root, matchType, confidence } = installedApplication
    const role = roleForPath(filePath, root)
    const evidence = matchType === 'install-path'
      ? `路径位于 Windows 登记的安装目录 ${root}`
      : `目录名称与 Windows 已安装应用“${application.displayName}”一致`
    return {
      entityType: 'application',
      entityId: `installed-application:${application.registryKey.toLowerCase()}`,
      entityName: application.displayName,
      entityKind: 'Windows 已安装应用',
      rootPath: root || conventionalOwner?.rootPath || null,
      installLocation: application.installLocation || null,
      publisher: application.publisher || null,
      role,
      confidence,
      evidence: [
        evidence,
        ...(application.publisher ? [`发布者：${application.publisher}`] : []),
        role.evidence
      ]
    }
  }
  const knownOwner = attribute(filePath)
  if (knownOwner) {
    const role = roleForPath(filePath)
    return {
      entityType: 'application',
      entityId: `application:${knownOwner.id}`,
      entityName: knownOwner.name,
      entityKind: '已识别应用足迹',
      rootPath: null,
      role,
      confidence: .94,
      evidence: [knownOwner.evidence, role.evidence]
    }
  }
  return conventionalOwner
}

function relationshipNarrative(relationship) {
  if (!relationship) return null
  const root = relationship.rootPath ? `，其关联根目录是 ${relationship.rootPath}` : ''
  return `它被识别为“${relationship.entityName}”的${relationship.role.label}${root}。${relationship.evidence.join('；')}。`
}

async function findRelationshipLocations(relationship, currentPath, knownVolumes = []) {
  if (!relationship) return []
  const current = path.resolve(currentPath).toLowerCase()
  const candidates = []
  if (relationship.rootPath) candidates.push({ path: relationship.rootPath, reason: `${relationship.entityName} 的关联根目录` })
  if (relationship.installLocation) candidates.push({ path: relationship.installLocation, reason: `${relationship.entityName} 在 Windows 中登记的安装目录` })
  if (relationship.entityType === 'application' && relationship.entityName) {
    const home = os.homedir()
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    const programData = process.env.PROGRAMDATA || 'C:\\ProgramData'
    for (const [base, reason] of [
      [local, '当前用户的本地应用数据'],
      [roaming, '当前用户的漫游应用配置'],
      [programData, '跨用户共享的应用数据'],
      [path.join(home, 'Documents'), '用户文档中的应用数据']
    ]) candidates.push({ path: path.join(base, relationship.entityName), reason })
    for (const volume of knownVolumes) {
      for (const base of ['Program Files', 'Program Files (x86)', 'Apps', 'Applications']) {
        candidates.push({ path: path.join(volume, base, relationship.entityName), reason: `${relationship.entityName} 的可能安装位置` })
      }
    }
  }
  const seen = new Set()
  const checked = await Promise.all(candidates.map(async candidate => {
    const resolved = path.resolve(candidate.path)
    const key = resolved.toLowerCase()
    if (key === current || seen.has(key)) return null
    seen.add(key)
    try {
      await fsp.access(resolved)
      return { ...candidate, path: resolved, volume: path.parse(resolved).root }
    } catch {
      return null
    }
  }))
  return checked.filter(Boolean).slice(0, 16)
}

module.exports = {
  PROJECT_CATALOGERS,
  ROLE_RULES,
  catalogDirectory,
  roleForPath,
  findProjectContext,
  conventionalApplicationContext,
  explainRelationship,
  relationshipNarrative,
  findRelationshipLocations
}
