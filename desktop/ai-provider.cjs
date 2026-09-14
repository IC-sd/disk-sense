const PROVIDERS = Object.freeze({
  CHAT: 'openai-compatible',
  RESPONSES: 'openai-responses',
  AZURE: 'azure-openai',
  LOCAL: 'local-openai'
})

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
      reasoning: { effort: modeConfig.reasoningEffort }
    }
  }
  return {
    model: config.model,
    temperature: 0.1,
    reasoning_effort: modeConfig.reasoningEffort,
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
