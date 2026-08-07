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
  installPath: string
  userDataPath: string
  defaultUserDataPath: string
  dataExternallyManaged: boolean
  dataUsage: DirectoryUsage
  appearance: AppearanceSettings
  stateVersion: number
  aiConfigured: boolean
  security: {
    rendererSandbox: boolean
    contextIsolation: boolean
    permanentDelete: boolean
    remoteAiRequiresHttps: boolean
    systemMaintenanceAllowlist: boolean
  }
}

export type AppTheme = 'dark' | 'light'

export interface AppearanceSettings {
  theme: AppTheme
}

export interface DirectoryUsage {
  bytes: number
  files: number
  directories: number
  inaccessible: number
  truncated: boolean
}

export interface DeviceInfo {
  deviceName: string
  manufacturer: string
  model: string
  operatingSystem: string
  osVersion: string
  osBuild: string
  architecture: string
  processor: string
  logicalProcessors: number
  totalMemoryBytes: number
  freeMemoryBytes: number
  uptimeSeconds: number
  graphics: Array<{
    name: string
    memoryBytes: number
  }>
  installPath: string
  dataPath: string
}

export interface DataMigrationResult {
  cancelled: boolean
  changed?: boolean
  source?: string
  target?: string
  copiedFiles?: string[]
  copiedBytes?: number
  restartRequired?: boolean
  sourceRetained?: boolean
}

export interface DirectoryItem {
  name: string
  path: string
  isDirectory: boolean
  isLink?: boolean
  size: number | null
  fileCount: number | null
  sizeEstimated: boolean
  metadataPending?: boolean
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
  context: {
    siblingCount: number
    analyzed: string
    metadataComplete?: number
    metadataPending?: number
  }
}

export type FileSearchScope = 'directory' | 'drive' | 'all'
export type FileSearchKind =
  | 'all'
  | 'folder'
  | 'file'
  | 'application'
  | 'document'
  | 'image'
  | 'video'
  | 'audio'
  | 'archive'
  | 'installer'
  | 'code'
export type FileSearchModified = 'any' | 'day' | 'week' | 'month' | 'year'
export type FileSearchSort = 'relevance' | 'name' | 'modified' | 'size'

export interface FileSearchQuery {
  query: string
  scope: FileSearchScope
  root?: string
  kind: FileSearchKind
  modified: FileSearchModified
  sort: FileSearchSort
  limit?: number
}

export interface FileSearchIndexStatus {
  available: boolean
  indexed: boolean
  building: boolean
  phase: 'idle' | 'building' | 'ready' | 'partial' | 'cancelled' | 'failed'
  roots: string[]
  entries: number
  directories: number
  inaccessible: number
  skippedLinks: number
  current: string
  startedAt: string | null
  completedAt: string | null
  durationMs: number
  truncated: boolean
  cancelled: boolean
  automatic: boolean
  watching: boolean
  watcherCount: number
  pendingChanges: number
  lastChangedAt: string | null
  lastError: string | null
  error?: string
}

export interface FileSearchItem extends DirectoryItem {
  parent: string
  displayName: string
  searchKind: Exclude<FileSearchKind, 'all'>
  searchPriority: 'primary' | 'standard' | 'secondary'
  relevanceReason: string
}

export interface NativeFilePresentation {
  dataUrl: string
  displayName?: string
  target?: string
  description?: string
}

export interface FileSearchResult {
  items: FileSearchItem[]
  truncated: boolean
  tookMs: number
  index: FileSearchIndexStatus
}

export interface FileSearchIndexStartResult {
  started: boolean
  generation?: string
  reason?: string
  status: FileSearchIndexStatus
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
  aiPersisted?: boolean
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

export interface StoredAiAnalysis {
  path: string
  fingerprint: string
  parsed?: Record<string, unknown> | null
  raw: string
  model?: string
  analysisMode: AnalysisMode
  thinkingLevel?: string
  tokenBudget?: number
  usage?: Record<string, number> | null
  analyzedAt: number
}

export interface AiAnalysisLookup {
  status: 'missing' | 'current' | 'stale'
  record?: StoredAiAnalysis
  analyzedAt?: number
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
  maximumAgeDays: number | null
  processNames: string[]
  summaryOnly?: boolean
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
  maximumAgeDays: number | null
  processNames: string[]
  blockedProcesses: string[]
  processCheckFailed: boolean
  blockedReason: string | null
  files: CleanerFile[]
  itemCount: number
  total: number
  summaryOnly: boolean
  volumeBreakdown: Array<{
    root: string
    code: number
    items: number
    bytes: number
  }>
  truncated: boolean
  limitReason: 'max-files' | 'max-visited' | 'max-time' | null
  durationMs: number
  visited: number
  skipped: {
    recent: number
    older: number
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
  category: string
  description: string
  risk: Risk
  impact: string
  action: string
  requiresAdmin: boolean
  detected: boolean
  bytes: number | null
  status: string
  actions: SlimmingAction[]
}

export interface SlimmingAction {
  id: string
  label: string
  description: string
  kind: 'command' | 'open-path' | 'open-external'
  risk: Risk
  requiresAdmin: boolean
  irreversible: boolean
  confirmationPhrase: string
  readOnly: boolean
  enabled: boolean
  disabledReason: string | null
}

export interface MaintenanceStatus {
  platform: string
  elevated: boolean
  commands: Record<string, boolean>
  activeTask: {
    id: string
    actionId: string
    startedAt: string
  } | null
}

export interface MaintenanceProgress {
  id: string
  actionId: string
  phase: 'running' | 'completed' | 'failed'
  percent: number | null
  message: string
}

export interface MaintenanceJob {
  id: string
  actionId: string
  ruleId: string
  title: string
  risk: Risk
  readOnly: boolean
  irreversible: boolean
  requiresAdmin: boolean
  success: boolean
  exitCode: number
  startedAt: string
  finishedAt: string
  reclaimedBytes: number
  message: string
  stdoutTail: string
  stderrTail: string
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
    baselineLimitReason: 'max-entries' | 'max-time' | 'root-budget' | 'cancelled' | null
    currentLimitReason: 'max-entries' | 'max-time' | 'root-budget' | 'cancelled' | null
    rootsChanged: boolean
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
  limitReason: 'max-entries' | 'max-time' | 'root-budget' | 'cancelled' | null
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
