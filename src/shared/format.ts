export function formatBytes(value: number | null | undefined): string {
  let bytes = Number(value || 0)
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`

  const units = ['KB', 'MB', 'GB', 'TB']
  let index = -1
  do {
    bytes /= 1024
    index += 1
  } while (bytes >= 1024 && index < units.length - 1)

  const digits = bytes >= 100 ? 0 : bytes >= 10 ? 1 : 2
  return `${bytes.toFixed(digits)} ${units[index]}`
}

export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (!value) return '尚未记录'
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString()
}

export function percent(value: number | null | undefined): string {
  const normalized = Math.max(0, Math.min(1, Number(value || 0)))
  return `${Math.round(normalized * 100)}%`
}
