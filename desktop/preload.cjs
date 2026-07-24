const { contextBridge, ipcRenderer } = require('electron')

function subscribe(channel, callback) {
  const listener = (_event, data) => callback(data)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('diskSense', {
  overviewGet: () => ipcRenderer.invoke('overview:get'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  appOpenDataDirectory: () => ipcRenderer.invoke('app:open-data-directory'),

  changesState: () => ipcRenderer.invoke('changes:state'),
  changesBaseline: () => ipcRenderer.invoke('changes:baseline'),
  changesScan: () => ipcRenderer.invoke('changes:scan'),
  changesCancel: () => ipcRenderer.invoke('changes:cancel'),
  onChangesProgress: callback => subscribe('changes:progress', callback),

  inspectList: dir => ipcRenderer.invoke('inspect:list', dir),
  inspectEstimate: dir => ipcRenderer.invoke('inspect:estimate', dir),
  inspectExplain: file => ipcRenderer.invoke('inspect:explain', file),

  aiStatus: () => ipcRenderer.invoke('analysis:ai-status'),
  aiConfigGet: () => ipcRenderer.invoke('analysis:ai-config:get'),
  aiConfigSave: input => ipcRenderer.invoke('analysis:ai-config:save', input),
  aiConfigClear: () => ipcRenderer.invoke('analysis:ai-config:clear'),
  aiModels: draft => ipcRenderer.invoke('analysis:ai-models', draft),
  aiTest: draft => ipcRenderer.invoke('analysis:ai-test', draft),
  aiReview: request => ipcRenderer.invoke('analysis:ai-review', request),

  cleanerRules: () => ipcRenderer.invoke('cleaner:rules'),
  cleanerScan: id => ipcRenderer.invoke('cleaner:scan', id),
  cleanerScanCancel: id => ipcRenderer.invoke('cleaner:scan-cancel', id),
  onCleanerScanProgress: callback => subscribe('cleaner:scan-progress', callback),
  cleanerSlimming: () => ipcRenderer.invoke('cleaner:slimming'),
  cleanerHistory: () => ipcRenderer.invoke('cleaner:history'),
  cleanerHistoryDetail: id => ipcRenderer.invoke('cleaner:history-detail', id),
  cleanerHistoryClear: () => ipcRenderer.invoke('cleaner:history-clear'),
  cleanerExclusions: () => ipcRenderer.invoke('cleaner:exclusions'),
  cleanerExclusionAdd: input => ipcRenderer.invoke('cleaner:exclusion-add', input),
  cleanerExclusionRemove: id => ipcRenderer.invoke('cleaner:exclusion-remove', id),
  cleanerExecute: files => ipcRenderer.invoke('cleaner:execute', files),
  cleanerCancel: () => ipcRenderer.invoke('cleaner:cancel'),
  onCleanerExecuteProgress: callback => subscribe('cleaner:execute-progress', callback)
})
