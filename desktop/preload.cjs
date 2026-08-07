const { contextBridge, ipcRenderer } = require('electron')

function subscribe(channel, callback) {
  const listener = (_event, data) => callback(data)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const bridge = {
  overviewGet: () => ipcRenderer.invoke('overview:get'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  appDataUsage: () => ipcRenderer.invoke('app:data-usage'),
  appAppearanceGet: () => ipcRenderer.invoke('app:appearance:get'),
  appAppearanceSet: input => ipcRenderer.invoke('app:appearance:set', input),
  appDeviceInfo: () => ipcRenderer.invoke('app:device-info'),
  appOpenDataDirectory: () => ipcRenderer.invoke('app:open-data-directory'),
  appOpenInstallDirectory: () => ipcRenderer.invoke('app:open-install-directory'),
  appMoveDataDirectory: () => ipcRenderer.invoke('app:data-directory:move'),
  appRestart: () => ipcRenderer.invoke('app:restart'),

  changesState: () => ipcRenderer.invoke('changes:state'),
  changesBaseline: () => ipcRenderer.invoke('changes:baseline'),
  changesScan: () => ipcRenderer.invoke('changes:scan'),
  changesCancel: () => ipcRenderer.invoke('changes:cancel'),
  onChangesProgress: callback => subscribe('changes:progress', callback),

  inspectList: dir => ipcRenderer.invoke('inspect:list', dir),
  inspectHydrate: paths => ipcRenderer.invoke('inspect:hydrate', paths),
  inspectEstimate: dir => ipcRenderer.invoke('inspect:estimate', dir),
  inspectExplain: file => ipcRenderer.invoke('inspect:explain', file),
  inspectIndexStatus: () => ipcRenderer.invoke('inspect:index-status'),
  inspectIndexStart: input => ipcRenderer.invoke('inspect:index-start', input),
  inspectIndexCancel: () => ipcRenderer.invoke('inspect:index-cancel'),
  inspectSearch: input => ipcRenderer.invoke('inspect:search', input),
  inspectFilePresentations: paths => ipcRenderer.invoke('inspect:file-presentations', paths),
  onInspectIndexProgress: callback => subscribe('inspect:index-progress', callback),

  aiStatus: () => ipcRenderer.invoke('analysis:ai-status'),
  aiConfigGet: () => ipcRenderer.invoke('analysis:ai-config:get'),
  aiConfigSave: input => ipcRenderer.invoke('analysis:ai-config:save', input),
  aiConfigClear: () => ipcRenderer.invoke('analysis:ai-config:clear'),
  aiModels: draft => ipcRenderer.invoke('analysis:ai-models', draft),
  aiTest: draft => ipcRenderer.invoke('analysis:ai-test', draft),
  aiReview: request => ipcRenderer.invoke('analysis:ai-review', request),
  aiAnalysisGet: request => ipcRenderer.invoke('analysis:ai-record:get', request),
  aiAnalysisSave: request => ipcRenderer.invoke('analysis:ai-record:save', request),

  cleanerRules: () => ipcRenderer.invoke('cleaner:rules'),
  cleanerScan: id => ipcRenderer.invoke('cleaner:scan', id),
  cleanerScanCancel: id => ipcRenderer.invoke('cleaner:scan-cancel', id),
  onCleanerScanProgress: callback => subscribe('cleaner:scan-progress', callback),
  cleanerSlimming: () => ipcRenderer.invoke('cleaner:slimming'),
  cleanerSlimmingStatus: () => ipcRenderer.invoke('cleaner:slimming-status'),
  cleanerSlimmingExecute: input => ipcRenderer.invoke('cleaner:slimming-execute', input),
  cleanerSlimmingHistory: () => ipcRenderer.invoke('cleaner:slimming-history'),
  onCleanerSlimmingProgress: callback => subscribe('cleaner:slimming-progress', callback),
  cleanerHistory: () => ipcRenderer.invoke('cleaner:history'),
  cleanerHistoryDetail: id => ipcRenderer.invoke('cleaner:history-detail', id),
  cleanerHistoryClear: () => ipcRenderer.invoke('cleaner:history-clear'),
  cleanerExclusions: () => ipcRenderer.invoke('cleaner:exclusions'),
  cleanerExclusionAdd: input => ipcRenderer.invoke('cleaner:exclusion-add', input),
  cleanerExclusionRemove: id => ipcRenderer.invoke('cleaner:exclusion-remove', id),
  cleanerExecute: files => ipcRenderer.invoke('cleaner:execute', files),
  cleanerCancel: () => ipcRenderer.invoke('cleaner:cancel'),
  onCleanerExecuteProgress: callback => subscribe('cleaner:execute-progress', callback)
}

if (process.argv.includes('--disk-sense-smoke')) {
  bridge.smokeCapture = () => ipcRenderer.invoke('smoke:capture')
}

contextBridge.exposeInMainWorld('diskSense', bridge)
