<template>
  <section class="page explorer-page">
    <header class="page-header">
      <div>
        <div class="eyebrow"><span></span> EXPLAINER EXPLORER</div>
        <h1>目录与文件</h1>
        <p>沿着熟悉的目录结构浏览，重点不是打开文件，而是弄清楚它是什么、有什么用。</p>
      </div>
      <div class="header-status">
        <span :class="{ online: aiConfigured }"></span>
        {{ aiConfigured ? 'AI 辅助已就绪' : '本地分析模式' }}
      </div>
    </header>

    <div class="path-bar">
      <div class="path-input-wrap">
        <AppIcon name="folder" />
        <input v-model="pathInput" @keyup.enter="loadDirectory(pathInput)" placeholder="输入 Windows 路径，例如 C:\\Users" />
      </div>
      <button class="primary-button compact" :disabled="loading" @click="loadDirectory(pathInput)">
        <AppIcon name="scan" />
        {{ loading ? '正在打开' : '打开路径' }}
      </button>
      <button class="icon-button labelled" @click="showAiSettings = true">
        <AppIcon name="settings" />
        AI 设置
      </button>
    </div>

    <p v-if="inspectError" class="inline-message error-message">{{ inspectError }}</p>

    <div class="explorer-toolbar">
      <div class="toolbar-actions">
        <button class="icon-button" title="返回" :disabled="historyIndex <= 0" @click="goBack">←</button>
        <button class="icon-button" title="上级目录" @click="goUp">↑</button>
        <button class="icon-button" title="刷新" :disabled="loading" @click="loadDirectory(browsePath, false)">↻</button>
      </div>
      <div class="breadcrumbs">
        <button v-for="crumb in crumbs" :key="crumb.path" @click="loadDirectory(crumb.path)">
          {{ crumb.name }}
        </button>
      </div>
      <div class="directory-meta">
        <span>{{ inspectItems.length.toLocaleString() }} 项</span>
        <span v-if="estimatingCount">{{ estimatingCount }} 个目录正在估算</span>
        <span v-if="directoryTruncated">列表已达到显示上限</span>
      </div>
    </div>

    <div class="explorer-layout">
      <section class="file-list" aria-label="文件和目录列表">
        <div class="list-head">
          <span>名称</span>
          <span>初步判断</span>
          <span>大小</span>
        </div>

        <div v-if="loading" class="list-loading">
          <div v-for="index in 8" :key="index" class="skeleton-row"><i></i><span></span><small></small></div>
        </div>

        <div
          v-else
          ref="fileScroller"
          class="file-scroll"
          @scroll="onListScroll"
        >
          <div class="file-spacer" :style="{ height: `${inspectItems.length * rowHeight}px` }">
            <button
              v-for="row in visibleRows"
              :key="row.item.path"
              class="file-row"
              :class="{ selected: selected?.path === row.item.path }"
              :style="{ transform: `translateY(${row.index * rowHeight}px)` }"
              @click="handleRowClick(row.item)"
              @dblclick="handleRowDoubleClick(row.item)"
            >
              <span class="file-name">
                <i :class="{ directory: row.item.isDirectory }">
                  <AppIcon :name="row.item.isDirectory ? 'folder' : 'file'" />
                </i>
                <span><b>{{ row.item.name }}</b><small v-if="row.item.fileCount && row.item.isDirectory">已抽样 {{ row.item.fileCount.toLocaleString() }} 个文件</small></span>
              </span>
              <span class="row-classification">{{ row.item.source || '待分析' }}</span>
              <span class="row-size">
                {{ row.item.isDirectory && row.item.size === null ? (estimatingPaths.has(row.item.path) ? '估算中…' : '待估算') : `${row.item.isDirectory && row.item.sizeEstimated ? '≥ ' : ''}${formatBytes(row.item.size)}` }}
                <small v-if="row.item.isDirectory && row.item.sizeEstimated && row.item.size !== null">抽样估算</small>
              </span>
            </button>
          </div>
          <div v-if="!inspectItems.length" class="list-empty">
            <AppIcon name="folder" />
            <b>这个位置没有可显示的内容</b>
            <span>也可能是当前权限无法读取。</span>
          </div>
        </div>
      </section>

      <aside class="explain-panel">
        <div v-if="explanation" class="explanation-content">
          <div class="object-heading">
            <div class="object-icon"><AppIcon :name="selected?.isDirectory ? 'folder' : 'file'" /></div>
            <div>
              <span>{{ explanation.kind }}</span>
              <h2>{{ selected?.name }}</h2>
            </div>
          </div>

          <div class="explanation-summary">
            <span class="risk-chip" :class="riskClass(explanation.risk)">{{ riskLabel(explanation.risk) }}</span>
            <span>{{ percent(explanation.confidence) }} 置信度</span>
            <span>{{ explanation.aiAnalyzed ? (explanation.aiMode === 'deep' ? 'AI 深入分析' : 'AI 普通分析') : '本地证据分析' }}</span>
          </div>

          <div class="meaning-list">
            <section v-for="detail in objectDetails" :key="detail.label">
              <span>{{ detail.label }}</span>
              <p>{{ detail.value }}</p>
            </section>
          </div>

          <div class="ai-actions">
            <button class="ai-review normal" :disabled="aiBusy" @click="requestAi('normal')">
              <AppIcon name="spark" />
              <span><b>{{ aiBusyMode === 'normal' ? '分析中…' : '普通分析' }}</b><small>低思考 · 更快</small></span>
            </button>
            <button class="ai-review deep" :disabled="aiBusy" @click="requestAi('deep')">
              <AppIcon name="spark" />
              <span><b>{{ aiBusyMode === 'deep' ? '分析中…' : '深入分析' }}</b><small>最大思考 · 更完整</small></span>
            </button>
          </div>

          <p v-if="aiError" class="inline-message error-message">{{ aiError }}</p>

          <details v-if="explanation.aiReasons?.length" class="reason-details">
            <summary>为什么这样判断</summary>
            <ul><li v-for="reason in explanation.aiReasons" :key="reason">{{ reason }}</li></ul>
          </details>

          <div v-if="explanation.relatedLocations?.length" class="related-locations">
            <b>相关位置</b>
            <div v-for="location in explanation.relatedLocations" :key="location.path">
              <AppIcon name="database" />
              <span>{{ location.path }}<small>{{ location.reason }}</small></span>
            </div>
          </div>
        </div>

        <div v-else class="panel-empty">
          <div class="empty-graphic"><AppIcon name="scan" /></div>
          <b>选择一个文件或目录</b>
          <p>右侧会直接解释它是什么、支持什么功能，以及是否适合处理。</p>
        </div>
      </aside>
    </div>

    <AiSettingsModal
      v-if="showAiSettings"
      @close="showAiSettings = false"
      @saved="status => { aiConfigured = status.configured }"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { desktopApi } from '../platform/api'
