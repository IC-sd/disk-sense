import { describe, expect, it } from 'vitest'
import { normalizeRisk, riskClass, riskLabel, riskRank } from '../src/domain/risk'

describe('global cleanup risk levels', () => {
  it('maps legacy and AI risk values into five product levels', () => {
    expect(normalizeRisk('high')).toBe('danger')
    expect(normalizeRisk('medium')).toBe('elevated')
    expect(normalizeRisk('unknown')).toBe('attention')
    expect(riskLabel('low')).toBe('低风险')
    expect(riskClass('safe')).toBe('risk-safe')
    expect(riskRank('danger')).toBeGreaterThan(riskRank('safe'))
  })
})
