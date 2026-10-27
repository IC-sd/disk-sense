import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import { captureFrontend } from './frontend-audit.mjs'

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
if (!fs.existsSync(executable)) throw new Error('Desktop executable is missing. For development, run node node_modules/electron/install.js; for a packaged check, build the Windows application first.')
const electronRuntime = path.basename(executable).toLowerCase() === 'electron.exe'
const developmentServerUrl = new URL(process.env.DISK_SENSE_DEV_SERVER_URL || 'http://127.0.0.1:5173/')
const captureView = ['overview', 'inspect', 'cleaner', 'settings'].includes(process.env.DISK_SENSE_SMOKE_VIEW)
  ? process.env.DISK_SENSE_SMOKE_VIEW
  : 'overview'
const captureLabel = {
  overview: '空间概览',
  inspect: '目录与文件',
  cleaner: '垃圾清理',
  settings: '设置与关于'
}[captureView]
const captureNavigationIndex = {
  overview: 0,
  inspect: 1,
  cleaner: 2,
  settings: 3
}[captureView]
const screenshotPath = path.resolve(
  process.env.DISK_SENSE_SMOKE_SCREENSHOT || `release/smoke-${captureView}.png`
)
const isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-smoke-'))
const smokeSearchRoot = path.join(isolatedUserData, 'search-fixture')
fs.mkdirSync(path.join(smokeSearchRoot, '$Recycle.Bin'), { recursive: true })
fs.mkdirSync(path.join(smokeSearchRoot, 'Documents'), { recursive: true })
fs.mkdirSync(path.join(smokeSearchRoot, 'ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'), { recursive: true })
fs.mkdirSync(path.join(smokeSearchRoot, 'Users', 'Test', 'Documents'), { recursive: true })
fs.mkdirSync(path.join(smokeSearchRoot, 'node_modules', 'word', 'lib'), { recursive: true })
const systemWordShortcut = 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Word.lnk'
const smokeWordShortcut = path.join(smokeSearchRoot, 'ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Word.lnk')
const realWordShortcutAvailable = process.platform === 'win32' && fs.existsSync(systemWordShortcut)
fs.writeFileSync(path.join(smokeSearchRoot, '$Recycle.Bin', 'discarded.tmp'), 'smoke fixture')
fs.writeFileSync(path.join(smokeSearchRoot, 'Documents', 'search-smoke.txt'), 'smoke fixture')
if (process.env.DISK_SENSE_SMOKE_SEARCH_ADVANCED === '1') {
  fs.writeFileSync(path.join(smokeSearchRoot, 'Documents', '季度报告2026.txt'), 'pinyin fixture')
  fs.writeFileSync(path.join(smokeSearchRoot, 'Documents', 'VisualStudioCode.txt'), 'abbreviation fixture')
  for (let index = 0; index < 145; index++) fs.writeFileSync(path.join(smokeSearchRoot, 'Documents', `page-report-${String(index).padStart(3, '0')}.txt`), '')
}
fs.writeFileSync(path.join(smokeSearchRoot, 'package.json'), JSON.stringify({ name: 'Space Demo' }))
if (realWordShortcutAvailable) fs.copyFileSync(systemWordShortcut, smokeWordShortcut)
else fs.writeFileSync(smokeWordShortcut, 'shortcut fixture')
fs.writeFileSync(path.join(smokeSearchRoot, 'Users', 'Test', 'Documents', 'word-plan.docx'), 'document fixture')
fs.writeFileSync(path.join(smokeSearchRoot, 'node_modules', 'word', 'lib', 'word.tcl'), 'dependency fixture')
const smokeSearchQuery = process.env.DISK_SENSE_SMOKE_SEARCH_QUERY || '*$Recycle*'
const smokeSearchExpected = process.env.DISK_SENSE_SMOKE_SEARCH_EXPECTED || '$Recycle.Bin'
const smokeRequiresOfficeShortcut = realWordShortcutAvailable && smokeSearchQuery.toLocaleLowerCase().includes('word')
const frontendFixtures = process.env.DISK_SENSE_SMOKE_FRONTEND_FIXTURES === '1'
const migrationFailureFixture = frontendFixtures && process.env.DISK_SENSE_SMOKE_MIGRATION_FAILURE === '1'
const fixtureUserData = migrationFailureFixture ? path.join(isolatedUserData, 'original-data') : isolatedUserData
const fixtureHome = path.join(isolatedUserData, 'fixture-home')
const fixtureLocalData = path.join(fixtureHome, 'AppData', 'Local')
const fixtureRoamingData = path.join(fixtureHome, 'AppData', 'Roaming')
if (frontendFixtures) {
  fs.mkdirSync(fixtureUserData, { recursive: true })
  fs.mkdirSync(fixtureRoamingData, { recursive: true })
  // These records exercise the real history UI; no cleanup has been executed.
  const createdAt = new Date().toISOString()
  const recorded = (name, success) => ({ candidateId: `frontend-${name}`, path: path.join(isolatedUserData, 'record-preview', name),
    size: 4096, modifiedAt: 0, ruleId: 'crash-dumps', success, ...(success ? {} : { error: '界面验收样本：文件状态已变化，已跳过。' }) })
  fs.writeFileSync(path.join(fixtureUserData, 'disk-sense-state.json'), JSON.stringify({ version: 7,
    cleanupJobs: [{ id: 'frontend-record-preview', createdAt, executionMode: 'trash', requested: 2, processed: 2,
      succeeded: 1, failed: 1, cancelled: false, rejectedOverflow: 0, movedToTrashBytes: 4096, reclaimedBytes: 0,
      results: [recorded('preview-complete.tmp', true), recorded('preview-skipped.tmp', false)] }],
    maintenanceJobs: [], cleanupExclusions: [], appearance: { theme: 'dark' }
  }))
  const dump = path.join(fixtureLocalData, 'CrashDumps', 'frontend-preview.dmp')
  fs.mkdirSync(path.dirname(dump), { recursive: true })
  fs.writeFileSync(dump, 'Owned frontend scan fixture; never execute cleanup.')
  // An invalid directory type exercises an unavailable rule without changing
  // ACLs or reading host caches. This is a disposable fixture file, not a cache.
  fs.writeFileSync(path.join(fixtureLocalData, 'D3DSCache'), 'Owned invalid-root fixture.')
  const old = new Date(Date.now() - 30 * 86_400_000)
  fs.utimesSync(dump, old, old)
  const discoveryCache = path.join(fixtureLocalData, 'DingTalk_108', 'Code Cache', 'discovery-preview.tmp')
  fs.mkdirSync(path.dirname(discoveryCache), { recursive: true })
  fs.writeFileSync(discoveryCache, 'Owned discovery fixture; never execute cleanup.')
  fs.utimesSync(discoveryCache, old, old)
  fs.mkdirSync(path.join(fixtureLocalData, 'DingTalk_108', 'ordinary', 'level1', 'level2', 'level3', 'level4', 'level5'), { recursive: true })
  if (migrationFailureFixture) {
    const target = path.join(isolatedUserData, 'migration-target')
    const state = JSON.parse(fs.readFileSync(path.join(fixtureUserData, 'disk-sense-state.json'), 'utf8'))
    fs.writeFileSync(path.join(fixtureUserData, 'disk-sense-state.json.operations.json'), JSON.stringify({ version: 1, cleanupJobs: state.cleanupJobs, maintenanceJobs: [] }))
    // A directory at a metadata-file destination forces an actual rename
    // failure without changing host ACLs or touching the user's data location.
    fs.mkdirSync(path.join(target, 'disk-sense-state.json.operations.json'), { recursive: true })
    fs.writeFileSync(path.join(target, 'migration.json'), JSON.stringify({ version: 1, source: fixtureUserData }))
    const pointerDirectory = path.join(fixtureRoamingData, 'Disk Sense')
    fs.mkdirSync(pointerDirectory, { recursive: true })
    fs.writeFileSync(path.join(pointerDirectory, 'data-location.json'), JSON.stringify({ version: 1, path: target }))
  }
}
const smokeArguments = process.env.DISK_SENSE_SMOKE_DEV === '1'
  ? ['--disable-gpu', `--remote-debugging-port=${port}`, path.resolve('desktop/main.cjs'), '--dev', '--smoke-test']
  : electronRuntime
    ? [`--remote-debugging-port=${port}`, path.resolve('desktop/main.cjs'), '--smoke-test']
    : [`--remote-debugging-port=${port}`, '--smoke-test']
