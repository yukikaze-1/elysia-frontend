import type { AppInfo } from '@shared/contracts'

/**
 * 具名 Desktop API(Phase 0 占位)。
 * Phase 1 将改为通过 contextBridge 暴露、经 Main 具名 IPC 与 Schema 校验实现;
 * Renderer 永远拿不到原始 ipcRenderer / Node 能力。
 */
const appInfo: AppInfo = {
  name: 'Cyrene',
  version: '0.1.0',
  platform: process.platform
}

export const desktopApi = {
  getAppInfo: (): Promise<AppInfo> => Promise.resolve(appInfo)
}

export type DesktopApi = typeof desktopApi
