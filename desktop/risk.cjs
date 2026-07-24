const LEVELS = ['safe', 'low', 'attention', 'elevated', 'danger']

function normalizeRisk(value) {
  const key = String(value || '').trim().toLowerCase()
  const aliases = {
    safe: 'safe',
    low: 'low',
    attention: 'attention',
    unknown: 'attention',
    medium: 'elevated',
    elevated: 'elevated',
    high: 'danger',
    danger: 'danger',
    安全: 'safe',
    低风险: 'low',
    重点: 'attention',
    较高: 'elevated',
    高风险: 'danger'
  }
  return aliases[key] || 'attention'
}

function riskRank(value) {
  return LEVELS.indexOf(normalizeRisk(value))
}

module.exports = { LEVELS, normalizeRisk, riskRank }
