const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { execFile, spawn } = require('node:child_process')
const { promisify } = require('node:util')

const compiling = new Map()
async function compileSpaceHelper(directory) {
  const source = await fs.promises.readFile(path.join(__dirname, 'file-space-metadata.cs'))
  const digest = crypto.createHash('sha256').update(source).digest('hex').slice(0, 20)
  const executable = path.join(directory, `file-space-${digest}.exe`)
  if (!compiling.has(executable)) compiling.set(executable, (async () => {
    await fs.promises.mkdir(directory, { recursive: true })
    if (!fs.existsSync(executable)) {
      const file = path.join(directory, `file-space-${digest}.cs`)
      await fs.promises.writeFile(file, source)
      const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
      await promisify(execFile)(compiler, ['/nologo', '/optimize+', '/target:exe', '/r:System.Web.Extensions.dll', `/out:${executable}`, file], { windowsHide: true, timeout: 30000 })
    }
    return executable
  })().catch(error => { compiling.delete(executable); throw error }))
  return compiling.get(executable)
}

async function nativeMetadata(paths, options = {}) {
  if (process.platform !== 'win32') return Promise.all(paths.map(async file => {
    try {
      const s = await fs.promises.lstat(file)
      return { path: file, directory: s.isDirectory(), logicalBytes: s.size, allocatedBytes: s.isFile() ? s.blocks * 512 : null,
        identity: `${s.dev}:${s.ino}`, linkCount: s.nlink, skipped: s.isSymbolicLink() ? 'reparse-point' : undefined }
    } catch { return { path: file, errorCode: 'metadata-unavailable' } }
  }))
  const executable = await compileSpaceHelper(options.cacheDirectory || path.join(os.tmpdir(), 'disk-sense-file-space'))
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] })
    let output = '', settled = false
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value) }
    const timer = setTimeout(() => { child.kill(); finish(new Error('File space metadata timed out')) }, options.timeoutMs || 3000)
    child.once('error', finish)
    child.stdin.on('error', finish)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 1024 * 1024) { child.kill(); finish(new Error('File space metadata exceeded output budget')) } })
    child.once('close', code => {
      if (code !== 0) return finish(new Error('File space metadata unavailable'))
      try { const result = JSON.parse(output.replace(/^\uFEFF/u, '')); if (!Array.isArray(result) || result.length !== paths.length) throw new Error('Invalid metadata response'); finish(null, result) } catch (error) { finish(error) }
    })
    child.stdin.end(JSON.stringify(paths))
  })
}

function bounded(value, fallback, maximum) { return Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value))) : fallback }
function bytes(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null }

// On-demand estimate, deliberately independent from search indexing and cleanup eligibility.
async function inspectPathSpace(target, options = {}) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || target.includes('\0')) throw new Error('请输入完整的绝对路径')
  const root = path.resolve(target), start = Date.now()
  const maxEntries = bounded(options.maxEntries, 20000, 100000), maxDurationMs = bounded(options.maxDurationMs, 4000, 15000)
  const provider = options.metadataProvider || (files => nativeMetadata(files, options))
  const result = { path: root, generatedAt: new Date().toISOString(), state: 'complete', logicalBytes: 0, uniqueLogicalBytes: 0,
    allocatedBytes: null, knownAllocatedBytes: 0, sharedOutsideBytes: 0, files: 0, directories: 0, hardLinkDuplicates: 0,
    unknownFiles: 0, skippedReparsePoints: 0, cloudPlaceholders: 0, sparseFiles: 0, compressedFiles: 0, errors: 0,
    stopReason: null, reclaimableBytes: null, measurement: 'observed-file-data-allocation',
    explanation: '逻辑大小按路径累加；已确认分配按文件身份去重。未包含目录索引、文件系统元数据及其他数据流，不代表删除或移入回收站后可释放空间。' }
  const queue = [root], identities = new Map()
  let visited = 0
  const stop = () => options.signal?.aborted ? 'cancelled' : Date.now() - start >= maxDurationMs ? 'time-budget' : visited >= maxEntries ? 'entry-budget' : null
  while (queue.length) {
    const reason = stop()
    if (reason) { result.stopReason = reason; break }
    const batch = queue.splice(0, Math.min(128, maxEntries - visited)); visited += batch.length
    let metadata
    try { metadata = await provider(batch) } catch { metadata = batch.map(file => ({ path: file, errorCode: 'metadata-unavailable' })) }
    for (let i = 0; i < batch.length; i++) {
      const item = metadata[i] || {}, file = batch[i]
      // A provider cannot redirect traversal to a path it returns.
      if (item.errorCode && item.logicalBytes == null) { result.errors++; result.unknownFiles++; continue }
      if (item.cloudPlaceholder) result.cloudPlaceholders++
      if (item.skipped) {
        if (item.skipped === 'reparse-point') result.skippedReparsePoints++
        if (!item.directory) { result.files++; result.logicalBytes += bytes(item.logicalBytes) || 0; result.unknownFiles++ }
        continue
      }
      if (item.directory) {
        result.directories++
        let directory
        try {
          directory = await fs.promises.opendir(file)
          for await (const entry of directory) {
            if (queue.length + visited >= maxEntries || Date.now() - start >= maxDurationMs || options.signal?.aborted) {
              result.stopReason = options.signal?.aborted ? 'cancelled' : Date.now() - start >= maxDurationMs ? 'time-budget' : 'entry-budget'; break
            }
            queue.push(path.join(file, entry.name))
          }
        } catch { result.errors++ }
        continue
      }
      result.files++
      if (item.attributes & 512) result.sparseFiles++
      if (item.attributes & 2048) result.compressedFiles++
      const logical = bytes(item.logicalBytes), allocated = bytes(item.allocatedBytes)
      if (logical != null) result.logicalBytes += logical
      const key = typeof item.identity === 'string' && item.identity ? item.identity : null
      const prior = key ? identities.get(key) : null
      if (prior) { prior.observed++; result.hardLinkDuplicates++; continue }
      if (logical != null && (key || item.linkCount === 1)) result.uniqueLogicalBytes += logical
      if (key) identities.set(key, { allocated: allocated || 0, observed: 1, links: item.linkCount })
      if (logical == null || allocated == null || (!key && item.linkCount !== 1)) { result.unknownFiles++; continue }
      result.knownAllocatedBytes += allocated
    }
    if (result.stopReason) break
  }
  for (const item of identities.values()) if (item.links > item.observed) result.sharedOutsideBytes += item.allocated
  if (result.stopReason || result.errors || result.skippedReparsePoints || result.cloudPlaceholders || result.unknownFiles) result.state = 'partial'
  if (result.state === 'complete') result.allocatedBytes = result.knownAllocatedBytes
  result.durationMs = Date.now() - start
  return result
}

module.exports = { inspectPathSpace, nativeMetadata, compileSpaceHelper }
