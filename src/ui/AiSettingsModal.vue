<template>
  <div class="modal" @click.self="$emit('close')">
    <section class="modal-card ai-settings-card">
      <div class="modal-title">
        <div><p class="kicker">AI API</p><h2>大模型分析设置</h2></div>
        <button class="modal-close" aria-label="关闭" @click="$emit('close')">×</button>
      </div>
      <p class="settings-intro">填写服务商提供的 Base URL 和 API 密钥，Disk Sense 会自动读取这个地址可用的模型。</p>

      <label>
        Base URL
        <input v-model.trim="form.endpoint" placeholder="https://api.openai.com/v1" />
        <small>填写到 API 版本层级即可，系统会自动访问 /models 和 /chat/completions。</small>
      </label>

      <label>
        API 密钥
        <input
          v-model="form.apiKey"
          type="password"
          autocomplete="off"
          :placeholder="canReuseStoredKey ? '已安全保存；留空表示继续使用' : '请输入该服务的 API Key'"
        />
      </label>

      <label>
        可用模型
        <div class="model-picker">
          <select v-model="form.model" :disabled="modelsBusy || !models.length">
            <option v-if="!models.length" value="">{{ modelPlaceholder }}</option>
            <option v-for="model in models" :key="model.id" :value="model.id">
              {{ model.name }}{{ model.ownedBy ? ` · ${model.ownedBy}` : '' }}
            </option>
          </select>
          <button class="quiet" :disabled="modelsBusy || !canLoadModels" @click="fetchModels(false)">
            {{ modelsBusy ? '获取中…' : '重新获取' }}
          </button>
        </div>
        <small>模型来自当前 Base URL 返回的列表，不需要手动输入模型名称。</small>
      </label>

      <div class="ai-privacy">
        <b>发送范围</b>
        <span>只发送当前对象的名称、路径层级、有限同级名称、本地判断和最多 1200 字内容摘要，不会上传完整文件。</span>
      </div>

      <p v-if="message" :class="messageKind === 'error' ? 'error-message' : 'success-message'">{{ message }}</p>
      <div class="modal-actions">
        <button class="quiet" :disabled="busy || modelsBusy || !form.model" @click="test">测试连接</button>
        <button v-if="status.configured" class="danger-quiet" :disabled="busy || modelsBusy" @click="clear">清除配置</button>
        <span></span>
        <button class="quiet" @click="$emit('close')">取消</button>
        <button class="scan" :disabled="busy || modelsBusy || !form.endpoint || !form.model" @click="save">保存</button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { desktopApi } from '../platform/api'

type ModelOption = { id: string; name: string; ownedBy?: string | null }

const emit = defineEmits<{ close: []; saved: [status: any] }>()
const form = reactive({ endpoint: '', model: '', apiKey: '' })
const status = reactive<any>({ configured: false, keyStored: false })
const models = ref<ModelOption[]>([])
const savedEndpoint = ref('')
const preferredModel = ref('')
const busy = ref(false)
const modelsBusy = ref(false)
const message = ref('')
const messageKind = ref<'success' | 'error'>('success')
let modelTimer: ReturnType<typeof setTimeout> | undefined
let modelRequestId = 0

const endpointValid = computed(() => {
  try {
    const parsed = new URL(form.endpoint)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
})
const canReuseStoredKey = computed(() => status.keyStored && form.endpoint === savedEndpoint.value)
const canLoadModels = computed(() => endpointValid.value && Boolean(form.apiKey.trim() || canReuseStoredKey.value))
const modelPlaceholder = computed(() => {
  if (modelsBusy.value) return '正在根据 Base URL 获取模型…'
  if (!endpointValid.value) return '请先填写正确的 Base URL'
  if (!canLoadModels.value) return '填写 API 密钥后自动获取'
  return '没有获取到可用模型'
})

function setMessage(text: string, kind: 'success' | 'error' = 'success') {
  message.value = text
  messageKind.value = kind
}

function scheduleModelFetch() {
  if (modelTimer) clearTimeout(modelTimer)
  modelRequestId += 1
  models.value = []
  form.model = ''
  if (!canLoadModels.value) {
    modelsBusy.value = false
    return
  }
  modelsBusy.value = true
  setMessage('正在根据 Base URL 获取可用模型…')
  modelTimer = setTimeout(() => void fetchModels(true), 700)
}

async function load() {
  const api = desktopApi()
  if (!api) return
  const result = await api.aiConfigGet()
  Object.assign(status, result)
  savedEndpoint.value = result.endpoint || ''
  preferredModel.value = result.model || ''
  form.endpoint = savedEndpoint.value
}

async function fetchModels(automatic = false) {
  const api = desktopApi()
  if (!api || !canLoadModels.value) return
  if (modelTimer) clearTimeout(modelTimer)
  const requestId = ++modelRequestId
  modelsBusy.value = true
  if (!automatic) setMessage('正在根据 Base URL 获取可用模型…')
  try {
    const result = await api.aiModels({ endpoint: form.endpoint, apiKey: form.apiKey })
    if (requestId !== modelRequestId) return
    const available: ModelOption[] = Array.isArray(result.models) ? result.models : []
    models.value = available
    const preferred = available.find(item => item.id === preferredModel.value)
    form.model = preferred?.id || available[0]?.id || ''
    setMessage(`已自动获取 ${available.length} 个可用模型`)
  } catch (error) {
    if (requestId !== modelRequestId) return
    models.value = []
    form.model = ''
    setMessage(`${error instanceof Error ? error.message : String(error)}。请检查 Base URL 和 API 密钥。`, 'error')
  } finally {
    if (requestId === modelRequestId) modelsBusy.value = false
  }
}

async function test() {
  const api = desktopApi()
  if (!api) return
  busy.value = true
  setMessage('')
  try {
    const result = await api.aiTest({ endpoint: form.endpoint, model: form.model, apiKey: form.apiKey })
    if (result.ok) setMessage(`连接成功，模型：${result.model}`)
    else setMessage(result.reason || '连接失败', 'error')
  } catch (error) {
    setMessage(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    busy.value = false
  }
}

async function save() {
  const api = desktopApi()
  if (!api) return
  busy.value = true
  setMessage('')
  try {
    const result = await api.aiConfigSave({ endpoint: form.endpoint, model: form.model, apiKey: form.apiKey })
    Object.assign(status, result)
    savedEndpoint.value = form.endpoint
    preferredModel.value = form.model
    form.apiKey = ''
    setMessage('AI 配置已保存')
    emit('saved', result)
  } catch (error) {
    setMessage(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    busy.value = false
  }
}

async function clear() {
  const api = desktopApi()
  if (!api) return
  busy.value = true
  try {
    const result = await api.aiConfigClear()
    Object.assign(status, result)
    savedEndpoint.value = ''
    preferredModel.value = ''
    form.endpoint = ''
    form.model = ''
    form.apiKey = ''
    models.value = []
    setMessage('已清除 AI 配置')
    emit('saved', result)
  } catch (error) {
    setMessage(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    busy.value = false
  }
}

watch([() => form.endpoint, () => form.apiKey], scheduleModelFetch)
onMounted(load)
onBeforeUnmount(() => {
  if (modelTimer) clearTimeout(modelTimer)
  modelRequestId += 1
})
</script>
