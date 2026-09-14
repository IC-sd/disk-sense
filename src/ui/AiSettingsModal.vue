<template>
  <div class="modal" @click.self="$emit('close')">
    <section class="modal-card ai-settings-card">
      <div class="modal-title">
        <div><p class="kicker">AI API</p><h2>大模型分析设置</h2></div>
        <button class="modal-close" aria-label="关闭" @click="$emit('close')">×</button>
      </div>
      <p class="settings-intro">选择服务类型并填写连接地址。模型可以自动读取，也可以直接填写；本地服务通常不需要密钥。</p>

      <label>
        接入类型
        <select v-model="form.provider">
          <option value="openai-compatible">OpenAI 兼容 · Chat Completions</option>
          <option value="openai-responses">OpenAI · Responses API</option>
          <option value="azure-openai">Azure OpenAI</option>
          <option value="local-openai">本地模型 · Ollama / vLLM</option>
        </select>
      </label>

      <label>
        Base URL
        <input v-model.trim="form.endpoint" :placeholder="endpointPlaceholder" />
        <small>{{ endpointHelp }}</small>
      </label>

      <label v-if="form.provider === 'azure-openai'">
        Azure API 版本
        <input v-model.trim="form.apiVersion" placeholder="2024-10-21" />
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
          <input v-model.trim="form.model" list="ai-model-options" :placeholder="modelPlaceholder" />
          <datalist id="ai-model-options">
            <option v-for="model in models" :key="model.id" :value="model.id">{{ model.ownedBy || '' }}</option>
          </datalist>
          <button class="quiet" :disabled="modelsBusy || !canLoadModels" @click="fetchModels(false)">
            {{ modelsBusy ? '获取中…' : '重新获取' }}
          </button>
        </div>
        <small>{{ form.provider === 'azure-openai' ? '填写 Azure 部署名称。' : '可以从服务返回的列表选择，也可以直接输入模型名称。' }}</small>
      </label>

      <div class="ai-privacy">
        <b>发送范围</b>
        <span>只发送当前对象的名称、路径层级、有限同级名称、本地判断和最多 1200 字内容摘要；密钥、令牌和密码样式会先被遮盖，不会上传完整文件。</span>
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
import type { AiConfigStatus, AiModelOption } from '../domain/desktop'

const emit = defineEmits<{ close: []; saved: [status: AiConfigStatus] }>()
type Provider = NonNullable<AiConfigStatus['provider']>
const form = reactive({ endpoint: '', provider: 'openai-compatible' as Provider, apiVersion: '', model: '', apiKey: '' })
const status = reactive<AiConfigStatus>({ configured: false, keyStored: false })
const models = ref<AiModelOption[]>([])
const savedEndpoint = ref('')
const savedProvider = ref<Provider>('openai-compatible')
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
    return parsed.protocol === 'https:' || (form.provider === 'local-openai' && parsed.protocol === 'http:')
  } catch {
    return false
  }
})
const canReuseStoredKey = computed(() => status.keyStored && form.endpoint === savedEndpoint.value && form.provider === savedProvider.value)
const canLoadModels = computed(() => endpointValid.value && form.provider !== 'azure-openai')
const canAutoLoadModels = computed(() => canLoadModels.value && Boolean(form.apiKey.trim() || canReuseStoredKey.value || form.provider === 'local-openai'))
const endpointPlaceholder = computed(() => {
  if (form.provider === 'local-openai') return 'http://127.0.0.1:11434/v1'
  if (form.provider === 'azure-openai') return 'https://资源名.openai.azure.com'
  return 'https://api.openai.com/v1'
})
const endpointHelp = computed(() => {
  if (form.provider === 'openai-responses') return '系统会调用 /responses；也可以填写完整的 Responses 地址。'
  if (form.provider === 'azure-openai') return '填写 Azure 资源地址，模型字段填写部署名称；也支持完整部署地址。'
  if (form.provider === 'local-openai') return '仅本地或局域网私有地址允许 HTTP；支持 OpenAI 兼容的 /v1 接口。'
  return '填写到 API 版本层级即可，系统会调用 /models 和 /chat/completions。'
})
const modelPlaceholder = computed(() => {
  if (modelsBusy.value) return '正在根据 Base URL 获取模型…'
  if (!endpointValid.value) return '请先填写正确的 Base URL'
  if (form.provider === 'azure-openai') return '输入 Azure 部署名称'
  return '选择或输入模型名称'
})

function setMessage(text: string, kind: 'success' | 'error' = 'success') {
  message.value = text
  messageKind.value = kind
}

function scheduleModelFetch() {
  if (modelTimer) clearTimeout(modelTimer)
  modelRequestId += 1
  models.value = []
  if (!canAutoLoadModels.value) {
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
  savedProvider.value = result.provider || 'openai-compatible'
  preferredModel.value = result.model || ''
  form.provider = savedProvider.value
  form.apiVersion = result.apiVersion || ''
  form.endpoint = savedEndpoint.value
  form.model = preferredModel.value
}

async function fetchModels(automatic = false) {
  const api = desktopApi()
  if (!api || !canLoadModels.value) return
  if (modelTimer) clearTimeout(modelTimer)
  const requestId = ++modelRequestId
  modelsBusy.value = true
  if (!automatic) setMessage('正在根据 Base URL 获取可用模型…')
  try {
    const result = await api.aiModels({ ...form })
    if (requestId !== modelRequestId) return
    const available = Array.isArray(result.models) ? result.models : []
    models.value = available
    const preferred = available.find(item => item.id === preferredModel.value)
    form.model = preferred?.id || form.model || available[0]?.id || ''
    setMessage(available.length ? `已获取 ${available.length} 个可用模型` : '此接入类型不提供模型列表，请直接填写模型或部署名称')
  } catch (error) {
    if (requestId !== modelRequestId) return
    models.value = []
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
    const result = await api.aiTest({ ...form })
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
    const result = await api.aiConfigSave({ ...form })
    Object.assign(status, result)
    savedEndpoint.value = form.endpoint
    savedProvider.value = form.provider
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
    savedProvider.value = 'openai-compatible'
    preferredModel.value = ''
    form.endpoint = ''
    form.provider = 'openai-compatible'
    form.apiVersion = ''
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

watch([() => form.endpoint, () => form.apiKey, () => form.provider], scheduleModelFetch)
onMounted(load)
onBeforeUnmount(() => {
  if (modelTimer) clearTimeout(modelTimer)
  modelRequestId += 1
})
</script>
