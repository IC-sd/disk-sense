import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const themeCss = fs.readFileSync(path.resolve('src/ui/theme.css'), 'utf8')
const extraCss = fs.readFileSync(path.resolve('src/ui/extra.css'), 'utf8')
const explorerSource = fs.readFileSync(path.resolve('src/ui/ExplorerWorkspace.vue'), 'utf8')

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(target)
    return /\.(?:ts|vue)$/u.test(entry.name) ? [target] : []
  })
}

describe('light and dark theme surfaces', () => {
  it('defines shared component tokens for both themes', () => {
    const lightThemeStart = themeCss.indexOf(':root[data-theme="light"]')
    const darkTheme = themeCss.slice(0, lightThemeStart)
    const lightTheme = themeCss.slice(lightThemeStart)
    const tokens = [
      '--field-bg',
      '--control-bg',
      '--control-hover',
      '--control-text',
      '--icon-bg',
      '--icon-border',
      '--icon-text',
      '--folder-icon-bg',
      '--info-bg',
      '--danger-control-bg'
    ]

    for (const token of tokens) {
      expect(darkTheme, `${token} missing from dark theme`).toContain(token)
      expect(lightTheme, `${token} missing from light theme`).toContain(token)
    }
  })

  it('routes nested controls and explorer icons through theme tokens', () => {
    expect(extraCss).toMatch(/\.model-picker \.quiet[^}]*background:\s*var\(--control-bg\)/s)
    expect(extraCss).toMatch(/\.modal-actions \.quiet[^}]*background:\s*var\(--control-bg\)/s)
    expect(extraCss).toMatch(/\.ai-privacy[^}]*background:\s*var\(--info-bg\)/s)
    expect(extraCss).toMatch(/\.file-name > i[^}]*background:\s*var\(--icon-bg\)/s)
    expect(extraCss).toMatch(/\.file-name > i\.directory[^}]*background:\s*var\(--folder-icon-bg\)/s)
    expect(extraCss).toMatch(/\.explain-panel[^}]*color:\s*var\(--text\)[^}]*background:\s*var\(--surface\)/s)
    expect(extraCss).toMatch(/\.meaning-list p[^}]*color:\s*var\(--text\)/s)
    expect(extraCss).toMatch(/\.explanation-summary[^}]*color:\s*var\(--muted\)/s)
    expect(extraCss).toMatch(/\.ai-review small[^}]*color:\s*var\(--muted\)/s)
    expect(extraCss).not.toContain('background: #091522')
    expect(extraCss).not.toContain('background: #102033')
  })

  it('keeps final light-theme guardrails after component declarations', () => {
    const guardrailStart = extraCss.lastIndexOf('/* Light theme guardrail.')
    expect(guardrailStart).toBeGreaterThan(0)

    const guardrail = extraCss.slice(guardrailStart)
    expect(guardrail).toContain(':root[data-theme="light"] #app .model-picker .quiet')
    expect(guardrail).toContain(':root[data-theme="light"] #app .modal-actions .quiet')
    expect(guardrail).toContain(':root[data-theme="light"] #app .ai-privacy')
    expect(guardrail).toContain(':root[data-theme="light"] #app .file-name > i')
    expect(guardrail).toContain(':root[data-theme="light"] #app .object-icon')
  })

  it('keeps explorer navigation integrated and cleanup surfaces rounded', () => {
    expect(extraCss).toMatch(/\.explorer-toolbar\s*\{[^}]*border-bottom:\s*1px solid var\(--line\)[^}]*border-radius:\s*0/s)
    expect(extraCss).toMatch(/\.file-list,[\s\S]*?border-radius:\s*15px/s)
    expect(extraCss).toMatch(/\.cleaner-commandbar\s*\{[^}]*border-radius:\s*13px 13px 0 0/s)
    expect(extraCss).toMatch(
      /\.cleaner-category:last-child > \.cleaner-category-row\s*\{[^}]*border-radius:\s*0 0 13px 13px/s
    )
  })

  it('keeps all cleanup tabs aligned and the safety card theme-aware', () => {
    expect(extraCss).toMatch(/\.history-panel\s*\{[^}]*max-width:\s*1420px[^}]*margin:\s*0 auto/s)
    expect(extraCss).toMatch(/\.cleaner-workspace\s*\{[^}]*max-width:\s*1420px[^}]*margin:\s*0 auto/s)
    expect(extraCss).toMatch(/\.slimming-workspace\s*\{[^}]*max-width:\s*1420px[^}]*margin:\s*0 auto/s)
    expect(extraCss).toContain(':root[data-theme="light"] #app .cleaner-page-header .cleaner-safety-state')
    expect(extraCss).toContain(':root[data-theme="light"] #app .cleaner-page-header .cleaner-safety-state > span')
  })

  it('separates file search controls from optional AI result analysis', () => {
    const searchControls = explorerSource.slice(
      explorerSource.indexOf('<div class="search-commandbar">'),
      explorerSource.indexOf('<div class="search-filterbar">')
    )
    const fileListStart = explorerSource.indexOf('<section class="file-list"')
    const browseToolbar = explorerSource.indexOf('class="explorer-toolbar file-list-toolbar"')
    const listHeader = explorerSource.indexOf('<div class="list-head">', fileListStart)

    expect(searchControls).not.toContain('AI 设置')
    expect(searchControls).not.toContain('showAiSettings')
    expect(explorerSource).toContain("@click=\"requestAi('normal')\"")
    expect(explorerSource).toContain("@click=\"requestAi('deep')\"")
    expect(browseToolbar).toBeGreaterThan(fileListStart)
    expect(browseToolbar).toBeLessThan(listHeader)
  })

  it('gives search results a clear identity, context and priority hierarchy', () => {
    expect(explorerSource).toContain('<span>名称与位置</span><span>匹配类型</span><span>最近修改</span>')
    expect(explorerSource).toContain('class="search-result-name"')
    expect(explorerSource).toContain('class="row-path"')
    expect(explorerSource).toContain('class="row-result-type"')
    expect(explorerSource).toContain('formatRelativeModified(row.item.modifiedAt)')
    expect(extraCss).toMatch(/\.search-result-name mark\s*\{[^}]*color:\s*var\(--blue-strong\)/s)
    expect(extraCss).toMatch(/\.search-result-row\.priority-primary \.row-result-type b\s*\{/s)
    expect(extraCss).toMatch(/\.search-result-row\.priority-secondary \.row-result-type b\s*\{/s)
    expect(explorerSource).toContain("'search-awaiting-selection': mode === 'search' && !selected")
    expect(explorerSource).toContain('class="native-result-icon"')
    expect(extraCss).toMatch(/\.explorer-layout\.search-awaiting-selection \.explain-panel\s*\{[^}]*display:\s*none/s)
    expect(extraCss).toMatch(/\.native-result-icon\s*\{[^}]*object-fit:\s*contain/s)
  })

  it('makes AI completion and its refreshed explanation visually explicit', () => {
    const banner = explorerSource.slice(
      explorerSource.indexOf('<div v-if="explanation.aiAnalyzed" class="ai-result-banner"'),
      explorerSource.indexOf('<div class="meaning-list">')
    )
    const details = explorerSource.slice(
      explorerSource.indexOf('const objectDetails'),
      explorerSource.indexOf('const emptyTitle')
    )
    expect(explorerSource).toContain("'ai-result': explanation.aiAnalyzed")
    expect(explorerSource).toContain('class="ai-result-banner"')
    expect(explorerSource).toContain('分析完成')
    expect(explorerSource).toContain("explanation.aiPersisted ? '已本地保存' : '已更新'")
    expect(banner).not.toContain('<AppIcon')
    expect(details).toContain("label: '识别结论'")
    expect(details).toContain("label: '与系统的关系'")
    expect(details).toContain("label: '处理建议'")
    expect(details).not.toContain("label: '它是什么'")
    expect(details).not.toContain("label: '有什么用'")
    expect(explorerSource).toContain("explainPanel.value?.scrollTo({ top: 0, behavior: 'smooth' })")
    expect(explorerSource).toContain('api.aiAnalysisGet({ path: item.path, fingerprint: currentFingerprint })')
    expect(explorerSource).toContain('api.aiAnalysisSave({ ...result, path: targetPath, fingerprint: currentFingerprint })')
    expect(extraCss).toMatch(/\.ai-result-banner\s*\{[^}]*border:[^}]*background:/s)
    expect(extraCss).toMatch(/\.ai-result \.meaning-list\s*\{[^}]*border:[^}]*background:/s)
    expect(extraCss).toMatch(/:root\[data-theme="light"\] #app \.meaning-list p[^}]*color:\s*var\(--text\)/s)
  })

  it('does not keep component classes after their templates are removed', () => {
    const source = sourceFiles(path.resolve('src'))
      .map(filePath => fs.readFileSync(filePath, 'utf8'))
      .join('\n')
    const cssClasses = [...`${themeCss}\n${extraCss}`.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/gu)]
      .map(match => match[1])
    const dynamicClass = /^(?:risk-(?:safe|low|attention|elevated|danger)|priority-(?:primary|secondary)|kind-(?:added|modified|removed|application|archive|audio|code|document|image|installer|video))$/u
    const unused = [...new Set(cssClasses)]
      .filter(className => !dynamicClass.test(className))
      .filter(className => !new RegExp(`(?<![A-Za-z0-9_-])${className}(?![A-Za-z0-9_-])`, 'u').test(source))

    expect(unused).toEqual([])
  })
})
