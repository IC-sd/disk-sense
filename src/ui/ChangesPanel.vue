<template>
  <section :class="embedded ? 'overview-changes' : 'page changes-page'">
    <header v-if="!embedded" class="page-header">
      <div>
        <div class="eyebrow"><span></span> CHANGE HISTORY</div>
        <h1>变化记录</h1>
        <p>比较两次磁盘状态，回答“刚才安装或下载的内容到底改变了什么”。</p>
      </div>
      <div class="header-actions">
        <button class="secondary-button" :disabled="busy" @click="createBaseline">
          <AppIcon name="database" />{{ baseline ? '重新建立基线' : '建立第一次基线' }}
        </button>
        <button class="primary-button" :disabled="busy || !baseline" @click="scanChanges">
          <AppIcon name="scan" />扫描变化
        </button>
      </div>
    </header>

    <header v-else class="overview-changes-header">
      <div>
        <div class="eyebrow"><span></span> STORAGE CHANGES</div>
        <h2>空间变化记录</h2>
        <p>记录当前磁盘状态，再比较软件安装、下载和文件整理之后新增、删除、修改或移动了什么。</p>
      </div>
      <div class="header-actions">
        <button class="secondary-button" :disabled="busy" @click="createBaseline">
          <AppIcon name="database" />{{ baseline ? '重新建立基线' : '建立第一次基线' }}
        </button>
        <button class="primary-button" :disabled="busy || !baseline" @click="scanChanges">
          <AppIcon name="scan" />扫描变化
        </button>
      </div>
    </header>

    <div class="baseline-card" :class="{ ready: baseline }">
      <div class="baseline-visual"><AppIcon :name="baseline ? 'shield' : 'history'" /></div>
      <div>
        <span>{{ baseline ? 'BASELINE READY' : 'NO BASELINE' }}</span>
        <b>{{ baseline ? `基线建立于 ${formatDateTime(baseline.createdAt)}` : '还没有可比较的磁盘基线' }}</b>
        <p>{{ baseline ? `已记录 ${baseline.entryCount.toLocaleString()} 项、${baseline.directoryCount.toLocaleString()} 个目录；只保存用于比较的元数据。` : '先记录当前状态，之后安装软件、下载或整理文件，再回来比较变化。' }}</p>
      </div>
      <div class="baseline-flow">
        <span>记录现在</span><i></i><span>发生变化</span><i></i><span>扫描差异</span>
      </div>
    </div>

    <div v-if="baseline?.rootCoverage?.length" class="root-coverage">
      <article v-for="root in baseline.rootCoverage" :key="root.root" :class="{ partial: root.truncated }">
        <b>{{ root.root }}</b>
        <span>{{ root.entries.toLocaleString() }} 项 · {{ root.directories.toLocaleString() }} 个目录</span>
        <small v-if="root.truncated">限时覆盖，仍有 {{ root.pendingDirectories.toLocaleString() }} 个目录待扫描</small>
        <small v-else>本次范围已完整遍历</small>
      </article>
    </div>

    <div v-if="busy" class="scan-progress">
      <div class="progress-pulse"></div>
      <div><b>{{ progressText }}</b><span>{{ (progress.entries || 0).toLocaleString() }} 项已记录</span></div>
      <p>{{ progress.current || '正在准备扫描范围' }}</p>
      <button class="text-button" @click="cancel">取消扫描</button>
    </div>

    <p v-if="error" class="inline-message error-message">{{ error }}</p>
    <p v-if="last?.result.coverage.partial" class="coverage-warning">
      <AppIcon name="shield" />
      {{ coverageWarning }}
    </p>

    <div v-if="last?.result" class="change-summary">
      <article class="summary-added"><AppIcon name="folder" /><span>新增</span><b>{{ last.result.summary.added }}</b></article>
      <article class="summary-modified"><AppIcon name="spark" /><span>修改</span><b>{{ last.result.summary.modified }}</b></article>
      <article class="summary-removed"><AppIcon name="clean" /><span>删除</span><b>{{ last.result.summary.removed }}</b></article>
      <article class="summary-moved"><AppIcon name="arrow" /><span>移动</span><b>{{ last.result.summary.moved }}</b></article>
      <article class="summary-space gained"><AppIcon name="database" /><span>新增空间</span><b>{{ formatBytes(last.result.summary.addedBytes) }}</b></article>
      <article class="summary-space released"><AppIcon name="database" /><span>减少空间</span><b>{{ formatBytes(last.result.summary.removedBytes) }}</b></article>
    </div>

    <div v-if="last?.result" class="change-groups">
      <section v-for="group in groups" :key="group.id" class="change-group">
        <header>
          <div class="change-group-icon" :class="`kind-${group.id}`"><AppIcon :name="group.icon" /></div>
          <div><h2>{{ group.title }}</h2><span>{{ group.items.length.toLocaleString() }} 项变化</span></div>
        </header>
        <div class="change-list">
          <div v-for="item in group.items.slice(0, 100)" :key="item.key" class="change-item">
            <span class="change-kind">{{ group.label }}</span>
            <div><b>{{ item.title }}</b><small>{{ item.detail }}</small></div>
          </div>
        </div>
        <p v-if="group.items.length > 100" class="muted">还有 {{ group.items.length - 100 }} 项未展开</p>
      </section>
    </div>

    <section v-if="history.length" class="change-history">
      <header><div><span>SCAN HISTORY</span><h2>最近比较记录</h2></div><small>最多保留 50 次摘要，不保存文件内容</small></header>
      <div class="change-history-list">
        <article v-for="record in history.slice(0, 8)" :key="record.id">
          <div><b>{{ formatDateTime(record.createdAt) }}</b><small>相对 {{ formatDateTime(record.baselineCreatedAt) }} 的基线</small></div>
          <span>+{{ record.summary.added }} / ~{{ record.summary.modified }} / -{{ record.summary.removed }} / ↔{{ record.summary.moved }}</span>
          <em :class="{ partial: record.partial }">{{ record.partial ? '限时覆盖' : '完整覆盖' }}</em>
        </article>
      </div>
    </section>

    <div v-if="!last?.result && !busy" class="empty-state">
      <div class="empty-rings"><AppIcon name="history" /></div>
      <h2>{{ baseline ? '等待下一次变化扫描' : '从记录当前状态开始' }}</h2>
      <p>{{ baseline ? '完成软件安装、下载或文件整理后，点击“扫描变化”。' : '基线不会读取或上传文件内容，只记录用于比较的元数据。' }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { desktopApi } from '../platform/api'
import type { ChangeBaseline, ChangeHistoryRecord, ChangeProgress, ChangeResult } from '../domain/desktop'
import { formatBytes, formatDateTime } from '../shared/format'
import AppIcon from './AppIcon.vue'

defineProps<{ embedded?: boolean }>()
const emit = defineEmits<{ changed: [] }>()

type ChangeGroup = {
  id: string
  title: string
  label: string
  icon: string
  items: Array<{ key: string; title: string; detail: string }>
}

const baseline = ref<ChangeBaseline | null>(null)
const last = ref<{ result: ChangeResult } | null>(null)
const history = ref<ChangeHistoryRecord[]>([])
const busy = ref(false)
const error = ref('')
const progress = ref<ChangeProgress>({})
let unsubscribeProgress: (() => void) | null = null

const progressText = computed(() => progress.value.current ? '正在扫描磁盘变化' : '正在准备扫描')
const coverageWarning = computed(() => {
  const coverage = last.value?.result.coverage
  if (!coverage) return ''
  if (coverage.rootsChanged) {
    return '两次扫描识别到的磁盘范围不同。为避免误报，新增或移除磁盘中的内容不会被猜测成普通文件变化。'
  }
  const reasons = [coverage.baselineLimitReason, coverage.currentLimitReason].filter(Boolean)
  if (reasons.includes('max-entries')) {
    return '本次扫描达到 50 万项安全上限：只报告两次都实际访问过的目录中的变化，未覆盖区域不会被猜测。'
  }
  if (reasons.includes('root-budget')) {
    return '部分磁盘目录数量超过本轮分配范围：结果只包含两次都实际访问过的位置，未覆盖区域不会被猜测。'
  }
  return '本次扫描达到 60 秒性能边界：只报告两次都实际访问过的目录中的变化，未覆盖区域不会被猜测。'
})
const groups = computed<ChangeGroup[]>(() => {
  const result = last.value?.result
  if (!result) return []
  return [
    { id: 'added', title: '新增内容', label: '新增', icon: 'folder', items: result.added.map(item => ({ key: item.path, title: item.path, detail: `${item.kind} · ${formatBytes(item.treeBytes ?? item.size)}${item.treeFileCount ? ` · ${item.treeFileCount} 个文件` : ''}` })) },
    { id: 'modified', title: '发生修改', label: '修改', icon: 'spark', items: result.modified.map(item => ({ key: item.path, title: item.path, detail: `${item.kind} · ${formatBytes(item.beforeSize)} → ${formatBytes(item.size)}` })) },
    { id: 'removed', title: '已不存在', label: '删除', icon: 'clean', items: result.removed.map(item => ({ key: item.path, title: item.path, detail: `${item.kind} · ${formatBytes(item.treeBytes ?? item.size)}${item.treeFileCount ? ` · ${item.treeFileCount} 个文件` : ''}` })) },
    { id: 'moved', title: '位置变化', label: '移动', icon: 'arrow', items: result.moved.map(item => ({ key: `${item.from}-${item.to}`, title: item.to, detail: `从 ${item.from} 移动 · ${formatBytes(item.size)}` })) }
  ].filter(group => group.items.length)
})

async function refresh() {
  const api = desktopApi()
  if (!api) return
  const state = await api.changesState()
  baseline.value = state.baseline
  last.value = state.last
  history.value = state.history || []
  emit('changed')
}

async function createBaseline() {
  const api = desktopApi()
  if (!api) return
  if (
    baseline.value &&
    !confirm('重新建立基线会替换当前对照点，之前尚未比较的变化将无法再以旧基线计算。确认继续吗？')
  ) return
  busy.value = true
  error.value = ''
  progress.value = {}
  try {
    const result = await api.changesBaseline()
    if (result.snapshot?.cancelled) error.value = '基线扫描已取消'
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

async function scanChanges() {
  const api = desktopApi()
  if (!api) return
  busy.value = true
  error.value = ''
  progress.value = {}
  try {
    const result = await api.changesScan()
    if (!result.ok) error.value = result.reason
    else await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

async function cancel() {
  const api = desktopApi()
  if (api) await api.changesCancel()
}

onMounted(() => {
  void refresh()
  const api = desktopApi()
  if (api) unsubscribeProgress = api.onChangesProgress(data => { progress.value = data })
})

onBeforeUnmount(() => unsubscribeProgress?.())
</script>
