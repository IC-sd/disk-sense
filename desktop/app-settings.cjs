const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { atomicWriteJson } = require('./atomic-file.cjs')

const POINTER_FILE = 'data-location.json'
const DATA_DIRECTORY_NAME = 'Disk Sense Data'
const OWNED_DATA_FILES = [
  'disk-sense-state.json',
  'disk-sense-state.json.bak',
  'disk-sense-state.json.changes.json',
  'disk-sense-state.json.changes.json.bak',
  'disk-sense-state.json.operations.json',
  'disk-sense-state.json.operations.json.bak',
  'disk-sense-state.json.analyses.json',
  'disk-sense-state.json.analyses.json.bak',
  'disk-sense-search.sqlite',
  'disk-sense-search.sqlite-wal',
  'disk-sense-search.sqlite-shm',
  'disk-sense-operations.sqlite',
  'disk-sense-operations.sqlite-wal',
  'disk-sense-operations.sqlite-shm',
  'disk-sense.log'
]

function ownedDataFiles(root) {
  const files = [...OWNED_DATA_FILES]
  // Preserve legacy journals during migration even though isolation is no longer offered.
  const directory = path.join(root, 'cleanup-quarantine')
  if (!fs.existsSync(directory)) return files
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !isSamePath(fs.realpathSync(directory), directory)) throw new Error('隔离恢复记录目录指向异常，停止数据迁移')
  const entries = fs.readdirSync(directory, { withFileTypes: true })
  if (entries.length > 10000) throw new Error('隔离恢复记录超过安全迁移上限，请先整理')
  for (const entry of entries) {
    if (!/^[a-f0-9-]{36}\.jsonl$/u.test(entry.name)) continue
    const file = path.join(directory, entry.name), fileStat = fs.lstatSync(file)
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink > 1 || fileStat.size > 64 * 1024 * 1024) throw new Error('隔离恢复记录文件异常，停止数据迁移')
    files.push(path.join('cleanup-quarantine', entry.name))
  }
  return files
}

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
  const temporary = `${target}.${crypto.randomUUID()}.handoff`
  try {
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL)
    const [sourceStat, targetStat] = [fs.statSync(source), fs.statSync(temporary)]
    if (sourceStat.size !== targetStat.size) throw new Error(`迁移交接校验失败：${path.basename(source)}`)
    if (target.endsWith('.json')) JSON.parse(fs.readFileSync(temporary, 'utf8'))
    const descriptor = fs.openSync(temporary, 'r+')
    try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
    fs.renameSync(temporary, target)
  } finally {
    try { fs.rmSync(temporary, { force: true }) } catch { /* Preserve the primary failure; retry replaces this app-owned staging file. */ }
  }
}

