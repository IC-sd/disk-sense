export type Risk = 'danger' | 'elevated' | 'attention' | 'low' | 'safe'

const aliases: Record<string, Risk> = {
  danger: 'danger',
  high: 'danger',
  elevated: 'elevated',
  medium: 'elevated',
  attention: 'attention',
  unknown: 'attention',
  low: 'low',
  safe: 'safe',
  高风险: 'danger',
  较高: 'elevated',
  重点: 'attention',
  低风险: 'low',
  安全: 'safe'
}

export const riskLevels: Array<{ value: Risk; label: string; color: string }> = [
  { value: 'danger', label: '高风险', color: 'red' },
  { value: 'elevated', label: '较高', color: 'orange' },
  { value: 'attention', label: '重点', color: 'yellow' },
  { value: 'low', label: '低风险', color: 'blue' },
  { value: 'safe', label: '安全', color: 'green' }
]

export function normalizeRisk(value: unknown): Risk {
  const raw = String(value || '').trim()
  return aliases[raw.toLowerCase()] || aliases[raw] || 'attention'
}

export function riskLabel(value: unknown) {
  const normalized = normalizeRisk(value)
  return riskLevels.find(level => level.value === normalized)?.label || '重点'
}

export function riskClass(value: unknown) {
  return `risk-${normalizeRisk(value)}`
}

export function riskRank(value: unknown) {
  return riskLevels.length - 1 - riskLevels.findIndex(level => level.value === normalizeRisk(value))
}
