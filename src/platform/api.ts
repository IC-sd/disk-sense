import type {
  AiConfigDraft,
  AiConfigStatus,
  AiAnalysisLookup,
  AiModelOption,
  AiReviewResult,
  StoredAiAnalysis,
  AnalysisMode,
  AppearanceSettings,
  AppInfo,
  ChangeProgress,
  ChangeResult,
  ChangeState,
  CleanerExecuteProgress,
  CleanerFile,
  CleanerRule,
  CleanerScanProgress,
  CleanerScanResult,
  CleanupExclusion,
  CleanupJob,
  CleanupJobSummary,
  DirectoryEstimate,
  DirectoryItem,
  DirectoryListResult,
  DataMigrationResult,
  DeviceInfo,
  DirectoryUsage,
  PathSpaceMeasurement,
  ToolCacheInspection,
  FileExplanation,
  FileSearchIndexStartResult,
  FileSearchIndexStatus,
  FileSearchQuery,
  FileSearchResult,
  MaintenanceJob,
  MaintenanceProgress,
  MaintenanceStatus,
  NativeFilePresentation,
  OverviewSummary,
  SlimmingItem
} from '../domain/desktop'

type Unsubscribe = () => void

export interface DesktopApi {
  overviewGet: () => Promise<OverviewSummary>
  appInfo: () => Promise<AppInfo>
  appDataUsage: () => Promise<DirectoryUsage>
  appAppearanceGet: () => Promise<AppearanceSettings>
  appAppearanceSet: (input: AppearanceSettings) => Promise<AppearanceSettings>
  appDeviceInfo: () => Promise<DeviceInfo>
  appOpenDataDirectory: () => Promise<{ opened: boolean }>
  appOpenInstallDirectory: () => Promise<{ opened: boolean }>
  appMoveDataDirectory: () => Promise<DataMigrationResult>
  appRestart: () => Promise<{ restarted: boolean }>
  appDiagnostics: () => Promise<{ generatedAt: string; context: unknown; records: unknown[]; redacted: boolean }>
  appDiagnosticsCopy: () => Promise<{ copied: boolean }>
  inspectList: (dir?: string) => Promise<DirectoryListResult>
  inspectListPage: (input: { sessionId: string; offset: number }) => Promise<DirectoryListResult>
  inspectListClose: (input: { sessionId: string }) => Promise<{ closed: boolean }>
  inspectHydrate: (paths: string[]) => Promise<DirectoryItem[]>
  inspectEstimate: (dir: string) => Promise<DirectoryEstimate>
  inspectSpace: (input: { path: string; requestId: string }) => Promise<PathSpaceMeasurement>
  inspectSpaceCancel: (requestId?: string) => Promise<{ cancelled: boolean }>
  inspectExplain: (filePath: string) => Promise<FileExplanation>
  inspectLocations: () => Promise<Array<{ name: string; path: string }>>
  inspectFileAction: (input: { path: string; action: 'open' | 'reveal' | 'copy'; query?: string }) => Promise<{ ok: boolean; path: string; action: string }>
  inspectIndexStatus: () => Promise<FileSearchIndexStatus>
  inspectIndexStart: (input: { scope: 'drive' | 'all'; root?: string }) => Promise<FileSearchIndexStartResult>
  inspectIndexCancel: () => Promise<{ cancelled: boolean; generation?: string }>
  inspectNtfsEnable: () => Promise<FileSearchIndexStartResult>
  inspectNtfsDisable: () => Promise<FileSearchIndexStartResult>
  inspectSearch: (input: FileSearchQuery) => Promise<FileSearchResult>
  inspectFilePresentations: (paths: string[]) => Promise<Record<string, NativeFilePresentation>>
  onInspectIndexProgress: (callback: (data: FileSearchIndexStatus) => void) => Unsubscribe
  aiStatus: () => Promise<AiConfigStatus>
  aiConfigGet: () => Promise<AiConfigStatus>
  aiConfigSave: (input: AiConfigDraft) => Promise<AiConfigStatus>
  aiConfigClear: () => Promise<AiConfigStatus>
  aiModels: (draft: Partial<AiConfigDraft>) => Promise<{ ok: boolean; reason?: string; models: AiModelOption[] }>
  aiTest: (draft: AiConfigDraft) => Promise<{ ok: boolean; reason?: string; model?: string }>
  aiReview: (request: { evidence: unknown; mode?: AnalysisMode }) => Promise<AiReviewResult>
  aiCancel: () => Promise<{ cancelled: boolean }>
  aiAnalysisGet: (request: { path: string; fingerprint: string }) => Promise<AiAnalysisLookup>
  aiAnalysisSave: (request: { path: string; fingerprint: string } & Partial<AiReviewResult>) => Promise<StoredAiAnalysis>
  changesState: () => Promise<ChangeState>
  changesBaseline: () => Promise<{ snapshot?: { cancelled?: boolean } }>
  changesScan: () => Promise<({ ok: false; reason: string } | ({ ok: true } & ChangeResult))>
  changesCancel: () => Promise<{ cancelled: boolean; id?: string }>
  onChangesProgress: (callback: (data: ChangeProgress) => void) => Unsubscribe
  cleanerRules: () => Promise<CleanerRule[]>
  cleanerToolCaches: () => Promise<ToolCacheInspection>
  cleanerScan: (id: string) => Promise<CleanerScanResult>
  cleanerScanCancel: (id?: string) => Promise<{ cancelled: boolean; count: number }>
  onCleanerScanProgress: (callback: (data: CleanerScanProgress) => void) => Unsubscribe
  cleanerSlimming: () => Promise<SlimmingItem[]>
  cleanerSlimmingStatus: () => Promise<MaintenanceStatus>
  cleanerSlimmingExecute: (input: { actionId: string; confirmation: string }) => Promise<MaintenanceJob>
  cleanerSlimmingHistory: () => Promise<MaintenanceJob[]>
  onCleanerSlimmingProgress: (callback: (data: MaintenanceProgress) => void) => Unsubscribe
  cleanerHistory: () => Promise<CleanupJobSummary[]>
  cleanerHistoryDetail: (id: string | { id: string; offset?: number; limit?: number }) => Promise<CleanupJob>
  cleanerHistoryClear: () => Promise<{ cleared: boolean; retained?: number }>
  cleanerHistoryAcknowledge: (id: string) => Promise<{ acknowledged: boolean }>
  cleanerExclusions: () => Promise<CleanupExclusion[]>
  cleanerExclusionAdd: (input: { path: string; mode: 'exact' | 'prefix'; reason?: string }) => Promise<CleanupExclusion>
  cleanerExclusionRemove: (id: string) => Promise<{ removed: boolean }>
  cleanerExecute: (files: CleanerFile[]) => Promise<CleanupJob>
  cleanerCancel: () => Promise<{ cancelled: boolean; id?: string }>
  onCleanerExecuteProgress: (callback: (data: CleanerExecuteProgress) => void) => Unsubscribe
}

export function desktopApi(): DesktopApi | null {
  return window.diskSense || null
}
