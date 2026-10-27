<template>
  <section class="tool-cache-inspection">
    <button class="secondary-button" :disabled="loading" @click="inspect">{{ loading ? '正在核实…' : '核实工具缓存位置' }}</button>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="tool">
      <p><b>{{ tool.id }} {{ tool.version || '版本未确认' }}</b> · {{ tool.status === 'confirmed' ? '工具只读查询已确认' : '位置尚未由工具确认' }}</p>
      <p class="tool-cache-path">{{ tool.effectivePath || tool.path }}<small>{{ tool.source }}</small></p>
      <p v-for="warning in tool.warnings" :key="warning">{{ warning }}</p>
      <p>{{ tool.nativePreview.impact }}</p>
      <p v-if="tool.nativePreview.available">工具维护命令预览：<code>{{ [tool.nativePreview.command, ...tool.nativePreview.args].join(' ') }}</code></p>
      <small>共享缓存仅核实位置和展示工具维护说明。请核对影响后自行在终端使用工具维护。</small>
    </template>
  </section>
</template>
<script setup lang="ts">
import { ref } from 'vue'
import { desktopApi } from '../platform/api'
import type { ToolCacheInspection } from '../domain/desktop'
const props = defineProps<{ ruleId: string }>()
const tool = ref<ToolCacheInspection['tools'][number] | null>(null)
const loading = ref(false), error = ref('')
async function inspect() {
  const api = desktopApi()
  if (!api) return
  loading.value = true; error.value = ''
  try {
    const report = await api.cleanerToolCaches()
    tool.value = report.tools.find(item => item.id.toLowerCase() === props.ruleId.replace('-cache', '').toLowerCase()) || null
  } catch (failure) { error.value = failure instanceof Error ? failure.message : String(failure) }
  finally { loading.value = false }
}
</script>
