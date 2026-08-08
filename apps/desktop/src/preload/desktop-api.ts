// apps/desktop/src/preload/desktop-api.ts
import { ipcRenderer } from 'electron'
import { IpcChannels, type IpcChannelName, type IpcResult } from '@shared/contracts'
import type { AppInfo } from '@shared/contracts'

async function invoke<T>(channel: IpcChannelName): Promise<IpcResult<T>> {
  try {
    return (await ipcRenderer.invoke(channel)) as IpcResult<T>
  } catch {
    throw new Error('[IPC_ERROR] IPC 调用失败')
  }
}

function isAppInfo(v: unknown): v is AppInfo {
  return !!v && typeof v === 'object' && !Array.isArray(v) &&
    typeof (v as AppInfo).name === 'string' && typeof (v as AppInfo).version === 'string' &&
    typeof (v as AppInfo).platform === 'string'
}

export const desktopApi = {
  getAppInfo: async (): Promise<AppInfo> => {
    const res = await invoke<AppInfo>(IpcChannels.appGetInfo)
    // 完整信封守卫：res 必须先判为对象（非信封值不崩 res.ok）；ok:true 且 data 为 AppInfo；ok:false 带 error{code,message}
    if (res && typeof res === 'object' && res.ok === true && res.data !== undefined && res.data !== null && isAppInfo(res.data)) return res.data
    if (res && typeof res === 'object' && res.ok === false &&
        res.error && typeof res.error.code === 'string' && typeof res.error.message === 'string') {
      throw new Error(`[${res.error.code}] ${res.error.message}`)
    }
    throw new Error('[IPC_ERROR] IPC 返回格式异常')
  }
}

export type DesktopApi = typeof desktopApi
