// src/main/windows/mic-permission.ts
// 阶段 4 批次 B（spec D-P7）：麦克风权限——纯 Node（无 electron import，可 node 环境单测）。
// 策略：仅 'media' 权限、非 video、且 requesting origin/URL 为受信 Renderer（cyrene://renderer 或 dev 回环/白名单 http）才放行；
// 复用 trusted-renderer-origin 既有 isAppRendererUrl（不新建 isTrustedRendererOrigin）。setPermissionCheckHandler（check）
// 的 details 是 PermissionCheckHandlerHandlerDetails（mediaType 单数）；setPermissionRequestHandler（request）
// 的 details 是 MediaAccessPermissionRequest（mediaTypes 复数数组）——二者统一归一为 opts 输入。
import { getTrustedDevOrigins, isAppRendererUrl } from '../config/trusted-renderer-origin'

export interface DecideMicrophoneAllowOpts {
  permission: string
  /** check handler details.mediaType（单数 'video' | 'audio' | 'unknown'） */
  mediaType?: string
  /** request handler details.mediaTypes（复数数组，Electron MediaAccessPermissionRequest） */
  mediaTypes?: ReadonlyArray<string>
  /** check: requestingOrigin；request: details.requestingUrl */
  url: string
  trusted: ReadonlySet<string>
}

/** 可测纯决策：非 media → false；video（含数组）→ false；非受信 origin → false；audio + 受信 origin → true */
export function decideMicrophoneAllow(opts: DecideMicrophoneAllowOpts): boolean {
  if (opts.permission !== 'media') return false
  if (opts.mediaType === 'video') return false
  if (opts.mediaTypes?.includes('video')) return false
  return isAppRendererUrl(opts.url, opts.trusted)
}

/** 装配两种 session 权限处理器（check + request）。ses 结构化入参（含 defaultSession），可在单测用假 session 验证接线。 */
export interface PermissionSessionLike {
  setPermissionCheckHandler(handler: (webContents: unknown, permission: string, requestingOrigin: string, details: { mediaType?: string }) => boolean): void
  setPermissionRequestHandler(handler: (webContents: unknown, permission: string, callback: (granted: boolean) => void, details: { requestingUrl: string; mediaTypes?: ReadonlyArray<string> }) => void): void
}

export function registerMicrophonePermission(ses: PermissionSessionLike): void {
  const trusted = getTrustedDevOrigins()
  ses.setPermissionCheckHandler((_wc, permission, origin, details) =>
    decideMicrophoneAllow({ permission, mediaType: details.mediaType, url: origin, trusted }))
  ses.setPermissionRequestHandler((_wc, permission, callback, details) =>
    callback(decideMicrophoneAllow({ permission, mediaTypes: details.mediaTypes, url: details.requestingUrl, trusted })))
}
