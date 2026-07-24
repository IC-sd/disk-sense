// @ts-expect-error CommonJS desktop module is intentionally tested from the TypeScript suite.
import { chatEndpoint, completionText, enrichResult, listModels, modelsEndpoint, parseResult, promptFor, redactSensitiveText, safeEvidence, status, review, validateAnalysis, validateEndpoint } from '../desktop/ai-explainer.cjs'
import { describe, expect, it, vi } from 'vitest'

describe('optional AI explainer', () => {
  it('stays unconfigured when no provider is configured', async () => {
    const result = await review({ name: 'unknown.bin' }, { endpoint: '', model: 'test' })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('Base URL')
    expect(status({ endpoint: '' }).mode).toBe('unconfigured')
  })

  it('accepts an OpenAI-compatible cloud base endpoint', () => {
    expect(chatEndpoint('https://api.example.test/v1')).toBe('https://api.example.test/v1/chat/completions')
    expect(modelsEndpoint('https://api.example.test/v1')).toBe('https://api.example.test/v1/models')
    expect(modelsEndpoint('https://example.test/v1/chat/completions')).toBe('https://example.test/v1/models')
    expect(status({ endpoint: 'https://api.example.test/v1', model: 'cloud-model', apiKey: 'secret' }).configured).toBe(true)
    expect(validateEndpoint('http://127.0.0.1:11434/v1').ok).toBe(false)
    expect(validateEndpoint('https://secret@example.test/v1').ok).toBe(false)
  })

  it('accepts array-form completion content but rejects vague pseudo-analysis', () => {
    expect(completionText([{ type: 'text', text: '{"what":"Edge 缓存","purpose":"加快网页加载"}' }])).toContain('Edge 缓存')
    expect(validateAnalysis({ what: '一个目录', purpose: '未知' }).ok).toBe(false)
    expect(validateAnalysis({ what: 'Microsoft Edge 的 HTTP 缓存目录', purpose: '保存可重建的网页资源以加快加载' }).ok).toBe(true)
  })

  it('loads and normalizes selectable models from the provider', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'z-model', owned_by: 'local' }, { id: 'a-model', owned_by: 'openai' }] })
    }))
    const result = await listModels({ endpoint: 'https://example.test/v1', apiKey: 'secret' }, fetchMock as any)
    expect(result.ok).toBe(true)
    expect(result.models.map((model: any) => model.id)).toEqual(['a-model', 'z-model'])
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/v1/models', expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ Authorization: 'Bearer secret' })
    }))
  })

  it('sends bounded evidence instead of a full file', () => {
    const result = safeEvidence({ name: 'x', contentPreview: 'a'.repeat(5000), evidence: { pathSegments: ['C:', 'x'], siblingNames: ['y'] } })
    expect(result.contentPreview.length).toBe(1200)
    expect(result.pathSegments).toEqual(['C:', 'x'])
  })

  it('redacts credentials before evidence can leave the computer', () => {
    const preview = [
      'API_KEY=sk-1234567890abcdefghijklmnop',
      'password: super-secret-value',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz'
    ].join('\n')
    const result = safeEvidence({
      name: 'token=abcdefghijklmnopqrstuvwxyz.txt',
      contentPreview: preview,
      evidence: { siblingNames: ['password=visible-in-name', 'y'.repeat(1000)] }
    })
    expect(result.name.length).toBeLessThanOrEqual(160)
    expect(result.name).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(result.siblingNames[0]).not.toContain('visible-in-name')
    expect(result.siblingNames[1].length).toBeLessThanOrEqual(160)
    expect(result.contentPreview).not.toContain('super-secret-value')
    expect(result.contentPreview).not.toContain('1234567890abcdefghijklmnop')
    expect(result.contentPreview).toContain('[REDACTED]')
    expect(redactSensitiveText('token=abcdefghijklmnopqrstuvwxyz')).not.toContain('abcdefghijklmnopqrstuvwxyz')
  })

  it('parses a compatible chat completion JSON response', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"what":"测试文件","purpose":"测试用途","risk":"low","confidence":0.8}' } }] }) }))
    const result = await review({ name: 'x.txt' }, { endpoint: 'https://example.test/v1', model: 'test', apiKey: 'secret' }, fetchMock as any)
    expect(result.ok).toBe(true)
    expect(result.parsed.what).toBe('测试文件')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(JSON.parse((fetchMock.mock.calls as any)[0][1].body).reasoning_effort).toBe('low')
  })

  it('uses maximum thinking and a larger token budget for deep analysis', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ usage: { total_tokens: 88 }, choices: [{ message: { content: '{"what":"系统目录","purpose":"系统功能"}' } }] }) }))
    const result = await review({ name: 'Windows', what: 'Windows 系统目录', classification: 'system-component', confidence: 0.95 }, { endpoint: 'https://example.test/v1', model: 'test', apiKey: 'secret', analysisMode: 'deep' }, fetchMock as any)
    const body = JSON.parse((fetchMock.mock.calls as any)[0][1].body)
    expect(body.reasoning_effort).toBe('high')
    expect(body.max_tokens).toBeGreaterThan(1200)
    expect(result.analysisMode).toBe('deep')
    expect(result.usage.total_tokens).toBe(88)
  })

  it('parses JSON even when a compatible model adds surrounding text', () => {
    expect(parseResult('分析结果如下：\n{"what":"缓存","confidence":0.7}\n结束')).toEqual({ what: '缓存', confidence: 0.7 })
  })

  it('keeps strong local conclusions when a model returns a vague label', () => {
    const result = enrichResult(
      { what: '一个名为 edge-profile 的文件夹', purpose: '不确定', confidence: 0.5 },
      { what: 'Chromium/Edge 浏览器用户数据目录', purpose: '保存浏览器 Profile、登录状态和缓存', source: 'Microsoft Edge', classification: 'browser-profile-data', confidence: 0.97, handling: '不要整体删除' }
    )
    expect(result.what).toBe('Chromium/Edge 浏览器用户数据目录')
    expect(result.purpose).toContain('浏览器 Profile')
    expect(result.belongsTo).toBe('Microsoft Edge')
  })

  it('asks the model for concrete identity and purpose', () => {
    const prompt = promptFor({ name: 'data' })
    expect(prompt).toContain('它具体是什么')
    expect(prompt).toContain('它实际有什么用')
    expect(prompt).toContain('不能只说“一个目录”')
  })

  it('retries without response_format when a provider does not support JSON mode', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'response_format is not supported' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: '{"what":"应用数据目录","purpose":"保存应用运行所需的数据"}' } }] }) })
    const result = await review({ name: 'data' }, { endpoint: 'https://example.test/v1', model: 'test', apiKey: 'secret' }, fetchMock as any)
    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty('response_format')
  })
})
