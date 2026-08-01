<template>
  <section class="page explorer-page">
    <header class="page-header explorer-header">
      <div>
        <div class="eyebrow"><span></span> EXPLAINER EXPLORER</div>
        <h1>目录与文件</h1>
        <p>像资源管理器一样浏览，也能跨目录搜索；找到对象后继续解释它是什么、有什么用。</p>
      </div>
      <div class="explorer-header-actions">
        <div class="explorer-mode-switch" role="tablist" aria-label="目录工作模式">
          <button :class="{ active: mode === 'browse' }" @click="setMode('browse')">
            <AppIcon name="folder" />目录浏览
          </button>
          <button :class="{ active: mode === 'search' }" @click="setMode('search')">
            <AppIcon name="search" />文件搜索
          </button>
        </div>
        <div class="header-status">
          <span :class="{ online: aiConfigured }"></span>
          {{ aiConfigured ? 'AI 辅助已就绪' : '本地分析模式' }}
        </div>
      </div>
    </header>

    <div v-if="mode === 'browse'" class="path-bar">
      <div class="path-input-wrap">
        <AppIcon name="folder" />
        <input
          v-model="pathInput"
          @keyup.enter="loadDirectory(pathInput)"
          placeholder="输入 Windows 路径，例如 C:\Users"
        />
      </div>
      <button class="primary-button compact" :disabled="loading" @click="loadDirectory(pathInput)">
        <AppIcon name="scan" />
        {{ loading ? '正在打开' : '打开路径' }}
      </button>
      <button class="icon-button labelled" @click="showAiSettings = true">
        <AppIcon name="settings" />AI 设置
      </button>
    </div>

    <div v-else class="search-workspace">
      <div class="search-commandbar">
        <div class="search-input-wrap">
          <AppIcon name="search" />
          <input
            ref="searchInputElement"
            v-model="searchQuery"
            placeholder="搜索文件或文件夹"
            @input="scheduleSearch"
            @keydown.enter.prevent="handleSearchEnter"
            @keyup.escape="clearSearch"
            @keydown.arrow-down.prevent="moveSearchSelection(1)"
            @keydown.arrow-up.prevent="moveSearchSelection(-1)"
          />
          <kbd>Enter</kbd>
        </div>
      </div>

      <div class="search-filterbar">
        <div class="search-kind-filters" aria-label="文件类型">
          <button
            v-for="filter in kindFilters"
            :key="filter.value"
            :class="{ active: searchKind === filter.value }"
            @click="searchKind = filter.value; performSearch({ resetPosition: true })"
          >
            {{ filter.label }}
          </button>
        </div>
        <label>
          修改时间
          <select v-model="searchModified" @change="performSearch({ resetPosition: true })">
            <option value="any">不限</option>
            <option value="day">最近 1 天</option>
            <option value="week">最近 7 天</option>
            <option value="month">最近 30 天</option>
            <option value="year">最近 1 年</option>
          </select>
        </label>
        <label>
          排序
          <select v-model="searchSort" @change="performSearch({ resetPosition: true })">
            <option value="relevance">相关度</option>
            <option value="modified">修改时间</option>
            <option value="size">大小</option>
            <option value="name">名称</option>
          </select>
        </label>
      </div>

      <div class="index-status" :class="{ building: searchIndex?.building, warning: !searchIndex?.indexed }">
        <span class="index-status-dot"></span>
        <template v-if="searchIndex && !searchIndex.available">
          文件索引暂时不可用<span v-if="searchIndex.error"> · {{ searchIndex.error }}</span>
        </template>
        <template v-else-if="searchIndex?.building">
          正在后台准备文件搜索 · {{ compactPath(searchIndex.current) }} ·
          {{ searchIndex.entries.toLocaleString() }} 项 ·
          {{ searchIndex.inaccessible.toLocaleString() }} 个位置无权访问
        </template>
        <template v-else-if="searchIndex?.indexed">
          可搜索 {{ searchIndex.entries.toLocaleString() }} 项
          <span v-if="searchIndex.watching">· 文件变化自动同步</span>
          <span v-else>· 后台定期校对</span>
          <span v-if="searchIndex.completedAt">· 上次完整校对 {{ formatRelativeTime(searchIndex.completedAt) }}</span>
          <span v-if="searchIndex.phase === 'partial'">· 已达到性能保护上限</span>
        </template>
        <template v-else>
          正在启动后台文件搜索
        </template>
        <span v-if="searchResultMeta">
          · 找到 {{ searchItems.length.toLocaleString() }} 项 · {{ searchResultMeta.tookMs }} ms
          <template v-if="searchResultMeta.truncated"> · 结果较多，仅显示前 {{ searchItems.length }} 项</template>
        </span>
      </div>
    </div>

    <p v-if="activeError" class="inline-message error-message">{{ activeError }}</p>

    <div
      class="explorer-layout"
      :class="{ 'search-awaiting-selection': mode === 'search' && !selected }"
    >
      <section class="file-list" :class="{ 'search-results': mode === 'search' }" aria-label="文件和目录列表">
        <div v-if="mode === 'browse'" class="explorer-toolbar file-list-toolbar">
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

        <div class="list-head">
          <template v-if="mode === 'browse'">
            <span>名称</span><span>初步判断</span><span>大小</span>
          </template>
          <template v-else>
            <span>名称与位置</span><span>匹配类型</span><span>最近修改</span>
          </template>
        </div>

        <div v-if="showListLoading" class="list-loading">
          <div v-for="index in 8" :key="index" class="skeleton-row"><i></i><span></span><small></small></div>
        </div>

        <div v-else ref="fileScroller" class="file-scroll" @scroll="onListScroll">
          <div class="file-spacer" :style="{ height: `${activeItems.length * activeRowHeight}px` }">
            <button
              v-for="row in visibleRows"
              :key="row.item.path"
              class="file-row"
              :class="[
                {
                  selected: selected?.path === row.item.path,
                  'search-result-row': mode === 'search',
                  'top-result': mode === 'search' && row.index === 0 && !selected
                },
                mode === 'search' ? `priority-${searchPriority(row.item)}` : ''
              ]"
              :style="{ height: `${activeRowHeight}px`, transform: `translateY(${row.index * activeRowHeight}px)` }"
              @click="handleRowClick(row.item)"
              @dblclick="handleRowDoubleClick(row.item)"
            >
              <span class="file-name">
                <i
                  :class="[
                    {
                      directory: row.item.isDirectory,
                      native: mode === 'search' && Boolean(nativeIcon(row.item.path))
                    },
                    mode === 'search' ? `kind-${searchItemKind(row.item)}` : ''
                  ]"
                >
                  <img
                    v-if="mode === 'search' && nativeIcon(row.item.path)"
                    class="native-result-icon"
                    :src="nativeIcon(row.item.path)"
                    alt=""
                  />
                  <AppIcon v-else :name="mode === 'search' ? searchIconName(row.item) : (row.item.isDirectory ? 'folder' : 'file')" />
                </i>
                <span>
                  <b v-if="mode === 'browse'">{{ row.item.name }}</b>
                  <b v-else class="search-result-name">
                    <template v-for="(segment, segmentIndex) in searchNameSegments(displayItemName(row.item))" :key="`${row.item.path}-${segmentIndex}`">
                      <mark v-if="segment.match">{{ segment.text }}</mark>
                      <span v-else>{{ segment.text }}</span>
                    </template>
                  </b>
                  <small v-if="mode === 'browse' && row.item.fileCount && row.item.isDirectory">
                    已抽样 {{ row.item.fileCount.toLocaleString() }} 个文件
                  </small>
                  <small v-else-if="mode === 'search'" class="row-path" :title="row.item.path">
                    {{ parentPath(row.item.path) }}
                  </small>
                </span>
              </span>
              <span v-if="mode === 'browse'" class="row-classification">{{ row.item.source || '待分析' }}</span>
              <span v-else class="row-result-type">
                <b>{{ searchResultReason(row.item) }}</b>
                <small>
                  {{ row.item.isDirectory ? '文件夹' : fileTypeLabel(row.item.extension) }}
                  <template v-if="!row.item.isDirectory"> · {{ formatBytes(row.item.size) }}</template>
                </small>
              </span>
              <span v-if="mode === 'browse'" class="row-size">
                {{
                  row.item.isDirectory && row.item.size === null
                    ? (estimatingPaths.has(row.item.path) ? '估算中…' : '待估算')
                    : `${row.item.isDirectory && row.item.sizeEstimated ? '≥ ' : ''}${formatBytes(row.item.size)}`
                }}
                <small v-if="row.item.isDirectory && row.item.sizeEstimated && row.item.size !== null">抽样估算</small>
              </span>
              <span v-else class="row-modified">
                <b>{{ formatRelativeModified(row.item.modifiedAt) }}</b>
                <small>{{ formatModified(row.item.modifiedAt) }}</small>
              </span>
            </button>
          </div>
          <div v-if="!activeItems.length" class="list-empty">
            <AppIcon :name="mode === 'search' ? 'search' : 'folder'" />
            <b>{{ emptyTitle }}</b>
            <span>{{ emptyDescription }}</span>
          </div>
        </div>
      </section>

      <aside class="explain-panel">
        <div v-if="explanation" class="explanation-content">
          <div class="object-heading">
            <div class="object-icon"><AppIcon :name="selected?.isDirectory ? 'folder' : 'file'" /></div>
            <div>
              <span>{{ explanation.kind }}</span>
              <h2>{{ selected ? (mode === 'search' ? displayItemName(selected) : selected.name) : '' }}</h2>
              <small class="explained-path" :title="selected?.path">{{ selected?.path }}</small>
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
          <p>无论从目录浏览还是搜索找到，都可以继续解释它是什么、有什么用，以及是否适合处理。</p>
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
import type {
  AnalysisMode,
  DirectoryItem,
  FileExplanation,
  FileSearchIndexStatus,
  FileSearchItem,
  FileSearchKind,
  FileSearchModified,
  FileSearchResult,
  FileSearchSort,
  NativeFilePresentation
} from '../domain/desktop'
import { riskClass, riskLabel } from '../domain/risk'
import { formatBytes, percent } from '../shared/format'
import AiSettingsModal from './AiSettingsModal.vue'
import AppIcon from './AppIcon.vue'

