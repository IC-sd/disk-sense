import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = path.resolve(import.meta.dirname, '..')

function componentSource(name: string) {
  return fs.readFileSync(path.join(projectRoot, 'src', 'ui', name), 'utf8')
}

describe('cached workspace lifecycle', () => {
  it('keeps device and data-directory inspection lazy on the settings page', () => {
    const source = componentSource('SettingsWorkspace.vue')
    expect(source).toContain("const tab = ref<SettingsTab>('general')")
    expect(source).toContain('@click="openStorage"')

    const mountedBody = source.match(/onMounted\(\(\) => \{([\s\S]*?)\n\}\)/)?.[1] || ''
    expect(mountedBody).not.toContain('openAbout()')
    expect(mountedBody).not.toContain('loadDataUsage()')
  })

  it('pauses explorer subscriptions and deferred work while KeepAlive hides the page', () => {
    const source = componentSource('ExplorerWorkspace.vue')
    expect(source).toContain('onDeactivated(stopActiveWork)')
    expect(source).toContain('navigationRequestId += 1')
    expect(source).toContain('searchRequestId += 1')
    expect(source).toContain('unsubscribeIndex = null')
    expect(source).toContain('if (!workspaceActive) return')
  })

  it('stops settings index updates while its cached page is inactive', () => {
    const source = componentSource('SettingsWorkspace.vue')
    expect(source).toContain('onActivated(() => {')
    expect(source).toContain('onDeactivated(stopActiveWork)')
    expect(source).toContain('stopIndexProgress = null')
  })
})
