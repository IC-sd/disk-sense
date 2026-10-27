<template>
  <section class="history-panel">
    <header class="history-intro">
      <div>
        <span>本机操作记录</span>
        <h2>查看每次处理的结果</h2>
        <p>每一次清理和系统维护都有结果可查。展开记录，核对文件结果与未处理原因。</p>
      </div>
      <button class="secondary-button" :disabled="loading" @click="loadHistory">
        <AppIcon name="scan" />{{ loading ? '读取中…' : '刷新记录' }}
      </button>
    </header>

    <div v-if="hasHistory" class="history-metrics">
      <article><span>已记录任务</span><b>{{ history.length + maintenanceHistory.length }}</b><small>{{ history.length }} 次清理 · {{ maintenanceHistory.length }} 次维护</small></article>
      <article><span>移入回收站</span><b>{{ formatBytes(totalMoved) }}</b><small>清空回收站后才释放</small></article>
      <article><span>系统维护</span><b>{{ maintenanceHistory.length }}</b><small>{{ successfulMaintenance }} 次成功完成</small></article>
      <article><span>未处理</span><b>{{ (totalFailed + failedMaintenance).toLocaleString() }}</b><small>失败或被安全边界阻止</small></article>
    </div>

    <section v-if="maintenanceHistory.length" class="maintenance-history audit-maintenance-history">
      <header><div><span>Windows 官方维护</span><b>系统维护记录</b></div><small>{{ maintenanceHistory.length }} 次 · 固定命令白名单</small></header>
      <article v-for="job in maintenanceHistory" :key="job.id">
        <span class="maintenance-result-icon" :class="{ success: job.success }"><AppIcon :name="job.success ? 'shield' : 'close'" /></span>
        <div><b>{{ job.title }}</b><small>{{ formatDateTime(job.finishedAt) }} · {{ job.readOnly ? '只读分析' : job.irreversible ? '不可逆维护' : '系统维护' }}</small></div>
        <p>{{ job.message }}</p>
        <p v-if="job.observedAvailableDeltaBytes != null">卷可用空间净变化 {{ job.observedAvailableDeltaBytes >= 0 ? '+' : '−' }}{{ formatBytes(Math.abs(job.observedAvailableDeltaBytes)) }}，包含其他程序的活动。</p>
        <button v-if="job.recoveryRequired" class="secondary-button" @click="acknowledgeMaintenance(job.id)">我已核对 Windows 维护结果</button>
        <strong :class="{ success: job.success }">{{ job.recoveryRequired ? '结果待核对' : job.restartRequired ? '完成，需重启' : job.success ? '成功' : `失败 ${job.exitCode}` }}</strong>
      </article>
    </section>

    <div v-if="history.length" class="history-list">
      <header class="history-list-heading"><b>文件处理记录</b><span>{{ history.length }} 次 · 点击查看文件明细</span></header>
      <article v-for="job in history" :key="job.id" :class="{ open: openJobId === job.id }">
        <button class="history-row" :aria-expanded="openJobId === job.id" @click="toggleDetail(job.id)">
          <span class="history-status" :class="{ success: !job.failed && !job.cancelled, warning: job.failed || job.cancelled }">
            <AppIcon :name="job.failed || job.cancelled ? 'shield' : 'clean'" />
          </span>
          <span class="history-title">
            <b>{{ formatDateTime(job.createdAt) }}</b>
            <small>{{ job.recoveryRequired ? '中断，结果待核对' : job.cancelled ? '任务已取消' : job.executionMode === 'quarantine' ? '历史跨盘隔离任务' : '回收站清理任务' }} · {{ job.processed }} / {{ job.requested }} 个文件</small>
          </span>
          <span class="history-count">
            <b>{{ formatBytes(job.executionMode === 'quarantine' ? job.isolatedBytes || 0 : job.movedToTrashBytes) }}</b>
            <small>{{ job.succeeded }} 成功 · {{ job.failed }} 未处理</small>
          </span>
          <AppIcon name="arrow" />
        </button>

        <div v-if="openJobId === job.id" class="history-detail">
          <div v-if="detailLoading" class="muted">正在读取逐文件结果…</div>
          <template v-else>
            <p v-if="detail?.recoveryRequired" class="muted" role="status">上次任务中断，{{ detail.uncertainCount || 0 }} 项操作结果未确认。请到回收站核对；再次处理前需要重新扫描，程序不会自动重试。</p>
            <button v-if="detail?.recoveryRequired" class="secondary-button" @click="acknowledgeRecovery">我已核对本次任务</button>
            <p v-if="detail?.executionMode === 'quarantine'" class="muted">这是旧版跨盘隔离记录；保留原始操作信息，隔离文件仍保存在原隔离目录。</p>
            <p v-for="volume in detail?.volumeChanges || []" :key="volume.root" class="muted">{{ volume.root }} 可用空间净变化：{{ volume.delta == null ? '无法测量' : `${volume.delta >= 0 ? '+' : '−'}${formatBytes(Math.abs(volume.delta))}` }}。此值包含后台活动，不等于可精确归因的释放量。</p>
            <div class="history-detail-heading"><b>逐文件结果</b><span>{{ detail?.results.length.toLocaleString() || 0 }} 条已保存明细</span></div>
            <div v-for="(result, index) in detail?.results" :key="`${index}-${result.candidateId}`" class="history-file">
              <span :class="{ success: result.success, failed: !result.success }">{{ result.success ? '成功' : '未处理' }}</span>
              <div><b :title="result.path">{{ result.path }}</b><small>{{ result.error || `${formatBytes(result.size)} · ${detail?.executionMode === 'quarantine' ? '已跨盘隔离' : '已移入回收站'}` }}</small></div>
            </div>
            <button v-if="detail?.nextOffset != null" class="secondary-button" :disabled="detailLoading" @click="loadDetailPage">加载更多明细</button>
            <p v-if="detail?.omittedResults" class="muted">为控制本地记录体积，另有 {{ detail.omittedResults.toLocaleString() }} 条成功或失败明细未长期保存；任务汇总数字仍为完整结果。</p>
          </template>
        </div>
      </article>
    </div>

    <div v-if="loading && !hasHistory" class="history-loading" role="status"><AppIcon name="history" /><span>正在读取本机操作记录…</span></div>
    <div v-if="!hasHistory && !loading" class="empty-state compact-empty history-empty">
      <div class="empty-rings"><AppIcon name="history" /></div>
      <h2>还没有清理记录</h2>
      <p>完成文件清理或 Windows 系统维护后，<br />这里会保存处理结果和逐项原因。</p>
      <small>文件清理保留最近 50 次 · 系统维护保留最近 30 次</small>
    </div>

    <div v-if="hasHistory" class="history-footer">
      <span>记录只保存在本机应用数据中。</span>
      <button class="danger-quiet" @click="showClearDialog = true">清空操作记录</button>
    </div>
    <p v-if="message" class="inline-message">{{ message }}</p>
    <div v-if="showClearDialog" class="modal cleaner-confirm-modal" @click.self="showClearDialog = false">
      <section ref="clearDialogElement" class="modal-card" role="dialog" aria-modal="true" aria-labelledby="clear-history-title" @keydown="handleClearDialogKeydown">
        <div class="modal-title"><div><p class="kicker">本机操作记录</p><h2 id="clear-history-title">清空已保存的记录？</h2></div><button class="modal-close" aria-label="关闭" @click="showClearDialog = false">×</button></div>
        <div class="maintenance-confirm-impact"><b>清空已完成、已取消和已核对的记录</b><p>尚未核对的中断记录继续保留。这不会撤销已完成的文件处理和系统维护。</p></div>
        <div class="modal-actions"><button class="quiet" @click="showClearDialog = false">保留记录</button><span></span><button class="danger-quiet" @click="clearHistory">确认清空记录</button></div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { desktopApi } from '../platform/api'