type ExplorerMode = 'browse' | 'search'

const mode = ref<ExplorerMode>('browse')
const pathInput = ref('C:\\')
const browsePath = ref('')
const history = ref<string[]>([])
const historyIndex = ref(-1)
const inspectItems = ref<DirectoryItem[]>([])
const searchItems = ref<FileSearchItem[]>([])
const selected = ref<DirectoryItem | null>(null)
const explanation = ref<FileExplanation | null>(null)
const inspectError = ref('')
const searchError = ref('')
const loading = ref(false)
const searching = ref(false)
const directoryTruncated = ref(false)
const estimatingCount = ref(0)
const estimatingPaths = ref(new Set<string>())
const aiConfigured = ref(false)
const aiBusy = ref(false)
const aiBusyMode = ref<AnalysisMode | null>(null)
const aiError = ref('')
const showAiSettings = ref(false)
const fileScroller = ref<HTMLElement | null>(null)
const searchInputElement = ref<HTMLInputElement | null>(null)
const nativePresentations = ref<Record<string, NativeFilePresentation>>({})
const scrollTop = ref(0)
const viewportHeight = ref(600)
const aiSession = appAiAnalysisSession

const searchQuery = ref('')
const searchKind = ref<FileSearchKind>('all')
const searchModified = ref<FileSearchModified>('any')
const searchSort = ref<FileSearchSort>('relevance')
const searchIndex = ref<FileSearchIndexStatus | null>(null)
const searchResultMeta = ref<Pick<FileSearchResult, 'tookMs' | 'truncated'> | null>(null)

