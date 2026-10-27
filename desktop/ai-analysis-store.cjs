const path = require('node:path')
const { ANALYSIS_VERSION, PROMPT_VERSION, EVIDENCE_VERSION, currentVersions } = require('./ai-contract.cjs')
const { redactSensitiveText } = require('./ai-safety.cjs')

const DEFAULT_MAX_RECORDS = 1000
const MAX_RAW_CHARS = 24_000
const MAX_FIELD_CHARS = 4_000

function pathKey(value) {
  const input = String(value || '').trim()
  if (!input || !path.isAbsolute(input)) throw new Error('AI 分析记录缺少有效的绝对路径')
  return path.resolve(input).replaceAll('/', '\\').toLowerCase()
}

function clipped(value, maximum = MAX_FIELD_CHARS) {
  return typeof value === 'string' ? redactSensitiveText(value).trim().slice(0, maximum) : ''
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function cleanParsed(input) {
  if (!input || typeof input !== 'object') return null
  const parsed = {
    what: clipped(input.what),
    purpose: clipped(input.purpose),
    belongsTo: clipped(input.belongsTo),
    whyHere: clipped(input.whyHere),
    risk: clipped(input.risk, 32),
    confidence: finiteNumber(input.confidence),
    handling: clipped(input.handling),
    reasons: Array.isArray(input.reasons)
      ? input.reasons.slice(0, 8).map(value => clipped(String(value), 1000)).filter(Boolean)
      : [],
    evidenceRefs: input.evidenceRefs && typeof input.evidenceRefs === 'object' ? Object.fromEntries(
      ['what', 'purpose', 'belongsTo', 'whyHere', 'handling'].map(field => [field,
        Array.isArray(input.evidenceRefs[field]) ? [...new Set(input.evidenceRefs[field].filter(id => typeof id === 'string' && /^E0[1-8]$/.test(id)))].slice(0, 8) : []])
    ) : {},
    uncertainties: Array.isArray(input.uncertainties) ? input.uncertainties.slice(0, 8).map(value => clipped(value, 320)).filter(Boolean) : []
  }
  return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== '' && value !== undefined))
}

function cleanUsage(input) {
  if (!input || typeof input !== 'object') return null
  const entries = Object.entries(input)
    .slice(0, 16)
    .map(([key, value]) => [clipped(key, 80), finiteNumber(value)])
    .filter(([key, value]) => key && value !== undefined)
  return entries.length ? Object.fromEntries(entries) : null
}

function cleanRecord(input) {
  if (!input || typeof input !== 'object') return null
  try {
    const inputPath = String(input.path || '').trim()
    if (!inputPath || !path.isAbsolute(inputPath)) return null
    const resolvedPath = path.resolve(inputPath)
    const fingerprint = clipped(input.fingerprint, 240)
    if (!fingerprint) return null
    return {
      path: resolvedPath,
      pathKey: pathKey(resolvedPath),
      fingerprint,
      parsed: cleanParsed(input.parsed),
      raw: clipped(input.raw ?? input.result, MAX_RAW_CHARS),
      model: clipped(input.model, 240),
      provider: clipped(input.provider || input.mode, 80),
      analysisVersion: clipped(input.analysisVersion, 80),
      promptVersion: clipped(input.promptVersion, 80),
      evidenceVersion: finiteNumber(input.evidenceVersion),
      evidenceDigest: /^[a-f0-9]{64}$/.test(input.evidenceDigest || '') ? input.evidenceDigest : '',
      analysisMode: input.analysisMode === 'deep' ? 'deep' : 'normal',
      thinkingLevel: clipped(input.thinkingLevel, 80),
      tokenBudget: finiteNumber(input.tokenBudget),
      usage: cleanUsage(input.usage),
      analyzedAt: finiteNumber(input.analyzedAt) || Date.now()
    }
  } catch {
    return null
  }
}

function createAiAnalysisStore({ getDb, maximumRecords = DEFAULT_MAX_RECORDS }) {
  const database = () => {
    const value = getDb?.()
    if (!value?.read || !value?.save) throw new Error('本地分析存储尚未准备好')
    return value
  }

  function records() {
    const db = database()
    const source = Array.isArray(db.read().aiAnalyses) ? db.read().aiAnalyses : []
    const cleaned = source.map(cleanRecord).filter(Boolean).slice(-maximumRecords)
    db.read().aiAnalyses = cleaned
    return cleaned
  }

  function get(input = {}) {
    const key = pathKey(input.path)
    const fingerprint = clipped(input.fingerprint, 240)
    if (!fingerprint) throw new Error('AI 分析记录缺少文件状态指纹')
    const record = [...records()].reverse().find(item => item.pathKey === key)
    if (!record) return { status: 'missing' }
    if (record.fingerprint !== fingerprint || !currentVersions(record)) {
      return { status: 'stale', analyzedAt: record.analyzedAt, reason: record.fingerprint !== fingerprint ? 'evidence-changed' : 'analysis-version-changed' }
    }
    const { pathKey: _pathKey, ...publicRecord } = record
    return { status: 'current', record: publicRecord }
  }

  function save(input = {}) {
    const record = cleanRecord({ analysisVersion: ANALYSIS_VERSION, promptVersion: PROMPT_VERSION, evidenceVersion: EVIDENCE_VERSION, ...input, analyzedAt: Date.now() })
    if (!record) throw new Error('AI 分析结果无效，无法保存')
    const db = database()
    const next = records().filter(item => item.pathKey !== record.pathKey)
    next.push(record)
    db.read().aiAnalyses = next.slice(-maximumRecords)
    db.save()
    const { pathKey: _pathKey, ...publicRecord } = record
    return publicRecord
  }

  return { get, save }
}

module.exports = {
  DEFAULT_MAX_RECORDS,
  cleanRecord,
  createAiAnalysisStore
}
