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
  runtimeVersions?: { electron: string; node: string; chrome: string }
  name: string
  version: string
  platform: string
  architecture: string
  packaged: boolean
  installPath: string
  userDataPath: string
  defaultUserDataPath: string
  dataExternallyManaged: boolean
  migrationRecovery?: { source: string; target: string; message: string; detail?: string } | null
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
  sessionId?: string
  offset?: number
  nextOffset?: number | null
  complete?: boolean
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
  offset?: number
  sessionId?: string
}

export interface FileSearchIndexStatus {
  nativeStage?: string | null
  scannedEntries?: number
  scanner?: 'windows-native' | 'portable' | 'ntfs-mft' | 'ntfs-usn'
  ntfs?: {
    publication?: { root: string; entries: number; tookMs: number } | null
    pendingReplays?: Array<{ root: string; phase: string; position: number }>
    active: boolean
    persistent?: boolean
    requiresElevation: boolean
    synchronizing: boolean
    error: string
    volumes: Array<{ root: string; complete: boolean; lastSynced: string | null }>
  }
  synchronizing?: boolean
  coverageVersion?: number
  revision?: number
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
  matchPositions?: number[]
  matchTitle?: string
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
  diagnostics?: { stages?: Record<string, number>; counts?: Record<string, unknown>; reusedSession?: boolean; candidates?: number; returned?: number; tookMs?: number; renderer?: { requestMs: number; publishMs: number; frameMs?: number } }
  sessionId?: string
  total?: number
  offset?: number
  nextOffset?: number | null
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

export interface SpaceRelationship {
  provenance?: Record<string, unknown>
  basis?: string
  limited?: boolean
  components?: SpaceRelationship[]
  entityType?: 'project' | 'application' | 'system'
  entityId?: string
  entityName?: string
  entityKind?: string
  rootPath?: string | null
  installLocation?: string | null
  publisher?: string | null
  shortcutTarget?: string | null
  role?: { id: string; label: string; risk?: string; evidence?: string }
  confidence?: number
  evidence?: string[]
  volume?: string
  systemDisk?: boolean
}

export interface DirectoryShape {
  sampledChildren?: number
  directories?: number
  files?: number
  commonExtensions?: Array<{ extension?: string; count?: number }>
}

export interface ExplanationEvidence {
  version?: number
  fileType?: { version: number; source: string; format: string; type: string; status: string; confidence: number; extension: string; extensionConflict: boolean; bytesRead: number; prefixLimited: boolean; details: string[] } | null
  observations?: Array<{ id: string; source: string; label?: string; confidence?: number; format?: string | null; extensionConflict?: boolean; status?: string }>
  pathSegments?: string[]
  siblingNames?: string[]
  childNames?: string[]
  directoryShape?: DirectoryShape | null
  relationship?: SpaceRelationship | null
}

export interface AiDetails {
  what: string
  purpose: string
  belongsTo: string
  whyHere: string
  handling: string
}

export interface FileExplanation {
  evidenceFingerprint?: string
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
  relationship?: SpaceRelationship
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
  provider?: 'openai-compatible' | 'openai-responses' | 'azure-openai' | 'local-openai'
  apiVersion?: string
  model?: string
  apiKey?: string
  clearApiKey?: boolean
}

export interface AiConfigStatus {
  configured: boolean
  endpoint?: string | null
  provider?: 'openai-compatible' | 'openai-responses' | 'azure-openai' | 'local-openai'
  apiVersion?: string | null
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
  analysisVersion?: string
  promptVersion?: string
  evidenceVersion?: number
  evidenceDigest?: string
  provider?: string
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
  analysisVersion?: string
  promptVersion?: string
  evidenceVersion?: number
  evidenceDigest?: string
  provider?: string
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
  version?: number
  source?: string
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
  canonicalPath?: string
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
  /** All known files observed in the rule roots, including retained recent files. */
  itemCount: number
  total: number
  /** Files that passed the age and safety gates and may enter a cleanup plan. */
  candidateItemCount: number
  candidateTotal: number
  retained: {
    recentItems: number
    recentBytes: number
    olderItems: number
    olderBytes: number
  }
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
  locations?: string[]
  coverage?: {
    status: 'complete' | 'partial' | 'unavailable' | 'not-found' | 'excluded'
    roots: number
    missingRoots: number
    excludedRoots: number
    directoriesRead: number
    errorCount: number
    diagnostics: Array<{ path: string; stage: 'discovery' | 'root' | 'directory' | 'file' | 'summary'; code: string }>
    omittedDiagnostics: number
    discovery?: {
      directoriesRead: number
      entriesVisited: number
      missingLocations: number
      excludedLocations: number
      linksSkipped: number
      limited: boolean
    }
  }
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
  recoveryRequired?: boolean
  state?: string
  outcome?: 'completed' | 'restart-required' | 'failed' | 'interrupted' | 'settings-opened'
  rebootState?: 'required' | 'initiated' | 'not-reported'
  restartRequired?: boolean
  signal?: string | null
  cancellable?: boolean
  observedAvailableDeltaBytes?: number | null
  spaceMeasurement?: 'volume-delta-not-attributed'
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
  state?: string
  uncertainCount?: number
  recoveryRequired?: boolean
  offset?: number
  nextOffset?: number | null
  id: string
  createdAt: string
  /** The quarantine value is retained only for reading historical jobs. */
  executionMode: 'trash' | 'quarantine'
  results: CleanupResult[]
  requested: number
  processed: number
  succeeded: number
  failed: number
  cancelled: boolean
  rejectedOverflow: number
  movedToTrashBytes: number
  reclaimedBytes: number
  isolatedBytes?: number
  quarantineId?: string | null
  volumeChanges?: Array<{ root: string; before: number | null; after: number | null; delta: number | null }>
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

export interface PathSpaceMeasurement {
  path: string
  generatedAt: string
  state: 'complete' | 'partial'
  logicalBytes: number
  uniqueLogicalBytes: number
  allocatedBytes: number | null
  knownAllocatedBytes: number
  sharedOutsideBytes: number
  files: number
  directories: number
  hardLinkDuplicates: number
  unknownFiles: number
  skippedReparsePoints: number
  cloudPlaceholders: number
  sparseFiles: number
  compressedFiles: number
  errors: number
  stopReason: 'entry-budget' | 'time-budget' | 'cancelled' | null
  reclaimableBytes: null
  measurement: string
  explanation: string
  durationMs: number
}

export interface ToolCacheInspection {
  generatedAt: string
  previewOnly: true
  tools: Array<{ id: string; path: string; source: string; version: string | null; status: string; effectivePath: string | null; warnings: string[];
    executablePath: string | null; shared: true; automaticExecution: false;
    nativePreview: { command: string; args: string[]; previewOnly: true; available: boolean; impact: string; scope: string } }>
}

export interface CleanerScanProgress {
  phase?: 'discovery' | 'files'
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
    modifiedBytes?: number
    movedBytesDelta?: number
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