import { createAiEvidence } from '../application/ai-evidence'
import { appAiAnalysisSession, applyAiRecord } from '../application/ai-session'
import type { AnalysisMode, DirectoryItem, FileExplanation } from '../domain/desktop'
import { riskClass, riskLabel } from '../domain/risk'
import { formatBytes, percent } from '../shared/format'
import AiSettingsModal from './AiSettingsModal.vue'
import AppIcon from './AppIcon.vue'

const rowHeight = 56
const pathInput = ref('C:\\')
const browsePath = ref('')
const history = ref<string[]>([])
const historyIndex = ref(-1)
const inspectItems = ref<DirectoryItem[]>([])
const selected = ref<DirectoryItem | null>(null)
const explanation = ref<FileExplanation | null>(null)
const inspectError = ref('')
const loading = ref(false)
const directoryTruncated = ref(false)
const estimatingCount = ref(0)
const estimatingPaths = ref(new Set<string>())
const aiConfigured = ref(false)
const aiBusy = ref(false)
const aiBusyMode = ref<AnalysisMode | null>(null)
const aiError = ref('')
const showAiSettings = ref(false)
const fileScroller = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(600)
const aiSession = appAiAnalysisSession
let navigationRequestId = 0
let selectionRequestId = 0
let rowClickTimer: ReturnType<typeof setTimeout> | null = null
let resizeObserver: ResizeObserver | null = null

