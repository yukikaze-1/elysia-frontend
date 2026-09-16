// renderer/src/message/fencing.ts
// 消息传输栅栏与会话归属：连接世代签名 + 按代捕获的会话身份 + 请求 owner 台账。
//
// 为什么抽出来：这是聊天 Renderer 最高风险的一段——「会话 A 的响应晚到污染 B」「上一代 delta 迟到
// 复活已取消的回复」两类缺陷的唯一防线。原先它以 6 个散落的闭包变量 + `generationSessionMatches`
// 谓词的形式存在于 store 里，只有整套 store 集成用例能到达；下沉后「同一会话、不同连接世代」
// 「同一连接、不同会话」「owner 已被取代」这三种边界可以直接钉住。
//
// 本模块**不 import `vue` / `pinia`**：它只接收连接状态的快照（值语义），不订阅响应性。
import type { ConnectionState } from '@shared/contracts'

/**
 * 传输世代签名。
 *
 * `activeConversationId` **刻意排除**：它是聊天选中项，不是传输转世。而
 * status / endpoint / connectionId / 协议版本 / 能力集合（角色档与角色态流）任一变化
 * 都意味着「另一条消息事件流」——包括 `connected(A) → connected(B)` 这种中间没有观察到
 * 断线状态的直接切换。
 */
export function connectionSignatureFor(state: ConnectionState): string {
  return JSON.stringify([
    state.status,
    state.serverUrl ?? null,
    state.connectionId ?? null,
    state.protocolVersion ?? null,
    state.features?.characterProfiles === true,
    state.features?.characterStateStream === true
  ])
}

/** 一次请求/一代生成被绑定的会话身份：会话 id + 捕获时的传输世代。 */
export interface GenerationSessionIdentity {
  conversationId: string
  connectionEpoch: number
  connectionSignature: string
}/**
 * 请求 owner 台账。
 *
 * 五条异步路径（send / voice-commit / resend+regenerate / loadOlder / loadEarlier / loadContext）
 * 共享公开的忙标志或游标，故「发起时占位、settle 时只释放仍属于自己的那一个」是必需的：
 * 一个过期的 settle 不得解锁或改写其后新请求的状态。
 *
 * 会话切换 / 连接换世代 / 快照载入时 `revokeAll()` 会一次性作废所有 owner，使新会话可以立即
 * 发起请求，而旧请求的 finally 因 owner 已变而不会误释放它。
 */
export interface RequestOwners {
  /** 登记一次请求并返回它的 owner 令牌。 */
  acquire(): symbol
  /** 该 owner 是否仍是当前登记的那个（被 revoke 或已被新请求取代 ⇒ false）。 */
  isCurrent(owner: symbol): boolean
  /** 仅当代 owner 是自己时释放（幂等：被 revoke 后再调用不会清掉新请求的登记）。 */
  release(owner: symbol): void
  /** 作废全部在途登记（会话切换 / 连接换世代 / 重放栅栏）。 */
  revokeAll(): void
}

export function createRequestOwners(): RequestOwners {
  let current: symbol | undefined
  return {
    acquire(): symbol {
      const token = Symbol('message-request')
      current = token
      return token
    },
    isCurrent: (owner) => current === owner,
    release(owner) {
      if (current === owner) current = undefined
    },
    revokeAll() {
      current = undefined
    }
  }
}

/**
 * 捕获的会话身份是否仍等于**当前**会话身份。
 *
 * 三个字段必须同时成立：只比会话 id 挡不住 `connected(A) → connected(B)`（同一个会话 id 存在于
 * 两个后端上），只比传输世代挡不住会话切换。
 *
 * **唯一的身份台账在 store**（`generationSessionById` 响应式表）。本模块只给判据、不另存一份：
 * 早先版本在模块内又放了一张 `generationId → 身份` 的表，于是同一个事实有了两处存储，而两条栅栏
 * 路径（换连接世代 / 会话切换）只清 store 那份——注册表会累积永不清空的残留，且模块的
 * `matchesCurrent` 与 store 的守卫对「这一代属于谁」给出两个可以分别编辑的答案。
 */
export function generationSessionMatches(
  captured: GenerationSessionIdentity,
  live: GenerationSessionIdentity
): boolean {
  return captured.conversationId === live.conversationId
    && captured.connectionEpoch === live.connectionEpoch
    && captured.connectionSignature === live.connectionSignature
}
