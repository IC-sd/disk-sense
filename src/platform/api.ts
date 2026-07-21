export interface DesktopApi { scan: () => Promise<any>; state: () => Promise<any>; diagnostics: () => Promise<any> }
export function desktopApi(): DesktopApi | null { return (window as any).diskSense || null }
