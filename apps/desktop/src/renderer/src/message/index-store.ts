// renderer/src/message/index-store.ts
// 消息表 + 有序 id 列表：去重、有序插入、乐观 key 迁移。
//
// 这是此前 `message.store.ts` 里最纯粹的算法段（P0-1 的二分有序插入、I1 的 key 迁移竞态守卫），
// 但原先只能经 store 集成用例到达。下沉后边界（同序 tie-break、原位替换重排、旧 key 已被清）可直测。
//
// 与 Vue 的关系：本模块**不 import `vue`**——只读写调用方传进来的响应式对象。调用方保持
// 「整对象重新赋值」的写法（`order.value = sorted` 而不是 `order.value.sort(...)`），
// 以便无论载体是 `ref` 还是裸对象都得到相同的更新语义。
import type { Message } from '@shared/contracts'
import { cmpMsg } from '../utils/message-order'

/** 消息表载体：`message.store` 持有的两个响应式容器（`byId` / `order`）。 */
export interface MessageIndexState {
  byId: Record<string, Message>
  order: string[]
}

export interface MessageIndex {
  /**
   * 按 `messageId` 去重 + `(createdAt, messageId)` 升序二分插入（P0-1）。
   *
   * 新 key 插到第一个「不早于自己」的 key 之前（同序插其后，稳定）；已存在的 key 原位替换并按
   * 相同判据重排——权威 replay/REST 副本可能纠正乐观消息的 `createdAt`，重排后 tie-break 仍确定。
   */
  upsert(msg: Message): void
  /**
   * 乐观发送 key 迁移到 `serverMessageId`（P2-1）：同步 `byId`/`order` 两处 key 与
   * `msg.messageId` 本体。
   *
   * **I1 承重**：旧 key 已不在表里（会话被 `resetConversation` 清掉 / 已被别的路径迁移）时
   * 直接返回、**不重插**——否则一次跨会话的迟到 ACK 会把已清掉的消息塞回新会话列表。
   */
  migrateKey(oldKey: string, newKey: string, msg: Message): void
  /** 按 `(createdAt, messageId)` 稳定重排（批量加载后保序；流式单条 upsert 不受影响） */
  reorder(): void
  /** 最后一条带 `usage` 的助手消息的用量（当前会话「最近一轮」的派生口径） */
  lastTurnUsage(): Message['usage']
}

export function createMessageIndex(state: MessageIndexState): MessageIndex {
  function upsert(msg: Message): void {
    if (state.byId[msg.messageId] !== undefined) {
      state.byId[msg.messageId] = msg
      state.order = [...state.order].sort((left, right) => cmpMsg(state.byId[left], state.byId[right]))
      return
    }
    let lo = 0
    let hi = state.order.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (cmpMsg(state.byId[state.order[mid]], msg) <= 0) lo = mid + 1
      else hi = mid
    }
    state.order = [...state.order.slice(0, lo), msg.messageId, ...state.order.slice(lo)]
    state.byId[msg.messageId] = msg
  }

  function migrateKey(oldKey: string, newKey: string, msg: Message): void {
    if (state.byId[oldKey] === undefined) return   // I1：乐观消息已被清掉则不重插
    if (oldKey === newKey) return
    const index = state.order.indexOf(oldKey)
    if (index >= 0) {
      const next = [...state.order]
      next[index] = newKey
      state.order = next
    }
    delete state.byId[oldKey]
    msg.messageId = newKey
    state.byId[newKey] = msg
  }

  function reorder(): void {
    state.order = [...state.order].sort((x, y) => cmpMsg(state.byId[x], state.byId[y]))
  }

  function lastTurnUsage(): Message['usage'] {
    for (let i = state.order.length - 1; i >= 0; i--) {
      const message = state.byId[state.order[i]]
      if (message?.role === 'assistant' && message.usage) return message.usage
    }
    return undefined
  }

  return { upsert, migrateKey, reorder, lastTurnUsage }
}
