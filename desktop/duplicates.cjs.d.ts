export interface DuplicateFile { path: string; size: number; name: string }
export interface DuplicateCandidate { id: string; confidence: string; size: number; files: DuplicateFile[]; reclaimable: number }
export function candidates(items: Array<{ path: string; size: number }>): DuplicateCandidate[]
