export type Risk = 'low' | 'medium' | 'high' | 'unknown'
export type Classification = 'system' | 'rebuildable-cache' | 'application-data' | 'personal' | 'stale' | 'unknown'
export type Action = 'inspect' | 'open' | 'ignore' | 'monitor' | 'move' | 'archive' | 'trash'

export interface Evidence { type: string; value: string; confidence?: number }
export interface SpaceObservation {
  id: string; path: string; volume: string; size: number; fileCount: number
  modifiedAt?: string; accessedAt?: string; classification: Classification
  source: string; risk: Risk; confidence: number; evidence: Evidence[]; actions: Action[]
}
export interface SpaceSource { id: string; title: string; classification: Classification; bytes: number; count: number; risk: Risk; observations: SpaceObservation[] }
export interface StorageSnapshot { id: string; createdAt: string; durationMs: number; volumes: string[]; sources: SpaceSource[]; skipped: number; errors: Array<{ path: string; reason: string }> }
export interface Recommendation { id: string; sourceId: string; title: string; reason: string; evidence: Evidence[]; bytes: number; risk: Risk; impact: string; defaultAction: Action; reversible: boolean }
