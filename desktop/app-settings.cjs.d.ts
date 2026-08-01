export interface DataLocation {
  defaultUserDataPath: string
  userDataPath: string
  pointerFile: string | null
  externallyManaged: boolean
}

export interface DirectoryUsage {
  bytes: number
  files: number
  directories: number
  inaccessible: number
  truncated: boolean
}

export function normalizeTheme(value: unknown): 'dark' | 'light'
export function resolveDataLocation(input: {
  appDataPath: string
  environment?: Record<string, string | undefined>
}): DataLocation
export function directoryUsage(root: string, maximumEntries?: number): Promise<DirectoryUsage>
export function migrationTarget(selectedDirectory: string): string
export function finalizePendingMigration(target: string): {
  finalized: boolean
  synchronized?: string[]
  error?: string
}
export function migrateDataDirectory(input: {
  source: string
  selectedDirectory: string
  pointerFile: string | null
  forbiddenPaths?: string[]
}): Promise<{
  changed: boolean
  source: string
  target: string
  copiedFiles?: string[]
  copiedBytes?: number
  restartRequired?: boolean
  sourceRetained?: boolean
}>
