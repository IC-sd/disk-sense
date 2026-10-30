// Used only by the disposable Windows installation acceptance harness.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
require('./windows-acceptance-guard.cjs').requireDisposableWindows()

const [executableValue, profileValue, action, expectedVersion, outputValue] = process.argv.slice(2)
assert(['seed', 'check'].includes(action), 'Expected seed or check')
const executable = path.resolve(executableValue)
const profile = path.resolve(profileValue)
const output = path.resolve(outputValue)
assert(fs.statSync(executable).isFile(), 'Installed executable required')
const fixture = path.join(path.dirname(output), 'search-fixture')
fs.mkdirSync(fixture, { recursive: true })
fs.writeFileSync(path.join(fixture, 'installed-profile-report.txt'), 'Owned installation acceptance fixture')
const server = net.createServer()
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const port = server.address().port
await new Promise(resolve => server.close(resolve))
const child = spawn(executable, [`--remote-debugging-port=${port}`, '--smoke-test'], { windowsHide: true, stdio: 'ignore',
  env: { ...process.env, DISK_SENSE_USER_DATA: '', DISK_SENSE_SMOKE_SEARCH_ROOT: fixture, DISK_SENSE_SMOKE_HEADLESS: '1' } })
let spawnError = null
child.once('error', error => { spawnError = error })
const exited = new Promise(resolve => child.once('exit', resolve))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
let socket
try {
  let target
  for (let attempt = 0; attempt < 120; attempt++) {
    if (spawnError) throw spawnError
    if (child.exitCode !== null) throw new Error(`Installed app exited before ready (${child.exitCode})`)
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = targets.find(item => item.type === 'page' && item.title === 'Disk Sense' && item.url?.startsWith('file:'))
      if (target?.webSocketDebuggerUrl) break
    } catch { /* Chromium may still be starting. */ }
    await wait(250)
  }
  assert(target?.webSocketDebuggerUrl, 'Installed renderer was not ready')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  const response = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Installed profile IPC timed out')), 30000)
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data))
      if (message.id !== 1) return
      clearTimeout(timeout)
      resolve(message)
    })
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { awaitPromise: true, returnByValue: true,
      expression: `(async () => {
        const api = window.diskSense
        if (!api) throw new Error('Missing preload API')
        const favorite = ${JSON.stringify(fixture)}
        if (${JSON.stringify(action)} === 'seed') {
          await api.appAppearanceSet({ theme: 'light' })
          await api.aiConfigSave({ endpoint: 'https://example.invalid/v1', model: 'installation-acceptance-fixture', provider: 'openai-compatible', apiKey: 'synthetic-installation-acceptance-key' })
          await api.cleanerExclusionAdd({ path: favorite, mode: 'exact', reason: 'Owned installation acceptance fixture' })
          localStorage.setItem('disk-sense.favorite-paths', JSON.stringify([favorite]))
        }
        const [info, appearance, ai, exclusions, history] = await Promise.all([
          api.appInfo(), api.appAppearanceGet(), api.aiConfigGet(), api.cleanerExclusions(), api.cleanerHistory()
        ])
        const favorites = JSON.parse(localStorage.getItem('disk-sense.favorite-paths') || '[]')
        return { version: info.version, packaged: info.packaged, profile: info.userDataPath, theme: appearance.theme,
          encryptedKeyStored: ai.keyStored && ai.hasApiKey && ai.encryptionAvailable,
          favoriteRetained: favorites.includes(favorite), exclusionRetained: exclusions.some(item => item.path === favorite),
          syntheticHistoryRetained: history.some(item => item.id === 'installation-acceptance-history') }
      })()` } }))
  })
  assert(!response.error && !response.result?.exceptionDetails, 'Installed profile IPC failed')
  const result = response.result?.result?.value
  assert(result?.packaged, 'Acceptance must use the installed packaged app')
  assert.equal(result.version, expectedVersion, 'Installed app version mismatch')
  assert.equal(path.resolve(result.profile).toLowerCase(), profile.toLowerCase(), 'Unexpected user data profile')
  assert.equal(result.theme, 'light')
  assert.equal(result.encryptedKeyStored, true, 'Encrypted fixture credential must survive and decrypt without sending a request')
  assert.equal(result.favoriteRetained, true)
  assert.equal(result.exclusionRetained, true)
  if (action === 'check') assert.equal(result.syntheticHistoryRetained, true)
  await wait(500)
  socket.send(JSON.stringify({ id: 2, method: 'Browser.close' }))
  const closed = await Promise.race([exited.then(() => true), wait(10000).then(() => false)])
  assert(closed, 'Installed app did not close gracefully')
  if (action === 'seed') {
    const sidecar = path.join(profile, 'disk-sense-state.json.operations.json')
    const previous = fs.existsSync(sidecar) ? JSON.parse(fs.readFileSync(sidecar, 'utf8')) : {}
    fs.writeFileSync(sidecar, JSON.stringify({ ...previous, version: 1, maintenanceJobs: [], cleanupJobs: [{
      id: 'installation-acceptance-history', createdAt: new Date().toISOString(), requested: 0, processed: 0,
      succeeded: 0, failed: 0, executionMode: 'trash', reclaimedBytes: 0, results: []
    }] }))
  }
  for (const file of fs.readdirSync(profile).filter(name => /\.(?:json|log|bak)$/u.test(name))) {
    const target = path.join(profile, file)
    if (fs.statSync(target).isFile()) assert(!fs.readFileSync(target, 'utf8').includes('synthetic-installation-acceptance-key'), 'Plaintext fixture credential found in state or diagnostics')
  }
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, `${JSON.stringify({ ...result, action, passed: true, syntheticFixturesOnly: true }, null, 2)}\n`)
  console.log(JSON.stringify({ action, version: result.version, passed: true }))
} finally {
  socket?.close()
  if (child.exitCode === null) { child.kill(); await Promise.race([exited, wait(5000)]) }
}
