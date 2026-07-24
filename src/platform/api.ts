import type {
  AiConfigDraft,
  AiConfigStatus,
  AiModelOption,
  AiReviewResult,
  AnalysisMode,
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
  DirectoryListResult,
  FileExplanation,
  OverviewSummary,
  SlimmingItem
} from '../domain/desktop'

type Unsubscribe = () => void

export interface DesktopApi {
  overviewGet: () => Promise<OverviewSummary>
  appInfo: () => Promise<AppInfo>
  appOpenDataDirectory: () => Promise<{ opened: boolean }>
  inspectList: (dir?: string) => Promise<DirectoryListResult>
  inspectEstimate: (dir: string) => Promise<DirectoryEstimate>
  inspectExplain: (filePath: string) => Promise<FileExplanation>
  aiStatus: () => Promise<AiConfigStatus>
  aiConfigGet: () => Promise<AiConfigStatus>
  aiConfigSave: (input: AiConfigDraft) => Promise<AiConfigStatus>
  aiConfigClear: () => Promise<AiConfigStatus>
  aiModels: (draft: Partial<AiConfigDraft>) => Promise<{ ok: boolean; reason?: string; models: AiModelOption[] }>
  aiTest: (draft: AiConfigDraft) => Promise<{ ok: boolean; reason?: string; model?: string }>
  aiReview: (request: { evidence: unknown; mode: AnalysisMode }) => Promise<AiReviewResult>
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
