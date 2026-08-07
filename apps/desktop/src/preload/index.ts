import { contextBridge } from 'electron'
import { desktopApi } from './desktop-api'

// 只暴露具名、窄接口;不暴露 ipcRenderer、Node 模块或任意通道
contextBridge.exposeInMainWorld('desktopApi', desktopApi)
