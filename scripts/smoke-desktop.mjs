import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'

async function reservePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise(resolve => server.close(resolve))
  if (!port) throw new Error('unable-to-reserve-debugging-port')
  return port
}

const port = await reservePort()
const executable = path.resolve(process.argv[2] || 'release/win-unpacked/Disk Sense.exe')
const captureView = ['overview', 'inspect', 'cleaner', 'changes', 'settings'].includes(process.env.DISK_SENSE_SMOKE_VIEW)
  ? process.env.DISK_SENSE_SMOKE_VIEW
  : 'overview'
const captureLabel = {
  overview: '空间概览',
  inspect: '目录与文件',
  cleaner: '垃圾清理',
  changes: '变化记录',
  settings: '设置与关于'
}[captureView]
const screenshotPath = path.resolve(
  process.env.DISK_SENSE_SMOKE_SCREENSHOT || `release/smoke-${captureView}.png`
)
const isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-smoke-'))
const child = spawn(executable, [`--remote-debugging-port=${port}`, '--smoke-test'], {
  stdio: 'ignore',
  windowsHide: true,
  env: { ...process.env, DISK_SENSE_USER_DATA: isolatedUserData }
})

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function target() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const page = targets.find(item => (
        item.type === 'page' &&
        item.webSocketDebuggerUrl &&
        typeof item.url === 'string' &&
        item.url.startsWith('file:') &&
        item.title === 'Disk Sense'
      ))
      if (page) return page
    } catch {
      // The packaged renderer is still starting.
    }
    await delay(250)
  }
  throw new Error('packaged-renderer-timeout')
}

