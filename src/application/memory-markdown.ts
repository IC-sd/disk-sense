import type { UserMemory } from '../domain/memory'
import { toMemoryMarkdown } from '../domain/memory'

export function exportMemories(memories: UserMemory[]) { return memories.map(toMemoryMarkdown).join('\n---\n\n') }
