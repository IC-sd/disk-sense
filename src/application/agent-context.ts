import type { ChangeEvent, UserMemory } from '../domain/memory'
import type { Recommendation, StorageSnapshot } from '../domain/storage'

export interface AgentPermissions { readMetadata: boolean; readContent: boolean; mutateFiles: boolean }
export interface AgentContext { schemaVersion: 1; createdAt: string; scope: string[]; observations: unknown[]; memories: UserMemory[]; changes: ChangeEvent[]; recommendations: Recommendation[]; snapshot?: StorageSnapshot; permissions: AgentPermissions }

export function createAgentContext(input: Partial<AgentContext> = {}): AgentContext {
  return { schemaVersion: 1, createdAt: new Date().toISOString(), scope: [], observations: [], memories: [], changes: [], recommendations: [], permissions: { readMetadata: true, readContent: false, mutateFiles: false }, ...input }
}
