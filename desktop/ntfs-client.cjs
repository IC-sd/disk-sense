const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn, execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { createInterface } = require('node:readline')

async function compileNtfsHelper(cacheDirectory) {
  const sources = await Promise.all(['ntfs-indexer.cs', 'ntfs-service.cs'].map(name => fs.promises.readFile(path.join(__dirname, name))))
  const digest = crypto.createHash('sha256').update(sources[0]).update('\0').update(sources[1]).digest('hex').slice(0, 20)
  const executable = path.join(cacheDirectory, `ntfs-${digest}.exe`)
  if (!fs.existsSync(executable)) {
    await fs.promises.mkdir(cacheDirectory, { recursive: true })
    const compileSource = path.join(cacheDirectory, `ntfs-${digest}.cs`)
    // Each compilation unit needs its own using directives.
    const serviceSource = path.join(cacheDirectory, `ntfs-${digest}-service.cs`)
    await fs.promises.writeFile(compileSource, sources[0])
    await fs.promises.writeFile(serviceSource, sources[1])
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
    await promisify(execFile)(compiler, ['/nologo', '/optimize+', '/target:exe', '/r:System.Web.Extensions.dll', '/r:System.ServiceProcess.dll', `/out:${executable}`, compileSource, serviceSource], { windowsHide: true, timeout: 30_000 })
  }
  return executable
}

function lineClient(input, output, close, broker = false) {
  const reader = createInterface({ input, crlfDelay: Infinity })
  const lines = reader[Symbol.asyncIterator]()
  let failure = null, busy = false
  input.on('error', error => { failure = error })
  output.on('error', error => { failure = error })
  return {
    broker,
    async *request(request) {
      if (busy) throw new Error('NTFS metadata request already running')
      busy = true
      let complete = false, error = null
      try {
        if (failure) throw failure
        output.write(`${JSON.stringify(request)}\n`)
        while (true) {
          const line = await lines.next()
          if (line.done) throw failure || new Error('NTFS metadata helper disconnected')
          const event = JSON.parse(line.value)
          if (event.type === 'done') { complete = true; if (error) throw error; return }
          if (event.type === 'error') error = Object.assign(new Error(event.message), { code: event.code || 'NTFS_ERROR' })
          else yield event
        }
      } finally { busy = false; if (!complete) { reader.close(); close() } }
    },
    close() { reader.close(); close() }
  }
}

function stdioClient(executable) {
  const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  child.on('error', error => child.stdout.destroy(error))
  child.stderr.resume()
  return lineClient(child.stdout, child.stdin, () => { child.stdin.destroy(); child.kill() })
}

async function connectBroker(descriptor) {
  const net = require('node:net')
  const socket = net.createConnection(`\\\\.\\pipe\\${descriptor.pipe}`)
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('NTFS broker unavailable')) }, 600)
    socket.once('connect', () => { clearTimeout(timeout); resolve() })
    socket.once('error', error => { clearTimeout(timeout); reject(error) })
  })
  socket.write(`${JSON.stringify({ token: descriptor.token })}\n`)
  // Consume the authentication greeting before exposing the operation stream.
  await new Promise((resolve, reject) => {
    let text = ''
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('NTFS broker handshake timed out')) }, 1500)
    const consume = chunk => {
      text += chunk.toString('utf8')
      if (!text.includes('\n')) return
      clearTimeout(timeout); socket.off('data', consume)
      try { const reply = JSON.parse(text.trim()); if (reply.type !== 'hello' || reply.protocol !== 1 || !reply.elevated
        || (descriptor.persistent && (!reply.persistent || reply.version !== descriptor.version))) throw new Error('Invalid NTFS broker'); resolve() }
      catch (error) { socket.destroy(); reject(error) }
    }
    socket.on('data', consume)
    socket.once('error', error => { clearTimeout(timeout); reject(error) })
  })
  return lineClient(socket, socket, () => socket.destroy(), true)
}

const identities = new Map()
async function requestingIdentity(executable) {
  if (!identities.has(executable)) identities.set(executable, (async () => {
    const ordinary = stdioClient(executable)
    try { for await (const event of ordinary.request({ op: 'identity' })) if (event.sid) return event }
    finally { ordinary.close() }
    throw new Error('Cannot identify requesting Windows user')
  })().catch(error => { identities.delete(executable); throw error }))
  return identities.get(executable)
}

