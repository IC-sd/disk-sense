<template>
  <section class="page overview-page">
    <header class="page-header overview-heading">
      <div>
        <div class="eyebrow"><span></span> 这台电脑</div>
        <h1>空间概览</h1>
        <p>从磁盘空间开始，找到你要了解的文件。</p>
      </div>
      <div class="hero-actions">
        <button class="primary-button" @click="$emit('navigate', 'inspect')">
          <AppIcon name="folder" />
          <span>浏览目录与文件</span>
          <AppIcon name="arrow" />
        </button>
      </div>
    </header>

    <section class="live-overview">
      <header>
        <div class="capacity-heading">
          <h2>磁盘容量</h2>
          <span v-if="summary">{{ summary.volumes.length }} 个本地磁盘</span>
        </div>
        <button class="text-button" :disabled="loading" @click="loadOverview">
          {{ loading ? '读取中…' : '刷新' }} <AppIcon name="refresh" />
        </button>
      </header>

      <div v-if="summary?.volumes.length" class="capacity-summary">
        <div><span>可用空间</span><strong>{{ formatBytes(availableBytes) }}</strong></div>
        <p>共 {{ formatBytes(totalBytes) }} 容量<span>·</span>已用 {{ formatBytes(totalBytes - availableBytes) }}</p>
      </div>

      <div v-if="summary?.volumes.length" class="volume-grid">
        <article v-for="volume in summary.volumes" :key="volume.root" :class="{ system: volume.isSystem, 'volume-warning': volume.usagePercent >= 85 }">
          <div class="volume-title">
            <span><AppIcon name="database" /></span>
            <div><b>{{ volume.root }}</b><small>{{ volume.isSystem ? 'Windows 系统盘' : '本地磁盘' }}</small></div>
            <strong>{{ volume.usagePercent }}%<small>已使用</small></strong>
          </div>
          <div class="volume-storage">
            <div class="volume-numbers">
              <span><b>{{ formatBytes(volume.freeBytes) }}</b> 可用</span>
              <span>{{ formatBytes(volume.usedBytes) }} / {{ formatBytes(volume.totalBytes) }}</span>
            </div>
            <div class="volume-bar" role="meter" :aria-label="`${volume.root} 已使用空间`" :aria-valuenow="volume.usagePercent" :aria-valuemin="0" :aria-valuemax="100"><i :style="{ width: `${Math.min(100, volume.usagePercent)}%` }"></i></div>
            <span v-if="volume.usagePercent >= 85" class="volume-space-note">可用空间较少</span>
            <button class="volume-browse" :aria-label="`浏览 ${volume.root} 文件`" @click="$emit('inspect-path', volume.root)">查看文件<AppIcon name="arrow" /></button>
          </div>
        </article>
      </div>
      <div v-else-if="loading" class="volume-loading" role="status"><AppIcon name="database" /><span>正在读取磁盘容量…</span><div class="capacity-skeleton"><i></i><i></i></div></div>
      <div v-else class="overview-unavailable" role="status"><AppIcon name="database" /><b>暂时无法读取磁盘容量</b><p>{{ overviewError || '请稍后重试，仍可从侧栏浏览文件。' }}</p><button class="secondary-button" @click="loadOverview">重新读取</button></div>
    </section>

    <details v-if="summary" class="overview-activity">
      <summary><AppIcon name="history" /><b>处理记录</b><span>{{ summary.activity.cleanupJobs }} 次清理 · {{ summary.activity.exclusionCount }} 个排除项</span><AppIcon name="arrow" /></summary>
      <div class="activity-grid">
        <article>
          <span>清理记录</span>
          <b>{{ summary.activity.cleanupJobs }}</b>
          <small>{{ summary.activity.lastCleanupAt ? `最近 ${formatDateTime(summary.activity.lastCleanupAt)}` : '还没有执行记录' }}</small>
        </article>
        <article>
          <span>已移入回收站</span>
          <b>{{ formatBytes(summary.activity.movedToTrashBytes) }}</b>
          <small>{{ summary.activity.movedToTrashFiles.toLocaleString() }} 个文件，尚不等于已释放</small>
        </article>
        <article>
          <span>清理排除项</span>
          <b>{{ summary.activity.exclusionCount }}</b>
          <small>长期保护用户指定的路径</small>
        </article>
      </div>
    </details>

    <div class="principle-banner">
      <div class="principle-icon"><AppIcon name="shield" /></div>
      <div>
        <b>文件由你掌控</b>
        <p>浏览和分析不会修改文件，清理由你确认后执行。</p>
      </div>
      <span class="local-badge">本地优先</span>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, ref } from 'vue'
import { desktopApi } from '../platform/api'
import type { OverviewSummary } from '../domain/desktop'
import { formatBytes, formatDateTime } from '../shared/format'
import AppIcon from './AppIcon.vue'

defineEmits<{ navigate: [view: 'inspect']; 'inspect-path': [path: string] }>()

const summary = ref<OverviewSummary | null>(null)
const loading = ref(false)
const overviewError = ref('')
const availableBytes = computed(() => summary.value?.volumes.reduce((total, volume) => total + volume.freeBytes, 0) || 0)
const totalBytes = computed(() => summary.value?.volumes.reduce((total, volume) => total + volume.totalBytes, 0) || 0)
let loadedAt = 0

async function loadOverview() {
  const api = desktopApi()
  if (!api || loading.value) return
  loading.value = true
  overviewError.value = ''
  try {
    summary.value = await api.overviewGet()
    loadedAt = Date.now()
  } catch (error) {
    overviewError.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
}

onMounted(() => void loadOverview())
onActivated(() => {
  if (Date.now() - loadedAt > 30_000) void loadOverview()
})
</script>

<style src="./overview.css"></style>
