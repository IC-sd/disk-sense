const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const POINTER_FILE = 'data-location.json'
const DATA_DIRECTORY_NAME = 'Disk Sense Data'
const OWNED_DATA_FILES = [
  'disk-sense-state.json',
  'disk-sense-state.json.bak',
  'disk-sense-state.json.changes.json',
  'disk-sense-state.json.changes.json.bak',
  'disk-sense-search.sqlite',
  'disk-sense-search.sqlite-wal',
  'disk-sense-search.sqlite-shm',
  'disk-sense.log'
]

function normalizeTheme(value) {
  return value === 'light' ? 'light' : 'dark'
}

function isSamePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function readPointer(pointerFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(pointerFile, 'utf8'))
    if (parsed?.version !== 1 || typeof parsed.path !== 'string' || !path.isAbsolute(parsed.path)) return null
    const resolved = path.resolve(parsed.path)
    if (path.parse(resolved).root === resolved) return null
    return resolved
  } catch {
    return null
  }
}

function replaceFileFromSource(source, target) {
  const temporary = `${target}.handoff`
  fs.copyFileSync(source, temporary)
  const [sourceStat, targetStat] = [fs.statSync(source), fs.statSync(temporary)]
  if (sourceStat.size !== targetStat.size) {
    fs.rmSync(temporary, { force: true })
    throw new Error(`迁移交接校验失败：${path.basename(source)}`)
  }
  if (target.endsWith('.json')) JSON.parse(fs.readFileSync(temporary, 'utf8'))
  fs.renameSync(temporary, target)
}