function installedLocation(sid, programFiles = process.env.ProgramW6432 || process.env.ProgramFiles) {
  if (!/^S-1-5-\d+(?:-\d+)+$/u.test(sid) || !programFiles) throw new Error('Invalid Windows installation identity')
  const suffix = crypto.createHash('sha256').update(sid).digest('hex').slice(0, 16)
  const directory = path.win32.join(programFiles, 'Disk Sense Search', suffix)
  return { directory, serviceName: `DiskSenseSearch-${suffix}`, pipe: `DiskSenseNtfs-service-${suffix}`,
    executable: path.win32.join(directory, 'ntfs-service.exe'), profile: path.win32.join(directory, 'connection.json') }
}

async function readInstalled(executable) {
  const { sid } = await requestingIdentity(executable), location = installedLocation(sid)
  const info = await fs.promises.lstat(location.profile)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new Error('Invalid installed NTFS service profile')
  const saved = JSON.parse(await fs.promises.readFile(location.profile, 'utf8'))
  const version = path.basename(executable).match(/^ntfs-([a-f0-9]{20})\.exe$/u)?.[1]
  if (saved.product !== 'io.github.ic-sd.disk-sense.ntfs/v1' || saved.sid !== sid || saved.version !== version
    || saved.executable !== location.executable || saved.pipe !== location.pipe || saved.serviceName !== location.serviceName
    || !/^[a-f0-9]{64}$/u.test(saved.token)) throw new Error('NTFS service requires installation or an update')
  return { ...saved, persistent: true }
}

async function configureService(executable, action) {
  const { sid } = await requestingIdentity(executable)
  try {
    await promisify(execFile)(executable, ['--service-launch', action, sid], { windowsHide: true, timeout: 150_000 })
  } catch (error) {
    let detail
    try { detail = JSON.parse(String(error.stdout || '').trim()) } catch {}
    throw Object.assign(new Error(detail?.message || error.message), { code: detail?.code || 'NTFS_SERVICE_INSTALL_FAILED' })
  }
}

async function persistentClient(descriptor, deferConnection = false) {
  let connection = deferConnection ? null : await connectBroker(descriptor), closed = false
  return {
    broker: true, persistent: true, serviceName: descriptor.serviceName,
    async *request(request) {
      if (closed) throw new Error('NTFS metadata client closed')
      try {
        connection ||= await connectBroker(descriptor)
        yield* connection.request(request)
      } catch (error) {
        connection?.close(); connection = null
        if (!String(error.code || '').startsWith('NTFS_')) error.code = 'NTFS_TRANSPORT_UNAVAILABLE'
        throw error
      }
    },
    close() { closed = true; connection?.close(); connection = null }
  }
}

async function removePersistentNtfsService(cacheDirectory) {
  const executable = await compileNtfsHelper(cacheDirectory)
  await configureService(executable, 'uninstall')
}

async function createNtfsClient(cacheDirectory, { elevate = false, connectOnly = false } = {}) {
  if (process.platform !== 'win32') return null
  const executable = await compileNtfsHelper(cacheDirectory)
  let installed
  try { installed = await readInstalled(executable) } catch { /* absent or an older installed version */ }
  if (installed) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await persistentClient(installed) } catch { await new Promise(resolve => setTimeout(resolve, 150)) }
    }
    // SCM can still be starting during login. Keep the installed transport and
    // retry from saved cursors instead of requesting UAC or starting a full scan.
    if (!elevate) return persistentClient(installed, true)
  }
  if (elevate) {
    await configureService(executable, 'install')
    const descriptor = await readInstalled(executable)
    let lastError
    for (let attempt = 0; attempt < 30; attempt++) {
      try { return await persistentClient(descriptor) } catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 100)) }
    }
    throw lastError
  }
  const descriptorPath = path.join(cacheDirectory, 'ntfs-session.json')
  try {
    const info = await fs.promises.lstat(descriptorPath)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new Error('Invalid NTFS session descriptor')
    const saved = JSON.parse(await fs.promises.readFile(descriptorPath, 'utf8'))
    if (saved.executable !== executable || !/^DiskSenseNtfs-[a-z0-9-]+$/u.test(saved.pipe) || !/^[a-f0-9]{64}$/u.test(saved.token)) throw new Error('NTFS session version changed')
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await connectBroker(saved) }
      catch (error) { if (attempt === 2) throw error; await new Promise(resolve => setTimeout(resolve, 150)) }
    }
  } catch { /* no reusable authenticated helper in this user session */ }
  return connectOnly ? null : stdioClient(executable)
}
module.exports = { compileNtfsHelper, createNtfsClient, removePersistentNtfsService, installedLocation, configureService }
