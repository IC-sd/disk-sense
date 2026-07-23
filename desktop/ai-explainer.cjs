const MAX_PREVIEW_CHARS = 1200

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
  if (!['http:', 'https:'].includes(parsed.protocol)) return { ok: false, reason: 'Base URL 必须使用 HTTP 或 HTTPS' }
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

function safeEvidence(input) {
  const evidence = input || {}
  return {
    name: evidence.name,
    parent: evidence.parent,
    size: evidence.size,
    isDirectory: evidence.isDirectory,
    classification: evidence.classification,
    source: evidence.source,
    localConclusion: evidence.what,
    localPurpose: evidence.purpose,
    localHandling: evidence.handling,
    confidence: evidence.confidence,
    risk: evidence.risk,
    pathSegments: Array.isArray(evidence.evidence?.pathSegments) ? evidence.evidence.pathSegments.slice(-8) : [],
    siblingNames: Array.isArray(evidence.evidence?.siblingNames) ? evidence.evidence.siblingNames.slice(0, 40) : [],
    contentPreview: typeof evidence.contentPreview === 'string' ? evidence.contentPreview.slice(0, MAX_PREVIEW_CHARS) : null,
    relatedLocations: Array.isArray(evidence.relatedLocations) ? evidence.relatedLocations.slice(0, 12).map(item => ({ path: item.path, reason: item.reason, volume: item.volume })) : []
  }
}

function promptFor(evidence) {
  return [
    '你是 Disk Sense 的 Windows 文件与目录分析器。',
    '请综合路径层级、名称、同级对象、内容摘要、本地规则结论和跨盘关联，解释目标对象。',
    '不要把未知内容称为垃圾，不要仅凭缓存字样建议删除，不要给出无证据的肯定结论。',
    '请只返回 JSON，不要使用 Markdown。结构如下：',
    '{"what":"它是什么","purpose":"有什么用","belongsTo":"属于哪个系统或应用","whyHere":"为什么出现在这个位置","risk":"low|medium|high|unknown","confidence":0.0,"handling":"保留或处理建议","reasons":["关键依据"]}',
    `本地证据：${JSON.stringify(safeEvidence(evidence))}`
  ].join('\n')
}

function parseResult(text) {
  const clean = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try { return JSON.parse(clean) } catch { return null }
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
  const headers = { 'Content-Type': 'application/json' }
  if (current.apiKey) headers.Authorization = `Bearer ${current.apiKey}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 45000)
  try {
    const response = await fetchImpl(chatEndpoint(current.endpoint), {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({ model: current.model, temperature: 0.1, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: '只根据提供的证据分析 Windows 文件与目录；证据不足时明确说明不确定。' }, { role: 'user', content: promptFor(evidence) }] })
    })
    if (!response.ok) { const detail = await response.text().catch(() => ''); throw new Error(`AI 服务请求失败：${response.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`) }
    const body = await response.json()
    const text = body.choices?.[0]?.message?.content || body.message?.content || ''
    if (!text) throw new Error('AI 服务没有返回分析内容')
    return { ok: true, mode: 'openai-compatible', model: current.model, result: text, parsed: parseResult(text), evidence: safeEvidence(evidence) }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('AI 请求超时，请检查 API 地址或网络')
    throw error
  } finally { clearTimeout(timeout) }
}

async function testConnection(override = {}, fetchImpl = globalThis.fetch) {
  const result = await review({ name: 'Disk Sense connection test', classification: 'connection-test', source: '连接测试', confidence: 1, risk: 'low' }, override, fetchImpl)
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
  review,
  testConnection,
  MAX_PREVIEW_CHARS
}
