const MAX_PREVIEW_CHARS = 1200
const MAX_EVIDENCE_TEXT = 160
const MAX_MODELS = 500
const { normalizeRisk } = require('./risk.cjs')
const ANALYSIS_MODES = {
  normal: { reasoningEffort: 'low', maxTokens: 1200, label: '普通分析' },
  deep: { reasoningEffort: 'high', maxTokens: 3200, label: '深入分析' }
}

function config(override = {}) {
  return {
    endpoint: String(override.endpoint ?? process.env.DISK_SENSE_AI_ENDPOINT ?? '').trim(),
    apiKey: String(override.apiKey ?? process.env.DISK_SENSE_AI_KEY ?? '').trim(),
    model: String(override.model ?? process.env.DISK_SENSE_AI_MODEL ?? '').trim()
  }
}

function chatEndpoint(endpoint) {
  const clean = String(endpoint || '').trim().replace(/\/$/, '')
  if (!clean) return ''
  if (/\/chat\/completions$/i.test(clean)) return clean
  return `${clean}/chat/completions`
}

function modelsEndpoint(endpoint) {
  const clean = String(endpoint || '').trim().replace(/\/+$/, '')
  if (!clean) return ''
  if (/\/models$/i.test(clean)) return clean
  if (/\/chat\/completions$/i.test(clean)) return clean.replace(/\/chat\/completions$/i, '/models')
  if (/\/responses$/i.test(clean)) return clean.replace(/\/responses$/i, '/models')
  return `${clean}/models`
}

function validateEndpoint(endpoint) {
  if (!String(endpoint || '').trim()) return { ok: false, reason: '请输入 Base URL' }
  let parsed
  try { parsed = new URL(modelsEndpoint(endpoint)) } catch { return { ok: false, reason: 'Base URL 格式不正确' } }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'Base URL 必须使用 HTTPS，避免 API 密钥和文件证据以明文传输' }
  if (parsed.username || parsed.password) return { ok: false, reason: 'Base URL 不能包含账号或密钥，请使用独立的 API 密钥字段' }
  if (parsed.search || parsed.hash) return { ok: false, reason: 'Base URL 不能包含查询参数或片段' }
  return { ok: true }
}

function validateConfig(input) {
  const current = config(input)
  const endpointValidation = validateEndpoint(current.endpoint)
  if (!endpointValidation.ok) return endpointValidation
  if (!current.model) return { ok: false, reason: '请输入模型名称' }
  return { ok: true, config: current }
}

function status(override = {}) {
  const current = config(override)
  const valid = validateConfig(current)
  return {
    configured: valid.ok,
    endpoint: current.endpoint || null,
    model: current.model,
    hasApiKey: Boolean(current.apiKey),
    mode: valid.ok ? 'openai-compatible' : 'unconfigured'
  }
}

function clipped(value, maximum = MAX_EVIDENCE_TEXT) {
  return typeof value === 'string' ? redactSensitiveText(value).slice(0, maximum) : value
}

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/-----BEGIN[\s\S]{0,80}PRIVATE KEY-----[\s\S]*?-----END[\s\S]{0,80}PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g, '$1-[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret)\s*["']?\s*[:=]\s*["']?)[^"',\s}\]]+/gi, '$1[REDACTED]')
}

function safeEvidence(input) {
  const evidence = input || {}
  const names = values => Array.isArray(values)
    ? values.map(value => clipped(String(value))).filter(Boolean)
    : []
  const directoryShape = evidence.evidence?.directoryShape
  return {
    name: clipped(evidence.name),
    parent: clipped(evidence.parent, 320),
    size: evidence.size,
    fileCount: evidence.fileCount,
    isDirectory: evidence.isDirectory,
    classification: clipped(evidence.classification),
    source: clipped(evidence.source),
    belongsTo: clipped(evidence.belongsTo),
    localConclusion: clipped(evidence.what, 600),
    localPurpose: clipped(evidence.purpose, 800),
    localHandling: clipped(evidence.handling, 600),
    confidence: evidence.confidence,
    risk: evidence.risk,
    pathSegments: names(evidence.evidence?.pathSegments).slice(-8),
    siblingNames: names(evidence.evidence?.siblingNames).slice(0, 40),
    childNames: names(evidence.evidence?.childNames).slice(0, 60),
    directoryShape: directoryShape && typeof directoryShape === 'object' ? {
      sampledChildren: Number(directoryShape.sampledChildren || 0),
      directories: Number(directoryShape.directories || 0),
      files: Number(directoryShape.files || 0),
      commonExtensions: Array.isArray(directoryShape.commonExtensions)
        ? directoryShape.commonExtensions.slice(0, 8).map(item => ({
            extension: clipped(String(item?.extension || ''), 24),
            count: Number(item?.count || 0)
          }))
        : []
    } : null,
    contentPreview: typeof evidence.contentPreview === 'string'
      ? redactSensitiveText(evidence.contentPreview).slice(0, MAX_PREVIEW_CHARS)
      : null,
    relatedLocations: Array.isArray(evidence.relatedLocations)
      ? evidence.relatedLocations.slice(0, 12).map(item => ({
          path: clipped(item?.path, 320),
          reason: clipped(item?.reason, 240),
          volume: clipped(item?.volume, 24)
        }))
      : []
  }
}

