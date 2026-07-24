<template>
  <section class="page overview-page">
    <header class="hero">
      <div class="hero-copy">
        <div class="eyebrow"><span></span> SPACE EXPLANATION</div>
        <h1><span>把磁盘变成一张</span><em>看得懂的空间地图</em></h1>
        <p>不只显示容量，还解释文件从哪里来、支持什么功能，以及为什么持续占用系统盘。</p>
        <div class="hero-actions">
          <button class="primary-button" @click="$emit('navigate', 'inspect')">
            <AppIcon name="scan" />
            探查 C 盘
          </button>
          <button class="secondary-button" @click="$emit('navigate', 'changes')">
            查看空间变化
            <AppIcon name="arrow" />
          </button>
        </div>
        <div class="trust-line">
          <span><AppIcon name="shield" /> 未知内容不自动删除</span>
          <span><AppIcon name="database" /> 本地证据优先</span>
        </div>
      </div>

      <div class="space-map" aria-label="Disk Sense 空间理解流程图">
        <div class="map-glow"></div>
        <div class="orbit orbit-one"><i></i><i></i></div>
        <div class="orbit orbit-two"><i></i></div>
        <div class="map-core">
          <AppIcon name="database" />
          <strong>C:\</strong>
          <small>空间入口</small>
        </div>
        <div class="map-node node-known"><span></span><b>已知系统内容</b><small>规则与签名识别</small></div>
        <div class="map-node node-personal"><span></span><b>个人内容</b><small>由用户决定</small></div>
        <div class="map-node node-unknown"><span></span><b>未知空间</b><small>继续收集证据</small></div>
      </div>
    </header>

    <section class="live-overview">
      <header>
        <div>
          <span>LIVE STORAGE STATUS</span>
          <h2>这台电脑的真实磁盘状态</h2>
        </div>
        <button class="text-button" :disabled="loading" @click="loadOverview">
          {{ loading ? '读取中…' : '刷新' }} <AppIcon name="scan" />
        </button>
      </header>

      <div v-if="summary?.volumes.length" class="volume-grid">
        <article v-for="volume in summary.volumes" :key="volume.root" :class="{ system: volume.isSystem }">
          <div class="volume-title">
            <span><AppIcon name="database" /></span>
            <div><b>{{ volume.root }}</b><small>{{ volume.isSystem ? 'Windows 系统盘' : '本地磁盘' }}</small></div>
            <strong>{{ volume.usagePercent }}%</strong>
          </div>
          <div class="volume-bar"><i :style="{ width: `${Math.min(100, volume.usagePercent)}%` }"></i></div>
          <div class="volume-numbers">
            <span><b>{{ formatBytes(volume.freeBytes) }}</b> 可用</span>
            <span>{{ formatBytes(volume.usedBytes) }} / {{ formatBytes(volume.totalBytes) }}</span>
          </div>
        </article>
      </div>
      <p v-else-if="!loading" class="inline-message">{{ overviewError || '暂时无法读取磁盘容量。' }}</p>

      <div v-if="summary" class="activity-grid">
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
          <span>变化基线</span>
          <b>{{ summary.activity.baselineCreatedAt ? '已建立' : '未建立' }}</b>
          <small>{{ summary.activity.baselineCreatedAt ? formatDateTime(summary.activity.baselineCreatedAt) : '建立后才能比较空间变化' }}</small>
        </article>
        <article>
          <span>清理排除项</span>
          <b>{{ summary.activity.exclusionCount }}</b>
          <small>长期保护用户指定的路径</small>
        </article>
      </div>
    </section>

    <div class="principle-banner">
      <div class="principle-icon"><AppIcon name="spark" /></div>
      <div>
        <b>先解释，再建议，最后才执行</b>
        <p>路径、名称、上下文和有限内容摘要会在本机形成判断；AI 只在你主动请求时参与补充分析。</p>
      </div>
      <span class="local-badge">LOCAL FIRST</span>
    </div>

    <div class="feature-grid">
      <article class="feature-card feature-blue">
        <span class="feature-index">01</span>
        <div class="feature-icon"><AppIcon name="folder" /></div>
        <h2>像资源管理器一样浏览</h2>
        <p>保留熟悉的目录结构，同时让每个文件和文件夹都拥有可理解的功能说明。</p>
        <button @click="$emit('navigate', 'inspect')">打开目录解释器 <AppIcon name="arrow" /></button>
      </article>
      <article class="feature-card feature-green">
        <span class="feature-index">02</span>
        <div class="feature-icon"><AppIcon name="history" /></div>
        <h2>看见空间为什么增长</h2>
        <p>在两次扫描之间识别新增、删除、修改和移动，追踪安装软件后的真实变化。</p>
        <button @click="$emit('navigate', 'changes')">建立变化基线 <AppIcon name="arrow" /></button>
      </article>
      <article class="feature-card feature-amber">
        <span class="feature-index">03</span>
        <div class="feature-icon"><AppIcon name="clean" /></div>
        <h2>把清理放在证据之后</h2>
        <p>垃圾清理和系统瘦身使用统一风险等级，高风险内容不会混入自动执行。</p>
        <button @click="$emit('navigate', 'cleaner')">进入清理中心 <AppIcon name="arrow" /></button>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onActivated, onMounted, ref } from 'vue'
import { desktopApi } from '../platform/api'
import type { OverviewSummary } from '../domain/desktop'
import { formatBytes, formatDateTime } from '../shared/format'
import AppIcon from './AppIcon.vue'

defineEmits<{ navigate: [view: 'inspect' | 'changes' | 'cleaner'] }>()

const summary = ref<OverviewSummary | null>(null)
const loading = ref(false)
const overviewError = ref('')
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
