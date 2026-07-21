import type { Action, Evidence } from './storage'

export type ChangeKind = 'added' | 'removed' | 'modified' | 'moved' | 'growth'
export interface ChangeEvent { id: string; path: string; kind: ChangeKind; observedAt: string; beforeSize?: number; afterSize?: number; source?: string; evidence: Evidence[] }
export interface UserMemory { id: string; subject: string; content: string; tags: string[]; source: 'user' | 'accepted-suggestion'; createdAt: string; updatedAt: string; preferredActions?: Action[]; confidence: number }
export interface MemorySuggestion { id: string; subject: string; proposedContent: string; reason: string; evidence: Evidence[]; accepted: boolean }

export function toMemoryMarkdown(memory: UserMemory) {
  return `# ${memory.subject}\n\n${memory.content}\n\n## Tags\n\n${memory.tags.map(tag => `- ${tag}`).join('\n')}\n\n_Last updated: ${memory.updatedAt}_\n`
}