function promptFor(evidence, mode = 'normal') {
  const analysisMode = ANALYSIS_MODES[mode] || ANALYSIS_MODES.normal
  const lines = [
    '你是 Disk Sense 的 Windows 文件与目录分析器。',
    '请综合目标类型、路径层级、名称、父目录同级对象、目录内部子项、内容摘要、本地规则结论和跨盘关联，解释目标对象。',
    '回答面向普通电脑用户，重点是明确说明“它具体是什么”和“它实际有什么用”。',
    'what 必须具体到所属产品、组件或数据类型，例如“Microsoft Edge 的 Chromium 用户数据目录”，不能只说“一个目录”“某个文件”或重复文件名。',
    'purpose 必须说明它保存或支持哪些实际功能；belongsTo 尽量给出具体应用或 Windows 组件；whyHere 说明它为什么出现在当前路径。',
    '当本地规则置信度较高且目录内部标记相互印证时，应以本地结论为基础，不要退化成模糊猜测。',
    '不要把未知内容称为垃圾，不要仅凭缓存字样建议删除，不要给出无证据的肯定结论。',
    '请只返回 JSON，不要使用 Markdown。结构如下：',
    '{"what":"它是什么","purpose":"有什么用","belongsTo":"属于哪个系统或应用","whyHere":"为什么出现在这个位置","risk":"danger|elevated|attention|low|safe","confidence":0.0,"handling":"保留或处理建议","reasons":["关键依据"]}',
    `本地证据：${JSON.stringify(safeEvidence(evidence))}`
  ]
  if (mode === 'deep') lines.splice(2, 0, '这是深入分析：请交叉检查路径、目录结构、文件类型、同级与跨盘关联，识别可能的应用来源冲突，并明确指出仍不确定的部分。')
  else lines.splice(2, 0, '这是普通分析：优先给出简洁、直接、用户可以立即理解的结论。')
  return lines.join('\n')
}

function isVague(value) {
  const text = String(value || '').trim()
  return !text || /^(未知|不确定|无法确定|暂未确定)/.test(text) || /^(?:一个|某个)(?:实体)?(?:文件|文件夹|目录)$/.test(text) || /(?:一个|某个)?名为.+的(?:实体)?(?:文件|文件夹|目录)$/.test(text) || /可能是(?:一个)?(?:文件|文件夹|目录)/.test(text)
}

function enrichResult(parsed, evidence) {
  if (!parsed || typeof parsed !== 'object') return null
  const local = safeEvidence(evidence)
  const strongLocal = Number(local.confidence) >= 0.8 && local.classification !== 'unclassified'
  const result = { ...parsed }
  if (strongLocal && isVague(result.what)) result.what = local.localConclusion
  if (strongLocal && isVague(result.purpose)) result.purpose = local.localPurpose
  if (isVague(result.belongsTo) && (local.belongsTo || local.source)) result.belongsTo = local.belongsTo || local.source
  if (strongLocal && isVague(result.handling)) result.handling = local.localHandling
  if (!result.whyHere && strongLocal && local.source) result.whyHere = `路径和内部结构与${local.source}的典型数据布局相符。`
  result.risk = normalizeRisk(result.risk || local.risk)
  return result
}

function parseResult(text) {
  const clean = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try { return JSON.parse(clean) } catch {
    const start = clean.indexOf('{')
    const end = clean.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try { return JSON.parse(clean.slice(start, end + 1)) } catch { /* not valid JSON */ }
    }
    return null
  }
}

function completionText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => typeof part === 'string' ? part : String(part?.text || part?.content || ''))
    .filter(Boolean)
    .join('\n')
}

function validateAnalysis(parsed) {
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'AI 返回内容不是可识别的结构化分析' }
  if (isVague(parsed.what)) return { ok: false, reason: 'AI 没有明确说明这个对象具体是什么，请尝试深入分析或更换模型' }
  if (isVague(parsed.purpose)) return { ok: false, reason: 'AI 没有明确说明这个对象有什么用，请尝试深入分析或更换模型' }
  return { ok: true }
}

