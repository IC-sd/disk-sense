import { describe, expect, it } from 'vitest'
import { AiAnalysisSession, MAX_AI_SESSION_RECORDS, applyAiRecord } from '../src/application/ai-session'

describe('in-window AI analysis session', () => {
  it('restores an analysis for the same unchanged path', () => {
    const session = new AiAnalysisSession()
    const record = session.save('C:\\Example', '100:2048', {
      model: 'test',
      result: '{"what":"浏览器数据"}',
      parsed: { what: '浏览器数据', purpose: '保存用户配置', belongsTo: 'Edge', whyHere: '由应用启动参数指定', handling: '保留', reasons: ['包含 Default'] }
    })

    expect(session.get('c:/example', '100:2048')).toBe(record)
    expect(session.get('C:\\Example', '101:2048')).toBeNull()
    const restored = applyAiRecord({ source: '待确认' }, record)
    expect(restored.source).toBe('Edge')
    expect(restored.aiDetails.purpose).toBe('保存用户配置')
    expect(restored.aiDetails.whyHere).toBe('由应用启动参数指定')
    expect(restored.aiReasons).toEqual(['包含 Default'])
  })

  it('bounds in-window analysis memory and evicts the oldest record', () => {
    const session = new AiAnalysisSession()
    for (let index = 0; index <= MAX_AI_SESSION_RECORDS; index++) {
      session.save(`C:\\item-${index}`, String(index), { result: '{}', parsed: null })
    }
    expect(session.size).toBe(MAX_AI_SESSION_RECORDS)
    expect(session.get('C:\\item-0', '0')).toBeNull()
    expect(session.get(`C:\\item-${MAX_AI_SESSION_RECORDS}`, String(MAX_AI_SESSION_RECORDS))).toBeTruthy()
  })
})
