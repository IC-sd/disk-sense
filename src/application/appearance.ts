import type { AppTheme } from '../domain/desktop'

const STORAGE_KEY = 'disk-sense-theme'

export function normalizeTheme(value: unknown): AppTheme {
  return value === 'light' ? 'light' : 'dark'
}

export function cachedTheme(): AppTheme {
  try {
    return normalizeTheme(localStorage.getItem(STORAGE_KEY))
  } catch {
    return 'dark'
  }
}

export function applyTheme(theme: AppTheme, remember = true) {
  const normalized = normalizeTheme(theme)
  document.documentElement.dataset.theme = normalized
  document.documentElement.style.colorScheme = normalized
  if (remember) {
    try {
      localStorage.setItem(STORAGE_KEY, normalized)
    } catch {
      // The persisted desktop state remains authoritative if storage is unavailable.
    }
  }
  return normalized
}
