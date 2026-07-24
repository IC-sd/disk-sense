<template>
  <section class="page cleanup-page">
    <header class="page-header">
      <div>
        <div class="eyebrow"><span></span> CLEANUP CENTER</div>
        <h1>垃圾清理</h1>
        <p>清理已知空间，系统级操作单独评估；所有内容共用同一套风险语言。</p>
      </div>
      <div class="cleanup-header-mark">
        <AppIcon name="shield" />
        <span><b>安全边界</b><small>默认使用回收站</small></span>
      </div>
    </header>

    <div class="cleanup-tabs" role="tablist">
      <button role="tab" :aria-selected="activeTab === 'junk'" :class="{ active: activeTab === 'junk' }" @click="activeTab = 'junk'">
        <AppIcon name="clean" />
        <span><b>垃圾清理</b><small>缓存、临时文件与日志</small></span>
      </button>
      <button role="tab" :aria-selected="activeTab === 'slimming'" :class="{ active: activeTab === 'slimming' }" @click="openSlimming">
        <AppIcon name="database" />
        <span><b>系统瘦身</b><small>系统功能与组件存储</small></span>
      </button>
      <button role="tab" :aria-selected="activeTab === 'history'" :class="{ active: activeTab === 'history' }" @click="activeTab = 'history'">
        <AppIcon name="history" />
        <span><b>操作记录</b><small>成功、失败与阻止原因</small></span>
      </button>
    </div>

    <div class="risk-scale">
      <span class="scale-title">统一清理等级</span>
      <div>
        <span v-for="level in riskLevels" :key="level.value" class="risk-chip" :class="riskClass(level.value)">
          <i></i>{{ level.label }}
        </span>
      </div>
      <small>只有“安全”和“低风险”规则可以直接进入回收站流程</small>
    </div>

    <template v-if="activeTab === 'junk'">
      <section class="cleanup-overview">
        <div class="cleanup-meter">
          <div class="meter-ring" :style="{ '--progress': `${scanProgress}%` }">
            <span><b>{{ scanProgress }}</b><small>%</small></span>
          </div>
          <div>
            <span>扫描进度</span>
            <b>{{ busy ? '正在理解可清理空间' : scannedCount ? '本轮扫描结果' : '等待开始扫描' }}</b>
            <small>{{ scannedCount }} / {{ rules.length }} 个清理规则已完成</small>
          </div>
        </div>

        <div class="cleanup-metrics">
          <article><span>发现文件</span><b>{{ foundFiles.toLocaleString() }}</b><small>来自已扫描规则</small></article>
          <article><span>可释放空间</span><b>{{ formatBytes(foundBytes) }}</b><small>不代表默认删除</small></article>
          <article class="selected-metric"><span>已选择</span><b>{{ formatBytes(selectedBytes) }}</b><small>{{ selected.length.toLocaleString() }} 个文件</small></article>
        </div>

        <div class="cleanup-actions">
          <button class="secondary-button" :disabled="cleanupBusy" @click="scanBusy ? cancelScans() : scanAll()">
            <AppIcon :name="scanBusy ? 'close' : 'scan'" />{{ scanBusy ? '取消扫描' : scannedCount ? '重新扫描全部' : '扫描全部' }}
          </button>
          <button class="primary-button" :disabled="scanBusy || (!cleanupBusy && !selected.length)" @click="cleanupBusy ? cancelCleanup() : execute()">
            <AppIcon :name="cleanupBusy ? 'close' : 'clean'" />{{ cleanupBusy ? '停止清理' : '移入回收站' }}
          </button>
        </div>
      </section>

      <div v-if="cleanupBusy" class="cleanup-operation">
        <div>
          <b>正在移入回收站</b>
          <span>{{ executeProgress.processed }} / {{ executeProgress.total }}</span>
        </div>
        <progress :value="executeProgress.processed" :max="Math.max(1, executeProgress.total)"></progress>
        <small>{{ executeProgress.current || '正在重新校验文件状态…' }}</small>
      </div>
      <div v-else-if="busy && scanStatus.current" class="cleanup-operation scan-operation">
        <div>
          <b>正在扫描 {{ scanningRuleTitle }}</b>
          <span>已访问 {{ scanStatus.visited.toLocaleString() }} 项 · 发现 {{ scanStatus.found.toLocaleString() }} 个候选</span>
        </div>
        <small>{{ scanStatus.current }}</small>
      </div>

      <section class="exclusion-manager">
        <button class="exclusion-toggle" @click="showExclusions = !showExclusions">
          <span><AppIcon name="shield" /><b>清理排除项</b><small>{{ exclusions.length }} 条长期保护路径</small></span>
          <AppIcon name="arrow" />
        </button>
        <div v-if="showExclusions" class="exclusion-body">
          <div class="exclusion-form">
            <input v-model="exclusionPath" placeholder="输入要保护的完整文件或目录路径" @keyup.enter="addExclusion()" />
            <select v-model="exclusionMode">
              <option value="prefix">保护此目录及其内容</option>
              <option value="exact">只保护这个路径</option>
            </select>
            <button class="secondary-button" :disabled="busy || !exclusionPath.trim()" @click="addExclusion()">添加排除</button>
          </div>
          <div v-if="exclusions.length" class="exclusion-list">
            <div v-for="item in exclusions" :key="item.id">
              <span><b>{{ item.path }}</b><small>{{ item.mode === 'prefix' ? '目录及其内容' : '仅此路径' }} · {{ item.reason }}</small></span>
              <button :disabled="busy" @click="removeExclusion(item.id)">移除</button>
            </div>
          </div>
          <p v-else class="muted">还没有排除项。你也可以在文件明细中直接点击“排除”。</p>
        </div>
      </section>

      <div class="cleaner-list">
        <article v-for="rule in rules" :key="rule.id" class="clean-rule-row" :class="{ scanned: results[rule.id] }">
          <label class="cleanup-check" :title="rule.selectable ? '选择该规则发现的文件' : '该等级不能直接选择'">
            <input
              type="checkbox"
              :disabled="!(results[rule.id]?.selectable ?? rule.selectable) || !results[rule.id]?.files.length"
              :checked="isSelected(rule.id)"
              @change="toggle(rule.id)"
            />
            <span></span>
          </label>

          <div class="rule-icon"><AppIcon :name="ruleIcon(rule.category)" /></div>

          <div class="cleanup-rule-main">
            <div class="cleanup-rule-title">
              <b>{{ rule.title }}</b>
              <span class="risk-chip" :class="riskClass(rule.risk)"><i></i>{{ riskLabel(rule.risk) }}</span>
              <span v-if="rule.requiresAdmin" class="admin-chip">需要管理员</span>
            </div>
            <p>{{ rule.reason }}</p>
            <div class="rule-safety">
              <AppIcon name="shield" />
              <span>{{ rule.safetyNote }}</span>
              <small v-if="rule.minimumAgeDays">保留最近 {{ rule.minimumAgeDays }} 天</small>
            </div>
            <p v-if="results[rule.id]?.blockedReason" class="rule-blocked">{{ results[rule.id].blockedReason }}</p>
            <p v-if="results[rule.id]?.truncated" class="rule-blocked">{{ scanLimitMessage(results[rule.id]) }}</p>
            <details v-if="results[rule.id]?.files.length">
              <summary>查看文件明细（{{ results[rule.id].files.length.toLocaleString() }}）</summary>
              <div class="rule-files">
                <div v-for="file in results[rule.id].files.slice(0, 30)" :key="file.path">
                  <span>{{ file.path }}</span><small>{{ formatBytes(file.size) }}</small>
                  <button @click="excludeFile(file.path)">排除</button>
                </div>
                <p v-if="results[rule.id].files.length > 30">还有 {{ results[rule.id].files.length - 30 }} 个文件未展开</p>
              </div>
            </details>
          </div>

          <div class="cleanup-rule-result">
            <b>{{ results[rule.id] ? formatBytes(results[rule.id].total) : '尚未扫描' }}</b>
            <small>{{ results[rule.id] ? `${results[rule.id].files.length.toLocaleString()} 个文件` : rule.category }}</small>
            <button class="text-button" :disabled="busy" @click="scanRule(rule.id)">
              {{ scanningIds.has(rule.id) ? '扫描中…' : results[rule.id] ? '重新扫描' : '扫描' }}
              <AppIcon name="arrow" />
            </button>
          </div>
        </article>
      </div>
    </template>

    <template v-else>
      <CleanupHistoryPanel v-if="activeTab === 'history'" :refresh-key="historyRefreshKey" />
      <template v-else>
      <section class="slimming-intro">
        <div class="slimming-visual"><AppIcon name="database" /><span></span></div>
        <div>
          <span>ADVANCED WINDOWS MAINTENANCE</span>
          <h2>系统瘦身不是普通垃圾删除</h2>
          <p>这些项目可能影响休眠、更新回退、虚拟内存或 Windows 组件。当前阶段只检测状态并解释影响，不执行系统修改。</p>
        </div>
        <button class="secondary-button" :disabled="slimmingBusy" @click="loadSlimming">
          <AppIcon name="scan" />{{ slimmingBusy ? '检测中…' : '重新检测' }}
        </button>
      </section>

      <div v-if="slimmingBusy && !slimming.length" class="slimming-skeleton">
        <div v-for="index in 4" :key="index"></div>
      </div>

      <div v-else class="slimming-list">
        <article v-for="item in slimming" :key="item.id" class="slimming-rule">
          <div class="slimming-icon"><AppIcon name="database" /></div>
          <div>
            <div class="cleanup-rule-title">
              <b>{{ item.title }}</b>
              <span class="risk-chip" :class="riskClass(item.risk)"><i></i>{{ riskLabel(item.risk) }}</span>
              <span v-if="item.requiresAdmin" class="admin-chip">需要管理员</span>
            </div>
            <p>{{ item.description }}</p>
            <div class="slimming-warning"><AppIcon name="shield" />{{ item.impact }}</div>
          </div>
          <div class="slimming-state">
            <span :class="{ detected: item.detected }">{{ item.detected ? '已检测' : '未检测到' }}</span>
            <b>{{ item.bytes ? formatBytes(item.bytes) : item.status }}</b>
            <small>{{ item.detected ? item.action : '当前无需处理' }}</small>
            <button class="text-button" disabled>仅检测</button>
          </div>
        </article>
      </div>
      </template>
    </template>

    <p v-if="message" class="inline-message" aria-live="polite">{{ message }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { desktopApi } from '../platform/api'
import type { CleanerExecuteProgress, CleanerFile, CleanerRule, CleanerScanProgress, CleanerScanResult, CleanupExclusion, SlimmingItem } from '../domain/desktop'
import { riskClass, riskLabel, riskLevels } from '../domain/risk'
import { formatBytes } from '../shared/format'
import AppIcon from './AppIcon.vue'
import CleanupHistoryPanel from './CleanupHistoryPanel.vue'

const activeTab = ref<'junk' | 'slimming' | 'history'>('junk')
const rules = ref<CleanerRule[]>([])
const results = reactive<Record<string, CleanerScanResult>>({})
const selected = ref<CleanerFile[]>([])
const slimming = ref<SlimmingItem[]>([])
const scanBusy = ref(false)
const cleanupBusy = ref(false)
const busy = computed(() => scanBusy.value || cleanupBusy.value || scanningIds.value.size > 0)
const slimmingBusy = ref(false)
const scanningIds = ref(new Set<string>())
const message = ref('')
const exclusions = ref<CleanupExclusion[]>([])
const exclusionPath = ref('')
const exclusionMode = ref<'exact' | 'prefix'>('prefix')
const showExclusions = ref(false)
const historyRefreshKey = ref(0)
const executeProgress = reactive<CleanerExecuteProgress>({ id: '', processed: 0, total: 0, succeeded: 0, failed: 0, current: '' })
const scanStatus = reactive<CleanerScanProgress>({ ruleId: '', visited: 0, found: 0, current: '' })
let unsubscribeExecute: (() => void) | null = null
let unsubscribeScan: (() => void) | null = null

const scannedCount = computed(() => Object.keys(results).length)
const scanProgress = computed(() => rules.value.length ? Math.round(scannedCount.value / rules.value.length * 100) : 0)
const foundFiles = computed(() => Object.values(results).reduce((sum, result) => sum + result.files.length, 0))
const foundBytes = computed(() => Object.values(results).reduce((sum, result) => sum + result.total, 0))
const selectedBytes = computed(() => selected.value.reduce((sum, item) => sum + item.size, 0))
const scanningRuleTitle = computed(() => rules.value.find(rule => rule.id === scanStatus.ruleId)?.title || '清理规则')

function scanLimitMessage(result: CleanerScanResult) {
  const messages: Record<string, string> = {
    'max-files': '候选文件达到单规则 20,000 个上限',
    'max-visited': '目录遍历达到单规则 100,000 项上限',
    'max-time': '扫描达到单规则 20 秒时间上限'
  }
  const detail = messages[result.limitReason || ''] || '扫描达到安全资源上限'
  return `${detail}；当前结果可安全预览，但不代表该目录的完整总量。`
}

function setScanning(id: string, active: boolean) {
  const next = new Set(scanningIds.value)
  if (active) next.add(id)
  else next.delete(id)
  scanningIds.value = next
}

async function scanRule(id: string, propagateError = false) {
  const api = desktopApi()
  if (!api || scanningIds.value.has(id)) return
  setScanning(id, true)
  selected.value = selected.value.filter(item => item.ruleId !== id)
  try {
    results[id] = await api.cleanerScan(id)
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError')) {
      message.value = error instanceof Error ? error.message : String(error)
    }
    if (propagateError) throw error
  } finally {
    setScanning(id, false)
  }
}