async function evaluate(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('cdp-evaluation-timeout')), 45000)
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data))
      if (message.id !== 1) return
      clearTimeout(timeout)
      resolve(message)
    })
    socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression: `(async () => {
          let api = window.diskSense
          for (let attempt = 0; !api && attempt < 40; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 50))
            api = window.diskSense
          }
          if (!api) throw new Error('preload-bridge-not-ready')
          const [rules, root, slimming, ai, changes, overview, appInfo, history, exclusions] = await Promise.all([
            api.cleanerRules(),
            api.inspectList('C:\\\\'),
            api.cleanerSlimming(),
            api.aiStatus(),
            api.changesState(),
            api.overviewGet(),
            api.appInfo(),
            api.cleanerHistory(),
            api.cleanerExclusions()
          ])
          const scan = await api.cleanerScan('crash-dumps')
          const explainTarget = root.items.find(item => item.name === 'Windows') || root.items.find(item => item.isDirectory && !item.isLink)
          const explanation = explainTarget ? await api.inspectExplain(explainTarget.path) : null
          let invalidPathRejected = false
          try {
            await api.inspectList('relative-path')
          } catch {
            invalidPathRejected = true
          }
          const settingsButton = [...document.querySelectorAll('.main-nav button')].find(button => button.textContent.includes('设置与关于'))
          settingsButton?.click()
          await new Promise(resolve => setTimeout(resolve, 80))
          const settingsRendered = document.body.innerText.includes('清理安全边界') && document.body.innerText.includes(appInfo.version)
          const cleanerButton = [...document.querySelectorAll('.main-nav button')].find(button => button.textContent.includes('垃圾清理'))
          cleanerButton?.click()
          await new Promise(resolve => setTimeout(resolve, 80))
          let historyRendered = true
          if (${JSON.stringify(captureView)} !== 'cleaner') {
            const historyButton = [...document.querySelectorAll('.cleanup-tabs button')].find(button => button.textContent.includes('操作记录'))
            historyButton?.click()
            await new Promise(resolve => setTimeout(resolve, 80))
            historyRendered = document.body.innerText.includes('每一次清理都有结果可查')
          }
          const overviewButton = [...document.querySelectorAll('.main-nav button')].find(button => button.textContent.includes('空间概览'))
          overviewButton?.click()
          await new Promise(resolve => setTimeout(resolve, 120))
          const overviewRendered = document.body.innerText.includes('看得懂的空间地图')
          const captureButton = [...document.querySelectorAll('.main-nav button')].find(button => button.textContent.includes(${JSON.stringify(captureLabel)}))
          captureButton?.click()
          await new Promise(resolve => setTimeout(resolve, 180))
          return {
            title: document.title,
            rendered: document.body.innerText.includes('目录与文件'),
            bridge: Boolean(api),
            ruleCount: rules.length,
            rootItems: root.items.length,
            rootPath: root.path,
            slimmingCount: slimming.length,
            aiConfigured: ai.configured,
            hasChangeState: Boolean(changes),
            changeHistoryCount: changes.history.length,
            scanRule: scan.id,
            scanFiles: scan.files.length,
            scanTruncated: scan.truncated,
            volumeCount: overview.volumes.length,
            appVersion: appInfo.version,
            stateVersion: appInfo.stateVersion,
            packaged: appInfo.packaged,
            security: appInfo.security,
            invalidPathRejected,
            explanation: explanation ? {
              classification: explanation.classification,
              what: explanation.what,
              purpose: explanation.purpose,
              risk: explanation.risk
            } : null,
            settingsRendered,
            historyRendered,
            overviewRendered,
            historyCount: history.length,
            exclusionCount: exclusions.length
          }
        })()`,
        awaitPromise: true,
        returnByValue: true
      }
    }))
  })
  if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.text || 'renderer-evaluation-failed')
  const value = result.result?.result?.value
  if (!value) throw new Error(`renderer-returned-no-smoke-result: ${JSON.stringify(result)}`)
  let screenshot = null
  try {
    screenshot = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('cdp-screenshot-timeout')), 10000)
      const listener = event => {
        const message = JSON.parse(String(event.data))
        if (message.id !== 2) return
        clearTimeout(timeout)
        socket.removeEventListener('message', listener)
        if (message.error) reject(new Error(message.error.message || 'cdp-screenshot-failed'))
        else resolve(message.result?.data)
      }
      socket.addEventListener('message', listener)
      socket.send(JSON.stringify({
        id: 2,
        method: 'Page.captureScreenshot',
        params: { format: 'png', captureBeyondViewport: false }
      }))
    })
  } catch (error) {
    if (process.env.DISK_SENSE_SMOKE_REQUIRE_SCREENSHOT === '1') throw error
    process.stderr.write(`Screenshot skipped: ${error.message}\n`)
  }
  if (screenshot) {
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true })
    fs.writeFileSync(screenshotPath, Buffer.from(String(screenshot), 'base64'))
  }
  socket.send(JSON.stringify({ id: 3, method: 'Browser.close' }))
  await delay(250)
  socket.close()
  return value
}

try {
  const page = await target()
  const result = await evaluate(page.webSocketDebuggerUrl)
  if (
    result?.title !== 'Disk Sense' ||
    !result?.rendered ||
    !result?.bridge ||
    result?.ruleCount < 8 ||
    result?.rootPath !== 'C:\\' ||
    result?.slimmingCount < 4 ||
    result?.scanRule !== 'crash-dumps' ||
    result?.volumeCount < 1 ||
    result?.stateVersion !== 4 ||
    !result?.packaged ||
    !result?.security?.rendererSandbox ||
    !result?.security?.contextIsolation ||
    result?.security?.permanentDelete ||
    !result?.invalidPathRejected ||
    !result?.explanation?.what ||
    !result?.explanation?.purpose ||
    !result?.settingsRendered ||
    !result?.historyRendered ||
    !result?.overviewRendered
  ) {
    throw new Error(`packaged-smoke-assertion-failed: ${JSON.stringify(result)}`)
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} catch (error) {
  const diagnosticPath = path.join(isolatedUserData, 'disk-sense.log')
  if (fs.existsSync(diagnosticPath)) {
    fs.mkdirSync(path.resolve('release'), { recursive: true })
    fs.copyFileSync(diagnosticPath, path.resolve('release/smoke-failure.log'))
  }
  throw error
} finally {
  if (child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill()
    await Promise.race([exited, delay(5000)])
  }
  fs.rmSync(isolatedUserData, { recursive: true, force: true })
}
