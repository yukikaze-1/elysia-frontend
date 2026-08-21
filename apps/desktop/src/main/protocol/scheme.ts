// apps/desktop/src/main/protocol/scheme.ts
import { protocol } from 'electron'
import { PROTOCOL_SCHEME } from './constants'

export { PROTOCOL_SCHEME, RENDERER_HOST } from './constants' // 从 constants 再导出，保持既有引用路径

// 必须在 app ready 前调用（main() 最前）
export function registerCyreneScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        // 阶段 5 D-4 已实验确认：放开后非受信 origin 也能读取 cyrene:// 资源，
        // 安全上不可接受，必须保持 false。dev 页面跨源 fetch cyrene:// 因此为
        // 已知限制；真实联调/运行一律走 preview/prod 同源（cyrene://renderer）。
        corsEnabled: false,
        bypassCSP: false
      }
    }
  ])
}
