import type { DesktopApi } from './platform/api'

declare global {
  interface Window {
    diskSense?: DesktopApi
  }
}

export {}
