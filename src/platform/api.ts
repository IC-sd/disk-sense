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
  inspectList: (dir?: string) => Promise<DirectoryListResult>
  inspectHydrate: (paths: string[]) => Promise<DirectoryItem[]>
  inspectEstimate: (dir: string) => Promise<DirectoryEstimate>
  inspectExplain: (filePath: string) => Promise<FileExplanation>
  inspectIndexStatus: () => Promise<FileSearchIndexStatus>
  inspectIndexStart: (input: { scope: 'drive' | 'all'; root?: string }) => Promise<FileSearchIndexStartResult>
  inspectIndexCancel: () => Promise<{ cancelled: boolean; generation?: string }>
  inspectSearch: (input: FileSearchQuery) => Promise<FileSearchResult>
  inspectFilePresentations: (paths: string[]) => Promise<Record<string, NativeFilePresentation>>
  onInspectIndexProgress: (callback: (data: FileSearchIndexStatus) => void) => Unsubscribe
  aiStatus: () => Promise<AiConfigStatus>
  aiConfigGet: () => Promise<AiConfigStatus>
  aiConfigSave: (input: AiConfigDraft) => Promise<AiConfigStatus>
  aiConfigClear: () => Promise<AiConfigStatus>
  aiModels: (draft: Partial<AiConfigDraft>) => Promise<{ ok: boolean; reason?: string; models: AiModelOption[] }>
  aiTest: (draft: AiConfigDraft) => Promise<{ ok: boolean; reason?: string; model?: string }>
  aiReview: (request: { evidence: unknown; mode: AnalysisMode }) => Promise<AiReviewResult>
  aiAnalysisGet: (request: { path: string; fingerprint: string }) => Promise<AiAnalysisLookup>
  aiAnalysisSave: (request: { path: string; fingerprint: string } & Partial<AiReviewResult>) => Promise<StoredAiAnalysis>
  changesState: () => Promise<ChangeState>
  changesBaseline: () => Promise<{ snapshot?: { cancelled?: boolean } }>
  changesScan: () => Promise<({ ok: false; reason: string } | ({ ok: true } & ChangeResult))>
  changesCancel: () => Promise<{ cancelled: boolean; id?: string }>
  onChangesProgress: (callback: (data: ChangeProgress) => void) => Unsubscribe
  cleanerRules: () => Promise<CleanerRule[]>
  cleanerScan: (id: string) => Promise<CleanerScanResult>
  cleanerScanCancel: (id?: string) => Promise<{ cancelled: boolean; count: number }>
  onCleanerScanProgress: (callback: (data: CleanerScanProgress) => void) => Unsubscribe
  cleanerSlimming: () => Promise<SlimmingItem[]>
  cleanerSlimmingStatus: () => Promise<MaintenanceStatus>
  cleanerSlimmingExecute: (input: { actionId: string; confirmation: string }) => Promise<MaintenanceJob>
  cleanerSlimmingHistory: () => Promise<MaintenanceJob[]>
  onCleanerSlimmingProgress: (callback: (data: MaintenanceProgress) => void) => Unsubscribe
  cleanerHistory: () => Promise<CleanupJobSummary[]>
  cleanerHistoryDetail: (id: string) => Promise<CleanupJob>
  cleanerHistoryClear: () => Promise<{ cleared: boolean }>
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