const crumbs = computed(() => {
  const normalized = browsePath.value.replaceAll('/', '\\')
  const parts = normalized.split('\\').filter(Boolean)
  return parts.map((part, index) => ({
    name: part,
    path: index === 0 ? `${part}\\` : `${parts.slice(0, index + 1).join('\\')}\\`
  }))
})

const visibleRows = computed(() => {
  const overscan = 8
  const start = Math.max(0, Math.floor(scrollTop.value / rowHeight) - overscan)
  const count = Math.ceil(viewportHeight.value / rowHeight) + overscan * 2
  return inspectItems.value.slice(start, start + count).map((item, offset) => ({ item, index: start + offset }))
})

const objectDetails = computed(() => {
  if (!explanation.value) return []
  const item = explanation.value
  const ai = item.aiDetails
  return [
    { label: '它是什么', value: ai?.what || item.what || item.description || item.reason || '当前证据还不足以明确识别这个对象。' },
    { label: '有什么用', value: ai?.purpose || item.purpose || '需要结合目录结构和应用来源继续确认具体用途。' },
    { label: '属于什么', value: ai?.belongsTo || item.belongsTo || item.source || '尚未确认所属应用或系统组件。' },
    { label: '为什么在这里', value: ai?.whyHere || item.whyHere || `它位于 ${item.parent || '磁盘根目录'}，当前由路径和周边结构形成初步判断。` },
    { label: '如何处理', value: ai?.handling || item.handling || item.action || '建议先保留，确认用途后再决定是否处理。' }
  ]
})

async function loadAiStatus() {
  const api = desktopApi()
  if (!api) return
  try { aiConfigured.value = Boolean((await api.aiStatus()).configured) } catch { aiConfigured.value = false }
}

async function loadDirectory(dir?: string, addHistory = true) {
  const api = desktopApi()
  if (!api) {
    inspectError.value = '请使用 Electron 桌面开发模式打开项目'
    return
  }

  const currentRequest = ++navigationRequestId
  selectionRequestId += 1
  loading.value = true
  inspectError.value = ''
    estimatingCount.value = 0
    estimatingPaths.value = new Set()
  try {
    const result = await api.inspectList(dir || 'C:\\')
    if (currentRequest !== navigationRequestId) return
    browsePath.value = result.path
    pathInput.value = result.path
    inspectItems.value = result.items
    directoryTruncated.value = result.truncated
    selected.value = null
    explanation.value = null
    scrollTop.value = 0
    if (fileScroller.value) fileScroller.value.scrollTop = 0

    if (addHistory) {
      const nextHistory = history.value.slice(0, historyIndex.value + 1)
      if (nextHistory.at(-1)?.toLowerCase() !== result.path.toLowerCase()) nextHistory.push(result.path)
      history.value = nextHistory
      historyIndex.value = nextHistory.length - 1
    }

    loading.value = false
    await nextTick()
    void estimateVisibleDirectories(currentRequest)
  } catch (error) {
    if (currentRequest !== navigationRequestId) return
    inspectError.value = error instanceof Error ? error.message : String(error)
    inspectItems.value = []
  } finally {
    if (currentRequest === navigationRequestId) loading.value = false
  }
}

async function estimateVisibleDirectories(currentRequest: number) {
  const api = desktopApi()
  if (!api) return
  const queue = visibleRows.value
    .map(row => row.item)
    .filter(item => item.isDirectory && item.size === null && !estimatingPaths.value.has(item.path))
    .slice(0, 16)
  if (!queue.length) return
  const nextEstimating = new Set(estimatingPaths.value)
  queue.forEach(item => nextEstimating.add(item.path))
  estimatingPaths.value = nextEstimating
  estimatingCount.value = nextEstimating.size

  const worker = async () => {
    while (queue.length && currentRequest === navigationRequestId) {
      const item = queue.shift()
      if (!item) return
      try {
        const estimate = await api.inspectEstimate(item.path)
        if (currentRequest !== navigationRequestId) return
        const index = inspectItems.value.findIndex(candidate => candidate.path === item.path)
        if (index >= 0) {
          inspectItems.value[index] = {
            ...inspectItems.value[index],
            size: estimate.bytes,
            fileCount: estimate.fileCount,
            sizeEstimated: !estimate.complete
          }
        }
      } catch {
        // A protected directory keeps its unknown size without blocking the list.
      } finally {
        const remaining = new Set(estimatingPaths.value)
        remaining.delete(item.path)
        estimatingPaths.value = remaining
        estimatingCount.value = remaining.size
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(2, queue.length) }, worker))
}

