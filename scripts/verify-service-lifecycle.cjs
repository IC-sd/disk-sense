// Installs a real SCM service ONLY after the disposable-environment guard.
const { requireDisposableWindows } = require('./windows-acceptance-guard.cjs')
const environment = requireDisposableWindows()
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { execFile, spawnSync } = require('node:child_process')
const { promisify } = require('node:util')
const run = promisify(execFile)
const { compileNtfsHelper, createNtfsClient } = require('../desktop/ntfs-client.cjs')

async function collect(client, request) { const events = []; for await (const event of client.request(request)) events.push(event); return events }
async function wrongTokenRejected(pipe) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(`\\\\.\\pipe\\${pipe}`)
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('Authentication probe timed out')) }, 10000)
    let response = ''
    const finish = (error, value) => { clearTimeout(timeout); socket.destroy(); error ? reject(error) : resolve(value) }
    socket.once('error', error => finish(error))
    socket.once('connect', () => socket.write(`${JSON.stringify({ token: '0'.repeat(64) })}\n`))
    socket.on('data', chunk => {
      response += chunk.toString('utf8')
      if (!response.includes('\n')) return
      try { finish(null, JSON.parse(response.trim()).code === 'NTFS_AUTH_FAILED') } catch (error) { finish(error) }
    })
  })
}

;(async () => {
  const output = path.resolve(process.argv[2] || 'work/windows-acceptance/service-lifecycle.json')
  const cache = path.join(path.dirname(output), 'service-cache')
  const executable = await compileNtfsHelper(cache)
  const version = path.basename(executable).match(/^ntfs-([a-f0-9]{20})\.exe$/u)?.[1]
  assert(version, 'Compiled helper version required')
  const invoke = args => run(executable, args, { windowsHide: true, timeout: 150000 })
  // Bypass installed brokers when finding the requesting user's identity.
  // Otherwise an existing LocalSystem broker could be mistaken for this user.
  const identityProcess = spawnSync(executable, [], { input: '{"op":"identity"}\n', encoding: 'utf8', windowsHide: true, timeout: 10000 })
  assert.equal(identityProcess.status, 0, 'Ordinary helper identity query failed')
  const identity = JSON.parse(identityProcess.stdout.split('\n')[0])
  assert(identity?.sid, 'Current Windows SID required')
  assert(identity.elevated, 'Service lifecycle requires an administrator token inside the disposable VM')
  const plan = JSON.parse((await invoke(['--service-plan', identity.sid])).stdout)
  const sc = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'sc.exe')
  const previous = await run(sc, ['query', plan.serviceName], { windowsHide: true }).then(() => true, error => {
    if (error.code === 1060) return false
    throw error
  })
  assert(!previous, 'Refusing to replace an existing search service')
  const report = { date: new Date().toISOString(), environment, passed: false, serviceName: plan.serviceName,
    hostRebootVerified: false, uacPromptVerified: false, administratorLaunch: Boolean(identity.elevated) }
  const clients = []
  let installed = false
  try {
    await invoke(['--service-install', identity.sid, version])
    installed = true
    const first = await createNtfsClient(cache, { connectOnly: true })
    assert(first?.persistent, 'Installed service transport required'); clients.push(first)
    const second = await createNtfsClient(cache, { connectOnly: true })
    assert(second?.persistent); clients.push(second)
    const serviceIdentity = (await collect(first, { op: 'identity' }))[0]
    assert.equal(serviceIdentity.sid, 'S-1-5-18')
    assert.equal(serviceIdentity.elevated, true)
    const root = path.parse(process.env.SystemRoot || 'C:\\Windows').root
    const probes = await Promise.all([collect(first, { op: 'probe', root }), collect(second, { op: 'probe', root })])
    assert(probes.every(events => events.some(event => event.available)))
    const profile = JSON.parse(fs.readFileSync(path.join(plan.directory, 'connection.json'), 'utf8'))
    assert(await wrongTokenRejected(profile.pipe), 'Wrong pipe token must be rejected')
    await assert.rejects(collect(second, { op: 'shutdown' }), /Unsupported/u)
    await invoke(['--service-restart', identity.sid, version])
    await collect(first, { op: 'probe', root }).catch(() => {})
    assert((await collect(first, { op: 'probe', root })).some(event => event.available), 'Existing client must reconnect after service restart')
    Object.assign(report, { localSystemIdentity: true, concurrentClients: 2, wrongTokenRejected: true,
      shutdownRpcRejected: true, reconnectAfterServiceRestart: true, passed: true })
  } catch (error) {
    report.error = error.message
    throw error
  } finally {
    for (const client of clients) client.close()
    try {
      if (installed) {
        await invoke(['--service-uninstall', identity.sid, version])
        assert(!fs.existsSync(path.join(plan.directory, 'connection.json')), 'Service profile must be removed')
        assert(!fs.existsSync(path.join(plan.directory, 'ntfs-service.exe')), 'Service executable must be removed')
        const absent = await run(sc, ['query', plan.serviceName], { windowsHide: true }).then(() => false, error => error.code === 1060)
        assert(absent, 'Service registration must be removed')
        report.uninstalled = true
      }
    } catch (error) {
      report.passed = false
      report.cleanupError = error.message
      throw error
    } finally {
      fs.mkdirSync(path.dirname(output), { recursive: true })
      fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
    }
  }
  console.log(JSON.stringify({ passed: report.passed, serviceLifecycle: true }))
})().catch(error => { console.error(error.message); process.exitCode = 1 })