function normalizeModels(body) {
  const items = Array.isArray(body?.data) ? body.data : []
  const seen = new Set()
  return items
    .map(item => {
      const id = String(item?.id || '').trim()
      if (!id || seen.has(id)) return null
      seen.add(id)
      return {
        id,
        name: id,
        ownedBy: String(item?.owned_by || '').trim() || null
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
    .slice(0, MAX_MODELS)
}

async function listModels(override = {}, fetchImpl = globalThis.fetch) {
  const current = config(override)
  const valid = validateEndpoint(current.endpoint)
  if (!valid.ok) return { ok: false, reason: valid.reason, models: [] }
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持网络请求')
  const headers = { Accept: 'application/json' }
  if (current.apiKey) headers.Authorization = `Bearer ${current.apiKey}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20000)
  try {
    const endpoint = modelsEndpoint(current.endpoint)
    const response = await fetchImpl(endpoint, { method: 'GET', headers, signal: controller.signal })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`获取模型列表失败：${response.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`)
    }
    const models = normalizeModels(await response.json())
    if (!models.length) throw new Error('服务已连接，但没有返回可用模型')
    return { ok: true, endpoint, models }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('获取模型列表超时，请检查 Base URL 或网络')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function review(evidence, override = {}, fetchImpl = globalThis.fetch) {
  const valid = validateConfig(override)
  if (!valid.ok) return { ok: false, reason: valid.reason, status: status(override) }
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持网络请求')
  const current = valid.config
  const analysisMode = override.analysisMode === 'deep' ? 'deep' : 'normal'
  const modeConfig = ANALYSIS_MODES[analysisMode]
  const headers = { 'Content-Type': 'application/json' }
  if (current.apiKey) headers.Authorization = `Bearer ${current.apiKey}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 45000)
  try {
    const payload = { model: current.model, temperature: 0.1, reasoning_effort: modeConfig.reasoningEffort, max_tokens: modeConfig.maxTokens, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: '只根据提供的证据分析 Windows 文件与目录；证据不足时明确说明不确定。' }, { role: 'user', content: promptFor(evidence, analysisMode) }] }
    const request = () => fetchImpl(chatEndpoint(current.endpoint), {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify(payload)
    })
    let response = await request()
    let detail = response.ok ? '' : await response.text().catch(() => '')
    if (!response.ok && [400, 422].includes(response.status) && /response.?format|json.?object|json mode/i.test(detail)) {
      delete payload.response_format
      response = await request()
      detail = response.ok ? '' : await response.text().catch(() => '')
    }
    if (!response.ok && [400, 422].includes(response.status) && /reasoning.?effort|reasoning parameter|unsupported.*reasoning/i.test(detail)) {
      delete payload.reasoning_effort
      response = await request()
      detail = response.ok ? '' : await response.text().catch(() => '')
    }
    if (!response.ok && [400, 422].includes(response.status) && /max.?tokens|unsupported.*token|unknown.*max_tokens/i.test(detail)) {
      payload.max_completion_tokens = payload.max_tokens
      delete payload.max_tokens
      response = await request()
      detail = response.ok ? '' : await response.text().catch(() => '')
    }
    if (!response.ok && [400, 422].includes(response.status) && /temperature|unsupported.*sampling/i.test(detail)) {
      delete payload.temperature
      response = await request()
      detail = response.ok ? '' : await response.text().catch(() => '')
    }
    if (!response.ok) throw new Error(`AI 服务请求失败：${response.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`)
    const body = await response.json()
    const text = completionText(body.choices?.[0]?.message?.content || body.message?.content)
    if (!text) throw new Error('AI 服务没有返回分析内容')
    const parsed = enrichResult(parseResult(text), evidence)
    const analysisValidation = validateAnalysis(parsed)
    if (!analysisValidation.ok) throw new Error(analysisValidation.reason)
    return { ok: true, mode: 'openai-compatible', analysisMode, thinkingLevel: modeConfig.reasoningEffort, tokenBudget: modeConfig.maxTokens, model: current.model, usage: body.usage || null, result: text, parsed, evidence: safeEvidence(evidence) }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('AI 请求超时，请检查 API 地址或网络')
    throw error
  } finally { clearTimeout(timeout) }
}

async function testConnection(override = {}, fetchImpl = globalThis.fetch) {
  const result = await review({ name: 'Disk Sense connection test', classification: 'connection-test', source: '连接测试', confidence: 1, risk: 'safe' }, { ...override, analysisMode: 'normal' }, fetchImpl)
  return result.ok ? { ok: true, model: result.model } : result
}

module.exports = {
  config,
  status,
  validateConfig,
  validateEndpoint,
  chatEndpoint,
  modelsEndpoint,
  normalizeModels,
  listModels,
  safeEvidence,
  promptFor,
  parseResult,
  completionText,
  validateAnalysis,
  enrichResult,
  review,
  testConnection,
  MAX_PREVIEW_CHARS,
  MAX_EVIDENCE_TEXT,
  MAX_MODELS,
  redactSensitiveText,
  ANALYSIS_MODES
}
