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
const developmentServerUrl = new URL(process.env.DISK_SENSE_DEV_SERVER_URL || 'http://127.0.0.1:5173/')
const captureView = ['overview', 'inspect', 'cleaner', 'changes', 'settings'].includes(process.env.DISK_SENSE_SMOKE_VIEW)
  ? process.env.DISK_SENSE_SMOKE_VIEW
  : 'overview'
const captureNavigationView = captureView === 'changes' ? 'overview' : captureView
const captureLabel = {
  overview: '空间概览',
  inspect: '目录与文件',
  cleaner: '垃圾清理',
  changes: '变化记录',
  settings: '设置与关于'
}[captureNavigationView]
const captureNavigationIndex = {
  overview: 0,
  inspect: 1,
  cleaner: 2,
  settings: 3
}[captureNavigationView]
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
if (realWordShortcutAvailable) fs.copyFileSync(systemWordShortcut, smokeWordShortcut)
else fs.writeFileSync(smokeWordShortcut, 'shortcut fixture')
fs.writeFileSync(path.join(smokeSearchRoot, 'Users', 'Test', 'Documents', 'word-plan.docx'), 'document fixture')
fs.writeFileSync(path.join(smokeSearchRoot, 'node_modules', 'word', 'lib', 'word.tcl'), 'dependency fixture')
const smokeSearchQuery = process.env.DISK_SENSE_SMOKE_SEARCH_QUERY || '*$Recycle*'
const smokeSearchExpected = process.env.DISK_SENSE_SMOKE_SEARCH_EXPECTED || '$Recycle.Bin'
const smokeRequiresOfficeShortcut = realWordShortcutAvailable && smokeSearchQuery.toLocaleLowerCase().includes('word')
const smokeArguments = process.env.DISK_SENSE_SMOKE_DEV === '1'
  ? ['--disable-gpu', `--remote-debugging-port=${port}`, path.resolve('desktop/main.cjs'), '--dev', '--smoke-test']
  : [`--remote-debugging-port=${port}`, '--smoke-test']
