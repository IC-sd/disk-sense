<template>
  <div class="modal ai-settings-overlay" @click.self="$emit('close')">
    <section ref="dialog" class="modal-card ai-settings-card" role="dialog" aria-modal="true" aria-labelledby="ai-settings-title" tabindex="-1" @keydown="handleDialogKeydown">
      <header class="modal-title">
        <div><p class="kicker">可选分析服务</p><h2 id="ai-settings-title">AI 分析设置</h2><p class="settings-intro">连接模型，帮助解释你选择的文件。</p></div>
        <button class="modal-close" aria-label="关闭" @click="$emit('close')">×</button>
      </header>
      <div class="ai-settings-body" :aria-busy="loading">
        <div class="ai-section-heading"><h3>选择服务</h3><span :class="['ai-config-state', { configured: status.configured }]">{{ loading ? '正在读取配置…' : status.configured ? '当前已配置' : '尚未配置' }}</span></div>
        <div class="ai-service-presets" aria-label="AI 服务">
          <button v-for="preset in presets" :key="preset.provider" :aria-pressed="form.provider === preset.provider" :class="{ active: form.provider === preset.provider }" :disabled="loading || busy || modelsBusy" @click="choosePreset(preset)">
            <b>{{ preset.label }}</b><small>{{ preset.description }}</small>
          </button>
        </div>

        <details class="ai-protocol-options">
          <summary>接口选项 <span>{{ providerLabel }}</span></summary>
          <label>
            接入类型
            <select v-model="form.provider" :disabled="loading || busy || modelsBusy">
              <option value="openai-compatible">OpenAI 兼容 · Chat Completions</option>
              <option value="openai-responses">OpenAI · Responses API</option>
              <option value="azure-openai">Azure OpenAI</option>
              <option value="local-openai">本地模型 · Ollama / vLLM</option>
            </select>
          </label>
        </details>

        <section class="ai-connection-fields" aria-label="连接信息">
          <div class="ai-section-heading"><h3>连接信息</h3><span>按服务商提供的信息填写</span></div>
          <label>
            服务地址
            <input v-model.trim="form.endpoint" :placeholder="endpointPlaceholder" :disabled="loading || busy || modelsBusy" :aria-invalid="Boolean(form.endpoint && !endpointValid)" spellcheck="false" />
            <small :class="{ 'ai-field-invalid': form.endpoint && !endpointValid }">{{ form.endpoint && !endpointValid ? '请填写 HTTPS 地址；本地模型可使用本机或局域网 HTTP 地址。' : endpointHelp }}</small>
          </label>

          <label v-if="form.provider === 'azure-openai'">
            Azure API 版本
            <input v-model.trim="form.apiVersion" placeholder="2024-10-21" :disabled="loading || busy || modelsBusy" />
          </label>

          <label>
            API 密钥 <span v-if="canReuseStoredKey" class="ai-stored-key">{{ status.keyStored ? '已保存 · 留空继续使用' : '启动配置 · 留空继续使用' }}</span>
            <input
              v-model="form.apiKey"
              type="password"
              autocomplete="off"
              :disabled="loading || busy || modelsBusy"
              :placeholder="canReuseStoredKey ? (status.keyStored ? '已安全保存；留空继续使用' : '由启动配置提供；留空继续使用') : form.provider === 'local-openai' ? '本地服务通常可以留空' : '请输入该服务的 API Key'"
            />
          </label>

          <label>
            模型
            <div class="model-picker">
              <input v-model.trim="form.model" list="ai-model-options" :placeholder="modelPlaceholder" :disabled="loading || busy || modelsBusy" spellcheck="false" />
              <datalist id="ai-model-options">
                <option v-for="model in models" :key="model.id" :value="model.id">{{ model.ownedBy || '' }}</option>
              </datalist>
              <button class="quiet" :disabled="loading || busy || modelsBusy || !canLoadModels" @click="fetchModels()">
                {{ modelsBusy ? '读取中…' : '读取模型' }}
              </button>
            </div>
            <small>{{ form.provider === 'azure-openai' ? '填写 Azure 部署名称。' : '可读取模型列表，也可以直接输入名称。' }}</small>
          </label>
        </section>

        <details class="ai-privacy">
          <summary>哪些信息会发送给模型？</summary>
          <span>只发送当前对象的名称、路径层级、有限同级名称、本地判断和最多 1200 字内容摘要；密钥、令牌和密码样式会先被遮盖，不会上传完整文件。</span>
        </details>

        <p v-if="message" class="ai-connection-message" :class="messageKind === 'error' ? 'error-message' : 'success-message'" role="status">{{ message }}</p>
      </div>
      <div class="modal-actions">
        <button class="quiet" :disabled="loading || busy || modelsBusy || !endpointValid || !form.model" @click="test">{{ testing ? '正在测试…' : '测试连接' }}</button>
        <button v-if="status.configured" class="danger-quiet" :disabled="loading || busy || modelsBusy" @click="clear">清除配置</button>
        <span></span>
        <button class="quiet" @click="$emit('close')">取消</button>
        <button class="scan" :disabled="loading || busy || modelsBusy || !endpointValid || !form.model" @click="save">{{ saving ? '正在保存…' : '保存配置' }}</button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { desktopApi } from '../platform/api'
import { trapDialogKeydown } from '../application/accessibility'
import type { AiConfigStatus, AiModelOption } from '../domain/desktop'