async function runLimited(ids: string[], concurrency: number) {
  const queue = [...ids]
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift()
      if (id) await scanRule(id, true)
    }
  }
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
  const failure = outcomes.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}

async function scanAll() {
  scanBusy.value = true
  message.value = ''
  try {
    await runLimited(rules.value.map(rule => rule.id), 3)
    message.value = `扫描完成：发现 ${foundFiles.value.toLocaleString()} 个文件，共 ${formatBytes(foundBytes.value)}。请按风险等级确认后再处理。`
  } catch (error) {
    message.value = error instanceof Error && error.name === 'AbortError' ? '扫描已取消，已完成的规则结果仍可查看。' : error instanceof Error ? error.message : String(error)
  } finally {
    scanBusy.value = false
  }
}

async function cancelScans() {
  const api = desktopApi()
  if (!api) return
  const result = await api.cleanerScanCancel()
  if (result.cancelled) message.value = '正在停止扫描…'
}

function isSelected(id: string) {
  const files = results[id]?.files || []
  const selectedPaths = new Set(selected.value.map(item => item.path.toLowerCase()))
  return files.length > 0 && files.every(item => selectedPaths.has(item.path.toLowerCase()))
}

function toggle(id: string) {
  const rule = rules.value.find(item => item.id === id)
  if (!(results[id]?.selectable ?? rule?.selectable)) return
  const files = results[id]?.files || []
  const paths = new Set(files.map(file => file.path.toLowerCase()))
  if (isSelected(id)) {
    selected.value = selected.value.filter(item => !paths.has(item.path.toLowerCase()))
  } else {
    const existing = new Set(selected.value.map(item => item.path.toLowerCase()))
    selected.value = [...selected.value, ...files.filter(file => !existing.has(file.path.toLowerCase()))]
  }
}

