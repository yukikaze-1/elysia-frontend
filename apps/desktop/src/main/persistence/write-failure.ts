// src/main/persistence/write-failure.ts
// 本地写失败的结构化（H-11b renderer 半边 2026-09-13 从 session-store 提取；M-19 复用同一份判据）。
//
// 背景（两处各自实测过同一症状）：`atomicWriteFile` 的原始错误直接上抛时，经 `createIpcHandler`
// 的兜底分支会变成 `{ code: 'UNKNOWN', message: '内部错误' }` —— Renderer 既分不清"降级拒绝写入"
// 与"磁盘满/权限不足"，也拿不到任何可展示的原因，于是持久化失败在 UI 上就是"什么都没有"
// （评审 M-19 同族症状：设置保存失败不可见）。
//
// 纪律：**只取 errno 码**（`ENOSPC`/`EACCES`/`EROFS`…），绝不把 fs 错误原文或路径带出去
// ——Main 是路径边界，Renderer 不得收到绝对本地路径。
import { CyreneError, CyreneErrorCode } from '@shared/errors'

/**
 * 把写失败转成**无路径**的公开错误码。
 *
 * @param err  原始错误（fs 层或 `atomicWriteFile` 抛出的）
 * @param code 目标公开码，默认 `PERSISTENCE_WRITE_FAILED`（会话草稿/缓存域）；设置域传
 *             `SETTINGS_SAVE_FAILED`，让 UI 能给出与"草稿没存住"不同的措辞。
 */
export function toWriteFailure(err: unknown, code: CyreneErrorCode = CyreneErrorCode.PERSISTENCE_WRITE_FAILED): unknown {
  if (err instanceof CyreneError) return err   // 已有语义码（DRAFT_LIMIT_EXCEEDED / IPC_MESSAGE_TOO_LARGE / PERSISTENCE_DEGRADED…）不覆盖
  const raw = (err as NodeJS.ErrnoException | undefined)?.code
  const errno = typeof raw === 'string' && /^[A-Z0-9_]{1,32}$/.test(raw) ? raw : undefined
  return new CyreneError(code, errno === undefined ? '本地保存失败' : `本地保存失败（${errno}）`)
}
