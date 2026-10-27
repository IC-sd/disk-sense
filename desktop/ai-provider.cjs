const PROVIDERS = Object.freeze({
  CHAT: 'openai-compatible',
  RESPONSES: 'openai-responses',
  AZURE: 'azure-openai',
  LOCAL: 'local-openai'
})
const { redactSensitiveText } = require('./ai-safety.cjs')
const CAPABILITIES = Object.freeze({
  [PROVIDERS.CHAT]: Object.freeze({ modelList: true, structuredOutput: 'json-object', cancellation: true, transportRetries: 0 }),
  [PROVIDERS.RESPONSES]: Object.freeze({ modelList: true, structuredOutput: 'prompt-json', cancellation: true, transportRetries: 0 }),
  [PROVIDERS.AZURE]: Object.freeze({ modelList: false, structuredOutput: 'json-object', cancellation: true, transportRetries: 0 }),
  [PROVIDERS.LOCAL]: Object.freeze({ modelList: true, structuredOutput: 'json-object', cancellation: true, transportRetries: 0 })
})
function providerCapabilities(provider) { return CAPABILITIES[normalizeProvider(provider)] }

class ProviderError extends Error {
  constructor(message, { code = 'NETWORK_ERROR', status = null, retryable = false, retryAfterMs = null } = {}) {
    super(redactSensitiveText(message))
    this.name = 'ProviderError'
    this.code = code
    this.status = status
    this.retryable = retryable
    this.retryAfterMs = retryAfterMs
  }
}

function providerError(response, detail, operation = 'AI 请求') {
  const status = Number(response?.status) || 0
  const codes = { 401: 'AUTHENTICATION', 403: 'PERMISSION', 404: 'NOT_FOUND', 429: 'RATE_LIMIT' }
  const hints = { 401: 'API 密钥无效或未填写', 403: '当前密钥没有访问权限', 404: '服务地址或模型不存在', 429: '请求过于频繁或额度不足' }
  const hint = hints[status] || (status >= 500 ? '服务暂时不可用，请稍后重试' : '请检查服务协议、模型名称和连接地址')
  const retryAfter = response?.headers?.get?.('retry-after')
  const seconds = Number(retryAfter)
  const retryAfterMs = retryAfter && Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 3600000) : null
  return new ProviderError(`${operation}失败（${status}）：${hint}${detail ? `。${redactSensitiveText(detail).slice(0, 180)}` : ''}`, {
    status, code: codes[status] || (status >= 500 ? 'SERVICE_UNAVAILABLE' : 'INVALID_REQUEST'), retryable: status === 429 || status >= 500, retryAfterMs
  })
}

function createRequestContext(signal, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false
  const cancel = () => controller.abort()
  signal?.addEventListener?.('abort', cancel, { once: true })
  if (signal?.aborted) controller.abort()
  const timeout = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  const check = () => {
    if (controller.signal.aborted) throw new ProviderError(timedOut ? 'AI 请求超时，请检查 API 地址或网络' : 'AI 分析已取消', { code: timedOut ? 'TIMEOUT' : 'CANCELLED', retryable: timedOut })
  }
  return {
    signal: controller.signal, check,
    error(error) {
      check()
      if (error instanceof ProviderError) return error
      return new ProviderError(`AI 请求失败：${String(error?.message || error || '网络连接失败')}`)
    },
    dispose() { clearTimeout(timeout); signal?.removeEventListener?.('abort', cancel) }
  }
}

function compatiblePayload(payload, provider, status, detail) {
  if (![400, 422].includes(Number(status))) return null
  const message = String(detail || '').toLowerCase()
  if (!/(?:unsupported|not supported|not allowed|unknown|unrecognized|unexpected|invalid parameter|不支持)/.test(message)) return null
  const next = JSON.parse(JSON.stringify(payload))
  const fields = normalizeProvider(provider) === PROVIDERS.RESPONSES
    ? ['reasoning', 'store'] : ['response_format', 'reasoning_effort', 'max_tokens', 'temperature']
  const field = fields.find(name => Object.hasOwn(next, name) && message.includes(name))
  if (!field) return null
  if (field === 'max_tokens') { next.max_completion_tokens = next.max_tokens; delete next.max_tokens }
  else delete next[field]
  return next
}

function normalizeProvider(value) {
  return Object.values(PROVIDERS).includes(value) ? value : PROVIDERS.CHAT
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) return true
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true
  const match = host.match(/^172\.(\d{1,3})\./)
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31)
}

function parseEndpoint(endpoint) {
  try { return new URL(String(endpoint || '').trim()) } catch { return null }
}

