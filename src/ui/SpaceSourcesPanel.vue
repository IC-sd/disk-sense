<template>
  <section class="space-sources" aria-labelledby="space-sources-title">
    <header>
      <div><h2 id="space-sources-title">空间归属</h2><p>把已识别的软件、项目和分散位置放在一起看。</p></div>
      <div class="source-actions">
        <button class="secondary-button compact" :disabled="discovering || loading" @click="discover">{{ discovering ? '识别中…' : '识别已安装软件' }}</button>
        <button class="text-button" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新占用' }}</button>
      </div>
    </header>
    <p v-if="error" class="inline-message error-message" role="alert">{{ error }}</p>
    <p v-if="notice" class="source-note" role="status">{{ notice }}</p>
    <template v-if="summary?.entities.length">
      <div class="source-filter">
        <input v-model="query" type="search" placeholder="查找软件或项目" aria-label="查找空间归属" />
        <span>{{ summary.entities.length }} 个实体 · {{ summary.locationCount }} 个关联位置</span>
      </div>
      <p class="source-note">仅统计已索引文件的逻辑大小，不代表可释放空间。链接、未访问位置可能未计入；共享范围不能跨软件相加。</p>
      <p v-if="summary.index.building || summary.index.synchronizing || summary.index.pendingChanges || summary.index.truncated || summary.index.lastError" class="source-warning">索引正在更新或覆盖不完整，暂不据此判断空间增长或减少。</p>
      <details v-for="entity in visible" :key="entity.id" class="source-entry">
        <summary>
          <span class="source-name"><b>{{ entity.name }}</b><small>{{ entity.inferred ? '包含待核实的关联' : entity.kind }} · {{ entity.locations.length }} 个位置</small></span>
          <span class="source-metric"><b>{{ formatBytes(entity.bytes) }}</b><small>已索引 {{ entity.files.toLocaleString() }} 个文件</small></span>
          <span class="source-delta" :title="entity.baselineAt ? `比较起点：${formatDateTime(entity.baselineAt)}` : '当前范围不可比较'">{{ delta(entity.deltaBytes) }}</span>
        </summary>
        <div class="source-locations">
          <p>关联依据保存在本机，不代表已证明文件由哪个进程创建，也不授予删除权限。</p>
          <article v-for="location in entity.locations" :key="location.path">
            <button class="source-path" @click="$emit('inspect-path', location.path)">{{ location.path }}</button>
            <span>{{ location.covered ? `${formatBytes(location.bytes)} · ${location.files.toLocaleString()} 个已索引文件` : '此位置尚未纳入索引' }}{{ location.incomplete ? ' · 部分内容未能读取，暂停变化比较' : '' }}{{ !location.counted ? ' · 已包含在上级位置，未重复累加' : '' }}{{ location.shared ? ' · 与其他实体范围重叠' : '' }}</span>
            <small>{{ location.evidence.join('；') }}</small>
            <small>最近核实：{{ formatDateTime(location.observedAt) }}</small>
          </article>
          <button class="text-button" :disabled="loading" @click="forget(entity.id)">移除此归属记录（不删除文件）</button>
        </div>
      </details>
      <p v-if="!filtered.length" class="source-note">没有匹配的已识别实体。</p>
      <button v-if="visible.length < filtered.length" class="text-button" @click="limit += 12">显示更多（还有 {{ filtered.length - visible.length }} 个）</button>
      <p v-if="summary.locationCount >= summary.limit" class="source-warning">已达到 {{ summary.limit }} 个位置的保存上限，现有记录仍保留。</p>
    </template>
    <div v-else-if="!loading" class="source-empty">
      <b>还没有记录空间归属</b>
      <p>可以识别已安装软件，也可以在目录浏览或文件搜索中选择对象。项目标记、软件安装位置等本地证据会自动保存到这里。</p>
      <button class="text-button" @click="$emit('browse')">浏览并解释文件 →</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, ref, watch } from 'vue'
import { desktopApi } from '../platform/api'
import type { SpaceLedgerSummary } from '../domain/desktop'
import { formatBytes, formatDateTime } from '../shared/format'

defineEmits<{ 'inspect-path': [path: string]; browse: [] }>()
const summary = ref<SpaceLedgerSummary | null>(null)
const loading = ref(false)
const discovering = ref(false)
const error = ref('')
const notice = ref('')
const query = ref('')
const limit = ref(8)
const filtered = computed(() => summary.value?.entities.filter(entity => entity.name.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())) || [])
const visible = computed(() => filtered.value.slice(0, limit.value))
watch(query, () => { limit.value = 8 })
function delta(value: number | null) {
  if (value === null) return '暂不可比较'
  if (value === 0) return '较起点无变化'
  return `${value > 0 ? '+' : '−'}${formatBytes(Math.abs(value))}`
}
async function load() {
  const api = desktopApi()
  if (!api || loading.value) return
  loading.value = true
  error.value = ''
  try { summary.value = await api.spaceSummary() }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { loading.value = false }
}
async function discover() {
  const api = desktopApi()
  if (!api || discovering.value) return
  discovering.value = true
  error.value = ''; notice.value = ''
  try {
    const result = await api.spaceDiscover()
    notice.value = `核实了 ${result.saved} 个安装位置；未登记、无法访问或范围过宽的位置不会计入。`
    await load()
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { discovering.value = false }
}
async function forget(entityId: string) {
  const api = desktopApi()
  if (!api || loading.value) return
  try {
    await api.spaceForget(entityId)
    await load()
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
}
onMounted(() => void load())
onActivated(() => void load())
</script>

<style scoped>
.space-sources { min-width: 0; padding: 20px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
header, .source-actions, .source-filter { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
h2 { margin: 0; font-size: 20px; color: var(--text); }
p { color: var(--muted); line-height: 1.6; margin: 8px 0; }
.source-actions { justify-content: flex-end; }
.source-filter { margin: 16px 0 10px; color: var(--muted); font-size: 12px; }
input { flex: 1 1 200px; max-width: 340px; min-width: 0; padding: 9px 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--text); background: var(--field-bg); }
.source-note, .source-warning { font-size: 12px; }
.source-warning { color: var(--amber); }
.source-entry { border-top: 1px solid var(--line); }
summary { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(110px, auto); gap: 16px; align-items: center; cursor: pointer; padding: 14px 0; color: var(--text); }
.source-name, .source-metric { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.source-name b { overflow-wrap: anywhere; }
small { color: var(--muted); font-size: 12px; line-height: 1.5; }
.source-metric { text-align: right; }
.source-delta { color: var(--muted); font-size: 12px; text-align: right; }
.source-locations { padding: 0 0 12px 12px; border-left: 2px solid var(--blue); margin: 0 0 12px; }
.source-locations p { font-size: 12px; }
.source-locations article { display: flex; flex-direction: column; gap: 5px; padding: 10px 0; }
.source-locations span { color: var(--text); font-size: 12px; }
.source-path { color: var(--blue); border: 0; background: none; padding: 0; text-align: left; overflow-wrap: anywhere; cursor: pointer; line-height: 1.5; }
.source-empty { padding: 18px 0 0; }
.source-empty b { color: var(--text); }
@media (max-width: 900px) { summary { grid-template-columns: minmax(0, 1fr) auto; gap: 8px; } .source-delta { grid-column: 1 / -1; text-align: left; } .space-sources { padding: 16px; } }
</style>