function fingerprint(item: DirectoryItem, result: FileExplanation) {
  return `${result.modifiedAt || item.modifiedAt || 0}:${item.size ?? result.size ?? 0}`
}

async function selectItem(item: DirectoryItem) {
  const api = desktopApi()
  if (!api) return
  const currentRequest = ++selectionRequestId
  selected.value = item
  aiError.value = ''
  try {
    const result = await api.inspectExplain(item.path)
    if (currentRequest !== selectionRequestId) return
    const base: FileExplanation = {
      ...result,
      size: item.size ?? result.size,
      fileCount: item.fileCount ?? result.fileCount,
      isDirectory: item.isDirectory,
      kind: result.source || '本地功能分析',
      title: item.name,
      description: result.reason || '暂时没有足够证据解释其用途。',
      action: ['safe', 'low'].includes(result.risk) ? '确认内容后可以处理。' : '建议保留，并在获得更多证据后再决定。'
    }
    const cached = aiSession.get(item.path, fingerprint(item, result))
    explanation.value = cached ? applyAiRecord(base, cached) : base
  } catch (error) {
    if (currentRequest === selectionRequestId) inspectError.value = error instanceof Error ? error.message : String(error)
  }
}

function handleRowClick(item: DirectoryItem) {
  if (rowClickTimer) clearTimeout(rowClickTimer)
  rowClickTimer = setTimeout(() => {
    rowClickTimer = null
    void selectItem(item)
  }, item.isDirectory ? 180 : 0)
}

function handleRowDoubleClick(item: DirectoryItem) {
  if (rowClickTimer) {
    clearTimeout(rowClickTimer)
    rowClickTimer = null
  }
  if (item.isDirectory) void loadDirectory(item.path)
  else void selectItem(item)
}

async function requestAi(mode: AnalysisMode) {
  if (!aiConfigured.value) {
    showAiSettings.value = true
    return
  }
  const api = desktopApi()
  if (!api || !explanation.value || !selected.value) return
  const path = selected.value.path
  const currentFingerprint = fingerprint(selected.value, explanation.value)
  aiBusy.value = true
  aiBusyMode.value = mode
  aiError.value = ''
  try {
    const result = await api.aiReview({ evidence: createAiEvidence(explanation.value), mode })
    if (!result.ok) {
      aiError.value = result.reason || 'AI 服务没有返回有效结果'
      return
    }
    const record = aiSession.save(path, currentFingerprint, result)
    if (selected.value?.path === path) explanation.value = applyAiRecord(explanation.value, record)
  } catch (error) {
    aiError.value = error instanceof Error ? error.message : String(error)
  } finally {
    aiBusy.value = false
    aiBusyMode.value = null
  }
}

function goBack() {
  if (historyIndex.value <= 0) return
  historyIndex.value -= 1
  void loadDirectory(history.value[historyIndex.value], false)
}

function goUp() {
  const clean = browsePath.value.replace(/[\\/]+$/, '')
  if (/^[A-Za-z]:$/.test(clean)) return
  const index = clean.lastIndexOf('\\')
  if (index < 0) return
  const parent = clean.slice(0, index)
  void loadDirectory(/^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent)
}

function onListScroll(event: Event) {
  const element = event.currentTarget as HTMLElement
  scrollTop.value = element.scrollTop
  viewportHeight.value = element.clientHeight
  void estimateVisibleDirectories(navigationRequestId)
}

onMounted(() => {
  void loadAiStatus()
  void loadDirectory('C:\\')
  nextTick(() => {
    if (!fileScroller.value) return
    viewportHeight.value = fileScroller.value.clientHeight
    resizeObserver = new ResizeObserver(entries => {
      viewportHeight.value = entries[0]?.contentRect.height || viewportHeight.value
    })
    resizeObserver.observe(fileScroller.value)
  })
})

onBeforeUnmount(() => {
  if (rowClickTimer) clearTimeout(rowClickTimer)
  resizeObserver?.disconnect()
})
</script>
