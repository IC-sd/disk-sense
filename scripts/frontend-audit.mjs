/**
 * A read-only journey through the real Vue application. The function is fully
 * self-contained so the desktop smoke runner can serialize it with toString().
 * Run with the smoke fixture/profile. Cleanup is never executed. With fixtures
 * enabled, a scan reads one owned dump and the history UI reads sample records.
 * Captured PNGs are bridge-provided base64, never reconstructed HTML.
 */
export async function captureFrontend(api, options = {}) {
  const captures = []
  const checks = {}
  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  const timeout = Math.max(1000, Math.min(60000, Number(options.timeoutMs) || 20000))
  const element = selector => document.querySelector(selector)
  const visible = node => Boolean(node && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0)
  const assert = (name, condition, detail = '') => {
    checks[name] = Boolean(condition)
    if (!condition) throw new Error(`frontend-audit:${name}${detail ? ':' + detail : ''}`)
  }
  const wait = async (label, condition) => {
    const started = performance.now()
    while (performance.now() - started < timeout) {
      if (condition()) return
      await delay(40)
    }
    throw new Error(`frontend-audit:timeout:${label}`)
  }
  const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const textButton = (selector, text) => [...document.querySelectorAll(selector)]
    .find(node => visible(node) && node.textContent.includes(text))
  const click = (node, name) => {
    assert(`${name}-control`, visible(node) && !node.disabled)
    node.click()
  }
  const change = (node, value, type = 'input') => {
    assert('input-control-available', node instanceof HTMLInputElement || node instanceof HTMLSelectElement)
    const prototype = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value)
    node.dispatchEvent(new Event(type, { bubbles: true }))
  }
  const navigate = async (label, selector) => {
    click(textButton('.main-nav button', label), `navigate-${label}`)
    await wait(label, () => visible(element(selector)) && textButton('.main-nav button.active', label))
  }
  const closeDialogs = async () => {
    for (const selector of ['.ai-settings-card', '.cleaner-drawer']) {
      const dialog = element(selector)
      if (dialog) {
        const close = dialog.querySelector('.modal-close')
        if (!close) throw new Error(`frontend-audit:dialog-close-missing:${selector}`)
        close.click()
        await wait(`close-${selector}`, () => !element(selector))
      }
    }
  }
  const snapshot = async (name, selector, reveal = false) => {
    await wait(`${name}-visible`, () => visible(element(selector)))
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
    for (const node of document.querySelectorAll('.workspace, .page, .file-scroll, .explain-panel, .modal-card, .ai-settings-body, .cleaner-drawer')) node.scrollTop = 0
    await frames()
    if (reveal) element(selector).scrollIntoView({ block: 'center', behavior: 'instant' })
    await delay(100)
    assert(`${name}-visible`, visible(element(selector)))
    const selectors = '.page-header, .live-overview, .cleaner-view-tabs, .cleaner-workspace, .slimming-workspace, .history-panel, .settings-tabs, .path-bar, .search-commandbar, .search-filterbar, .file-list, .explain-panel, .modal-card, .cleaner-drawer'
    const outside = [...document.querySelectorAll(selectors)].filter(visible).filter(node => {
      const rect = node.getBoundingClientRect()
      return rect.left < -1 || rect.right > window.innerWidth + 1
    })
    assert(`${name}-layout`, document.documentElement.scrollWidth <= window.innerWidth + 1 && !outside.length,
      outside.map(node => node.className).join(','))
    const dialog = element('.ai-settings-card, .cleaner-drawer')
    if (dialog) {
      const rect = dialog.getBoundingClientRect()
      assert(`${name}-dialog-in-window`, rect.top >= -1 && rect.bottom <= window.innerHeight + 1)
    }
    const png = await api.smokeCapture()
    assert(`${name}-png`, typeof png === 'string' && png.startsWith('iVBORw0KGgo') && png.length > 100)
    captures.push({ name, png, width: window.innerWidth, height: window.innerHeight })
  }
  const searchSettled = () => !element('.search-results .list-loading')
    && !element('.search-result-summary')?.textContent.includes('正在搜索')
  const query = async value => {
    change(element('.search-input-wrap input'), value)
    await delay(100)
    await wait(`search-${value || 'empty'}`, () => element('.search-input-wrap input')?.value === value && searchSettled())
  }
  let completed = false
  assert('capture-bridge', typeof api?.smokeCapture === 'function')
  assert('four-primary-entries', document.querySelectorAll('.main-nav button').length === 4)
  try {
    await closeDialogs()
    if (options.migrationRecovery) {
      await wait('migration-notice', () => visible(element('.startup-recovery-notice')))
      assert('migration-original-path-shown', element('.startup-recovery-notice').textContent.includes(String(options.originalDataPath)))
      await snapshot('migration-recovery', '.startup-recovery-notice')
      click(element('[aria-label="关闭数据迁移提示"]'), 'migration-notice-dismiss')
      await wait('migration-notice-dismissed', () => !element('.startup-recovery-notice'))
      assert('migration-dismiss-keeps-source', (await api.appInfo()).userDataPath === options.originalDataPath)
    }
    assert('no-unsafe-dialog-open', !element('.maintenance-modal, .cleanup-confirm-modal, .history-clear-modal'))
    await navigate('空间概览', '.overview-page')
    await wait('overview-data', () => element('.volume-grid article') || element('.overview-unavailable'))
    const activity = element('.overview-activity')
    if (activity?.open) activity.querySelector('summary').click()
    await snapshot('overview', '.live-overview')

    await navigate('目录与文件', '.explorer-page')
    click(textButton('.explorer-mode-switch button', '目录浏览'), 'browse-mode')
    await wait('browse-path', () => element('.path-input-wrap input'))
    if (options.searchRoot) {
      const address = element('.path-input-wrap input')
      change(address, String(options.searchRoot))
      address.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
    }
    const filter = element('.browse-controls input')
    if (filter?.value) change(filter, '')
    await wait('browse-list', () => !element('.file-list .list-loading') && element('.file-row'))
    await snapshot('browse', '.path-bar')
    const browseRow = [...document.querySelectorAll('.file-row')].find(node => node.querySelector('.file-name b')?.textContent.trim() === 'Documents') || element('.file-row')
    const browseName = browseRow.querySelector('.file-name b')?.textContent.trim()
    click(browseRow, 'browse-local-explanation')
    await wait('browse-explanation', () => visible(element('.explanation-content'))
      && element('.object-heading h2')?.textContent.includes(browseName)
      && !element('.explanation-content .inline-message[role="status"]'))
    await snapshot('browse-analysis', '.explanation-content')
    if (options.fixtures) {
      click(textButton('.space-measurement button', '读取实际占用'), 'physical-space-read')
      await wait('physical-space-result', () => element('.space-measurement .object-facts') || element('.space-measurement [role="alert"]'))
      assert('physical-space-complete', Boolean(element('.space-measurement .object-facts')))
      assert('physical-space-not-reclaimable', element('.space-measurement').textContent.includes('不等于删除后可释放空间'))
      await snapshot('physical-space', '.space-measurement', true)
    }

    click(textButton('.explorer-mode-switch button', '文件搜索'), 'search-mode')
    await wait('search-input', () => element('.search-input-wrap input'))
    const input = element('.search-input-wrap input')
    input.focus()
    assert('search-input-focus', document.activeElement === input)
    for (const [selector, value] of [['.search-scope-control select', options.searchRoot ? 'directory' : 'all'],
      ['.search-filterbar select[aria-label="修改时间"]', 'any'], ['.search-filterbar select[aria-label="搜索排序"]', 'relevance']]) {
      const select = element(selector)
      if (select && select.value !== value) change(select, value, 'change')
    }
    const allTypes = textButton('.search-kind-filters button', '全部')
    if (allTypes && !allTypes.classList.contains('active')) click(allTypes, 'search-all-types')
    await query('')
    await wait('search-welcome', () => element('.search-examples button') && !element('.search-results .file-row'))
    assert('welcome-buttons-not-listbox', !element('#explorer-items')?.hasAttribute('role'))
    await snapshot('search-empty', '.search-examples')
    await query('__disk_sense_frontend_audit_missing_4bf583c7__')
    await wait('no-search-results', () => element('.search-results .list-empty') && !element('.search-results .file-row'))
    await snapshot('search-no-results', '.search-results .list-empty')
    await query(String(options.query || (options.searchRoot ? 'search-smoke' : browseName)))
    await wait('search-results', () => element('.search-results .file-row') && searchSettled())
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await wait('search-selection', () => element('.search-results .file-row.selected'))
    assert('selection-keeps-analysis-optional', Boolean(element('.explorer-layout.search-awaiting-selection')))
    await snapshot('search-results', '.search-results')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true }))
    await wait('search-analysis', () => !element('.explorer-layout.search-awaiting-selection') && visible(element('.explanation-content')))
    await snapshot('search-analysis', '.explanation-content')

    await navigate('垃圾清理', '.cleanup-page')
    click(textButton('.cleanup-tabs button', '垃圾清理'), 'cleaner-junk-tab')
    await wait('cleaner-rules', () => element('.cleaner-category'))
    await snapshot('cleaner', '.cleaner-workspace')
    click(textButton('.cleaner-command-actions button', '排除项'), 'cleaner-exclusions')
    await wait('exclusion-drawer', () => visible(element('.cleaner-drawer')))
    await frames()
    const drawer = element('.cleaner-drawer')
    assert('exclusion-dialog-focus', drawer.contains(document.activeElement))
    await snapshot('cleaner-exclusions', '.cleaner-drawer')
    await closeDialogs()
    if (options.fixtures) {
      // Scan only the owned old dump under the isolated LOCALAPPDATA profile.
      for (const header of document.querySelectorAll('.cleaner-category-row')) {
        if (header.getAttribute('aria-expanded') !== 'true') header.click()
      }
      await frames()
      const rule = [...document.querySelectorAll('.compact-rule')]
        .find(node => node.querySelector('.cleanup-rule-title b')?.textContent.trim() === '程序崩溃转储')
      click(rule?.querySelector('.compact-scan-button'), 'owned-dump-scan')
      await wait('owned-scan-result', () => rule.querySelector('.compact-rule input[type="checkbox"]')?.disabled === false)
      const evidence = rule.querySelector('.rule-evidence')
      if (!evidence.open) evidence.querySelector('summary').click()
      await frames()
      const paths = [...rule.querySelectorAll('.rule-files > div > span')].map(node => node.textContent.trim().toLowerCase())
      assert('owned-scan-only', paths.length === 1 && paths[0] === String(options.dumpPath).toLowerCase())
      assert('owned-scan-coverage-complete', rule.querySelector('.scan-coverage.complete')?.textContent === '扫描完成')
      const scanFixtureRule = async (title, status, label, expectDisabled = true) => {
        const targetRule = [...document.querySelectorAll('.compact-rule')]
          .find(node => node.querySelector('.cleanup-rule-title b')?.textContent.trim() === title)
        click(targetRule?.querySelector('.compact-scan-button'), `fixture-scan-${status}`)
        await wait(`fixture-${status}`, () => targetRule.querySelector(`.scan-coverage.${status}`))
        assert(`coverage-${status}-label`, targetRule.querySelector('.scan-coverage')?.textContent === label)
        if (expectDisabled) assert(`coverage-${status}-not-selectable`, targetRule.querySelector('input[type="checkbox"]').disabled)
        const details = targetRule.querySelector('.rule-evidence')
        if (!details.open) details.querySelector('summary').click()
        await frames()
        return targetRule
      }
      await scanFixtureRule('Visual Studio Code 缓存', 'not-found', '未发现规则位置')
      const discoveryRule = await scanFixtureRule('钉钉界面缓存', 'partial', '部分扫描', false)
      assert('discovery-limit-explained', discoveryRule.querySelector('.rule-scan-report').textContent.includes('应用位置搜索已达到深度上限'))
      assert('discovery-partial-keeps-owned-candidate', discoveryRule.querySelector('.rule-files > div > span')?.textContent.trim().toLowerCase() === String(options.discoveryCachePath).toLowerCase())
      assert('discovery-stats-rendered', discoveryRule.querySelector('.rule-discovery-report')?.textContent.includes('应用位置发现'))
      await snapshot('cleaner-discovery-limited', '.scan-coverage.partial', true)
      const unavailableRule = await scanFixtureRule('DirectX Shader 缓存', 'unavailable', '未能读取')
      assert('unavailable-scan-explained', unavailableRule.querySelector('.rule-scan-report').textContent.includes('当前数量不代表完整占用'))
      assert('unavailable-scan-issue-path', unavailableRule.querySelector('.rule-scan-report li span').textContent.endsWith('D3DSCache'))
      assert('unavailable-scan-not-zero-bytes', unavailableRule.querySelector('.compact-rule-result b').textContent === '未能读取')
      await snapshot('cleaner-unavailable-rule', '.scan-coverage.unavailable', true)
      assert('scan-summary-incomplete', element('.scan-time-stat b')?.textContent === '结果不完整')
      await snapshot('cleaner-scan-results', '.cleaner-stats')
      await snapshot('cleaner-rule-files', '.rule-files', true)
      const selection = rule.querySelector('input[type="checkbox"]')
      if (!selection.checked) selection.click()
      await frames()
      click(element('.cleaner-command-actions .primary-button'), 'cleanup-preview')
      await wait('cleanup-confirmation', () => visible(element('.cleaner-confirm-modal .modal-card')))
      assert('cleanup-needs-explicit-confirmation', Boolean(element('#cleanup-confirm-title')))
      await snapshot('cleanup-confirmation', '.cleaner-confirm-modal .modal-card')
      element('.cleaner-confirm-modal .modal-close').click()
      await wait('cleanup-cancelled', () => !element('.cleaner-confirm-modal'))
    }
    click(textButton('.cleanup-tabs button', '系统瘦身'), 'cleaner-slimming-tab')
    await wait('slimming-read-only-data', () => element('.slimming-rule') && !element('.slimming-skeleton'))
    await snapshot('cleaner-slimming', '.slimming-workspace')
    click(textButton('.cleanup-tabs button', '操作记录'), 'cleaner-history-tab')
    await wait('history-read', () => element('.history-panel') && !element('.history-loading')
      && (element('.history-panel .compact-empty') || element('.history-metrics')))
    assert('history-rendered', Boolean(element('.history-panel .compact-empty, .history-metrics')))
    await snapshot('cleaner-history', '.history-panel')
    if (options.fixtures) {
      click(element('.history-row'), 'history-detail')
      await wait('history-detail-read', () => element('.history-file') && !element('.history-detail .muted')?.textContent.includes('正在读取'))
      await snapshot('history-detail', '.history-detail', true)
      click(textButton('.history-footer button', '清空操作记录'), 'history-clear-preview')
      await wait('history-clear-confirmation', () => visible(element('#clear-history-title')))
      await snapshot('history-clear-confirmation', '.cleaner-confirm-modal .modal-card')
      element('.cleaner-confirm-modal .modal-close').click()
      await wait('history-clear-cancelled', () => !element('.cleaner-confirm-modal'))
      assert('fixture-history-kept', Boolean(element('.history-row')))
    }

    await navigate('设置与关于', '.settings-page')
    await wait('settings-tabs', () => element('.settings-tabs'))
    click(textButton('.settings-tabs button', '通用'), 'settings-general-tab')
    await wait('general-settings', () => element('.theme-options'))
    const generalTab = element('#settings-general-tab')
    generalTab.focus()
    generalTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    await wait('settings-keyboard-tab', () => element('#settings-storage-tab')?.getAttribute('aria-selected') === 'true')
    assert('settings-keyboard-focus', document.activeElement === element('#settings-storage-tab'))
    click(element('#settings-general-tab'), 'settings-general-keyboard-return')
    await wait('settings-general-keyboard-ready', () => element('.theme-options'))
    await snapshot('settings-general', '.theme-options')
    click(textButton('.settings-tabs button', '存储位置'), 'settings-storage-tab')
    await wait('storage-read', () => element('.location-panel')
      && !element('.storage-summary-panel strong')?.textContent.includes('读取'))
    await snapshot('settings-storage', '.location-panel')
    click(textButton('.settings-tabs button', '关于'), 'settings-about-tab')
    await wait('device-read', () => element('.device-panel') && !element('.settings-loading'))
    await snapshot('settings-about', '.device-panel')
    const diagnostics = element('.settings-diagnostics')
    click(diagnostics?.querySelector('summary'), 'local-diagnostics')
    await wait('diagnostics-read', () => diagnostics.querySelector('pre')?.textContent.includes('redacted'))
    assert('diagnostics-paths-redacted', !/[A-Za-z]:\\\\Users\\\\/u.test(diagnostics.textContent))
    await snapshot('settings-diagnostics', '.settings-diagnostics', true)
    click(textButton('.settings-tabs button', '通用'), 'settings-general-return')
    await wait('ai-entry', () => element('.settings-ai-entry'))
    const aiEntry = element('.settings-ai-entry')
    aiEntry.focus()
    click(aiEntry, 'ai-settings')
    await wait('ai-dialog', () => visible(element('.ai-settings-card')) && element('.ai-settings-card .model-picker'))
    await frames()
    const aiDialog = element('.ai-settings-card')
    assert('ai-dialog-semantics', aiDialog.getAttribute('role') === 'dialog' && aiDialog.getAttribute('aria-modal') === 'true')
    assert('ai-dialog-focus', aiDialog.contains(document.activeElement))
    const focusable = [...aiDialog.querySelectorAll('button, input, select, textarea, summary, a[href], [tabindex]:not([tabindex="-1"])')]
      .filter(node => !node.matches(':disabled, [hidden], [aria-hidden="true"]') && node.getClientRects().length > 0)
    focusable.at(-1).focus()
    aiDialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    assert('ai-dialog-tab-wrap', document.activeElement === focusable[0])
    aiDialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    assert('ai-dialog-shift-tab-wrap', document.activeElement === focusable.at(-1))
    await snapshot('ai-settings', '.ai-settings-card')
    aiDialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wait('ai-escape-close', () => !element('.ai-settings-card'))
    assert('ai-focus-return', document.activeElement === aiEntry)
    completed = true
    return { captures, checks, fixtures: Boolean(options.fixtures) }
  } catch (error) {
    // Persist real partial captures before the parent fails the audit.
    try { await snapshot('failure', '.app-shell') } catch {}
    return { captures, checks, fixtures: Boolean(options.fixtures), error: error.message || String(error) }
  } finally {
    // The caller collects its ordinary smoke assertions before this journey.
    // Always leave a normal overview and no audit-owned dialog behind.
    try {
      await closeDialogs()
      await navigate('空间概览', '.overview-page')
      await frames()
      checks.finalOverview = Boolean(element('.overview-page') && !element('.ai-settings-card, .cleaner-drawer'))
      if (completed) assert('final-overview-restored', checks.finalOverview)
    } catch (error) {
      if (completed) throw error
    }
  }
}