let navigationRequestId = 0
let selectionRequestId = 0
let searchRequestId = 0
let rowClickTimer: ReturnType<typeof setTimeout> | null = null
let searchTimer: ReturnType<typeof setTimeout> | null = null
let lastObservedChangedAt = ''
let backgroundRefreshTimer: ReturnType<typeof setTimeout> | null = null
let nativeIconTimer: ReturnType<typeof setTimeout> | null = null
let resizeObserver: ResizeObserver | null = null
let unsubscribeIndex: (() => void) | null = null
const pendingNativeIcons = new Set<string>()
const maximumNativePresentations = 600

const kindFilters: Array<{ value: FileSearchKind; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'folder', label: '文件夹' },
  { value: 'file', label: '文件' },
  { value: 'application', label: '应用' },
  { value: 'document', label: '文档' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
  { value: 'archive', label: '压缩包' },
  { value: 'installer', label: '安装包' },
  { value: 'code', label: '代码' }
]

const activeItems = computed(() => mode.value === 'search' ? searchItems.value : inspectItems.value)
const showListLoading = computed(() => mode.value === 'search'
  ? searching.value && searchItems.value.length === 0
  : loading.value)
const activeError = computed(() => mode.value === 'search' ? searchError.value : inspectError.value)
const activeRowHeight = computed(() => mode.value === 'search' ? 54 : 56)

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
  const start = Math.max(0, Math.floor(scrollTop.value / activeRowHeight.value) - overscan)
  const count = Math.ceil(viewportHeight.value / activeRowHeight.value) + overscan * 2
  return activeItems.value.slice(start, start + count).map((item, offset) => ({ item, index: start + offset }))
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

