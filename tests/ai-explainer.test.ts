// @ts-expect-error CommonJS desktop module is intentionally tested from the TypeScript suite.
import { chatEndpoint, listModels, modelsEndpoint, safeEvidence, status, review } from '../desktop/ai-explainer.cjs'
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

  it('parses a compatible chat completion JSON response', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"what":"测试文件","purpose":"测试用途","risk":"low","confidence":0.8}' } }] }) }))
    const result = await review({ name: 'x.txt' }, { endpoint: 'https://example.test/v1', model: 'test', apiKey: 'secret' }, fetchMock as any)
    expect(result.ok).toBe(true)
    expect(result.parsed.what).toBe('测试文件')
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
