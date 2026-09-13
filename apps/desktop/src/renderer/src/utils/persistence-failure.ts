// src/renderer/src/utils/persistence-failure.ts
// 本地持久化故障的**共享形态与状态转移**（2026-09-13）。
//
// 为什么抽出来：这条规则此前只写在 `draft.store` 里（H-11b renderer 半边落地时），而同一个
// `SessionStore` 还负责 `message-cache-v1.json`（消息快照）——`cache.store.pushMessages` 的失败
// 一直是 fire-and-forget 的静默 catch（评审 M-19 同族："失败以什么都没有的形式到达用户"）。
// 现在两个 store 各自持有本域的状态（不互相写对方的 store，store 之间无新增依赖边），
// 但**转移规则只有这一份**：失败即置位 + 保留上一次的 file/reason，成功只清"单次失败"、
// **不清不可自愈的降级**。
import { parsePublicError } from './public-error'

/**
 * 本地持久化故障。
 *
 * `code` 为 IPC 公开错误码（UI 经 `errorMessage()` 取文案，store 不产出用户措辞）；
 * `file`/`reason` 只在降级态有值，来自 Main 的无路径投影（基名 + 封闭标签）。
 */
export interface PersistenceFailure {
  code: string
  file?: string
  reason?: string
}

/** 由跨进程错误构造故障态（解析 `[code] message` 前缀，不显示原文措辞） */
export function failureFromError(error: unknown): PersistenceFailure {
  const parsed = parsePublicError(error instanceof Error ? error.message : String(error))
  return { code: parsed.code }
}

/**
 * 置位：已有 file/reason（来自水合的降级投影）时必须保留——后续的单次失败只补充/覆盖 code，
 * 不该把"哪个文件、什么原因"这两条最有用的信息抹掉。
 */
export function applyPersistenceFailure(_current: PersistenceFailure | undefined, error: unknown): PersistenceFailure {
  return failureFromError(error)
}

/**
 * 成功写回时清除：**降级态是 Main 侧的持续条件（本进程内不可自愈）**，只能由 hydrate 改变；
 * 若在这里一并清掉，UI 会在"拒绝写入 → 显示 → 下一次尝试又清掉"之间闪烁。
 */
export function clearPersistenceFailure(current: PersistenceFailure | undefined): PersistenceFailure | undefined {
  return current?.code === 'PERSISTENCE_DEGRADED' ? current : undefined
}