const emptyTitle = computed(() => {
  if (mode.value === 'browse') return '这个位置没有可显示的内容'
  if (!searchQuery.value.trim()) return '输入关键词开始搜索'
  if (searchIndex.value?.building && !searchIndex.value.indexed) return '正在后台准备文件搜索'
  if (!searchIndex.value?.indexed) return '正在准备全盘文件搜索'
  return '没有找到匹配内容'
})

const emptyDescription = computed(() => {
  if (mode.value === 'browse') return '也可能是当前权限无法读取。'
  if (!searchQuery.value.trim()) return '输入文件或文件夹名称，搜索这台电脑中的匹配内容。'
  if (!searchIndex.value?.indexed) return '结果会随着索引建立逐步出现，索引不会读取文件正文。'
  return '尝试缩短关键词、使用通配符，或清除类型和时间筛选条件。'
})

async function loadAiStatus() {
  const api = desktopApi()
  if (!api) return
  try { aiConfigured.value = Boolean((await api.aiStatus()).configured) } catch { aiConfigured.value = false }
}

async function loadIndexStatus() {
  const api = desktopApi()
  if (!api) return
  try {
    searchIndex.value = await api.inspectIndexStatus()
    lastObservedChangedAt = searchIndex.value.lastChangedAt || ''
  } catch (error) {
    searchError.value = error instanceof Error ? error.message : String(error)
  }
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
    resetListScroll()
    if (addHistory) {
      const nextHistory = history.value.slice(0, historyIndex.value + 1)
      if (nextHistory.at(-1)?.toLowerCase() !== result.path.toLowerCase()) nextHistory.push(result.path)
      history.value = nextHistory
      historyIndex.value = nextHistory.length - 1
    }
    loading.value = false
    await nextTick()
    attachScrollerObserver()
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
  if (mode.value !== 'browse') return
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
        // Protected directories remain unknown and do not block the visible list.
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

function setMode(next: ExplorerMode) {
  if (mode.value === next) return
  mode.value = next
  selected.value = null
  explanation.value = null
  inspectError.value = ''
  searchError.value = ''
  resetListScroll()
  nextTick(() => {
    attachScrollerObserver()
    if (next === 'search') {
      searchInputElement.value?.focus()
      void loadIndexStatus()
      if (searchQuery.value.trim()) void performSearch()
    }
  })
}

function scheduleSearch() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void performSearch({ resetPosition: true }), 65)
}