async function execute() {
  if (!selected.value.length || !confirm(`确认将 ${selected.value.length} 个已扫描文件移入回收站？`)) return
  const api = desktopApi()
  if (!api) return
  cleanupBusy.value = true
  executeProgress.id = ''
  executeProgress.processed = 0
  executeProgress.total = selected.value.length
  executeProgress.succeeded = 0
  executeProgress.failed = 0
  executeProgress.current = ''
  message.value = ''
  try {
    const affectedRules = [...new Set(selected.value.map(item => item.ruleId))]
    const job = await api.cleanerExecute(selected.value)
    const cancelled = job.cancelled ? '；任务已按请求停止' : ''
    const overflow = job.rejectedOverflow ? `；另有 ${job.rejectedOverflow} 个文件超过单次任务上限` : ''
    message.value = `已将 ${job.succeeded} 个文件（${formatBytes(job.movedToTrashBytes)}）移入回收站${job.failed ? `；${job.failed} 个文件未处理` : ''}${cancelled}${overflow}。这些空间需在清空回收站后才会真正释放。`
    selected.value = []
    historyRefreshKey.value++
    await runLimited(affectedRules, 2)
  } catch (error) {
    message.value = error instanceof Error ? error.message : String(error)
  } finally {
    cleanupBusy.value = false
  }
}