function finalizePendingMigration(target) {
  const markerFile = path.join(target, 'migration.json')
  let marker
  try {
    marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
  } catch {
    return { finalized: false }
  }
  if (marker?.version !== 1 || marker.finalizedAt || typeof marker.source !== 'string') {
    return { finalized: Boolean(marker?.finalizedAt) }
  }
  const source = path.resolve(marker.source)
  if (!fs.existsSync(source) || isSamePath(source, target)) return { finalized: false }
  const synchronized = []
  try {
    for (const name of OWNED_DATA_FILES) {
      const from = path.join(source, name)
      if (!fs.existsSync(from)) continue
      replaceFileFromSource(from, path.join(target, name))
      synchronized.push(name)
    }
    const completed = {
      ...marker,
      synchronized,
      finalizedAt: new Date().toISOString()
    }
    const temporary = `${markerFile}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(completed, null, 2), 'utf8')
    fs.renameSync(temporary, markerFile)
    return { finalized: true, synchronized }
  } catch (error) {
    return {
      finalized: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function resolveDataLocation({ appDataPath, environment = process.env }) {
  if (environment.DISK_SENSE_USER_DATA) {
    const userDataPath = path.resolve(environment.DISK_SENSE_USER_DATA)
    return {
      defaultUserDataPath: userDataPath,
      userDataPath,
      pointerFile: null,
      externallyManaged: true
    }
  }
  const defaultUserDataPath = path.join(appDataPath, 'Disk Sense')
  const pointerFile = path.join(defaultUserDataPath, POINTER_FILE)
  const pointedPath = readPointer(pointerFile)
  if (pointedPath) finalizePendingMigration(pointedPath)
  return {
    defaultUserDataPath,
    userDataPath: pointedPath || defaultUserDataPath,
    pointerFile,
    externallyManaged: false
  }
}

async function directoryUsage(root, maximumEntries = 30_000) {
  let bytes = 0
  let files = 0
  let directories = 0
  let inaccessible = 0
  let truncated = false
  const queue = [path.resolve(root)]
  let queueIndex = 0
  let visited = 0

  while (queueIndex < queue.length && visited < maximumEntries) {
    const current = queue[queueIndex++]
    let entries
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true })
    } catch {
      inaccessible++
      continue
    }
    directories++
    for (let offset = 0; offset < entries.length && visited < maximumEntries; offset += 48) {
      const remaining = maximumEntries - visited
      const chunk = entries.slice(offset, offset + Math.min(48, remaining))
      visited += chunk.length
      const regularFiles = []
      for (const entry of chunk) {
        const target = path.join(current, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) queue.push(target)
        else if (entry.isFile()) regularFiles.push(target)
      }
      files += regularFiles.length
      const sizes = await Promise.all(regularFiles.map(async target => {
        try {
          return Number((await fs.promises.stat(target)).size || 0)
        } catch {
          inaccessible++
          return 0
        }
      }))
      bytes += sizes.reduce((sum, size) => sum + size, 0)
      await new Promise(resolve => setImmediate(resolve))
    }
    if (visited >= maximumEntries && entries.length) truncated = true
  }
  if (queueIndex < queue.length) truncated = true
  return { bytes, files, directories, inaccessible, truncated }
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(file)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

async function verifyCopiedFile(source, target) {
  const [sourceStat, targetStat] = await Promise.all([fs.promises.stat(source), fs.promises.stat(target)])
  if (sourceStat.size !== targetStat.size) throw new Error(`复制校验失败：${path.basename(source)}`)
  const [sourceHash, targetHash] = await Promise.all([hashFile(source), hashFile(target)])
  if (sourceHash !== targetHash) throw new Error(`复制校验失败：${path.basename(source)}`)
  if (target.endsWith('.json')) JSON.parse(await fs.promises.readFile(target, 'utf8'))
}

function migrationTarget(selectedDirectory) {
  const resolved = path.resolve(selectedDirectory)
  if (!path.isAbsolute(resolved) || path.parse(resolved).root === resolved || resolved.startsWith('\\\\')) {
    throw new Error('请选择磁盘中的文件夹，不要直接使用磁盘根目录。')
  }
  return path.basename(resolved).toLowerCase() === DATA_DIRECTORY_NAME.toLowerCase()
    ? resolved
    : path.join(resolved, DATA_DIRECTORY_NAME)
}

async function assertWritable(directory) {
  await fs.promises.mkdir(directory, { recursive: true })
  const probe = path.join(directory, `.disk-sense-write-${process.pid}-${Date.now()}`)
  await fs.promises.writeFile(probe, 'ok', { flag: 'wx' })
  await fs.promises.unlink(probe)
}

async function writePointer(pointerFile, target) {
  await fs.promises.mkdir(path.dirname(pointerFile), { recursive: true })
  const temporary = `${pointerFile}.tmp`
  await fs.promises.writeFile(temporary, JSON.stringify({
    version: 1,
    path: target,
    updatedAt: new Date().toISOString()
  }, null, 2), 'utf8')
  await fs.promises.rename(temporary, pointerFile)
}

async function migrateDataDirectory({ source, selectedDirectory, pointerFile, forbiddenPaths = [] }) {
  if (!pointerFile) throw new Error('当前数据目录由测试或外部环境管理，不能在应用内迁移。')
  const sourcePath = path.resolve(source)
  const targetPath = migrationTarget(selectedDirectory)
  if (isSamePath(sourcePath, targetPath)) return { changed: false, source: sourcePath, target: targetPath }
  if (isInside(sourcePath, targetPath) || isInside(targetPath, sourcePath)) {
    throw new Error('新旧数据目录不能互相包含，请选择另一个独立文件夹。')
  }
  for (const forbidden of forbiddenPaths.filter(Boolean)) {
    if (isSamePath(forbidden, targetPath) || isInside(forbidden, targetPath)) {
      throw new Error('数据目录不能放在程序安装目录内，否则卸载或升级时可能丢失。')
    }
  }

  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true })
  if (fs.existsSync(targetPath)) {
    const existing = await fs.promises.readdir(targetPath)
    if (existing.length) throw new Error('目标数据目录已包含文件，请选择一个空文件夹。')
  }
  await assertWritable(targetPath)
  const sources = OWNED_DATA_FILES
    .map(name => ({ name, file: path.join(sourcePath, name) }))
    .filter(item => fs.existsSync(item.file))
  const requiredBytes = sources.reduce((sum, item) => sum + Number(fs.statSync(item.file).size || 0), 0)
  try {
    const stat = await fs.promises.statfs(targetPath, { bigint: true })
    const availableBytes = Number(stat.bavail * stat.bsize)
    if (Number.isFinite(availableBytes) && availableBytes < requiredBytes + 32 * 1024 * 1024) {
      throw new Error('目标磁盘可用空间不足，无法安全复制并校验数据。')
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('可用空间不足')) throw error
    // A few virtual filesystems do not expose statfs; writability is still checked.
  }

  let copiedBytes = 0
  const copiedFiles = []
  try {
    for (const { name, file: from } of sources) {
      const to = path.join(targetPath, name)
      await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL)
      await verifyCopiedFile(from, to)
      copiedBytes += Number((await fs.promises.stat(to)).size || 0)
      copiedFiles.push(name)
    }
    await fs.promises.writeFile(path.join(targetPath, 'migration.json'), JSON.stringify({
      version: 1,
      source: sourcePath,
      copiedFiles,
      copiedBytes,
      migratedAt: new Date().toISOString()
    }, null, 2), 'utf8')
    await writePointer(pointerFile, targetPath)
  } catch (error) {
    await fs.promises.rm(targetPath, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  return {
    changed: true,
    source: sourcePath,
    target: targetPath,
    copiedFiles,
    copiedBytes,
    restartRequired: true,
    sourceRetained: true
  }
}

module.exports = {
  normalizeTheme,
  resolveDataLocation,
  directoryUsage,
  migrationTarget,
  migrateDataDirectory,
  finalizePendingMigration
}