interface SearchRequestOptions {
  resetPosition?: boolean
  background?: boolean
}

function sameSearchItems(current: FileSearchItem[], incoming: FileSearchItem[]) {
  if (current.length !== incoming.length) return false
  return current.every((item, index) => {
    const next = incoming[index]
    return item.path === next?.path
      && item.modifiedAt === next.modifiedAt
      && item.size === next.size
  })
}

async function performSearch(options: SearchRequestOptions = {}) {
  if (searchTimer) {
    clearTimeout(searchTimer)
    searchTimer = null
  }
  const query = searchQuery.value.trim()
  const currentRequest = ++searchRequestId
  if (!options.background) searchError.value = ''
  if (!query) {
    searchItems.value = []
    searchResultMeta.value = null
    return
  }
  const api = desktopApi()
  if (!api) {
    searchError.value = '请使用 Electron 桌面开发模式执行文件搜索'
    return
  }
  if (!searchIndex.value?.indexed) {
    searchItems.value = []
    if (!searchIndex.value?.building) {
      try {
        const result = await api.inspectIndexStart({ scope: 'all' })
        searchIndex.value = result.status
        if (!result.started && result.reason) searchError.value = result.reason
      } catch (error) {
        searchError.value = error instanceof Error ? error.message : String(error)
      }
    }
    return
  }
  searching.value = true
  try {
    const result = await api.inspectSearch({
      query,
      scope: 'all',
      kind: searchKind.value,
      modified: searchModified.value,
      sort: searchSort.value,
      limit: 300
    })
    if (currentRequest !== searchRequestId) return
    if (!sameSearchItems(searchItems.value, result.items)) {
      searchItems.value = result.items
    }
    searchIndex.value = result.index
    searchResultMeta.value = { tookMs: result.tookMs, truncated: result.truncated }
    if (options.resetPosition) resetListScroll()
    await nextTick()
    scheduleNativeIconLoad()
    if (selected.value && !result.items.some(item => item.path === selected.value?.path)) {
      selected.value = null
      explanation.value = null
    }
  } catch (error) {
    if (currentRequest === searchRequestId) {
      searchError.value = error instanceof Error ? error.message : String(error)
      searchItems.value = []
    }
  } finally {
    if (currentRequest === searchRequestId) searching.value = false
  }
}

function clearSearch() {
  searchRequestId += 1
  searchQuery.value = ''
  searchItems.value = []
  searchError.value = ''
  searchResultMeta.value = null
  searching.value = false
  resetListScroll()
}

function moveSearchSelection(direction: 1 | -1) {
  if (mode.value !== 'search' || !searchItems.value.length) return
  const currentIndex = selected.value
    ? searchItems.value.findIndex(item => item.path === selected.value?.path)
    : -1
  const nextIndex = currentIndex < 0
    ? (direction > 0 ? 0 : searchItems.value.length - 1)
    : Math.max(0, Math.min(searchItems.value.length - 1, currentIndex + direction))
  const item = searchItems.value[nextIndex]
  if (!item) return
  void selectItem(item)

  const scroller = fileScroller.value
  if (!scroller) return
  const rowTop = nextIndex * activeRowHeight.value
  const rowBottom = rowTop + activeRowHeight.value
  if (rowTop < scroller.scrollTop) scroller.scrollTop = rowTop
  else if (rowBottom > scroller.scrollTop + scroller.clientHeight) {
    scroller.scrollTop = rowBottom - scroller.clientHeight
  }
}

function handleSearchEnter() {
  const current = selected.value && searchItems.value.find(item => item.path === selected.value?.path)
  const target = current || searchItems.value[0]
  if (target) {
    void selectItem(target)
    return
  }
  void performSearch({ resetPosition: true })
}