const child = spawn(executable, smokeArguments, {
  stdio: process.env.DISK_SENSE_SMOKE_DEV === '1' ? 'inherit' : 'ignore',
  windowsHide: true,
  env: {
    ...process.env,
    DISK_SENSE_USER_DATA: migrationFailureFixture ? '' : isolatedUserData,
    DISK_SENSE_SMOKE_SEARCH_ROOT: smokeSearchRoot,
    DISK_SENSE_SMOKE_HEADLESS: '1',
    ...(frontendFixtures ? { USERPROFILE: fixtureHome, LOCALAPPDATA: fixtureLocalData, APPDATA: fixtureRoamingData } : {})
  }
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
        (
          item.url.startsWith('file:') ||
          (
            process.env.DISK_SENSE_SMOKE_DEV === '1' &&
            item.url.startsWith(developmentServerUrl.origin)
          )
        ) &&
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
    const timeout = setTimeout(() => reject(new Error('cdp-evaluation-timeout')), 120000)
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
          const waitForDom = async (condition, label) => {
            for (let attempt = 0; attempt < 100; attempt++) {
              if (condition()) return
              await new Promise(resolve => setTimeout(resolve, 50))
            }
            throw new Error('dom-ready-timeout: ' + label)
          }
          const [rules, root, slimming, slimmingStatus, maintenanceHistory, ai, changes, overview, appInfo, dataUsage, history, exclusions, appearance, deviceInfo, searchIndex] = await Promise.all([
            api.cleanerRules(),
            api.inspectList('C:\\\\'),
            api.cleanerSlimming(),
            api.cleanerSlimmingStatus(),
            api.cleanerSlimmingHistory(),
            api.aiStatus(),
            api.changesState(),
            api.overviewGet(),
            api.appInfo(),
            api.appDataUsage(),
            api.cleanerHistory(),
            api.cleanerExclusions(),
            api.appAppearanceGet(),
            api.appDeviceInfo(),
            api.inspectIndexStatus()
          ])
          const scan = await api.cleanerScan('crash-dumps')
          let migrationRecoveryVerified = null
          if (${JSON.stringify(migrationFailureFixture)}) {
            await waitForDom(() => document.querySelector('.startup-recovery-notice'), 'migration-recovery-notice')
            migrationRecoveryVerified = appInfo.userDataPath === ${JSON.stringify(fixtureUserData)}
              && appInfo.migrationRecovery?.source === appInfo.userDataPath
              && history.some(job => job.id === 'frontend-record-preview')
            if (!migrationRecoveryVerified) throw new Error('migration-recovery-used-incomplete-data')
          }
          const explainTarget = root.items.find(item => item.name === 'Windows') || root.items.find(item => item.isDirectory && !item.isLink)
          const explanation = explainTarget ? await api.inspectExplain(explainTarget.path) : null
          await api.inspectExplain(${JSON.stringify(smokeSearchRoot)})
          await api.inspectIndexStart({ scope: 'all' })
          for (let attempt = 0; attempt < 100 && (await api.inspectIndexStatus()).building; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 50))
          }
          await waitForDom(() => document.querySelectorAll('.main-nav button').length === 4, 'initial-navigation')
          const settingsButton = [...document.querySelectorAll('.main-nav button')].find(button => button.textContent.includes('设置与关于'))
          settingsButton?.click()
          await waitForDom(() => document.querySelector('.settings-tabs'), 'settings-tabs')
          const generalSettingsButton = [...document.querySelectorAll('.settings-tabs button')]
            .find(button => button.textContent.includes('通用'))
          generalSettingsButton?.click()
          await waitForDom(() => document.querySelector('.settings-page')?.innerText.includes('清理安全边界')
            && document.querySelector('.settings-page')?.innerText.includes(appInfo.version), 'general-settings')
          const settingsRendered = document.body.innerText.includes('清理安全边界') && document.body.innerText.includes(appInfo.version)
          const settingsSearchAbsent = (
            !document.querySelector('.settings-page .search-maintenance-panel') &&
            ![...document.querySelectorAll('.settings-page h2')].some(heading => heading.textContent.includes('文件搜索')) &&
            !document.querySelector('.settings-page')?.innerText.includes('索引维护')
          )
          if (${JSON.stringify(process.env.DISK_SENSE_SMOKE_THEME === 'light')}) {
            const lightThemeButton = [...document.querySelectorAll('.theme-options button')].find(button => button.textContent.includes('浅色'))
            lightThemeButton?.click()
            await new Promise(resolve => setTimeout(resolve, 120))
          }
          const settingsDetailTab = ${JSON.stringify(process.env.DISK_SENSE_SMOKE_SETTINGS_TAB || '')}
          if (settingsDetailTab) {
            const detailLabel = settingsDetailTab === 'about' ? '关于' : '存储位置'
            const detailButton = [...document.querySelectorAll('.settings-tabs button')].find(button => button.textContent.includes(detailLabel))
            detailButton?.click()
            for (let attempt = 0; attempt < (settingsDetailTab === 'about' ? 80 : 4); attempt++) {
              await new Promise(resolve => setTimeout(resolve, 100))
              const ready = settingsDetailTab === 'about'
                ? document.body.innerText.includes('逻辑处理器')
                : document.body.innerText.includes('更改位置')
              if (ready) break
            }
          }
          const settingsDetailRendered = !settingsDetailTab || (
            settingsDetailTab === 'about'
              ? document.body.innerText.includes('设备信息') && document.body.innerText.includes('逻辑处理器')
              : document.body.innerText.includes('程序安装位置') && document.body.innerText.includes('更改位置')
          )
          const cleanerButton = [...document.querySelectorAll('.main-nav button')].find(button => button.textContent.includes('垃圾清理'))
          cleanerButton?.click()
          await waitForDom(() => document.querySelector('.cleaner-view-tabs'), 'cleaner-tabs')
          let historyRendered = true
          let historyWidthAligned = true
          const cleanerSafetyElement = document.querySelector('.cleaner-safety-state')
          const cleanerSafetyBackground = cleanerSafetyElement
            ? getComputedStyle(cleanerSafetyElement).backgroundColor
            : null
          if (${JSON.stringify(captureView)} !== 'cleaner') {
            const historyButton = [...document.querySelectorAll('.cleanup-tabs button')].find(button => button.textContent.includes('操作记录'))
            historyButton?.click()
            await waitForDom(() => document.querySelector('.history-panel')
              && document.body.innerText.includes('每一次清理和系统维护都有结果可查'), 'cleaner-history')
            historyRendered = document.body.innerText.includes('每一次清理和系统维护都有结果可查')
            const historyPanel = document.querySelector('.history-panel')?.getBoundingClientRect()
            const tabBar = document.querySelector('.cleaner-view-tabs')?.getBoundingClientRect()
            historyWidthAligned = Boolean(historyPanel && tabBar && Math.abs(historyPanel.width - tabBar.width) <= 1)
          }
          const overviewButton = [...document.querySelectorAll('.main-nav button')].find(button => button.textContent.includes('空间概览'))
          overviewButton?.click()
          await new Promise(resolve => setTimeout(resolve, 120))
          const overviewChangesAbsent = !document.querySelector('.overview-changes, .overview-changes-anchor, .baseline-card') &&
            !document.body.innerText.includes('查看空间变化') && !document.body.innerText.includes('变化基线')
          const overviewRendered = Boolean(document.querySelector('.live-overview') && document.body.innerText.includes('磁盘容量'))
          const homepageCapacityFirst = document.querySelector('.overview-page > section')?.classList.contains('live-overview') === true
          const overviewActivityCollapsed = !document.querySelector('.overview-activity')?.open
          const overviewAttributionAbsent = !document.querySelector('.space-sources') &&
            !document.querySelector('.overview-page')?.innerText.includes('空间归属') &&
            ['spaceSummary', 'spaceDiscover', 'spaceForget'].every(name => !(name in api))
          document.querySelector('.overview-page .hero-actions button')?.click()
          await new Promise(resolve => setTimeout(resolve, 200))
          const overviewBrowseNavigation = document.querySelector('.main-nav button.active')?.textContent.includes('目录与文件')
          overviewButton?.click()
          await new Promise(resolve => setTimeout(resolve, 100))
          const captureButton = [...document.querySelectorAll('.main-nav button')].find(button => button.textContent.includes(${JSON.stringify(captureLabel)}))
          captureButton?.click()
          await new Promise(resolve => setTimeout(resolve, 180))
          let inspectSearchRendered = null
          let inspectGlobalSearchConfigured = null
          let inspectSearchSettingsAbsent = null
          let inspectSearchAiAvailable = null
          let inspectSearchKeyboardSelection = null
          let inspectSearchKeyboardVisual = null
          let inspectNativeIconRendered = null
          let inspectAwaitingPanelHidden = null
          let inspectOfficeShortcutResolved = null
          let inspectBrowseNavigation = null
          let inspectBrowseFilter = null
          let inspectQuickSearchShortcut = null
          let inspectSearchSelectionIsLightweight = null
          let inspectSearchAdvanced = null
          let inspectSearchExamplesWorks = null
          let inspectIndexDetailsWorks = null
          if (${JSON.stringify(captureView)} === 'inspect') {
            document.querySelectorAll('.explorer-mode-switch button')[0]?.click()
            await new Promise(resolve => setTimeout(resolve, 80))
            const address = document.querySelector('.path-input-wrap input')
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
            setter?.call(address, ${JSON.stringify(smokeSearchRoot)})
            address?.dispatchEvent(new Event('input', { bubbles: true }))
            address?.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
            for (let attempt = 0; attempt < 60 && document.querySelector('.path-input-wrap input')?.value !== ${JSON.stringify(smokeSearchRoot)}; attempt++) await new Promise(resolve => setTimeout(resolve, 50))
            await new Promise(resolve => setTimeout(resolve, 200))
            const filter = document.querySelector('.browse-controls input')
            setter?.call(filter, 'Documents')
            filter?.dispatchEvent(new Event('input', { bubbles: true }))
            await new Promise(resolve => setTimeout(resolve, 80))
            inspectBrowseFilter = document.querySelectorAll('.file-row').length === 1 && document.querySelector('.file-row')?.textContent.includes('Documents')
            document.querySelector('.file-row')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
            for (let attempt = 0; attempt < 60 && !document.querySelector('.path-input-wrap input')?.value.endsWith('Documents'); attempt++) await new Promise(resolve => setTimeout(resolve, 50))
            const enteredDirectory = document.querySelector('.path-input-wrap input')?.value.endsWith('Documents')
            document.querySelector('.path-bar [aria-label="返回"]')?.click()
            await new Promise(resolve => setTimeout(resolve, 200))
            const backWorked = document.querySelector('.path-input-wrap input')?.value === ${JSON.stringify(smokeSearchRoot)}
            document.querySelector('.path-bar [aria-label="前进"]')?.click()
            await new Promise(resolve => setTimeout(resolve, 200))
            const forwardWorked = document.querySelector('.path-input-wrap input')?.value.endsWith('Documents')
            inspectBrowseNavigation = Boolean(enteredDirectory && backWorked && forwardWorked)
            document.querySelector('.path-bar [aria-label="返回"]')?.click()
            await new Promise(resolve => setTimeout(resolve, 200))
          }
          if (${JSON.stringify(process.env.DISK_SENSE_SMOKE_INSPECT_SEARCH === '1')} && ${JSON.stringify(captureView)} === 'inspect') {
            overviewButton?.click()
            await new Promise(resolve => setTimeout(resolve, 80))
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
            await new Promise(resolve => setTimeout(resolve, 120))
            const input = document.querySelector('.search-input-wrap input')
            inspectQuickSearchShortcut = Boolean(input && document.activeElement === input)
            inspectGlobalSearchConfigured = !document.querySelector('.search-commandbar > select')
            inspectSearchSettingsAbsent = ![...document.querySelectorAll('.search-commandbar button')]
              .some(button => button.textContent.includes('AI 设置'))
            const examples = [...document.querySelectorAll('.search-examples button')]
            if (input && examples.length === 3) {
              const emptyHasButtonSemantics = !document.querySelector('#explorer-items')?.hasAttribute('role')
              examples[0].click()
              await new Promise(resolve => setTimeout(resolve, 250))
              inspectSearchExamplesWorks = emptyHasButtonSemantics && input.value === 'report'
              document.querySelector('.search-clear')?.click()
              await new Promise(resolve => setTimeout(resolve, 100))
              inspectSearchExamplesWorks &&= !input.value && document.querySelectorAll('.search-examples button').length === 3
            }
            const indexDetails = document.querySelector('.search-index-details')
            indexDetails?.querySelector('summary')?.click()
            inspectIndexDetailsWorks = Boolean(indexDetails?.open && indexDetails.querySelector('.search-index-popover')?.getBoundingClientRect().width > 0)
            indexDetails?.querySelector('summary')?.click()
            inspectIndexDetailsWorks &&= !indexDetails?.open
            if (input) {
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
              setter?.call(input, ${JSON.stringify(smokeSearchQuery)})
              input.dispatchEvent(new Event('input', { bubbles: true }))
            }
            await new Promise(resolve => setTimeout(resolve, 1600))
            inspectSearchRendered = Boolean(
              document.querySelector('.search-workspace') &&
              document.querySelector('.search-results') &&
              [...document.querySelectorAll('.file-row')].some(row => row.textContent.includes(${JSON.stringify(smokeSearchExpected)}))
            )
            for (let attempt = 0; attempt < 20 && !document.querySelector('.native-result-icon'); attempt += 1) {
              await new Promise(resolve => setTimeout(resolve, 50))
            }
            inspectNativeIconRendered = Boolean(document.querySelector('.native-result-icon'))
            inspectOfficeShortcutResolved = !${JSON.stringify(smokeRequiresOfficeShortcut)} ||
              [...document.querySelectorAll('.file-row')].some(row => row.textContent.includes('Microsoft Word'))
            const awaitingLayout = document.querySelector('.explorer-layout.search-awaiting-selection')
            const awaitingPanel = awaitingLayout?.querySelector('.explain-panel')
            inspectAwaitingPanelHidden = Boolean(
              awaitingLayout && awaitingPanel && getComputedStyle(awaitingPanel).display === 'none'
            )
            input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
            await new Promise(resolve => setTimeout(resolve, 80))
            inspectSearchSelectionIsLightweight = Boolean(document.querySelector('.file-row.selected') && document.querySelector('.explorer-layout.search-awaiting-selection'))
            input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true }))
            for (let attempt = 0; attempt < 30; attempt += 1) {
              const selectedRow = document.querySelector('.file-row.selected')
              const explanationTitle = document.querySelector('.explanation-content .object-heading h2')
              const explanationText = document.querySelector('.explanation-content')?.textContent || ''
              inspectSearchKeyboardSelection = Boolean(
                selectedRow?.textContent.includes(${JSON.stringify(smokeSearchExpected)}) &&
                explanationTitle?.textContent.trim().toLocaleLowerCase().includes(${JSON.stringify(smokeSearchExpected.toLocaleLowerCase())}) &&
                explanationText.length > 20
              )
              if (inspectSearchKeyboardSelection) break
              await new Promise(resolve => setTimeout(resolve, 100))
            }
            const selectedRow = document.querySelector('.file-row.selected')
            const explanationContent = document.querySelector('.explanation-content')
            if (selectedRow && explanationContent) {
              const selectedStyle = getComputedStyle(selectedRow)
              const explanationStyle = getComputedStyle(explanationContent)
              const explanationRect = explanationContent.getBoundingClientRect()
              inspectSearchKeyboardVisual = {
                selectedBackground: selectedStyle.backgroundColor,
                selectedShadow: selectedStyle.boxShadow,
                explanationDisplay: explanationStyle.display,
                explanationVisibility: explanationStyle.visibility,
                explanationOpacity: explanationStyle.opacity,
                explanationColor: explanationStyle.color,
                explanationWidth: Math.round(explanationRect.width),
                explanationHeight: Math.round(explanationRect.height),
                explanationText: explanationContent.textContent.trim().slice(0, 80)
              }
            }
            inspectSearchAiAvailable = document.querySelectorAll('.ai-actions .ai-review').length === 1
            if ((await api.inspectIndexStatus()).building) await api.inspectIndexCancel()
          }
          if (${JSON.stringify(process.env.DISK_SENSE_SMOKE_SEARCH_ADVANCED === '1')} && ${JSON.stringify(captureView)} === 'inspect') {
            const input = document.querySelector('.search-input-wrap input')
            if (!input) throw new Error('advanced-search-input-missing: enable DISK_SENSE_SMOKE_INSPECT_SEARCH=1')
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
            const enterQuery = async query => {
              setter?.call(input, query)
              input?.dispatchEvent(new Event('input', { bubbles: true }))
              await new Promise(resolve => setTimeout(resolve, 600))
            }
            await enterQuery('baogao')
            const pinyinRow = [...document.querySelectorAll('.file-row')].find(row => row.textContent.includes('季度报告2026'))
            const pinyinHighlighted = pinyinRow && [...pinyinRow.querySelectorAll('mark')].map(mark => mark.textContent).join('') === '报告'
            let continuousInputComplete = true
            for (const query of ['page-rep', 'page-repo', 'page-rep']) {
              await enterQuery(query)
              const status = document.querySelector('.index-status')?.textContent || ''
              continuousInputComplete = continuousInputComplete && status.includes('145') && status.includes('100')
                && [...document.querySelectorAll('.file-row')].some(row => row.textContent.includes('page-report-'))
            }
            await enterQuery('page-report-')
            const moreButton = [...document.querySelectorAll('.search-actionbar button')].find(button => button.textContent.includes('加载更多'))
            const before = document.querySelector('.index-status')?.textContent || ''
            moreButton?.click()
            await new Promise(resolve => setTimeout(resolve, 600))
            const after = document.querySelector('.index-status')?.textContent || ''
            const allPagesLoaded = Boolean(moreButton && before.includes('145') && before.includes('100') && after.includes('145') && ![...document.querySelectorAll('.search-actionbar button')].some(button => button.textContent.includes('加载更多')))
            const waitForSearchView = async (condition, label) => {
              for (let attempt = 0; attempt < 100; attempt++) {
                if (condition()) return
                await new Promise(resolve => setTimeout(resolve, 30))
              }
              throw new Error('search-view-timeout: ' + label)
            }
            const loadedSearchRows = () => {
              const spacer = document.querySelector('.search-results .file-spacer')
              const row = document.querySelector('.search-results .file-row')
              const rowHeight = Number.parseFloat(row?.style.height || '')
              return rowHeight > 0 ? Math.round(Number.parseFloat(spacer?.style.height || '0') / rowHeight) : 0
            }
            const loadMoreSearchButton = () => [...document.querySelectorAll('.search-actionbar button')]
              .find(button => button.textContent.includes('加载更多'))
            await waitForSearchView(() => loadedSearchRows() === 145 && !loadMoreSearchButton(), 'all-145-before-sort')
            const sortControl = [...document.querySelectorAll('.search-filterbar select')]
              .find(select => [...select.options].some(option => option.value === 'relevance'))
            if (!sortControl) throw new Error('search-sort-control-missing')
            sortControl.value = 'name'
            sortControl.dispatchEvent(new Event('change', { bubbles: true }))
            const hasOrderedNamePage = () => {
              const names = [...document.querySelectorAll('.search-result-name')].map(row => row.textContent.trim())
              return names.length > 1 && names.every((name, index) => name === 'page-report-' + String(index).padStart(3, '0') + '.txt')
            }
            await waitForSearchView(() => loadedSearchRows() === 100 && hasOrderedNamePage()
              && (document.querySelector('#explorer-items')?.scrollTop || 0) === 0
              && !loadMoreSearchButton()?.disabled
              && (document.querySelector('.index-status')?.textContent || '').includes('已加载 100 项'), 'name-sort-first-100')
            const sortResetToFirstPage = loadedSearchRows() === 100 && hasOrderedNamePage()
            loadMoreSearchButton()?.click()
            await waitForSearchView(() => loadedSearchRows() === 145 && !loadMoreSearchButton(), 'name-sort-all-145')
            const sortResetsPage = sortResetToFirstPage && loadedSearchRows() === 145

            const sessionQuery = { query: 'page-report-', scope: 'all', kind: 'all', modified: 'any', limit: 100 }
            const candidateSession = await api.inspectSearch({ ...sessionQuery, sort: 'relevance' })
            let sortedSessionViews = Boolean(candidateSession.sessionId && candidateSession.total === 145 && candidateSession.items.length === 100)
            for (const sort of ['name', 'modified', 'size']) {
              const firstPage = await api.inspectSearch({ ...sessionQuery, sort, sessionId: candidateSession.sessionId, offset: 0 })
              const lastPage = await api.inspectSearch({ ...sessionQuery, sort, sessionId: candidateSession.sessionId, offset: 100 })
              sortedSessionViews = sortedSessionViews && firstPage.sessionId === candidateSession.sessionId
                && lastPage.sessionId === candidateSession.sessionId
                && firstPage.total === 145 && lastPage.total === 145
                && firstPage.items.length === 100 && lastPage.items.length === 45
                && firstPage.nextOffset === 100 && lastPage.nextOffset == null
                && new Set([...firstPage.items, ...lastPage.items].map(item => item.path)).size === 145
            }
            sortControl.value = 'relevance'
            sortControl.dispatchEvent(new Event('change', { bubbles: true }))
            await waitForSearchView(() => loadedSearchRows() === 100 && Boolean(loadMoreSearchButton()), 'restore-relevance-first-page')
            const rebuilding = await api.inspectIndexStart({ scope: 'all' })
            const during = await api.inspectSearch({ query: 'baogao', scope: 'all', kind: 'all', sort: 'relevance', modified: 'any', limit: 100 })
            const searchableDuringBuild = Boolean(rebuilding.started && during.index.building && during.items.some(item => item.name === '季度报告2026.txt'))
            if (during.index.building) await api.inspectIndexCancel()
            await enterQuery('vsc')
            const acronymRow = [...document.querySelectorAll('.file-row')].find(row => row.textContent.includes('VisualStudioCode.txt'))
            const acronymRecall = Boolean(acronymRow)
            await enterQuery('vsco')
            const changedRow = [...document.querySelectorAll('.file-row')].find(row => row.textContent.includes('VisualStudioCode.txt'))
            const highlightRefresh = [...(changedRow?.querySelectorAll('mark') || [])].map(mark => mark.textContent).join('') === 'VSCo'
            if (!acronymRecall || !highlightRefresh) throw new Error('abbreviation-recall-or-highlight-refresh-failed')
            inspectSearchAdvanced = { pinyinHighlighted: Boolean(pinyinHighlighted), continuousInputComplete, allPagesLoaded, sortResetsPage, sortedSessionViews, searchableDuringBuild, acronymRecall, highlightRefresh }
            await enterQuery('baogao')
          }
          let slimmingRendered = null
          let cleanerHistorySubviewRendered = null
          const cleanerDetailTab = ${JSON.stringify(process.env.DISK_SENSE_SMOKE_CLEANER_TAB || '')}
          if (cleanerDetailTab && ${JSON.stringify(captureView)} === 'cleaner') {
            const cleanerDetailLabel = cleanerDetailTab === 'history' ? '操作记录' : '系统瘦身'
            const cleanerDetailButton = [...document.querySelectorAll('.cleanup-tabs button')].find(button => button.textContent.includes(cleanerDetailLabel))
            cleanerDetailButton?.click()
          }
          if (cleanerDetailTab === 'slimming' && ${JSON.stringify(captureView)} === 'cleaner') {
            for (let attempt = 0; attempt < 80; attempt++) {
              await new Promise(resolve => setTimeout(resolve, 100))
              if (document.body.innerText.includes('执行边界') && document.querySelectorAll('.slimming-rule').length >= 4) break
            }
            slimmingRendered = (
              document.body.innerText.includes('命令和参数由程序白名单固定生成') &&
              document.body.innerText.includes('ResetBase') &&
              document.querySelectorAll('.slimming-rule').length >= 4
            )
          }
          if (cleanerDetailTab === 'history' && ${JSON.stringify(captureView)} === 'cleaner') {
            for (let attempt = 0; attempt < 20; attempt++) {
              await new Promise(resolve => setTimeout(resolve, 100))
              if (document.body.innerText.includes('每一次清理和系统维护都有结果可查')) break
            }
            cleanerHistorySubviewRendered = document.body.innerText.includes('每一次清理和系统维护都有结果可查')
          }
          let cleanerDrawerRendered = null
          const cleanerWorkspaceSimplified = ${JSON.stringify(captureView)} !== 'cleaner' || (
            document.querySelectorAll('.cleanup-tabs button').length === 3 &&
            !document.querySelector('option[value="quarantine"]') &&
            ['cleanerGovernance', 'cleanerPackageDocs', 'cleanerQuarantineList', 'cleanerQuarantineTarget', 'cleanerQuarantineRestore'].every(name => !(name in api))
          )
          if (${JSON.stringify(process.env.DISK_SENSE_SMOKE_CLEANER_DRAWER === '1')} && ${JSON.stringify(captureView)} === 'cleaner') {
            document.querySelector('.cleanup-tabs button')?.click()
            await new Promise(resolve => setTimeout(resolve, 120))
            const exclusionButton = [...document.querySelectorAll('.cleaner-command-actions button')].find(button => button.textContent.includes('排除项'))
            exclusionButton?.click()
            await new Promise(resolve => setTimeout(resolve, 120))
            cleanerDrawerRendered = Boolean(
              document.querySelector('.cleaner-drawer') &&
              document.body.innerText.includes('这些路径不会进入任何清理候选')
            )
            document.querySelector('.cleaner-drawer .modal-close')?.click()
            await new Promise(resolve => setTimeout(resolve, 80))
          }
          let cleanerScanRendered = null
          let cleanerCategoryCount = 0
          let cleanerRuleDetailCount = 0
          if (${JSON.stringify(process.env.DISK_SENSE_SMOKE_SCAN_CLEANER === '1')} && ${JSON.stringify(captureView)} === 'cleaner') {
            document.querySelector('.cleanup-tabs button')?.click()
            await new Promise(resolve => setTimeout(resolve, 120))
            const scanButtons = [...document.querySelectorAll('.cleaner-command-actions .secondary-button')]
            const scanButton = scanButtons.at(-1)
            scanButton?.click()
            for (let attempt = 0; attempt < 450; attempt++) {
              await new Promise(resolve => setTimeout(resolve, 200))
              const statusText = document.querySelector('.scan-time-stat small')?.textContent || ''
              if (statusText.includes(String(rules.length) + ' / ' + String(rules.length))) break
            }
            cleanerCategoryCount = document.querySelectorAll('.cleaner-category').length
            document.querySelector('.cleaner-category-row')?.click()
            await new Promise(resolve => setTimeout(resolve, 80))
            cleanerRuleDetailCount = document.querySelectorAll('.compact-rule').length
            const finalStatusText = document.querySelector('.scan-time-stat small')?.textContent || ''
            cleanerScanRendered = (
              Boolean(document.querySelector('.cleaner-stats')) &&
              finalStatusText.includes(String(rules.length) + ' / ' + String(rules.length)) &&
              cleanerCategoryCount > 0 &&
              cleanerRuleDetailCount > 0
            )
            if (cleanerDetailTab) {
              const cleanerDetailLabel = cleanerDetailTab === 'history' ? '操作记录' : '系统瘦身'
              const cleanerDetailButton = [...document.querySelectorAll('.cleanup-tabs button')]
                .find(button => button.textContent.includes(cleanerDetailLabel))
              cleanerDetailButton?.click()
              await new Promise(resolve => setTimeout(resolve, 120))
            }
          }
          let lightThemeSurfaces = null
          let aiDialogKeyboardNavigation = null
          if (
            ${JSON.stringify(process.env.DISK_SENSE_SMOKE_THEME === 'light')} &&
            ${JSON.stringify(captureView)} === 'inspect' &&
            ${JSON.stringify(process.env.DISK_SENSE_SMOKE_SKIP_LIGHT_SURFACES !== '1')}
          ) {
            const background = selector => {
              const element = document.querySelector(selector)
              return element ? getComputedStyle(element).backgroundColor : null
            }
            const isLightSurface = value => {
              const serialized = String(value || '')
              const start = serialized.indexOf('(')
              const end = serialized.lastIndexOf(')')
              const channels = start >= 0 && end > start
                ? serialized.slice(start + 1, end).split(',').slice(0, 3).map(channel => Number.parseFloat(channel))
                : []
              return Boolean(channels?.length === 3 && channels.reduce((sum, channel) => sum + channel, 0) / 3 >= 190)
            }
            const iconProbe = document.createElement('span')
            iconProbe.className = 'file-name'
            iconProbe.innerHTML = '<i></i><i class="directory"></i>'
            document.querySelector('#app')?.append(iconProbe)
            const fileIconBackground = getComputedStyle(iconProbe.children[0]).backgroundColor
            const folderIconBackground = getComputedStyle(iconProbe.children[1]).backgroundColor
            iconProbe.remove()
            const searchModeWasActive = document.querySelector('.explorer-mode-switch button.active')
              ?.textContent.includes('文件搜索')
            settingsButton?.click()
            await waitForDom(() => document.querySelector('.settings-tabs'), 'light-settings-tabs')
            ;[...document.querySelectorAll('.settings-tabs button')].find(button => button.textContent.includes('通用'))?.click()
            await waitForDom(() => document.querySelector('.settings-ai-entry'), 'light-ai-entry')
            document.querySelector('.settings-ai-entry')?.click()
            await waitForDom(() => document.querySelector('.ai-settings-card .model-picker'), 'light-ai-dialog')
            await new Promise(resolve => setTimeout(resolve, 120))
            const modalBackground = background('.modal-card')
            const modelButton = document.querySelector('.model-picker .quiet')
            const actionButton = document.querySelector('.modal-actions .quiet')
            const disabledModelButtonBackground = modelButton ? getComputedStyle(modelButton).backgroundColor : null
            const disabledActionButtonBackground = actionButton ? getComputedStyle(actionButton).backgroundColor : null
            if (modelButton) modelButton.disabled = false
            if (actionButton) actionButton.disabled = false
            const modelButtonBackground = modelButton ? getComputedStyle(modelButton).backgroundColor : null
            const actionButtonBackground = actionButton ? getComputedStyle(actionButton).backgroundColor : null
            const privacyBackground = background('.ai-privacy')
            lightThemeSurfaces = {
              fileIconBackground,
              folderIconBackground,
              modalBackground,
              modelButtonBackground,
              actionButtonBackground,
              disabledModelButtonBackground,
              disabledActionButtonBackground,
              privacyBackground,
              fileIconIsLight: isLightSurface(fileIconBackground),
              folderIconIsLight: isLightSurface(folderIconBackground),
              modalIsLight: isLightSurface(modalBackground),
              modelButtonIsLight: isLightSurface(modelButtonBackground),
              actionButtonIsLight: isLightSurface(actionButtonBackground),
              disabledModelButtonIsLight: isLightSurface(disabledModelButtonBackground),
              disabledActionButtonIsLight: isLightSurface(disabledActionButtonBackground),
              privacyIsLight: isLightSurface(privacyBackground)
            }
            const cancelButton = [...document.querySelectorAll('.modal-actions button')]
              .find(button => button.textContent.includes('取消'))
            const aiDialog = document.querySelector('.ai-settings-card')
            const closeButton = aiDialog?.querySelector('.modal-close')
            const focusStartsInsideDialog = document.activeElement === closeButton && aiDialog?.getAttribute('role') === 'dialog'
            // Restore the disabled state changed above for color probes before exercising Tab.
            if (modelButton) modelButton.disabled = true
            if (actionButton) actionButton.disabled = true
            closeButton?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
            const tabWrapsBackward = document.activeElement === cancelButton
            cancelButton?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
            const tabWrapsForward = document.activeElement === closeButton
            closeButton?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
            await new Promise(resolve => setTimeout(resolve, 80))
            aiDialogKeyboardNavigation = Boolean(focusStartsInsideDialog && tabWrapsBackward && tabWrapsForward && !document.querySelector('.ai-settings-card'))
            document.querySelectorAll('.main-nav button')[1]?.click()
            await waitForDom(() => document.querySelector('.explorer-page'), 'restore-light-explorer')
            if (searchModeWasActive) {
              document.querySelectorAll('.explorer-mode-switch button')[1]?.click()
              await new Promise(resolve => setTimeout(resolve, 100))
            }
          }
          const captureNavigation = document.querySelectorAll('.main-nav button')[${captureNavigationIndex}]
          captureNavigation?.click()
          await new Promise(resolve => setTimeout(resolve, 180))
          if (${JSON.stringify(process.env.DISK_SENSE_SMOKE_INSPECT_TARGET || '')}) {
            const target = [...document.querySelectorAll('.file-row')].find(row => row.textContent.includes(${JSON.stringify(process.env.DISK_SENSE_SMOKE_INSPECT_TARGET || '')}))
            target?.click()
            for (let attempt = 0; attempt < 40 && !document.querySelector('.explanation-content .object-heading h2')?.textContent.includes(${JSON.stringify(process.env.DISK_SENSE_SMOKE_INSPECT_TARGET || '')}); attempt++) await new Promise(resolve => setTimeout(resolve, 50))
          }
          let aiSetupPresetWorks = null
          let aiSetupManualModel = null
          let aiSetupInvalidEndpointBlocked = null
          if (${JSON.stringify(process.env.DISK_SENSE_SMOKE_AI_SETTINGS === '1')}) {
            const entry = document.querySelector('.settings-ai-entry') || document.querySelector('.ai-config-link')
            entry?.click()
            await new Promise(resolve => setTimeout(resolve, 150))
            document.querySelectorAll('.ai-service-presets button')[2]?.click()
            await new Promise(resolve => setTimeout(resolve, 50))
            const modal = document.querySelector('.ai-settings-card')
            const endpoint = [...(modal?.querySelectorAll('input') || [])].find(input => input.placeholder.includes('127.0.0.1'))
            const model = modal?.querySelector('.model-picker input')
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
            aiSetupPresetWorks = endpoint?.value === 'http://127.0.0.1:11434/v1'
            setter?.call(model, 'example-model')
            model?.dispatchEvent(new Event('input', { bubbles: true }))
            await new Promise(resolve => setTimeout(resolve, 800))
            const save = modal?.querySelector('.modal-actions .scan')
            aiSetupManualModel = Boolean(save && !save.disabled && !modal.querySelector('.ai-connection-message'))
            setter?.call(endpoint, 'http://public.example.test/v1')
            endpoint?.dispatchEvent(new Event('input', { bubbles: true }))
            await new Promise(resolve => setTimeout(resolve, 50))
            aiSetupInvalidEndpointBlocked = Boolean(save?.disabled)
            setter?.call(endpoint, 'http://127.0.0.1:11434/v1')
            endpoint?.dispatchEvent(new Event('input', { bubbles: true }))
            await new Promise(resolve => setTimeout(resolve, 50))
          }
          if (${JSON.stringify(process.env.DISK_SENSE_SMOKE_SEARCH_PANEL === '0')}) {
            document.querySelector('[aria-label="收起文件分析"]')?.click()
            await new Promise(resolve => setTimeout(resolve, 80))
          }
          const captureQuery = ${JSON.stringify(process.env.DISK_SENSE_SMOKE_CAPTURE_EMPTY === '1' ? '' : process.env.DISK_SENSE_SMOKE_CAPTURE_QUERY ?? null)}
          if (captureQuery !== null && ${JSON.stringify(captureView)} === 'inspect') {
            const input = document.querySelector('.search-input-wrap input')
            if (!input) throw new Error('capture-search-input-missing')
            if (captureQuery === '') document.querySelector('.search-clear')?.click()
            else {
              Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, captureQuery)
              input.dispatchEvent(new Event('input', { bubbles: true }))
            }
            await new Promise(resolve => setTimeout(resolve, 700))
            if (input.value !== captureQuery) throw new Error('capture-query-not-applied')
          }
          // Public documentation uses fixture paths and synthetic capacity, never host data.
          // This runs only after the real interaction assertions have been collected.
          if (${JSON.stringify(process.env.DISK_SENSE_SMOKE_PUBLIC_PREVIEW === '1')} && ${JSON.stringify(captureView)} === 'overview') {
            const capacitySummary = document.querySelector('.capacity-summary')
            if (capacitySummary) {
              capacitySummary.querySelector('strong').textContent = '475 GB'
              capacitySummary.querySelector('p').textContent = '共 1 TB 容量 · 已用 525 GB'
            }
            document.querySelectorAll('.volume-grid article').forEach((element, index) => {
              if (index > 1) { element.remove(); return }
              element.querySelector('.volume-title b').textContent = index ? 'D:\\\\' : 'C:\\\\'
              element.querySelector('.volume-title strong').innerHTML = (index ? '35%' : '70%') + '<small>已使用</small>'
              element.querySelector('.volume-bar i').style.width = index ? '35%' : '70%'
              element.querySelector('.volume-numbers').textContent = index ? '325 GB 可用 · 175 GB / 500 GB' : '150 GB 可用 · 350 GB / 500 GB'
            })
            const sensitiveText = document.querySelector('.overview-page')?.innerText || ''
            if (sensitiveText.includes(${JSON.stringify(isolatedUserData)}) || sensitiveText.includes(${JSON.stringify(os.homedir())})) throw new Error('public-preview-contains-host-path')
            await new Promise(resolve => setTimeout(resolve, 100))
          }
          if (${JSON.stringify(process.env.DISK_SENSE_SMOKE_PUBLIC_PREVIEW === '1')} && ${JSON.stringify(captureView)} === 'inspect') {
            const panel = document.querySelector('.explorer-page')
            const sanitize = text => text.split(${JSON.stringify(smokeSearchRoot)}).join('D:\\\\Projects\\\\SpaceDemo')
              .split(${JSON.stringify(isolatedUserData)}).join('D:\\\\DiskSenseDemo')
              .split(${JSON.stringify(os.homedir())}).join('C:\\\\Users\\\\Demo')
            const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT)
            while (walker.nextNode()) walker.currentNode.textContent = sanitize(walker.currentNode.textContent)
            panel?.querySelectorAll('input').forEach(input => { input.value = sanitize(input.value) })
            panel?.querySelectorAll('[title]').forEach(element => element.removeAttribute('title'))
            if (document.querySelector('.path-bar')) {
              const breadcrumbs = panel?.querySelector('.breadcrumbs')
              if (breadcrumbs) breadcrumbs.innerHTML = '<button>D:</button><button>Projects</button><button>SpaceDemo</button>'
            }
            if (panel?.innerText.includes(${JSON.stringify(os.homedir())})) throw new Error('public-preview-contains-host-path')
          }
          const layoutFitsWindow = document.documentElement.scrollWidth <= window.innerWidth &&
            [...document.querySelectorAll('.page-header, .live-overview, .cleaner-view-tabs, .cleaner-workspace, .cleaner-command-actions, .slimming-workspace, .history-panel, .settings-tabs, .path-bar, .search-commandbar, .search-filterbar, .file-list, .explain-panel')]
              .filter(element => element.getBoundingClientRect().width > 0)
              .every(element => element.getBoundingClientRect().left >= 0 && element.getBoundingClientRect().right <= window.innerWidth + 1)
          const directoryAddressFitsRow = !document.querySelector('.path-bar') || document.querySelector('.path-bar').getBoundingClientRect().height <= 70
          const capturedPng = (
            ${JSON.stringify(process.env.DISK_SENSE_SMOKE_USE_BRIDGE_SCREENSHOT === '1')} &&
            ${JSON.stringify(process.env.DISK_SENSE_SMOKE_SKIP_SCREENSHOT !== '1')} &&
            typeof api.smokeCapture === 'function'
          )
            ? await api.smokeCapture()
            : null
          const hmrWebSocketConnected = ${JSON.stringify(process.env.DISK_SENSE_SMOKE_DEV === '1')}
            ? await new Promise(async resolve => {
                const clientSource = await fetch('/@vite/client').then(response => response.text()).catch(() => '')
                const token = clientSource.match(/const wsToken = "([^"]+)"/u)?.[1] || ''
                if (!token) return resolve(false)
                const socket = new WebSocket(
                  location.origin.replace(/^http/u, 'ws') + '?token=' + encodeURIComponent(token),
                  'vite-hmr'
                )
                const timeout = setTimeout(() => {
                  socket.close()
                  resolve(false)
                }, 3000)
                socket.addEventListener('open', () => {
                  clearTimeout(timeout)
                  socket.close()
                  resolve(true)
                }, { once: true })
                socket.addEventListener('error', () => {
                  clearTimeout(timeout)
                  resolve(false)
                }, { once: true })
              })
            : null
          const summary = {
            title: document.title,
            rendered: Boolean(document.querySelector('#app .page')),
            bridge: Boolean(api),
            hmrWebSocketConnected,
            ruleCount: rules.length,
            rootItems: root.items.length,
            rootPath: root.path,
            slimmingCount: slimming.length,
            slimmingActionCount: slimming.flatMap(item => item.actions || []).length,
            maintenanceElevated: slimmingStatus.elevated,
            maintenanceActive: Boolean(slimmingStatus.activeTask),
            maintenanceHistoryCount: maintenanceHistory.length,
            maintenanceActionsOpaque: slimming.flatMap(item => item.actions || []).every(action => (
              !Object.prototype.hasOwnProperty.call(action, 'args') &&
              !Object.prototype.hasOwnProperty.call(action, 'executable')
            )),
            aiConfigured: ai.configured,
            hasChangeState: Boolean(changes),
            changeHistoryCount: changes.history.length,
            scanRule: scan.id,
            scanFiles: scan.files.length,
            scanTruncated: scan.truncated,
            volumeCount: overview.volumes.length,
            appVersion: appInfo.version,
            runtimeVersions: appInfo.runtimeVersions,
            stateVersion: appInfo.stateVersion,
            dataPath: appInfo.userDataPath,
            dataUsageFiles: dataUsage.files,
            installPath: appInfo.installPath,
            appearanceTheme: appearance.theme,
            renderedTheme: document.documentElement.dataset.theme,
            deviceName: deviceInfo.deviceName,
            processor: deviceInfo.processor,
            deviceHasVolumes: Object.prototype.hasOwnProperty.call(deviceInfo, 'volumes'),
            searchIndexAvailable: searchIndex.available,
            searchIndexBuilding: searchIndex.building,
            inspectSearchRendered,
            inspectBrowseNavigation,
            inspectBrowseFilter,
            inspectQuickSearchShortcut,
            inspectSearchSelectionIsLightweight,
            inspectSearchAdvanced,
            inspectSearchExamplesWorks,
            inspectIndexDetailsWorks,
            inspectGlobalSearchConfigured,
            inspectSearchSettingsAbsent,
            inspectSearchAiAvailable,
            inspectSearchKeyboardSelection,
            inspectSearchKeyboardVisual,
            inspectNativeIconRendered,
            inspectAwaitingPanelHidden,
            inspectOfficeShortcutResolved,
            packaged: appInfo.packaged,
            security: appInfo.security,
            migrationRecoveryVerified,
            explanation: explanation ? {
              classification: explanation.classification,
              what: explanation.what,
              purpose: explanation.purpose,
              risk: explanation.risk
            } : null,
            settingsRendered,
            settingsSearchAbsent,
            settingsDetailRendered,
            historyRendered,
            historyWidthAligned,
            cleanerSafetyBackground,
            overviewRendered,
            homepageCapacityFirst,
            overviewActivityCollapsed,
            layoutFitsWindow,
            directoryAddressFitsRow,
            overviewAttributionAbsent,
            overviewBrowseNavigation,
            overviewChangesAbsent,
            cleanerScanRendered,
            cleanerCategoryCount,
            cleanerRuleDetailCount,
            slimmingRendered,
            cleanerHistorySubviewRendered,
            cleanerDrawerRendered,
            cleanerWorkspaceSimplified,
            lightThemeSurfaces,
            aiDialogKeyboardNavigation,
            aiSetupPresetWorks,
            aiSetupManualModel,
            aiSetupInvalidEndpointBlocked,
            historyCount: history.length,
            exclusionCount: exclusions.length,
            finalActiveNavigation: document.querySelector('.main-nav button.active')?.innerText || document.querySelector('.main-nav button.active')?.getAttribute('aria-label') || '',
            finalHeading: document.querySelector('.workspace h1')?.innerText || '',
            capturedPng
          }
          if (${JSON.stringify(process.env.DISK_SENSE_SMOKE_FRONTEND_AUDIT === '1')}) {
            summary.frontendAudit = await (${captureFrontend.toString()})(api, { searchRoot: ${JSON.stringify(smokeSearchRoot)}, fixtures: ${JSON.stringify(frontendFixtures)}, migrationRecovery: ${JSON.stringify(migrationFailureFixture)}, originalDataPath: ${JSON.stringify(fixtureUserData)}, dumpPath: ${JSON.stringify(path.join(fixtureLocalData, 'CrashDumps', 'frontend-preview.dmp'))}, discoveryCachePath: ${JSON.stringify(path.join(fixtureLocalData, 'DingTalk_108', 'Code Cache', 'discovery-preview.tmp'))} })
          }
          return summary
        })()`,
        awaitPromise: true,
        returnByValue: true
      }
    }))
  })
  if (result.result?.exceptionDetails) {
    const details = result.result.exceptionDetails
    throw new Error(details.exception?.description || details.text || 'renderer-evaluation-failed')
  }
  const value = result.result?.result?.value
  if (!value) throw new Error(`renderer-returned-no-smoke-result: ${JSON.stringify(result)}`)
  if (value.frontendAudit) {
    const tag = process.env.DISK_SENSE_SMOKE_CAPTURE_TAG || ''
    if (tag && !/^[a-z0-9-]{1,64}$/u.test(tag)) throw new Error('invalid-smoke-capture-tag')
    const folder = path.resolve('release', `frontend-full-${value.renderedTheme}-${Number.parseInt(process.env.DISK_SENSE_WINDOW_WIDTH || '1280', 10)}${frontendFixtures ? '-fixtures' : ''}${tag ? '-' + tag : ''}`)
    fs.mkdirSync(folder, { recursive: true })
    for (const capture of value.frontendAudit.captures) {
      if (!/^[a-z0-9-]+$/u.test(capture.name)) throw new Error('invalid-frontend-capture-name')
      const filename = path.join(folder, `${capture.name}.png`)
      fs.writeFileSync(filename, Buffer.from(capture.png, 'base64'))
      delete capture.png
      capture.file = path.relative(process.cwd(), filename)
    }
    fs.writeFileSync(path.join(folder, 'validation.json'), JSON.stringify(value.frontendAudit, null, 2) + '\n')
    if (value.frontendAudit.error) throw new Error(value.frontendAudit.error)
  }
  let screenshot = value.capturedPng || null
  delete value.capturedPng
  if (!screenshot && process.env.DISK_SENSE_SMOKE_SKIP_SCREENSHOT !== '1') try {
    // Runtime.evaluate keeps the renderer busy until the complete smoke scenario
    // returns. Give Chromium a frame to commit the final Vue state before capture.
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('cdp-paint-flush-timeout')), 10000)
      const listener = event => {
        const message = JSON.parse(String(event.data))
        if (message.id !== 2) return
        clearTimeout(timeout)
        socket.removeEventListener('message', listener)
        if (message.error) reject(new Error(message.error.message || 'cdp-paint-flush-failed'))
        else resolve(message.result)
      }
      socket.addEventListener('message', listener)
      socket.send(JSON.stringify({
        id: 2,
        method: 'Runtime.evaluate',
        params: {
          expression: 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(document.body.offsetHeight))))',
          awaitPromise: true,
          returnByValue: true
        }
      }))
    })
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('cdp-page-enable-timeout')), 10000)
      const listener = event => {
        const message = JSON.parse(String(event.data))
        if (message.id !== 3) return
        clearTimeout(timeout)
        socket.removeEventListener('message', listener)
        if (message.error) reject(new Error(message.error.message || 'cdp-page-enable-failed'))
        else resolve(message.result)
      }
      socket.addEventListener('message', listener)
      socket.send(JSON.stringify({ id: 3, method: 'Page.enable' }))
    })
    screenshot = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('cdp-screenshot-timeout')), 30000)
      const listener = event => {
        const message = JSON.parse(String(event.data))
        if (message.id !== 4) return
        clearTimeout(timeout)
        socket.removeEventListener('message', listener)
        if (message.error) reject(new Error(message.error.message || 'cdp-screenshot-failed'))
        else resolve(message.result?.data)
      }
      socket.addEventListener('message', listener)
      socket.send(JSON.stringify({
        id: 4,
        method: 'Page.captureScreenshot',
        params: { format: 'png', captureBeyondViewport: false, fromSurface: true }
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
  socket.send(JSON.stringify({ id: 5, method: 'Browser.close' }))
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
    !result?.overviewAttributionAbsent || !result?.overviewBrowseNavigation ||
    (process.env.DISK_SENSE_SMOKE_DEV === '1' && !result?.hmrWebSocketConnected) ||
    result?.ruleCount < 8 ||
    result?.rootPath !== 'C:\\' ||
    result?.slimmingCount < 4 ||
    result?.slimmingActionCount < 5 ||
    !result?.maintenanceActionsOpaque ||
    result?.scanRule !== 'crash-dumps' ||
    result?.volumeCount < 1 ||
    result?.stateVersion !== 7 ||
    !result?.dataPath ||
    result?.dataUsageFiles < 1 ||
    !result?.installPath ||
    !['dark', 'light'].includes(result?.appearanceTheme) ||
    !['dark', 'light'].includes(result?.renderedTheme) ||
    result?.renderedTheme !== (process.env.DISK_SENSE_SMOKE_THEME === 'light' ? 'light' : 'dark') ||
    !result?.deviceName ||
    !result?.processor ||
    result?.deviceHasVolumes ||
    (process.env.DISK_SENSE_SMOKE_SEARCH_ADVANCED === '1' && (
      !result?.inspectSearchAdvanced?.pinyinHighlighted || !result?.inspectSearchAdvanced?.continuousInputComplete || !result?.inspectSearchAdvanced?.allPagesLoaded ||
      !result?.inspectSearchAdvanced?.sortResetsPage || !result?.inspectSearchAdvanced?.sortedSessionViews ||
      !result?.inspectSearchAdvanced?.searchableDuringBuild
    )) ||
    !result?.searchIndexAvailable ||
    result?.searchIndexBuilding ||
    (
      process.env.DISK_SENSE_SMOKE_INSPECT_SEARCH === '1' &&
      (
        !result?.inspectSearchRendered ||
        !result?.inspectSearchExamplesWorks || !result?.inspectIndexDetailsWorks ||
        !result?.inspectQuickSearchShortcut ||
        !result?.inspectSearchSelectionIsLightweight ||
        !result?.inspectGlobalSearchConfigured ||
        !result?.inspectSearchSettingsAbsent ||
        !result?.inspectSearchAiAvailable ||
        !result?.inspectSearchKeyboardSelection ||
        !result?.inspectNativeIconRendered ||
        !result?.inspectAwaitingPanelHidden ||
        !result?.inspectOfficeShortcutResolved
      )
    ) ||
    (captureView === 'inspect' && (!result?.inspectBrowseNavigation || !result?.inspectBrowseFilter)) ||
    (process.env.DISK_SENSE_SMOKE_DEV !== '1' && !electronRuntime && !result?.packaged) ||
    !result?.security?.rendererSandbox ||
    !result?.security?.contextIsolation ||
    !result?.security?.rendererPermissionsDenied ||
    result?.security?.permanentDelete ||
    !result?.security?.systemMaintenanceAllowlist ||
    !result?.explanation?.what ||
    !result?.explanation?.purpose ||
    !result?.settingsRendered ||
    !result?.settingsSearchAbsent ||
    !result?.settingsDetailRendered ||
    !result?.historyRendered ||
    !result?.historyWidthAligned ||
    (
      process.env.DISK_SENSE_SMOKE_THEME === 'light' &&
      !/^rgba?\(255, 255, 255(?:, 1)?\)$/u.test(String(result?.cleanerSafetyBackground || ''))
    ) ||
    !result?.overviewRendered || !result?.homepageCapacityFirst || !result?.overviewActivityCollapsed || !result?.layoutFitsWindow || !result?.directoryAddressFitsRow ||
    (process.env.DISK_SENSE_SMOKE_AI_SETTINGS === '1' && (!result?.aiSetupPresetWorks || !result?.aiSetupManualModel || !result?.aiSetupInvalidEndpointBlocked)) ||
    !result?.overviewChangesAbsent ||
    !result?.finalActiveNavigation?.includes(captureLabel) ||
    (process.env.DISK_SENSE_SMOKE_CLEANER_TAB === 'slimming' && !result?.slimmingRendered) ||
    (process.env.DISK_SENSE_SMOKE_CLEANER_TAB === 'history' && !result?.cleanerHistorySubviewRendered) ||
    !result?.cleanerWorkspaceSimplified ||
    (process.env.DISK_SENSE_SMOKE_CLEANER_DRAWER === '1' && !result?.cleanerDrawerRendered) ||
    (process.env.DISK_SENSE_SMOKE_SCAN_CLEANER === '1' && !result?.cleanerScanRendered) ||
    (
      process.env.DISK_SENSE_SMOKE_THEME === 'light' &&
      captureView === 'inspect' &&
      process.env.DISK_SENSE_SMOKE_SKIP_LIGHT_SURFACES !== '1' &&
      (
        !result?.aiDialogKeyboardNavigation ||
        !result?.lightThemeSurfaces?.fileIconIsLight ||
        !result?.lightThemeSurfaces?.folderIconIsLight ||
        !result?.lightThemeSurfaces?.modalIsLight ||
        !result?.lightThemeSurfaces?.modelButtonIsLight ||
        !result?.lightThemeSurfaces?.actionButtonIsLight ||
        !result?.lightThemeSurfaces?.disabledModelButtonIsLight ||
        !result?.lightThemeSurfaces?.disabledActionButtonIsLight ||
        !result?.lightThemeSurfaces?.privacyIsLight
      )
    )
  ) {
    throw new Error(`packaged-smoke-assertion-failed: ${JSON.stringify(result)}`)
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} catch (error) {
  const diagnosticPath = path.join(fixtureUserData, 'disk-sense.log')
  if (fs.existsSync(diagnosticPath)) {
    try {
      fs.mkdirSync(path.resolve('release'), { recursive: true })
      fs.copyFileSync(diagnosticPath, path.resolve(`release/smoke-failure-${process.pid}.log`))
    } catch {
      // The app may still be releasing its diagnostic handle on Windows.
      // Preserve the original smoke-test error instead of masking it.
    }
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
