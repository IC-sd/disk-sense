declare module '../desktop/app-attribution.cjs' {
  export function attribute(filePath: string): { id: string; name: string; evidence: string } | null
  export function storageRelationship(filePath: string): { volume: string; owner: unknown; systemDisk: boolean }
}
declare module '../desktop/duplicates.cjs' {
  export function candidates(items: Array<{ path: string; size: number }>): Array<{ id: string; confidence: string; size: number; files: Array<{ path: string; size: number; name: string }>; reclaimable: number }>
}