function scheduleBackgroundSearchRefresh() {
  if (backgroundRefreshTimer) clearTimeout(backgroundRefreshTimer)
  backgroundRefreshTimer = setTimeout(() => {
    backgroundRefreshTimer = null
    if (mode.value === 'search' && searchQuery.value.trim()) {
      void performSearch({ background: true })
    }
  }, 220)
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
      title: mode.value === 'search' ? displayItemName(item) : item.name,
      description: result.reason || '暂时没有足够证据解释其用途。',
      action: ['safe', 'low'].includes(result.risk)
        ? '确认内容后可以处理。'
        : '建议保留，并在获得更多证据后再决定。'
    }
    const cached = aiSession.get(item.path, fingerprint(item, result))
    explanation.value = cached ? applyAiRecord(base, cached) : base
  } catch (error) {
    if (currentRequest === selectionRequestId) {
      const target = mode.value === 'search' ? searchError : inspectError
      target.value = error instanceof Error ? error.message : String(error)
    }
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
  if (item.isDirectory) {
    mode.value = 'browse'
    void loadDirectory(item.path)
  } else {
    void selectItem(item)
  }
}

async function requestAi(mode: AnalysisMode) {
  if (!aiConfigured.value) {
    showAiSettings.value = true
    return
  }
  const api = desktopApi()
  if (!api || !explanation.value || !selected.value) return
  const targetPath = selected.value.path
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
    const record = aiSession.save(targetPath, currentFingerprint, result)
    if (selected.value?.path === targetPath) explanation.value = applyAiRecord(explanation.value, record)
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
  if (mode.value === 'browse') void estimateVisibleDirectories(navigationRequestId)
  else scheduleNativeIconLoad()
}

function resetListScroll() {
  scrollTop.value = 0
  if (fileScroller.value) fileScroller.value.scrollTop = 0
}

function attachScrollerObserver() {
  resizeObserver?.disconnect()
  if (!fileScroller.value) return
  viewportHeight.value = fileScroller.value.clientHeight
  resizeObserver = new ResizeObserver(entries => {
    viewportHeight.value = entries[0]?.contentRect.height || viewportHeight.value
  })
  resizeObserver.observe(fileScroller.value)
}

function parentPath(value: string) {
  const clean = value.replace(/[\\/]+$/, '')
  const index = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'))
  return index > 0 ? clean.slice(0, index) : clean
}

function searchItem(item: DirectoryItem) {
  return item as FileSearchItem
}

function displayItemName(item: DirectoryItem) {
  return nativePresentation(item.path)?.displayName || searchItem(item).displayName || item.name
}

function nativePresentation(filePath: string) {
  return nativePresentations.value[filePath.toLowerCase()]
}

function nativeIcon(filePath: string) {
  return nativePresentation(filePath)?.dataUrl || ''
}

function scheduleNativeIconLoad() {
  if (nativeIconTimer) clearTimeout(nativeIconTimer)
  nativeIconTimer = setTimeout(() => {
    nativeIconTimer = null
    void loadVisibleNativeIcons()
  }, 45)
}

async function loadVisibleNativeIcons() {
  if (mode.value !== 'search') return
  const api = desktopApi()
  if (!api?.inspectFilePresentations) return
  const paths = visibleRows.value
    .map(row => row.item.path)
    .filter(filePath => !nativePresentation(filePath) && !pendingNativeIcons.has(filePath.toLowerCase()))
    .slice(0, 32)
  if (!paths.length) return
  paths.forEach(filePath => pendingNativeIcons.add(filePath.toLowerCase()))
  try {
    const loaded = await api.inspectFilePresentations(paths)
    const next = new Map(Object.entries(nativePresentations.value))
    for (const [filePath, presentation] of Object.entries(loaded)) {
      if (presentation.dataUrl?.startsWith('data:image/') || presentation.displayName) {
        const cacheKey = filePath.toLowerCase()
        next.delete(cacheKey)
        next.set(cacheKey, presentation)
      }
    }
    while (next.size > maximumNativePresentations) next.delete(next.keys().next().value as string)
    nativePresentations.value = Object.fromEntries(next)
  } catch {
    // Native icons improve recognition but never block search results.
  } finally {
    paths.forEach(filePath => pendingNativeIcons.delete(filePath.toLowerCase()))
  }
}