async function loadExclusions() {
  const api = desktopApi()
  if (api) exclusions.value = await api.cleanerExclusions()
}

async function addExclusion(pathOverride?: string) {
  const value = String(pathOverride || exclusionPath.value).trim()
  if (!value) return
  const api = desktopApi()
  if (!api) return
  try {
    await api.cleanerExclusionAdd({
      path: value,
      mode: pathOverride ? 'exact' : exclusionMode.value,
      reason: pathOverride ? '从清理文件明细中排除' : '用户手动排除'
    })
    exclusionPath.value = ''
    selected.value = []
    for (const id of Object.keys(results)) delete results[id]
    await loadExclusions()
    message.value = '排除项已保存。为保证结果准确，请重新扫描。'
  } catch (error) {
    message.value = error instanceof Error ? error.message : String(error)
  }
}

async function excludeFile(filePath: string) {
  await addExclusion(filePath)
}

async function removeExclusion(id: string) {
  const api = desktopApi()
  if (!api) return
  try {
    await api.cleanerExclusionRemove(id)
    for (const ruleId of Object.keys(results)) delete results[ruleId]
    selected.value = []
    await loadExclusions()
    message.value = '排除项已移除，请重新扫描以更新候选结果。'
  } catch (error) {
    message.value = error instanceof Error ? error.message : String(error)
  }
}