function validateProviderEndpoint(endpoint, provider = PROVIDERS.CHAT) {
  if (!String(endpoint || '').trim()) return { ok: false, reason: '请输入 Base URL' }
  const parsed = parseEndpoint(endpoint)
  if (!parsed) return { ok: false, reason: 'Base URL 格式不正确' }
  if (parsed.username || parsed.password) return { ok: false, reason: 'Base URL 不能包含账号或密钥，请使用独立的 API 密钥字段' }
  if (parsed.hash) return { ok: false, reason: 'Base URL 不能包含片段' }
  const selected = normalizeProvider(provider)
  if (parsed.search && (selected !== PROVIDERS.AZURE || [...parsed.searchParams.keys()].some(key => key !== 'api-version'))) {
    return { ok: false, reason: 'Base URL 不能包含查询参数；Azure 仅允许 api-version' }
  }
  if (parsed.protocol === 'https:') return { ok: true }
  if (selected === PROVIDERS.LOCAL && parsed.protocol === 'http:' && isPrivateHost(parsed.hostname)) return { ok: true }
  return { ok: false, reason: selected === PROVIDERS.LOCAL
    ? '本地服务仅允许 HTTPS，或 localhost/局域网私有地址的 HTTP'
    : '远程 API 必须使用 HTTPS，避免密钥和文件证据以明文传输' }
}

function replaceKnownPath(pathname, suffix) {
  const clean = pathname.replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(clean)) return clean.replace(/\/chat\/completions$/i, suffix)
  if (/\/responses$/i.test(clean)) return clean.replace(/\/responses$/i, suffix)
  if (/\/models$/i.test(clean)) return clean.replace(/\/models$/i, suffix)
  return `${clean}${suffix}`
}

function requestEndpoint(config, purpose = 'completion') {
  const provider = normalizeProvider(config.provider)
  const parsed = parseEndpoint(config.endpoint)
  if (!parsed) return ''
  if (provider === PROVIDERS.AZURE) {
    if (purpose === 'models') return ''
    const deploymentPath = /\/openai\/deployments\//i.test(parsed.pathname)
      ? parsed.pathname
      : `${parsed.pathname.replace(/\/+$/, '')}/openai/deployments/${encodeURIComponent(config.model || '')}`
    parsed.pathname = replaceKnownPath(deploymentPath, '/chat/completions')
    if (!parsed.searchParams.has('api-version')) parsed.searchParams.set('api-version', config.apiVersion || '2024-10-21')
    return parsed.toString()
  }
  const suffix = purpose === 'models'
    ? '/models'
    : provider === PROVIDERS.RESPONSES ? '/responses' : '/chat/completions'
  parsed.pathname = replaceKnownPath(parsed.pathname, suffix)
  return parsed.toString()
}

function requestHeaders(config) {
  const headers = { Accept: 'application/json' }
  if (config.apiKey) {
    if (normalizeProvider(config.provider) === PROVIDERS.AZURE) headers['api-key'] = config.apiKey
    else headers.Authorization = `Bearer ${config.apiKey}`
  }
  return headers
}

function completionPayload(config, system, prompt, modeConfig) {
  const provider = normalizeProvider(config.provider)
  if (provider === PROVIDERS.RESPONSES) {
    return {
      model: config.model,
      instructions: system,
      input: prompt,
      store: false,
      max_output_tokens: modeConfig.maxTokens,
      ...(modeConfig.reasoningEffort ? { reasoning: { effort: modeConfig.reasoningEffort } } : {})
    }
  }
  return {
    model: config.model,
    temperature: 0.1,
    ...(modeConfig.reasoningEffort ? { reasoning_effort: modeConfig.reasoningEffort } : {}),
    max_tokens: modeConfig.maxTokens,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }]
  }
}

function responseText(body) {
  const chatContent = body?.choices?.[0]?.message?.content || body?.message?.content
  if (typeof chatContent === 'string') return chatContent
  if (Array.isArray(chatContent)) return chatContent.map(part => typeof part === 'string' ? part : part?.text || part?.content || '').filter(Boolean).join('\n')
  if (typeof body?.output_text === 'string') return body.output_text
  if (!Array.isArray(body?.output)) return ''
  return body.output.flatMap(item => Array.isArray(item?.content) ? item.content : [])
    .map(part => part?.text || part?.content || '')
    .filter(Boolean)
    .join('\n')
}

function fallbackPayload(payload, provider, attempt) {
  const copy = JSON.parse(JSON.stringify(payload))
  if (normalizeProvider(provider) === PROVIDERS.RESPONSES) {
    if (attempt >= 1) delete copy.reasoning
    if (attempt >= 2) delete copy.store
    return copy
  }
  if (attempt >= 1) delete copy.response_format
  if (attempt >= 2) delete copy.reasoning_effort
  if (attempt >= 3) {
    copy.max_completion_tokens = copy.max_tokens
    delete copy.max_tokens
    delete copy.temperature
  }
  return copy
}

module.exports = {
  CAPABILITIES,
  providerCapabilities,
  ProviderError,
  providerError,
  createRequestContext,
  compatiblePayload,
  PROVIDERS,
  normalizeProvider,
  isPrivateHost,
  validateProviderEndpoint,
  requestEndpoint,
  requestHeaders,
  completionPayload,
  responseText,
  fallbackPayload
}
