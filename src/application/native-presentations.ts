import { ref } from 'vue'
import { desktopApi } from '../platform/api'
import type { DirectoryItem, NativeFilePresentation } from '../domain/desktop'

export function useNativePresentations(active: () => boolean, visible: () => DirectoryItem[]) {
  const cache = ref<Record<string, NativeFilePresentation>>({})
  const pending = new Set<string>()
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const nativePresentation = (filePath: string) => cache.value[filePath.toLowerCase()]
  async function load() {
    if (!active()) return
    const api = desktopApi()
    if (!api?.inspectFilePresentations) return
    const paths = visible().map(item => item.path)
      .filter(file => !nativePresentation(file) && !pending.has(file.toLowerCase())).slice(0, 32)
    if (!paths.length) return
    const requestGeneration = generation
    paths.forEach(file => pending.add(file.toLowerCase()))
    try {
      const loaded = await api.inspectFilePresentations(paths)
      if (requestGeneration !== generation || !active()) return
      const next = new Map(Object.entries(cache.value))
      for (const [file, presentation] of Object.entries(loaded)) {
        if (presentation.dataUrl?.startsWith('data:image/') || presentation.displayName) {
          const key = file.toLowerCase()
          next.delete(key); next.set(key, presentation)
        }
      }
      while (next.size > 600) next.delete(next.keys().next().value as string)
      cache.value = Object.fromEntries(next)
    } catch { /* Icon availability never blocks a file action or search. */ }
    finally {
      if (requestGeneration === generation) paths.forEach(file => pending.delete(file.toLowerCase()))
    }
  }
  return {
    nativePresentation,
    nativeIcon: (file: string) => nativePresentation(file)?.dataUrl || '',
    scheduleNativeIconLoad() {
      if (!active()) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; void load() }, 45)
    },
    stop() { generation++; if (timer) clearTimeout(timer); timer = null; pending.clear() }
  }
}
