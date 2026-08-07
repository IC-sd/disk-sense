export interface Attribution { id: string; name: string; evidence: string }
export interface Relationship { volume: string; owner: Attribution | null; systemDisk: boolean }
export function attribute(filePath: string): Attribution | null
export function storageRelationship(filePath: string): Relationship
export function findRelatedLocationsAsync(filePath: string, knownVolumes?: string[]): Promise<Array<{ path: string; reason: string; volume: string }>>