import { trapDialogKeydown } from '../application/accessibility'
import type { CleanupJob, CleanupJobSummary, MaintenanceJob } from '../domain/desktop'
import { formatBytes, formatDateTime } from '../shared/format'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ refreshKey: number }>()
const history = ref<CleanupJobSummary[]>([])
const maintenanceHistory = ref<MaintenanceJob[]>([])
const detail = ref<CleanupJob | null>(null)
const openJobId = ref<string | null>(null)
const loading = ref(false)
const detailLoading = ref(false)
let detailRequestId = 0
const message = ref('')
const showClearDialog = ref(false)
const clearDialogElement = ref<HTMLElement | null>(null)
let previousDialogFocus: HTMLElement | null = null

const totalMoved = computed(() => history.value.reduce((sum, job) => sum + job.movedToTrashBytes, 0))
const totalFailed = computed(() => history.value.reduce((sum, job) => sum + job.failed, 0))
const successfulMaintenance = computed(() => maintenanceHistory.value.filter(job => job.success).length)
const failedMaintenance = computed(() => maintenanceHistory.value.filter(job => !job.success).length)
const hasHistory = computed(() => history.value.length > 0 || maintenanceHistory.value.length > 0)

async function loadHistory() {
  const api = desktopApi()
  if (!api || loading.value) return
  loading.value = true
  try {
    ;[history.value, maintenanceHistory.value] = await Promise.all([
      api.cleanerHistory(),
      api.cleanerSlimmingHistory()
    ])
    if (openJobId.value && !history.value.some(job => job.id === openJobId.value)) {
      openJobId.value = null
      detail.value = null
    }
  } catch (error) {
    message.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
}

async function toggleDetail(id: string) {
  const currentRequest = ++detailRequestId
  if (openJobId.value === id) {
    openJobId.value = null
    detail.value = null
    return
  }
  const api = desktopApi()
  if (!api) return
  detailLoading.value = true
  openJobId.value = id
  detail.value = null
  try {
    const result = await api.cleanerHistoryDetail(id)
    if (currentRequest === detailRequestId && openJobId.value === id) detail.value = result
  } catch (error) {
    if (currentRequest !== detailRequestId) return
    openJobId.value = null
    detail.value = null
    message.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (currentRequest === detailRequestId) detailLoading.value = false
  }
}

async function loadDetailPage() {
  const api = desktopApi()
  const previous = detail.value
  if (!api || !previous || previous.nextOffset == null || detailLoading.value) return
  const currentRequest = ++detailRequestId
  detailLoading.value = true
  try {
    const page = await api.cleanerHistoryDetail({ id: previous.id, offset: previous.nextOffset })
    if (currentRequest === detailRequestId && openJobId.value === previous.id) detail.value = { ...page, results: previous.results.concat(page.results) }
  } catch (error) { if (currentRequest === detailRequestId) message.value = String(error) }
  finally { if (currentRequest === detailRequestId) detailLoading.value = false }
}

async function acknowledgeRecovery() {
  const api = desktopApi()
  const id = openJobId.value
  if (!api || !id) return
  try {
    await api.cleanerHistoryAcknowledge(id)
    if (openJobId.value === id) detail.value = await api.cleanerHistoryDetail(id)
    await loadHistory()
  } catch (error) { message.value = String(error) }
}

async function acknowledgeMaintenance(id: string) {
  try { await desktopApi()?.cleanerHistoryAcknowledge(id); await loadHistory() }
  catch (error) { message.value = String(error) }
}

async function clearHistory() {
  showClearDialog.value = false
  const api = desktopApi()
  if (!api) return
  try {
    const result = await api.cleanerHistoryClear()
    if (result.retained) message.value = '已清空完成记录，中断任务的核对记录继续保留。'
    openJobId.value = null
    detail.value = null
    maintenanceHistory.value = []
    await loadHistory()
  } catch (error) {
    message.value = error instanceof Error ? error.message : String(error)
  }
}

function handleClearDialogKeydown(event: KeyboardEvent) {
  trapDialogKeydown(event, clearDialogElement.value, () => { showClearDialog.value = false })
}

watch(showClearDialog, async open => {
  if (open) previousDialogFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  await nextTick()
  if (open) clearDialogElement.value?.querySelector<HTMLButtonElement>('.modal-close')?.focus()
  else if (previousDialogFocus?.isConnected) {
    previousDialogFocus.focus()
    previousDialogFocus = null
  }
})

onMounted(() => void loadHistory())
watch(() => props.refreshKey, () => void loadHistory())
</script>
