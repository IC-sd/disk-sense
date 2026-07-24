<template>
  <main class="app-shell">
    <aside class="app-sidebar">
      <div class="brand">
        <div class="brand-mark"><AppIcon name="spark" /></div>
        <div>
          <b>Disk Sense</b>
          <small>空间理解工具</small>
        </div>
      </div>

      <nav class="main-nav" aria-label="主要功能">
        <button
          v-for="item in navigation"
          :key="item.id"
          :class="{ active: view === item.id }"
          :aria-current="view === item.id ? 'page' : undefined"
          @click="view = item.id"
        >
          <span class="nav-icon"><AppIcon :name="item.icon" /></span>
          <span><b>{{ item.label }}</b><small>{{ item.description }}</small></span>
          <i></i>
        </button>
      </nav>

      <div class="sidebar-insight">
        <div class="insight-orbit"><span></span></div>
        <small>DISK SENSE PRINCIPLE</small>
        <b>未知不等于垃圾</b>
        <p>先理解内容，再决定是否处理。</p>
      </div>

      <div class="sidebar-footer">
        <span class="status-dot"></span>
        <div><b>本地分析核心</b><small>数据默认留在电脑中</small></div>
      </div>
    </aside>

    <section class="workspace">
      <KeepAlive>
        <component :is="currentComponent" @navigate="navigate" />
      </KeepAlive>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import ChangesPanel from './ChangesPanel.vue'
import CleanerPanel from './CleanerPanel.vue'
import ExplorerPanel from './ExplorerPanel.vue'
import OverviewPanel from './OverviewPanel.vue'
import SettingsPanel from './SettingsPanel.vue'

type View = 'overview' | 'inspect' | 'cleaner' | 'changes' | 'settings'

const view = ref<View>('overview')
const navigation: Array<{ id: View; label: string; description: string; icon: string }> = [
  { id: 'overview', label: '空间概览', description: '理解产品与空间入口', icon: 'overview' },
  { id: 'inspect', label: '目录与文件', description: '解释每一个对象', icon: 'folder' },
  { id: 'cleaner', label: '垃圾清理', description: '清理与系统瘦身', icon: 'clean' },
  { id: 'changes', label: '变化记录', description: '追踪磁盘增减来源', icon: 'history' },
  { id: 'settings', label: '设置与关于', description: '隐私、安全与版本', icon: 'settings' }
]

const componentByView = {
  overview: OverviewPanel,
  inspect: ExplorerPanel,
  cleaner: CleanerPanel,
  changes: ChangesPanel,
  settings: SettingsPanel
}

const currentComponent = computed(() => componentByView[view.value])
function navigate(target: View) { view.value = target }
</script>
