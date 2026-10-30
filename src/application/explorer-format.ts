export function formatModified(value: number) {
  if (!value) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(new Date(value))
}

export function formatRelativeModified(value: number) {
  if (!value) return '时间未知'
  const elapsed = Math.max(0, Date.now() - value)
  if (elapsed < 60_000) return '刚刚'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`
  if (elapsed < 7 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)} 天前`
  if (elapsed < 30 * 86_400_000) return `${Math.floor(elapsed / (7 * 86_400_000))} 周前`
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value))
}

export function formatRelativeTime(value: string) {
  const elapsed = Date.now() - new Date(value).getTime()
  if (elapsed < 60_000) return '刚刚'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`
  return `${Math.floor(elapsed / 86_400_000)} 天前`
}

export function fileTypeLabel(extension: string) {
  const knownTypes: Record<string, string> = {
    '.lnk': '快捷方式',
    '.url': '网页快捷方式',
    '.exe': '应用程序',
    '.msi': '安装程序',
    '.msix': '应用安装包',
    '.appx': '应用安装包'
  }
  return knownTypes[extension.toLowerCase()]
    || (extension ? `${extension.slice(1).toUpperCase()} 文件` : '文件')
}
