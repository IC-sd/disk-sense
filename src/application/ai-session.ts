import type { AiDetails, AiReviewResult, FileExplanation } from '../domain/desktop'
import { normalizeRisk } from '../domain/risk'

type ParsedAiAnalysis = {
  what?: string
  purpose?: string
  belongsTo?: string
  whyHere?: string
  risk?: string
  confidence?: number
  handling?: string
  reasons?: unknown[]
}

export type AiSessionRecord = {
  parsed: ParsedAiAnalysis | null
  raw: string
  model?: string
  analysisMode: 'normal' | 'deep'
  thinkingLevel?: string
  tokenBudget?: number
  usage?: Record<string, number> | null
  analyzedAt: number
  fingerprint: string
}

export const MAX_AI_SESSION_RECORDS = 500

function key(path: string) {
  return String(path || '').replaceAll('/', '\\').toLowerCase()
}

function parsedResult(value: AiReviewResult['parsed']): ParsedAiAnalysis | null {
  return value && typeof value === 'object' ? value as ParsedAiAnalysis : null
}

export class AiAnalysisSession {
  private records = new Map<string, AiSessionRecord>()

  get(path: string, fingerprint: string) {
    const recordKey = key(path)
    const record = this.records.get(recordKey)
    if (record?.fingerprint !== fingerprint) return null
    this.records.delete(recordKey)
    this.records.set(recordKey, record)
    return record
  }

  save(path: string, fingerprint: string, result: Partial<AiReviewResult>) {
    const record: AiSessionRecord = {
      parsed: parsedResult(result.parsed),
      raw: String(result.result || ''),
      model: result.model,
      analysisMode: result.analysisMode === 'deep' ? 'deep' : 'normal',
      thinkingLevel: result.thinkingLevel,
      tokenBudget: result.tokenBudget,
      usage: result.usage || null,
      analyzedAt: Date.now(),
      fingerprint
    }
    const recordKey = key(path)
    this.records.delete(recordKey)
    this.records.set(recordKey, record)
    while (this.records.size > MAX_AI_SESSION_RECORDS) {
      const oldest = this.records.keys().next().value
      if (typeof oldest !== 'string') break
      this.records.delete(oldest)
    }
    return record
  }

  clear() {
    this.records.clear()
  }

  get size() {
    return this.records.size
  }
}

export const appAiAnalysisSession = new AiAnalysisSession()

export function applyAiRecord<T extends Partial<FileExplanation>>(
  base: T,
  record: AiSessionRecord
): T & {
  kind: string
  aiDetails: AiDetails
  aiReasons: string[]
  aiMode: 'normal' | 'deep'
  aiAnalyzed: true
  aiAnalyzedAt: number
} {
  const parsed = record.parsed
  const kind = record.analysisMode === 'deep' ? 'AI 深入分析' : 'AI 普通分析'
  const what = parsed?.what || base.what || base.description || '暂未确定的对象'
  const purpose = parsed?.purpose || base.purpose || '证据不足'
  const details: AiDetails = {
    what,
    purpose,
    belongsTo: parsed?.belongsTo || base.source || '尚未确认',
    whyHere: parsed?.whyHere || base.whyHere || '当前证据不足以解释它为什么出现在这里。',
    handling: parsed?.handling || base.action || '建议保留并进一步确认。'
  }

  return {
    ...base,
    kind,
    source: parsed?.belongsTo || base.source,
    description: `${what}。${purpose}`,
    risk: normalizeRisk(parsed?.risk || base.risk),
    confidence: typeof parsed?.confidence === 'number' ? parsed.confidence : base.confidence,
    action: parsed?.handling || base.action,
    aiDetails: details,
    aiReasons: Array.isArray(parsed?.reasons) ? parsed.reasons.map(String) : [],
    aiMode: record.analysisMode,
    aiThinkingLevel: record.thinkingLevel,
    aiTokenBudget: record.tokenBudget,
    aiUsage: record.usage,
    aiAnalyzed: true,
    aiAnalyzedAt: record.analyzedAt
  } as T & {
    kind: string
    aiDetails: AiDetails
    aiReasons: string[]
    aiMode: 'normal' | 'deep'
    aiAnalyzed: true
    aiAnalyzedAt: number
  }
}
