/**
 * 会话边界广播（UI/基础设施解耦缝）。
 *
 * 背景：会话切换时必须清空渲染层缓存（markdown HTML 缓存——防敏感内容跨会话驻留，
 * 安全判据 M-2）。此前 `message.store` 直接 import `utils/markdown` 的
 * `clearMarkdownCache()`，造成功能层反向依赖 UI 层：store 必须知道 UI 用哪个
 * renderer、有没有缓存、缓存 key 是什么。多套 UI / 换 renderer 时该耦合立即失效。
 *
 * 现在方向反转：功能层只播报「会话边界」这一领域事实，不关心谁在听；
 * 需要清理的渲染层缓存自行订阅。这样
 *   - 功能层（stores/）不再 import 任何 UI 模块；
 *   - 新增渲染缓存（换 renderer、加第二套 UI）只需自己订阅，不必改 store；
 *   - 安全语义不变：只要渲染模块被加载（即只要真的有 markdown 渲染发生），
 *     订阅即生效，会话切换必清空。
 *
 * 语义约定：通知在**偏离旧会话之后、进入新会话之前**同步派发；订阅者必须同步完成清理。
 */

export interface SessionBoundaryDetail {
  /** 被切换掉的会话 id；`undefined` = 从无会话状态进入（如断开后重连） */
  readonly previousConversationId: string | undefined
  /** 进入的会话 id；`undefined` = 退出到无会话状态 */
  readonly nextConversationId: string | undefined
}

export type SessionBoundarySubscriber = (detail: SessionBoundaryDetail) => void

const subscribers = new Set<SessionBoundarySubscriber>()

/** 订阅会话边界；返回退订函数。重复订阅同一函数是幂等的（Set 语义）。 */
export function subscribeSessionBoundary(fn: SessionBoundarySubscriber): () => void {
  subscribers.add(fn)
  return () => { subscribers.delete(fn) }
}

/**
 * 派发会话边界。
 * 单个订阅者抛错不得中断其余订阅者、也不得中断发起切换的 store 流程——
 * 但错误必须可见（不静默吞），交由调用方/控制台暴露。
 */
export function emitSessionBoundary(detail: SessionBoundaryDetail): void {
  for (const fn of [...subscribers]) {
    try {
      fn(detail)
    } catch (cause) {
      console.error('[session-boundary] subscriber failed', cause)
    }
  }
}

/** 仅供测试：清空订阅表，避免跨用例泄漏。 */
export function resetSessionBoundarySubscribers(): void {
  subscribers.clear()
}
