import type { CleanerFile, CleanerScanResult } from '../domain/desktop'

// The Windows scanner supplies canonical names. Keep one registered candidate
// per pathname; inode equality alone must not merge different hard-link names.
export function cleanerFileKey(file: CleanerFile) {
  return (file.canonicalPath || file.path).replaceAll('/', '\\').toLowerCase()
}

export function uniqueCleanerFiles(files: CleanerFile[]) {
  const seen = new Set<string>()
  return files.filter(file => {
    const key = cleanerFileKey(file)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function cleanerCoverageLabel(result: CleanerScanResult) {
  const status = result.coverage?.status
  if (status === 'partial') return '部分扫描'
  if (status === 'unavailable') return '未能读取'
  if (status === 'not-found') return '未发现规则位置'
  if (status === 'excluded') return '已按排除项跳过'
  if (status === 'complete') return '扫描完成'
  return result.truncated ? '部分扫描' : '扫描结束'
}

export function cleanerIssueLabel(code: string) {
  if (code === 'TOOL_CONFIG_UNCONFIRMED') return '工具缓存配置未能确认'
  if (code === 'DISCOVERY_DEPTH_LIMIT') return '应用位置搜索已达到深度上限'
  if (code === 'DISCOVERY_DIRECTORY_LIMIT') return '应用位置搜索已达到目录数量上限'
  if (code === 'DISCOVERY_ENTRY_LIMIT') return '应用位置搜索已达到检查数量上限'
  if (code === 'DISCOVERY_TIME_LIMIT') return '应用位置搜索已达到时间上限'
  if (['EACCES', 'EPERM'].includes(code)) return '无权读取'
  if (['ENOENT', 'ENOTDIR'].includes(code)) return '扫描时位置发生变化'
  if (['EMFILE', 'ENFILE'].includes(code)) return '系统打开文件数量达到上限'
  if (code.startsWith('UNSAFE_')) return '文件或目录类型不符合规则，已跳过'
  if (code === 'OUTSIDE_ROOT') return '实际位置超出规则范围，已跳过'
  return '未能读取'
}