async function cancelCleanup() {
  const api = desktopApi()
  if (!api) return
  const result = await api.cleanerCancel()
  if (result.cancelled) message.value = '正在安全停止；当前文件处理完成后不会继续下一个。'
}

async function loadSlimming() {
  const api = desktopApi()
  if (!api) return
  slimmingBusy.value = true
  try {
    slimming.value = await api.cleanerSlimming()
  } catch (error) {
    message.value = error instanceof Error ? error.message : String(error)
  } finally {
    slimmingBusy.value = false
  }
}

function openSlimming() {
  activeTab.value = 'slimming'
  if (!slimming.value.length) void loadSlimming()
}

function ruleIcon(category: string) {
  if (category.includes('Windows')) return 'shield'
  if (category.includes('诊断')) return 'history'
  if (category.includes('浏览器')) return 'overview'
  return 'database'
}

onMounted(async () => {
  const api = desktopApi()
  if (!api) return
  unsubscribeExecute = api.onCleanerExecuteProgress(progress => Object.assign(executeProgress, progress))
  unsubscribeScan = api.onCleanerScanProgress(progress => Object.assign(scanStatus, progress))
  try {
    ;[rules.value, exclusions.value] = await Promise.all([api.cleanerRules(), api.cleanerExclusions()])
  } catch (error) {
    message.value = error instanceof Error ? error.message : String(error)
  }
})

onUnmounted(() => {
  unsubscribeExecute?.()
  unsubscribeScan?.()
})
</script>