function finalizePendingMigration(target) {
  const markerFile = path.join(target, 'migration.json')
  let marker
  try {
    marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
  } catch (error) {
    // Pre-migration data directories may have no marker. An unreadable or
    // malformed marker cannot establish that a previous handoff completed.
    return error.code === 'ENOENT' ? { finalized: false }
      : { finalized: false, pending: true, error: error.message }
  }
  if (marker?.version !== 1 || typeof marker.source !== 'string' || !path.isAbsolute(marker.source)) {
    return { finalized: false, pending: true, error: '数据迁移记录无效，无法确认交接状态' }
  }
  if (marker.finalizedAt) return { finalized: true }
  const source = path.resolve(marker.source)
  if (!isUsableDataDirectory(source) || isSamePath(source, target)) {
    return { finalized: false, pending: true, source, error: '数据迁移的原目录不可用，无法完成交接' }
  }
  const synchronized = []
  try {
    for (const name of ownedDataFiles(source)) {
      const from = path.join(source, name)
      if (!fs.existsSync(from)) continue
      if (name.startsWith('cleanup-quarantine' + path.sep)) {
        const directory = path.join(target, 'cleanup-quarantine')
        fs.mkdirSync(directory, { recursive: true })
        if (fs.lstatSync(directory).isSymbolicLink() || !isSamePath(fs.realpathSync(directory), directory)) throw new Error('隔离恢复记录目标指向异常')
      }
      replaceFileFromSource(from, path.join(target, name))
      synchronized.push(name)
    }
    const completed = {
      ...marker,
      synchronized,
      finalizedAt: new Date().toISOString()
    }
    atomicWriteJson(markerFile, completed, { pretty: true })
    return { finalized: true, synchronized }
  } catch (error) {
    return {
      finalized: false,
      pending: true,
      source,
      code: error.code,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function isUsableDataDirectory(directory) {
  try {
    if (!fs.statSync(directory).isDirectory()) return false
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK)
    return true
  } catch { return false }
}

function migrationStartupError(message) {
  return Object.assign(new Error(`数据迁移尚未完成，已停止打开目标目录，原有文件未删除。${message}`), { code: 'DATA_MIGRATION_INCOMPLETE' })
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
  let userDataPath = pointedPath || defaultUserDataPath
  let migrationRecovery = null
  if (pointedPath) {
    if (!isUsableDataDirectory(pointedPath)) throw migrationStartupError('保存的数据目录当前不可访问，请恢复该位置后重试。')
    const handoff = finalizePendingMigration(pointedPath)
    if (handoff.pending && !handoff.finalized) {
      if (!handoff.source || isSamePath(handoff.source, pointedPath) || !isUsableDataDirectory(handoff.source)) {
        throw migrationStartupError(handoff.error || '无法访问原数据目录。')
      }
      userDataPath = handoff.source
      const reason = {
        ENOSPC: '目标磁盘的可用空间不足。',
        EACCES: '目标目录没有写入权限，或文件正被占用。',
        EPERM: '目标目录没有写入权限，或文件正被占用。',
        EBUSY: '目标文件正被占用。',
        EIO: '目标磁盘读写失败。'
      }[handoff.code] || '目标目录的数据交接未成功。'
      migrationRecovery = {
        source: handoff.source,
        target: pointedPath,
        message: `${reason}当前继续使用原数据目录，重新启动时会重试交接。`,
        detail: handoff.error
      }
    }
  }
  return {
    defaultUserDataPath,
    userDataPath,
    pointerFile,
    externallyManaged: false,
    migrationRecovery
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
  atomicWriteJson(pointerFile, {
    version: 1,
    path: target,
    updatedAt: new Date().toISOString()
  }, { pretty: true })
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
  const sources = ownedDataFiles(sourcePath)
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
      await fs.promises.mkdir(path.dirname(to), { recursive: true })
      await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL)
      await verifyCopiedFile(from, to)
      copiedBytes += Number((await fs.promises.stat(to)).size || 0)
      copiedFiles.push(name)
    }
    atomicWriteJson(path.join(targetPath, 'migration.json'), {
      version: 1,
      source: sourcePath,
      copiedFiles,
      copiedBytes,
      migratedAt: new Date().toISOString()
    }, { pretty: true })
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

async function coordinateDataMigration({ checkpoint, saveState, migrate, resume, onResumeError }) {
  let checkpointStarted = false
  let resumeAttempted = false
  try {
    checkpointStarted = true
    await checkpoint?.()
    await saveState?.()
    const result = await migrate()
    if (!result?.changed) {
      resumeAttempted = true
      await resume?.()
    }
    return result
  } catch (error) {
    if (checkpointStarted && !resumeAttempted) {
      resumeAttempted = true
      try {
        await resume?.()
      } catch (resumeError) {
        onResumeError?.(resumeError)
      }
    }
    throw error
  }
}

module.exports = {
  normalizeTheme,
  resolveDataLocation,
  directoryUsage,
  migrationTarget,
  migrateDataDirectory,
  coordinateDataMigration,
  finalizePendingMigration
}
