import type { Risk } from './risk'

export type AnalysisMode = 'normal' | 'deep'

export interface DiskVolume {
  root: string
  totalBytes: number
  freeBytes: number
  usedBytes: number
  usagePercent: number
  isSystem: boolean
}

export interface OverviewSummary {
  generatedAt: string
  volumes: DiskVolume[]
  activity: {
    cleanupJobs: number
    movedToTrashBytes: number
    movedToTrashFiles: number
    lastCleanupAt: string | null
    baselineCreatedAt: string | null
    lastChangeScanAt: string | null
    exclusionCount: number
  }
}

export interface AppInfo {
  name: string
  version: string
  platform: string
  architecture: string
  packaged: boolean
  userDataPath: string
  stateVersion: number
  aiConfigured: boolean
  security: {
    rendererSandbox: boolean
    contextIsolation: boolean
    permanentDelete: boolean
    remoteAiRequiresHttps: boolean
  }
}

export interface DirectoryItem {
  name: string
  path: string
  isDirectory: boolean
  isLink?: boolean
  size: number | null
  fileCount: number | null
  sizeEstimated: boolean
  modifiedAt: number
  extension: string
  classification: string
  source: string
  risk: Risk
  confidence: number
  reason: string
}

export interface DirectoryListResult {
  path: string
  items: DirectoryItem[]
  truncated: boolean
  context: { siblingCount: number; analyzed: string }
}

export interface DirectoryEstimate {
  path: string
  bytes: number
  fileCount: number
  sampledNodes: number
  complete: boolean
}

export interface RelatedLocation {
  path: string
  reason: string
  volume?: string
}

export interface DirectoryShape {
  sampledChildren?: number
  directories?: number
  files?: number
  commonExtensions?: Array<{ extension?: string; count?: number }>
}

export interface ExplanationEvidence {
  pathSegments?: string[]
  siblingNames?: string[]
  childNames?: string[]
  directoryShape?: DirectoryShape | null
}

export interface AiDetails {
  what: string
  purpose: string
  belongsTo: string
  whyHere: string
  handling: string
}

export interface FileExplanation {
  path: string
  name: string
  parent: string
  size: number
  fileCount?: number | null
  modifiedAt: number
  isDirectory: boolean
  isLink?: boolean
  classification: string
  source: string
  risk: Risk
  confidence: number
  reason: string
  what?: string
  purpose?: string
  belongsTo?: string
  whyHere?: string
  handling?: string
  icon?: string
  kind?: string
  title?: string
  description?: string
  action?: string
  contentPreview?: string | null
  relatedLocations?: RelatedLocation[]
  evidence?: ExplanationEvidence
  aiDetails?: AiDetails
  aiReasons?: string[]
  aiAnalyzed?: boolean
  aiMode?: AnalysisMode
  aiAnalyzedAt?: number
  aiThinkingLevel?: string
  aiTokenBudget?: number
  aiUsage?: Record<string, number> | null
}

export interface AiConfigDraft {
  endpoint: string
  model?: string
  apiKey?: string
  clearApiKey?: boolean
}

export interface AiConfigStatus {
  configured: boolean
  endpoint?: string | null
  model?: string
  hasApiKey?: boolean
  keyStored?: boolean
  encryptionAvailable?: boolean
}

export interface AiModelOption {
  id: string
  name: string
  ownedBy?: string | null
}

export interface AiReviewResult {
  ok: boolean
  reason?: string
  result?: string
  parsed?: Record<string, unknown> | null
  model?: string
  analysisMode?: AnalysisMode
  thinkingLevel?: string
  tokenBudget?: number
  usage?: Record<string, number> | null
}

export interface CleanerRule {
  id: string
  title: string
  category: string
  risk: Risk
  reason: string
  safetyNote: string
  selectable: boolean
  requiresAdmin: boolean
  minimumAgeDays: number
  processNames: string[]
}

export interface CleanerFile {
  candidateId: string
  path: string
  size: number
  modifiedAt: number
  ruleId: string
}

export interface CleanerScanResult {
  id: string
  title: string
  category: string
  risk: Risk
  reason: string
  safetyNote: string
  selectable: boolean
  configuredSelectable: boolean
  requiresAdmin: boolean
  minimumAgeDays: number
  processNames: string[]
  blockedProcesses: string[]
  processCheckFailed: boolean
  blockedReason: string | null
  files: CleanerFile[]
  total: number
  truncated: boolean
  limitReason: 'max-files' | 'max-visited' | 'max-time' | null
  durationMs: number
  visited: number
  skipped: {
    recent: number
    links: number
    inaccessible: number
    outsideRoot: number
    unsupported: number
    excluded: number
  }
  scannedAt: number
}

export interface SlimmingItem {
  id: string
  title: string
  description: string
  risk: Risk
  impact: string
  action: string
  requiresAdmin: boolean
  detected: boolean
  bytes: number
  status: string
}

export interface CleanupResult extends CleanerFile {
  success: boolean
  error?: string
}

export interface CleanupJob {
  id: string
  createdAt: string
  executionMode: 'trash'
  results: CleanupResult[]
  requested: number
  processed: number
  succeeded: number
  failed: number
  cancelled: boolean
  rejectedOverflow: number
  movedToTrashBytes: number
  reclaimedBytes: number
  omittedResults?: number
}

export type CleanupJobSummary = Omit<CleanupJob, 'results' | 'rejectedOverflow'> & {
  results?: never
}

export interface CleanupExclusion {
  id: string
  path: string
  mode: 'exact' | 'prefix'
  reason: string
  createdAt: string
}

export interface CleanerScanProgress {
  ruleId: string
  visited: number
  found: number
  current: string
}

export interface CleanerExecuteProgress {
  id: string
  processed: number
  total: number
  succeeded: number
  failed: number
  current: string
}

export interface ChangeEntry {
  path: string
  kind: string
  size: number
  modifiedAt: number
  beforeSize?: number
  treeBytes?: number
  treeFileCount?: number
}

export interface MovedEntry {
  from: string
  to: string
  kind: string
  size: number
}

export interface ChangeResult {
  added: ChangeEntry[]
  removed: ChangeEntry[]
  modified: ChangeEntry[]
  moved: MovedEntry[]
  coverage: {
    baselineDirectories: number
    currentDirectories: number
    baselineTruncated: boolean
    currentTruncated: boolean
    partial: boolean
    baselineRoots: ChangeRootCoverage[]
    currentRoots: ChangeRootCoverage[]
  }
  summary: {
    added: number
    removed: number
    modified: number
    moved: number
    addedBytes: number
    removedBytes: number
  }
}

export interface ChangeRootCoverage {
  root: string
  entries: number
  directories: number
  inaccessible: number
  skippedLinks: number
  pendingDirectories: number
  truncated: boolean
}

export interface ChangeBaseline {
  createdAt: string
  roots: string[]
  truncated: boolean
  durationMs: number
  entryCount: number
  directoryCount: number
  rootCoverage: ChangeRootCoverage[]
}

export interface ChangeHistoryRecord {
  id: string
  createdAt: string
  baselineCreatedAt: string
  roots: string[]
  summary: ChangeResult['summary']
  partial: boolean
}

export interface ChangeState {
  baseline: ChangeBaseline | null
  last: { result: ChangeResult } | null
  history: ChangeHistoryRecord[]
}

export interface ChangeProgress {
  current?: string
  activeRoot?: string
  entries?: number
  rootCoverage?: ChangeRootCoverage[]
}