const child = spawn(executable, smokeArguments, {
  stdio: process.env.DISK_SENSE_SMOKE_DEV === '1' ? 'inherit' : 'ignore',
  windowsHide: true,
  env: {
    ...process.env,
    DISK_SENSE_USER_DATA: isolatedUserData,
    DISK_SENSE_SMOKE_SEARCH_ROOT: smokeSearchRoot,
    DISK_SENSE_SMOKE_HEADLESS: '1'
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
          const generalSettingsButton = [...document.querySelectorAll('.settings-tabs button')]
            .find(button => button.textContent.includes('通用'))
          generalSettingsButton?.click()
          await new Promise(resolve => setTimeout(resolve, 80))
          const settingsRendered = document.body.innerText.includes('清理安全边界') && document.body.innerText.includes(appInfo.version)
          const searchMaintenanceRendered = (
            document.body.innerText.includes('文件搜索') &&
            document.body.innerText.includes('重新建立搜索数据库')
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
          await new Promise(resolve => setTimeout(resolve, 80))
          let historyRendered = true
          let historyWidthAligned = true
          const cleanerSafetyElement = document.querySelector('.cleaner-safety-state')
          const cleanerSafetyBackground = cleanerSafetyElement
            ? getComputedStyle(cleanerSafetyElement).backgroundColor
            : null
          if (${JSON.stringify(captureView)} !== 'cleaner') {
            const historyButton = [...document.querySelectorAll('.cleanup-tabs button')].find(button => button.textContent.includes('操作记录'))
            historyButton?.click()
            await new Promise(resolve => setTimeout(resolve, 80))
            historyRendered = document.body.innerText.includes('每一次清理和系统维护都有结果可查')
            const historyPanel = document.querySelector('.history-panel')?.getBoundingClientRect()
            const tabBar = document.querySelector('.cleaner-view-tabs')?.getBoundingClientRect()
            historyWidthAligned = Boolean(historyPanel && tabBar && Math.abs(historyPanel.width - tabBar.width) <= 1)
          }
          const overviewButton = [...document.querySelectorAll('.main-nav button')].find(button => button.textContent.includes('空间概览'))
          overviewButton?.click()
          await new Promise(resolve => setTimeout(resolve, 120))
          const overviewChangesRendered = Boolean(document.querySelector('.overview-changes'))
          const overviewRendered = document.body.innerText.includes('看得懂的空间地图')
          const captureButton = [...document.querySelectorAll('.main-nav button')].find(button => button.textContent.includes(${JSON.stringify(captureLabel)}))
          captureButton?.click()
          await new Promise(resolve => setTimeout(resolve, 180))
          if (${JSON.stringify(captureView)} === 'changes') {
            document.querySelector('.overview-changes-anchor')?.scrollIntoView({ block: 'start' })
            await new Promise(resolve => setTimeout(resolve, 120))
          }
          let inspectSearchRendered = null
          let inspectGlobalSearchConfigured = null
          let inspectSearchSettingsAbsent = null
          let inspectSearchAiAvailable = null
          let inspectSearchKeyboardSelection = null
          let inspectSearchKeyboardVisual = null
          let inspectNativeIconRendered = null
          let inspectAwaitingPanelHidden = null
          let inspectOfficeShortcutResolved = null
          if (${JSON.stringify(process.env.DISK_SENSE_SMOKE_INSPECT_SEARCH === '1')} && ${JSON.stringify(captureView)} === 'inspect') {
            const searchModeButton = document.querySelectorAll('.explorer-mode-switch button')[1]
            searchModeButton?.click()
            await new Promise(resolve => setTimeout(resolve, 120))
            const input = document.querySelector('.search-input-wrap input')
            inspectGlobalSearchConfigured = !document.querySelector('.search-commandbar > select')
            inspectSearchSettingsAbsent = ![...document.querySelectorAll('.search-commandbar button')]
              .some(button => button.textContent.includes('AI 设置'))
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
            inspectSearchAiAvailable = document.querySelectorAll('.ai-actions .ai-review').length === 2
            if ((await api.inspectIndexStatus()).building) await api.inspectIndexCancel()
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
          if (${JSON.stringify(process.env.DISK_SENSE_SMOKE_CLEANER_DRAWER === '1')} && ${JSON.stringify(captureView)} === 'cleaner') {
            const exclusionButton = [...document.querySelectorAll('.cleaner-command-actions button')].find(button => button.textContent.includes('排除项'))
            exclusionButton?.click()
            await new Promise(resolve => setTimeout(resolve, 120))
            cleanerDrawerRendered = Boolean(
              document.querySelector('.cleaner-drawer') &&
              document.body.innerText.includes('这些路径不会进入任何清理候选')
            )
          }
          let cleanerScanRendered = null
          let cleanerCategoryCount = 0
          let cleanerRuleDetailCount = 0
          if (${JSON.stringify(process.env.DISK_SENSE_SMOKE_SCAN_CLEANER === '1')} && ${JSON.stringify(captureView)} === 'cleaner') {
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
          }
          let lightThemeSurfaces = null
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
            if (searchModeWasActive) {
              document.querySelectorAll('.explorer-mode-switch button')[0]?.click()
              await new Promise(resolve => setTimeout(resolve, 100))
            }
            document.querySelector('.path-bar .icon-button.labelled')?.click()
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
            cancelButton?.click()
            await new Promise(resolve => setTimeout(resolve, 80))
            if (searchModeWasActive) {
              document.querySelectorAll('.explorer-mode-switch button')[1]?.click()
              await new Promise(resolve => setTimeout(resolve, 100))
            }
          }
          const captureNavigation = document.querySelectorAll('.main-nav button')[${captureNavigationIndex}]
          captureNavigation?.click()
          await new Promise(resolve => setTimeout(resolve, 180))
          if (${JSON.stringify(captureView)} === 'changes') {
            document.querySelector('.overview-changes-anchor')?.scrollIntoView({ block: 'start' })
            await new Promise(resolve => setTimeout(resolve, 100))
          }
          const capturedPng = (
            ${JSON.stringify(process.env.DISK_SENSE_SMOKE_USE_BRIDGE_SCREENSHOT === '1')} &&
            ${JSON.stringify(process.env.DISK_SENSE_SMOKE_SKIP_SCREENSHOT !== '1')} &&
            typeof api.smokeCapture === 'function'
          )
            ? await api.smokeCapture()
            : null
          return {
            title: document.title,
            rendered: Boolean(document.querySelector('#app .page')),
            bridge: Boolean(api),
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
            invalidPathRejected,
            explanation: explanation ? {
              classification: explanation.classification,
              what: explanation.what,
              purpose: explanation.purpose,
              risk: explanation.risk
            } : null,
            settingsRendered,
            searchMaintenanceRendered,
            settingsDetailRendered,
            historyRendered,
            historyWidthAligned,
            cleanerSafetyBackground,
            overviewRendered,
            overviewChangesRendered,
            cleanerScanRendered,
            cleanerCategoryCount,
            cleanerRuleDetailCount,
            slimmingRendered,
            cleanerHistorySubviewRendered,
            cleanerDrawerRendered,
            lightThemeSurfaces,
            historyCount: history.length,
            exclusionCount: exclusions.length,
            finalActiveNavigation: document.querySelector('.main-nav button.active')?.innerText || '',
            finalHeading: document.querySelector('.workspace h1')?.innerText || '',
            capturedPng
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
    result?.ruleCount < 8 ||
    result?.rootPath !== 'C:\\' ||
    result?.slimmingCount < 4 ||
    result?.slimmingActionCount < 5 ||
    !result?.maintenanceActionsOpaque ||
    result?.scanRule !== 'crash-dumps' ||
    result?.volumeCount < 1 ||
    result?.stateVersion !== 6 ||
    !result?.dataPath ||
    result?.dataUsageFiles < 1 ||
    !result?.installPath ||
    !['dark', 'light'].includes(result?.appearanceTheme) ||
    !['dark', 'light'].includes(result?.renderedTheme) ||
    result?.renderedTheme !== (process.env.DISK_SENSE_SMOKE_THEME === 'light' ? 'light' : 'dark') ||
    !result?.deviceName ||
    !result?.processor ||
    result?.deviceHasVolumes ||
    !result?.searchIndexAvailable ||
    result?.searchIndexBuilding ||
    (
      process.env.DISK_SENSE_SMOKE_INSPECT_SEARCH === '1' &&
      (
        !result?.inspectSearchRendered ||
        !result?.inspectGlobalSearchConfigured ||
        !result?.inspectSearchSettingsAbsent ||
        !result?.inspectSearchAiAvailable ||
        !result?.inspectSearchKeyboardSelection ||
        !result?.inspectNativeIconRendered ||
        !result?.inspectAwaitingPanelHidden ||
        !result?.inspectOfficeShortcutResolved
      )
    ) ||
    (process.env.DISK_SENSE_SMOKE_DEV !== '1' && !result?.packaged) ||
    !result?.security?.rendererSandbox ||
    !result?.security?.contextIsolation ||
    result?.security?.permanentDelete ||
    !result?.security?.systemMaintenanceAllowlist ||
    !result?.invalidPathRejected ||
    !result?.explanation?.what ||
    !result?.explanation?.purpose ||
    !result?.settingsRendered ||
    !result?.searchMaintenanceRendered ||
    !result?.settingsDetailRendered ||
    !result?.historyRendered ||
    !result?.historyWidthAligned ||
    (
      process.env.DISK_SENSE_SMOKE_THEME === 'light' &&
      !/^rgba?\(255, 255, 255(?:, 1)?\)$/u.test(String(result?.cleanerSafetyBackground || ''))
    ) ||
    !result?.overviewRendered ||
    !result?.overviewChangesRendered ||
    (process.env.DISK_SENSE_SMOKE_CLEANER_TAB === 'slimming' && !result?.slimmingRendered) ||
    (process.env.DISK_SENSE_SMOKE_CLEANER_TAB === 'history' && !result?.cleanerHistorySubviewRendered) ||
    (process.env.DISK_SENSE_SMOKE_CLEANER_DRAWER === '1' && !result?.cleanerDrawerRendered) ||
    (process.env.DISK_SENSE_SMOKE_SCAN_CLEANER === '1' && !result?.cleanerScanRendered) ||
    (
      process.env.DISK_SENSE_SMOKE_THEME === 'light' &&
      captureView === 'inspect' &&
      process.env.DISK_SENSE_SMOKE_SKIP_LIGHT_SURFACES !== '1' &&
      (
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
  const diagnosticPath = path.join(isolatedUserData, 'disk-sense.log')
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