const emit = defineEmits<{ close: []; saved: [status: AiConfigStatus] }>()
const dialog = ref<HTMLElement | null>(null)
let previousFocus: HTMLElement | null = null
function handleDialogKeydown(event: KeyboardEvent) {
  trapDialogKeydown(event, dialog.value, () => emit('close'))
}
type Provider = NonNullable<AiConfigStatus['provider']>
const form = reactive({ endpoint: '', provider: 'openai-compatible' as Provider, apiVersion: '', model: '', apiKey: '' })
const status = reactive<AiConfigStatus>({ configured: false, keyStored: false })
const models = ref<AiModelOption[]>([])
const savedEndpoint = ref('')
const savedProvider = ref<Provider>('openai-compatible')
const preferredModel = ref('')
const loading = ref(true)
const busy = ref(false)
const saving = ref(false)
const testing = ref(false)
const modelsBusy = ref(false)
const message = ref('')
const messageKind = ref<'success' | 'error'>('success')
let modelRequestId = 0
const presets: Array<{ provider: Provider; label: string; description: string; endpoint: string }> = [
  { provider: 'openai-compatible', label: '兼容服务', description: '自定义 API 地址', endpoint: '' },
  { provider: 'openai-responses', label: 'OpenAI', description: 'Responses 接口', endpoint: 'https://api.openai.com/v1' },
  { provider: 'local-openai', label: '本地模型', description: 'Ollama / vLLM', endpoint: 'http://127.0.0.1:11434/v1' },
  { provider: 'azure-openai', label: 'Azure', description: '已有模型部署', endpoint: '' }
]
const providerLabel = computed(() => presets.find(preset => preset.provider === form.provider)?.label || '兼容服务')
function choosePreset(preset: typeof presets[number]) {
  if (form.provider === preset.provider) return
  form.provider = preset.provider
  form.endpoint = preset.endpoint
  form.model = ''
  form.apiKey = ''
  form.apiVersion = ''
}

const endpointValid = computed(() => {
  try {
    const parsed = new URL(form.endpoint)
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '')
    const privateHost = host === 'localhost' || host === '::1' || host.endsWith('.localhost') || /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(host)
    return !parsed.username && !parsed.password && !parsed.hash && (!parsed.search || (form.provider === 'azure-openai' && [...parsed.searchParams.keys()].every(key => key === 'api-version')))
      && (parsed.protocol === 'https:' || (form.provider === 'local-openai' && parsed.protocol === 'http:' && privateHost))
  } catch {
    return false
  }
})
const canReuseStoredKey = computed(() => (status.keyStored || status.hasApiKey) && form.endpoint === savedEndpoint.value && form.provider === savedProvider.value)
const canLoadModels = computed(() => endpointValid.value && form.provider !== 'azure-openai')
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

function invalidateConnection() {
  if (busy.value || modelsBusy.value) return
  modelRequestId += 1
  models.value = []
  modelsBusy.value = false
  setMessage('')
}

async function load() {
  const api = desktopApi()
  if (!api) { loading.value = false; return }
  try {
    const result = await api.aiConfigGet()
    Object.assign(status, result)
    savedEndpoint.value = result.endpoint || ''
    savedProvider.value = result.provider || 'openai-compatible'
    preferredModel.value = result.model || ''
    form.provider = savedProvider.value
    form.apiVersion = result.apiVersion || ''
    form.endpoint = savedEndpoint.value
    form.model = preferredModel.value
  } catch (error) { setMessage(error instanceof Error ? error.message : String(error), 'error') }
  finally { loading.value = false }
}

async function fetchModels() {
  const api = desktopApi()
  if (!api || !canLoadModels.value) return
  const requestId = ++modelRequestId
  modelsBusy.value = true
  setMessage('正在读取可用模型…')
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
    setMessage(`${error instanceof Error ? error.message : String(error)}。也可以直接填写模型名称，列表不可用不影响保存。`, 'error')
  } finally {
    if (requestId === modelRequestId) modelsBusy.value = false
  }
}

async function test() {
  const api = desktopApi()
  if (!api) return
  busy.value = true
  testing.value = true
  const started = performance.now()
  setMessage('')
  try {
    const result = await api.aiTest({ ...form })
    if (result.ok) setMessage(`连接成功 · ${result.model} · ${((performance.now() - started) / 1000).toFixed(1)} 秒`)
    else setMessage(result.reason || '连接失败', 'error')
  } catch (error) {
    setMessage(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    busy.value = false
    testing.value = false
  }
}

async function save() {
  const api = desktopApi()
  if (!api) return
  busy.value = true
  saving.value = true
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
    saving.value = false
  }
}

async function clear() {
  const api = desktopApi()
  if (!api) return
  busy.value = true
  try {
    const result = await api.aiConfigClear()
    Object.assign(status, result)
    savedEndpoint.value = result.endpoint || ''
    savedProvider.value = result.provider || 'openai-compatible'
    preferredModel.value = result.model || ''
    form.endpoint = savedEndpoint.value
    form.provider = savedProvider.value
    form.apiVersion = result.apiVersion || ''
    form.model = preferredModel.value
    form.apiKey = ''
    models.value = []
    setMessage(result.configured ? '已清除本地配置，当前使用启动时提供的配置' : '已清除 AI 配置')
    emit('saved', result)
  } catch (error) {
    setMessage(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    busy.value = false
  }
}

watch([() => form.endpoint, () => form.apiKey, () => form.provider, () => form.apiVersion], invalidateConnection, { flush: 'sync' })
watch(() => form.model, () => { if (!busy.value && !modelsBusy.value) setMessage('') }, { flush: 'sync' })
onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  dialog.value?.querySelector<HTMLButtonElement>('.modal-close')?.focus()
  void load()
})
onBeforeUnmount(() => {
  modelRequestId += 1
  if (previousFocus?.isConnected) previousFocus.focus()
})
</script>

<style src="./ai-settings.css"></style>
