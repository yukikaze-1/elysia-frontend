// tests/unit/session-usage.store.spec.ts
// C2 展示半边（2026-09-15）：会话级 token 累计在 messageStore 里的**归属与栅栏**。
//
// 这条链上真正会出错的地方不是"数字对不对"（数字全部来自后端），而是：
//   · 跨会话串号（把 A 的累计显示成 B 的）；
//   · 迟到/异会话终态把别人的累计写进当前会话；
//   · 把"这次没说"（回放不带 token_stats）当成"累计归零"；
//   · 重连回放与实时事件两条路径给出不一致的归属。
// 故用例全部围绕这四条。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useMessageStore } from '../../src/renderer/src/stores/message.store'
import { useConversationStore } from '../../src/renderer/src/stores/conversation.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { createDesktopApiMock } from './helpers/desktop-api'
import type { BackendEvent, ConversationTokenUsage, GenerationStartedEvent, Message } from '@shared/contracts'

const mockApi = createDesktopApiMock()
vi.spyOn(console, 'warn').mockImplementation(() => {})

function setCurrent(id: string | undefined): void {
  useConversationStore().$patch({ currentId: id })
}

function started(conversationId = 'conv-1', generationId = 'gen-1'): GenerationStartedEvent {
  return { eventId: 'e', sequence: 1, event: 'generation.started', generationId, messageId: 'msg-1', responseId: generationId, conversationId, model: 'm1' }
}

function completed(
  conversationUsage: ConversationTokenUsage | undefined,
  generationId = 'gen-1'
): BackendEvent {
  return {
    eventId: `c-${generationId}`,
    sequence: 3,
    event: 'generation.completed',
    generationId,
    responseId: generationId,
    usage: { input: 100, output: 20, total: 120, source: 'provider_reported' },
    ...(conversationUsage ? { conversationUsage } : {})
  }
}

function server(total: number, byModel: Record<string, number> = { 'm1': total }): ConversationTokenUsage {
  return { total, byModel, source: 'server_aggregate' }
}

function assistant(messageId: string, conversationId = 'conv-1', total?: number): Message {
  return {
    messageId,
    conversationId,
    role: 'assistant',
    status: 'completed',
    createdAt: '2026-09-15T00:00:00.000Z',
    ...(total === undefined ? {} : { usage: { input: total - 10, output: 10, total, source: 'provider_reported' } })
  }
}

