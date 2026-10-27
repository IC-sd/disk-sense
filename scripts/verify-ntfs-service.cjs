const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs/promises')
const { execFile, spawnSync } = require('node:child_process')
const { promisify } = require('node:util')
const { performance } = require('node:perf_hooks')
const { compileNtfsHelper, createNtfsClient, configureService, installedLocation } = require('../desktop/ntfs-client.cjs')

;(async () => {
  const cache = path.resolve('.cache/ntfs-service-validation'), clients = []
  const executable = await compileNtfsHelper(cache)
  const selftest = JSON.parse((await promisify(execFile)(executable, ['--selftest'])).stdout)
  assert.equal(selftest.passed, 6)
  const collect = async (client, request) => { const events = []; for await (const event of client.request(request)) events.push(event); return events }
  // An ordinary helper verifies that only the SCM process owns elevated rights.
  const identity = JSON.parse(spawnSync(executable, [], { input: '{"op":"identity"}\n', encoding: 'utf8', windowsHide: true }).stdout.split('\n')[0])
  assert.equal(identity.elevated, false, 'Validation runs as the ordinary desktop user')
  const plan = JSON.parse((await promisify(execFile)(executable, ['--service-plan', identity.sid])).stdout)
  console.log(JSON.stringify({ stage: 'review', ...plan }))
  if (process.argv.includes('--plan')) return
  const start = performance.now()
  try {
    const first = await createNtfsClient(cache, { elevate: process.argv.includes('--install'), connectOnly: true })
    assert(first?.persistent, 'A matching persistent search service is required'); clients.push(first)
    const second = await createNtfsClient(cache, { connectOnly: true }); clients.push(second)
    assert(second?.persistent)
    const probes = await Promise.all([collect(first, { op: 'probe', root: 'C:\\' }), collect(second, { op: 'probe', root: 'D:\\' })])
    assert(probes.every(events => events.some(event => event.available)), 'Both ordinary clients can read NTFS metadata concurrently')
    const serviceIdentity = (await collect(first, { op: 'identity' }))[0]
    assert.equal(serviceIdentity.sid, 'S-1-5-18'); assert.equal(serviceIdentity.elevated, true)
    await assert.rejects(collect(second, { op: 'shutdown' }), /Unsupported/u)
    assert((await collect(second, { op: 'probe', root: 'D:\\' }))[0].available, 'Unsupported RPC cannot stop the service')
    if (process.argv.includes('--restart')) {
      await configureService(executable, 'restart')
      try { await collect(first, { op: 'probe', root: 'C:\\' }) } catch (error) { assert.equal(error.code, 'NTFS_TRANSPORT_UNAVAILABLE') }
      assert((await collect(first, { op: 'probe', root: 'C:\\' }))[0].available, 'The existing client reconnects after a service restart')
    }
    const location = installedLocation(identity.sid)
    const report = { date: new Date().toISOString(), ordinaryUser: true, persistent: true, concurrentVolumes: 2,
      reconnectAfterServiceRestart: process.argv.includes('--restart'), shutdownRpcRejected: true,
      serviceName: location.serviceName, executable: location.executable, elapsedMs: Math.round(performance.now() - start) }
    await fs.mkdir('release-search-validation', { recursive: true })
    await fs.writeFile(`release-search-validation/ntfs-service${process.argv.includes('--restart') ? '-restart' : ''}-validation.json`, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report, null, 2))
  } finally { for (const client of clients) client?.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
