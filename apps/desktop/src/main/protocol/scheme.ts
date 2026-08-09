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
        corsEnabled: false,
        bypassCSP: false
      }
    }
  ])
}
