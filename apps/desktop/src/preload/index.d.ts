import type { AppInfo } from '@shared/contracts'

declare global {
  interface Window {
    desktopApi: {
      getAppInfo(): Promise<AppInfo>
    }
  }
}

export {}
