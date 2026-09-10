// 离线缓存内存态（spec §4.1/§4.5 D2）：启动水合离线视图 + 已确认消息快照分片推送。
// Main 是持久化边界：会话列表缓存由 Main 在 listConversations 服务时派生，消息快照由本 store 推送。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { MAX_IPC_MESSAGE_BYTES, type Conversation, type Message, type SessionPersistenceState } from '@shared/contracts'
import { api } from './desktop-api'
import { cloneValue } from '@shared/domain'

export const CACHE_PUSH_CHUNK = 200

function estBytes(s: string): number { return new TextEncoder().encode(s).byteLength }
function msgBytes(m: Message): number {
  let n = 200 // 元数据近似
  n += estBytes(m.content ?? '')
  for (const seg of m.assistantSegments ?? []) n += estBytes(seg.text ?? '')
  return n
}

/** 分片（P1-2）：先按条数 ≤200，再按字节预算拆；单条超限整条跳过（Main 侧另有整批拒绝兜底 IPC_MESSAGE_TOO_LARGE） */
export function chunkMessages(messages: Message[], maxBytes: number): Message[][] {
  const chunks: Message[][] = []
  let cur: Message[] = []
  let curBytes = 0
  for (const m of messages) {
    const b = msgBytes(m)
    if (b > maxBytes) continue // 罕见超大消息：跳过 + 计数由调用侧告警
    if (cur.length >= CACHE_PUSH_CHUNK || curBytes + b > maxBytes) {
      if (cur.length) { chunks.push(cur); cur = []; curBytes = 0 }
    }
    cur.push(m)
    curBytes += b
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

export const useCacheStore = defineStore('cache', () => {
  const conversations = ref<Conversation[]>([])
  const snapshots = ref<Record<string, Message[]>>({})
  const lastActiveConversationId = ref<string>()
  const hydrated = ref(false)

  function hydrate(state: SessionPersistenceState): void {
    conversations.value = cloneValue(state.conversations)
    snapshots.value = cloneValue(state.messageSnapshots)
    lastActiveConversationId.value = state.lastActiveConversationId
    hydrated.value = true
  }

  /** 已确认消息增量推送（loadPage / generation.completed / send ack 后调用）；best-effort fail-open。
   * `guard` 由消息域在存在 transport/session fence 时传入；它只阻止
   * 过期请求继续发起下一片或合并内存快照，不改变 cache store 的公开
   * IPC 形状，也保留无 guard 的 legacy 调用语义。 */
  async function pushMessages(
    conversationId: string,
    messages: Message[],
    updatedAt: string,
    options?: { guard?: () => boolean }
  ): Promise<void> {
    if (options?.guard && !options.guard()) return
    // 在第一个 await 之前建立调用方输入的完整快照；否则调用方在 IPC
    // 等待期间修改 assistantSegments/character，会同时改变待发 chunk。
    const inputSnapshot = cloneValue(messages)
    const chunks = chunkMessages(inputSnapshot, MAX_IPC_MESSAGE_BYTES)
    for (const chunk of chunks) {
      if (options?.guard && !options.guard()) return
      // 请求参数和内存 merge 各自持有副本，防止 api/mock 或调用方在
      // await 期间修改同一对象后反向污染本地缓存。
      const chunkSnapshot = cloneValue(chunk)
      try {
        await api.cacheMessages({ conversationId, messages: cloneValue(chunkSnapshot), updatedAt })
        if (options?.guard && !options.guard()) return
        // 同步内存快照（评审 P2-2）：否则离线切换 activateLocal → snapshotMessages 读到启动水合时的陈旧快照
        const prev = snapshots.value[conversationId] ?? []
        const byId = new Map(prev.map((m) => [m.messageId, m]))
        for (const m of chunkSnapshot) byId.set(m.messageId, cloneValue(m))
        snapshots.value = { ...snapshots.value, [conversationId]: [...byId.values()] }
      } catch { /* 缓存缺落由后端调和兜底 */ }
    }
  }

  function snapshotMessages(conversationId: string): Message[] | undefined {
    const snapshot = snapshots.value[conversationId]
    return snapshot ? cloneValue(snapshot) : undefined
  }

  /** 在线 list 成功后同步内存会话列表（供离线切换 activateLocal 判定；持久化列表由 Main 派生） */
  function syncConversations(list: Conversation[]): void {
    conversations.value = cloneValue(list)
  }

  function purge(conversationId: string): void {
    delete snapshots.value[conversationId]
  }

  return { conversations, snapshots, lastActiveConversationId, hydrated, hydrate, pushMessages, snapshotMessages, syncConversations, purge }
})
