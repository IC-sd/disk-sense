<template>
  <section class="history-panel">
    <header class="history-intro">
      <div>
        <span>LOCAL OPERATION AUDIT</span>
        <h2>每一次清理都有结果可查</h2>
        <p>记录哪些文件成功移入回收站、哪些被安全阻止，以及失败的具体原因。</p>
      </div>
      <button class="secondary-button" :disabled="loading" @click="loadHistory">
        <AppIcon name="scan" />{{ loading ? '读取中…' : '刷新记录' }}
      </button>
    </header>

    <div v-if="history.length" class="history-metrics">
      <article><span>任务</span><b>{{ history.length }}</b><small>本地最多保留 50 次</small></article>
      <article><span>移入回收站</span><b>{{ formatBytes(totalMoved) }}</b><small>清空回收站后才释放</small></article>
      <article><span>成功文件</span><b>{{ totalSucceeded.toLocaleString() }}</b><small>逐文件重新校验后执行</small></article>
      <article><span>未处理</span><b>{{ totalFailed.toLocaleString() }}</b><small>失败或被安全边界阻止</small></article>
    </div>

    <div v-if="history.length" class="history-list">
      <article v-for="job in history" :key="job.id" :class="{ open: openJobId === job.id }">
        <button class="history-row" @click="toggleDetail(job.id)">
          <span class="history-status" :class="{ success: !job.failed && !job.cancelled, warning: job.failed || job.cancelled }">
            <AppIcon :name="job.failed || job.cancelled ? 'shield' : 'clean'" />
          </span>
          <span class="history-title">
            <b>{{ formatDateTime(job.createdAt) }}</b>
            <small>{{ job.cancelled ? '任务已取消' : '回收站清理任务' }} · {{ job.processed }} / {{ job.requested }} 个文件</small>
          </span>
          <span class="history-count">
            <b>{{ formatBytes(job.movedToTrashBytes) }}</b>
            <small>{{ job.succeeded }} 成功 · {{ job.failed }} 未处理</small>
          </span>
          <AppIcon name="arrow" />
        </button>

        <div v-if="openJobId === job.id" class="history-detail">
          <div v-if="detailLoading" class="muted">正在读取逐文件结果…</div>
          <template v-else>
            <div v-for="result in detail?.results.slice(0, 200)" :key="`${result.candidateId}-${result.path}`" class="history-file">
              <span :class="{ success: result.success, failed: !result.success }">{{ result.success ? '成功' : '未处理' }}</span>
              <div><b>{{ result.path }}</b><small>{{ result.error || `${formatBytes(result.size)} · 已移入回收站` }}</small></div>
            </div>
            <p v-if="(detail?.results.length || 0) > 200" class="muted">还有 {{ (detail?.results.length || 0) - 200 }} 项未展开。</p>
            <p v-if="detail?.omittedResults" class="muted">为控制本地记录体积，另有 {{ detail.omittedResults.toLocaleString() }} 条成功或失败明细未长期保存；任务汇总数字仍为完整结果。</p>
          </template>
        </div>
      </article>
    </div>

    <div v-else-if="!loading" class="empty-state compact-empty">
      <div class="empty-rings"><AppIcon name="history" /></div>
      <h2>还没有清理记录</h2>
      <p>执行垃圾清理后，这里会保留本地审计结果。</p>
    </div>

    <div v-if="history.length" class="history-footer">
      <span>记录只保存在本机应用数据中。</span>
      <button class="danger-quiet" @click="clearHistory">清空操作记录</button>
    </div>
    <p v-if="message" class="inline-message">{{ message }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { desktopApi } from '../platform/api'
import type { CleanupJob, CleanupJobSummary } from '../domain/desktop'
import { formatBytes, formatDateTime } from '../shared/format'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ refreshKey: number }>()
const history = ref<CleanupJobSummary[]>([])
const detail = ref<CleanupJob | null>(null)
const openJobId = ref<string | null>(null)
const loading = ref(false)
const detailLoading = ref(false)
const message = ref('')

const totalMoved = computed(() => history.value.reduce((sum, job) => sum + job.movedToTrashBytes, 0))
const totalSucceeded = computed(() => history.value.reduce((sum, job) => sum + job.succeeded, 0))
const totalFailed = computed(() => history.value.reduce((sum, job) => sum + job.failed, 0))

async function loadHistory() {
  const api = desktopApi()
  if (!api || loading.value) return
  loading.value = true
  try {
    history.value = await api.cleanerHistory()
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
    detail.value = await api.cleanerHistoryDetail(id)
  } catch (error) {
    openJobId.value = null
    detail.value = null
    message.value = error instanceof Error ? error.message : String(error)
  } finally {
    detailLoading.value = false
  }
}

async function clearHistory() {
  if (!confirm('确认清空本机保存的清理操作记录？这不会影响回收站中的文件。')) return
  const api = desktopApi()
  if (!api) return
  try {
    await api.cleanerHistoryClear()
    openJobId.value = null
    detail.value = null
    await loadHistory()
  } catch (error) {
    message.value = error instanceof Error ? error.message : String(error)
  }
}

onMounted(() => void loadHistory())
watch(() => props.refreshKey, () => void loadHistory())
</script>
