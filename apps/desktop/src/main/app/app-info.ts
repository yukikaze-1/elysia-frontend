import { app } from 'electron'
import type { AppInfo } from '@shared/contracts'

export function getAppInfo(): AppInfo {
  return { name: 'Cyrene', version: app.getVersion(), platform: process.platform }
}
