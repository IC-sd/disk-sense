<template>
  <section class="space-measurement" aria-label="实际磁盘占用">
    <button class="secondary-button" :disabled="loading" @click="measure">{{ loading ? '正在读取实际占用…' : '读取实际占用' }}</button>
    <button v-if="loading" class="secondary-button" @click="cancel">取消</button>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="result">
      <dl class="object-facts">
        <div><dt>逻辑大小</dt><dd>{{ formatBytes(result.logicalBytes) }}</dd></div>
        <div><dt>实际分配</dt><dd>{{ result.allocatedBytes === null ? `已确认 ≥ ${formatBytes(result.knownAllocatedBytes)}` : formatBytes(result.allocatedBytes) }}</dd></div>
        <div><dt>读取范围</dt><dd>{{ result.files.toLocaleString() }} 个文件 · {{ result.state === 'complete' ? '已完成' : '部分结果' }}</dd></div>
      </dl>
      <p>{{ result.explanation }}</p>
      <p v-if="result.hardLinkDuplicates || result.cloudPlaceholders || result.unknownFiles || result.skippedReparsePoints">
        重复硬链接 {{ result.hardLinkDuplicates }} · 云占位文件 {{ result.cloudPlaceholders }} · 未确认 {{ result.unknownFiles }} · 跳过链接 {{ result.skippedReparsePoints }}
      </p>
      <small>实际占用不等于删除后可释放空间。仅按需读取元数据，目录读取有时间和数量限制。</small>
    </template>
  </section>
</template>
<script setup lang="ts">
import { onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import { desktopApi } from '../platform/api'
import type { PathSpaceMeasurement } from '../domain/desktop'
import { formatBytes } from '../shared/format'
const props = defineProps<{ path: string }>()
const result = ref<PathSpaceMeasurement | null>(null)
const error = ref(''), loading = ref(false)
let request = ''
function cancel() {
  const previous = request
  request = ''
  loading.value = false
  if (previous) void desktopApi()?.inspectSpaceCancel(previous).catch(() => {})
}
async function measure() {
  const api = desktopApi()
  if (!api) return
  cancel()
  const id = crypto.randomUUID(), target = props.path
  request = id; loading.value = true; error.value = ''; result.value = null
  try {
    const measurement = await api.inspectSpace({ path: target, requestId: id })
    if (request === id && props.path === target) result.value = measurement
  } catch (failure) {
    if (request === id) error.value = failure instanceof Error ? failure.message : String(failure)
  } finally { if (request === id) { request = ''; loading.value = false } }
}
watch(() => props.path, () => { cancel(); result.value = null; error.value = '' })
onBeforeUnmount(cancel)
onDeactivated(cancel)
</script>
