import type { Recommendation, SpaceObservation, SpaceSource, StorageSnapshot } from '../domain/storage'

export function aggregateSources(observations: SpaceObservation[]): SpaceSource[] {
  const groups = new Map<string, SpaceSource>()
  for (const item of observations) {
    const id = `${item.classification}:${item.source}`
    const current = groups.get(id) ?? { id, title: item.source, classification: item.classification, bytes: 0, count: 0, risk: item.risk, observations: [] }
    current.bytes += item.size; current.count += item.fileCount; current.observations.push(item)
    if (item.risk === 'high' || (item.risk === 'unknown' && current.risk === 'low')) current.risk = item.risk
    groups.set(id, current)
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes)
}

export function recommend(source: SpaceSource): Recommendation | null {
  if (source.classification === 'rebuildable-cache' && source.risk === 'low') return { id: `recommend:${source.id}`, sourceId: source.id, title: `清理 ${source.title}`, reason: '这些内容被识别为可重建缓存，清理后应用会在需要时重新生成。', evidence: [], bytes: source.bytes, risk: 'low', impact: '可能导致首次启动或访问时重新生成缓存。', defaultAction: 'trash', reversible: true }
  if (source.classification === 'stale' || source.classification === 'personal') return { id: `recommend:${source.id}`, sourceId: source.id, title: `检查 ${source.title}`, reason: '这是用户空间内容，不能自动判断为垃圾。建议查看、归档或移动。', evidence: [], bytes: source.bytes, risk: source.risk, impact: '可能包含仍有价值的个人内容。', defaultAction: 'inspect', reversible: true }
  return null
}

export function snapshotDelta(previous: StorageSnapshot | undefined, current: StorageSnapshot) {
  if (!previous) return []
  const old = new Map(previous.sources.map(s => [s.id, s.bytes]))
  return current.sources.map(s => ({ sourceId: s.id, title: s.title, delta: s.bytes - (old.get(s.id) ?? 0) })).filter(x => x.delta !== 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
}
