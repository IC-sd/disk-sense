<template>
  <main class="app-shell">
    <aside class="app-sidebar">
      <div class="brand">
        <div class="brand-mark"><AppIcon name="database" /></div>
        <div>
          <b>Disk Sense</b>
          <small>文件与空间</small>
        </div>
      </div>

      <div class="sidebar-section-label" aria-hidden="true">工作区</div>
      <nav class="main-nav" aria-label="主要功能">
        <button
          v-for="item in navigation"
          :key="item.id"
          :class="{ active: view === item.id }"
          :aria-current="view === item.id ? 'page' : undefined"
          :aria-label="item.label"
          :title="`${item.label} · ${item.description}`"
          @click="navigate(item.id)"
        >
          <span class="nav-icon"><AppIcon :name="item.icon" /></span>
          <span><b>{{ item.label }}</b><small>{{ item.description }}</small></span>
          <i aria-hidden="true"></i>
        </button>
      </nav>

      <div class="sidebar-bottom">
        <button class="sidebar-search" aria-label="快速查找文件" title="快速查找文件 · Ctrl K" @click="openSearch">
          <AppIcon name="search" />
          <span>快速查找</span>
          <kbd>Ctrl K</kbd>
        </button>
        <div class="sidebar-footer" title="文件索引保存在此设备">
          <span class="status-dot"></span>
          <div><b>本地优先</b><small>文件索引保存在此设备</small></div>
        </div>
      </div>
    </aside>

    <section class="workspace" aria-label="主要工作区">
      <div v-if="migrationRecovery" class="startup-recovery-notice" role="status">
        <AppIcon name="shield" />
        <div><b>数据迁移未完成</b><p>{{ migrationRecovery.message }}</p><small>当前数据目录：{{ migrationRecovery.source }}</small></div>
        <button class="icon-button" aria-label="关闭数据迁移提示" @click="migrationRecovery = null"><AppIcon name="close" /></button>
      </div>
      <KeepAlive>
        <component :is="currentComponent" :requested-path="requestedPath" :requested-search="requestedSearch" @navigate="navigate" @inspect-path="inspectPath" />
      </KeepAlive>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import CleanerPanel from './CleanerPanel.vue'
import ExplorerPanel from './ExplorerWorkspace.vue'
import OverviewPanel from './OverviewWorkspace.vue'
import SettingsPanel from './SettingsWorkspace.vue'
import { desktopApi } from '../platform/api'
import type { AppInfo } from '../domain/desktop'

type View = 'overview' | 'inspect' | 'cleaner' | 'settings'

const view = ref<View>('overview')
const requestedPath = ref<{ path: string; id: number } | null>(null)
const requestedSearch = ref(0)
const migrationRecovery = ref<AppInfo['migrationRecovery']>(null)
const navigation: Array<{ id: View; label: string; description: string; icon: string }> = [
  { id: 'overview', label: '空间概览', description: '磁盘容量与使用情况', icon: 'overview' },
  { id: 'inspect', label: '目录与文件', description: '快速查找与用途分析', icon: 'folder' },
  { id: 'cleaner', label: '垃圾清理', description: '清理与系统瘦身', icon: 'clean' },
  { id: 'settings', label: '设置与关于', description: '隐私、安全与版本', icon: 'settings' }
]

const componentByView = {
  overview: OverviewPanel,
  inspect: ExplorerPanel,
  cleaner: CleanerPanel,
  settings: SettingsPanel
}

const currentComponent = computed(() => componentByView[view.value])
function navigate(target: View) {
  view.value = target
  requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: 'auto' }))
}
function inspectPath(path: string) {
  requestedPath.value = { path, id: (requestedPath.value?.id || 0) + 1 }
  navigate('inspect')
}
function openSearch() {
  requestedSearch.value += 1
  navigate('inspect')
}
function handleAppKeydown(event: KeyboardEvent) {
  if (event.ctrlKey && event.key.toLowerCase() === 'k' && !event.isComposing && !document.querySelector('[role="dialog"]')) {
    event.preventDefault()
    openSearch()
  }
}
onMounted(() => {
  document.addEventListener('keydown', handleAppKeydown)
  void desktopApi()?.appInfo().then(info => { migrationRecovery.value = info.migrationRecovery || null }).catch(() => {})
})
onBeforeUnmount(() => document.removeEventListener('keydown', handleAppKeydown))
</script>

<style src="./shell.css"></style>
