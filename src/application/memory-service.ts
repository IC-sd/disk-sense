import type { ChangeEvent, MemorySuggestion, UserMemory } from '../domain/memory'
import type { StorageSnapshot } from '../domain/storage'

export function detectGrowth(previous: StorageSnapshot | undefined, current: StorageSnapshot): ChangeEvent[] {
  if (!previous) return []
  const old = new Map(previous.sources.map(source => [source.id, source]))
  return current.sources.flatMap(source => {
    const before = old.get(source.id)?.bytes ?? 0
    const delta = source.bytes - before
    if (delta <= 0) return []
    return [{ id: `growth:${source.id}:${current.id}`, path: source.id, kind: 'growth' as const, observedAt: current.createdAt, beforeSize: before, afterSize: source.bytes, source: source.title, evidence: [{ type: 'snapshot-delta', value: `${delta} bytes since previous snapshot` }] }]
  })
}

export function suggestMemory(change: ChangeEvent): MemorySuggestion | null {
  if (change.kind !== 'growth' || !change.source) return null
  return { id: `memory:${change.id}`, subject: change.source, proposedContent: `${change.source} appears to be growing between observations. Keep monitoring before deciding whether to clean, move, or change retention.`, reason: 'The same source increased between snapshots.', evidence: change.evidence, accepted: false }
}

export function memorySearch(memories: UserMemory[], subject: string) {
  const needle = subject.toLowerCase()
  return memories.filter(memory => `${memory.subject} ${memory.content} ${memory.tags.join(' ')}`.toLowerCase().includes(needle))
}
