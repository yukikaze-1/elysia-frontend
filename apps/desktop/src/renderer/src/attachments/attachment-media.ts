// src/renderer/src/attachments/attachment-media.ts
// 阶段 3 G3（spec §4.7/D6）：媒体占位「重试/刷新」决策纯函数——重查 ok → 重挂载（重新 resolve 签名/媒体）；
// 否则沿用最新状态文案。纯逻辑无 Vue/API 依赖，便于单测。
import type { AttachmentCheckResult, AttachmentMediaStatus } from '@shared/contracts'

export type RetryDecision = 'remount' | AttachmentMediaStatus

/** P1-2：占位「重试/刷新」结果决策——recheck ok → 'remount'（父组件重挂载媒体元素，Main 重新 resolve/重签）；
 *  否则返回最新状态（expired/not_found/revoked/error），占位文案随之更新 */
export function retryDecision(recheck: AttachmentCheckResult): RetryDecision {
  return recheck.status === 'ok' ? 'remount' : recheck.status
}