function searchPriority(item: DirectoryItem) {
  return searchItem(item).searchPriority || 'standard'
}

function searchItemKind(item: DirectoryItem) {
  return searchItem(item).searchKind || (item.isDirectory ? 'folder' : 'file')
}

function searchResultReason(item: DirectoryItem) {
  const presentation = nativePresentation(item.path)
  if (searchItemKind(item) === 'application' && presentation?.displayName?.startsWith('Microsoft ')) {
    return 'Microsoft Office 应用'
  }
  return searchItem(item).relevanceReason || (item.isDirectory ? '文件夹匹配' : '文件名匹配')
}

function searchIconName(item: DirectoryItem) {
  const kind = searchItemKind(item)
  return ['folder', 'application', 'document', 'image', 'video', 'audio', 'archive', 'installer', 'code'].includes(kind)
    ? kind
    : 'file'
}

function searchNameSegments(name: string) {
  const query = searchQuery.value.replaceAll('*', '').replaceAll('?', '').trim()
  if (!query) return [{ text: name, match: false }]
  const index = name.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
  if (index < 0) return [{ text: name, match: false }]
  return [
    { text: name.slice(0, index), match: false },
    { text: name.slice(index, index + query.length), match: true },
    { text: name.slice(index + query.length), match: false }
  ].filter(segment => segment.text)
}

function compactPath(value: string) {
  if (!value) return '准备中'
  return value.length > 72 ? `…${value.slice(-69)}` : value
}

function formatModified(value: number) {
  if (!value) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(new Date(value))
}

function formatRelativeModified(value: number) {
  if (!value) return '时间未知'
  const elapsed = Math.max(0, Date.now() - value)
  if (elapsed < 60_000) return '刚刚'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`
  if (elapsed < 7 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)} 天前`
  if (elapsed < 30 * 86_400_000) return `${Math.floor(elapsed / (7 * 86_400_000))} 周前`
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value))
}

function formatRelativeTime(value: string) {
  const elapsed = Date.now() - new Date(value).getTime()
  if (elapsed < 60_000) return '刚刚'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`
  return `${Math.floor(elapsed / 86_400_000)} 天前`
}

function fileTypeLabel(extension: string) {
  const knownTypes: Record<string, string> = {
    '.lnk': '快捷方式',
    '.url': '网页快捷方式',
    '.exe': '应用程序',
    '.msi': '安装程序',
    '.msix': '应用安装包',
    '.appx': '应用安装包'
  }
  return knownTypes[extension.toLowerCase()]
    || (extension ? `${extension.slice(1).toUpperCase()} 文件` : '文件')
}

onMounted(() => {
  const api = desktopApi()
  void loadAiStatus()
  void loadIndexStatus()
  void loadDirectory('C:\\')
  if (api) {
    unsubscribeIndex = api.onInspectIndexProgress(status => {
      const wasBuilding = searchIndex.value?.building
      const previousChangedAt = lastObservedChangedAt || searchIndex.value?.lastChangedAt || ''
      searchIndex.value = status
      lastObservedChangedAt = status.lastChangedAt || ''
      const rebuildCompleted = Boolean(wasBuilding && !status.building)
      const filesChanged = Boolean(
        status.lastChangedAt
        && status.lastChangedAt !== previousChangedAt
      )
      if (rebuildCompleted || filesChanged) {
        scheduleBackgroundSearchRefresh()
      }
    })
  }
  nextTick(attachScrollerObserver)
})

onBeforeUnmount(() => {
  if (rowClickTimer) clearTimeout(rowClickTimer)
  if (searchTimer) clearTimeout(searchTimer)
  if (backgroundRefreshTimer) clearTimeout(backgroundRefreshTimer)
  if (nativeIconTimer) clearTimeout(nativeIconTimer)
  unsubscribeIndex?.()
  resizeObserver?.disconnect()
})
</script>
