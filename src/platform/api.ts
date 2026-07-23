export interface DesktopApi {
  scan: () => Promise<any>
  state: () => Promise<any>
  diagnostics: () => Promise<any>
  inspectList: (dir?: string) => Promise<any>
  inspectExplain: (filePath: string) => Promise<any>
  aiStatus: () => Promise<any>
  aiConfigGet: () => Promise<any>
  aiConfigSave: (input: any) => Promise<any>
  aiConfigClear: () => Promise<any>
  aiModels: (draft: any) => Promise<any>
  aiTest: (draft: any) => Promise<any>
  aiReview: (evidence: any) => Promise<any>
  scanStart: () => Promise<any>
  scanCancel: () => Promise<any>
  onScanProgress: (callback: (data: any) => void) => void
  onScanComplete: (callback: (data: any) => void) => void
  onScanError: (callback: (data: any) => void) => void
  changesState: () => Promise<any>
  changesBaseline: () => Promise<any>
  changesScan: () => Promise<any>
  changesCancel: () => Promise<any>
  onChangesProgress: (callback: (data: any) => void) => void
}
export function desktopApi(): DesktopApi | null { return (window as any).diskSense || null }