describe('会话级 token 累计（messageStore）', () => {
  beforeEach(() => { setActivePinia(createPinia()); setDesktopApi(mockApi); setCurrent('conv-1') })

  it('completed 带 conversationUsage → 记入当前会话；lastTurnUsage 取该轮 usage', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.applyEvent(completed(server(12_000)))
    expect(store.currentSessionUsage).toEqual(server(12_000))
    expect(store.lastTurnUsage?.total).toBe(120)
    expect(store.droppedEvents).toBe(0)
  })

  it('completed 不带 conversationUsage → 累计保持 undefined（不补 0），本轮用量仍然可用', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.applyEvent(completed(undefined))
    expect(store.currentSessionUsage).toBeUndefined()
    expect(store.lastTurnUsage?.total).toBe(120)
  })

  it('异会话的迟到终态被守卫丢弃 → 不写入该会话、也不写入当前会话', () => {
    const store = useMessageStore()
    // gen-9 属于 conv-2；当前会话是 conv-1
    store.applyEvent(started('conv-2', 'gen-9'))
    setCurrent('conv-1')
    store.applyEvent(started('conv-1', 'gen-1'))
    store.applyEvent(completed(server(999), 'gen-9'))
    expect(store.droppedEvents).toBeGreaterThan(0)
    expect(store.sessionUsageByConversation['conv-2']).toBeUndefined()
    expect(store.currentSessionUsage).toBeUndefined()
  })

  it('同一会话第二次 completed 覆盖为新的服务端累计（单调来源，不做前端累加）', () => {
    const store = useMessageStore()
    store.applyEvent(started('conv-1', 'gen-1'))
    store.applyEvent(completed(server(1000), 'gen-1'))
    store.applyEvent({ ...started('conv-1', 'gen-2'), messageId: 'msg-2' })
    store.applyEvent(completed(server(2500), 'gen-2'))
    expect(store.currentSessionUsage?.total).toBe(2500)
  })

  it('切换会话互不串号：A 的累计不出现在 B，切回 A 仍在（按会话键控）', () => {
    const store = useMessageStore()
    store.applyEvent(started('conv-1', 'gen-1'))
    store.applyEvent(completed(server(1000), 'gen-1'))

    setCurrent('conv-2')
    store.resetConversation('conv-1')
    expect(store.currentSessionUsage).toBeUndefined()   // B 没有数据 → 隐藏，而不是显示 A 的数字

    setCurrent('conv-1')
    expect(store.currentSessionUsage?.total).toBe(1000)
  })

  it('loadReplay 匹配当前会话 → 累计随回放一起落位', () => {
    const store = useMessageStore()
    store.loadReplay('conv-1', [], server(7777))
    expect(store.currentSessionUsage?.total).toBe(7777)
  })

  it('loadReplay 未激活会话 → 与消息一起缓冲，applyPendingReplay 后一并生效', () => {
    const store = useMessageStore()
    setCurrent(undefined)
    store.loadReplay('conv-9', [assistant('m-9', 'conv-9')], server(4242))
    expect(store.currentSessionUsage).toBeUndefined()
    expect(store.pendingReplay?.usage?.total).toBe(4242)

    setCurrent('conv-9')
    store.applyPendingReplay('conv-9')
    expect(store.currentSessionUsage?.total).toBe(4242)
    expect(store.pendingReplay).toBeUndefined()
  })

  it('loadReplay 非当前会话（已激活别的会话）→ 整批丢弃，不写入任何键', () => {
    const store = useMessageStore()
    store.loadReplay('conv-other', [assistant('m-o', 'conv-other')], server(8888))
    expect(store.sessionUsageByConversation['conv-other']).toBeUndefined()
    expect(store.currentSessionUsage).toBeUndefined()
  })

  it('回放不带 usage（后端无该会话记录）→ 保留上一次已知值，不归零', () => {
    const store = useMessageStore()
    store.applyEvent(started('conv-1', 'gen-1'))
    store.applyEvent(completed(server(1234), 'gen-1'))
    store.loadReplay('conv-1', [], undefined)
    expect(store.currentSessionUsage?.total).toBe(1234)
  })

  it('lastTurnUsage 取最后一条带用量的助手消息（忽略 user 与无用量的助手消息）', () => {
    const store = useMessageStore()
    store.loadReplay('conv-1', [
      { messageId: 'u1', conversationId: 'conv-1', role: 'user', content: 'hi', status: 'completed', createdAt: '2026-09-15T00:00:00.000Z' },
      assistant('a1', 'conv-1', 300),
      assistant('a2', 'conv-1'),          // 无 usage（该分支走 completed 但不带 usage 的终态）
      assistant('a3', 'conv-1', 900)
    ])
    expect(store.lastTurnUsage?.total).toBe(900)
  })

  it('断线（reconnecting）不清累计——同一个后端同一个会话，清了只会让数字闪回空档', () => {
    const store = useMessageStore()
    store.applyEvent(started('conv-1', 'gen-1'))
    store.applyEvent(completed(server(555), 'gen-1'))
    store.handleConnectionStateChange({ status: 'reconnecting' })
    expect(store.currentSessionUsage?.total).toBe(555)
  })

  it('purgeConversationUsage / purgeAllSessionUsage：删除会话与切换端点两条清理路径', () => {
    const store = useMessageStore()
    store.applyEvent(started('conv-1', 'gen-1'))
    store.applyEvent(completed(server(111), 'gen-1'))
    store.purgeConversationUsage('conv-1')
    expect(store.currentSessionUsage).toBeUndefined()

    store.applyEvent({ ...started('conv-1', 'gen-2'), messageId: 'msg-2' })
    store.applyEvent(completed(server(222), 'gen-2'))
    store.purgeAllSessionUsage()
    expect(store.sessionUsageByConversation).toEqual({})
  })
})
