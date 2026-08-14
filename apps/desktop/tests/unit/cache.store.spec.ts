// tests/unit/cache.store.spec.ts —— spec §4.1/§4.5：离线水合、分片推送、快照查询、列表同步。
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCacheStore, chunkMessages } from '../../src/renderer/src/stores/cache.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { MAX_IPC_MESSAGE_BYTES } from '@shared/contracts'
import type { Message, SessionPersistenceState } from '@shared/contracts'

const mockApi = {
  cacheMessages: vi.fn(), persistSession: vi.fn(), hydratePersistence: vi.fn(), openExternal: vi.fn(), attachmentsValidate: vi.fn(), attachmentsUpload: vi.fn(), attachmentsCancel: vi.fn(), attachmentsCheck: vi.fn(),
  getCredentialStatus: vi.fn(), setBackendToken: vi.fn(), clearBackendToken: vi.fn(),
  setEndpoint: vi.fn(), getEndpoint: vi.fn(), getRuntimeInfo: vi.fn(),
  connect: vi.fn(), disconnect: vi.fn(), listConversations: vi.fn(), getMessages: vi.fn(),
  send: vi.fn(), cancel: vi.fn(), activate: vi.fn(), createConversation: vi.fn(),
  renameConversation: vi.fn(), deleteConversation: vi.fn(), getConnectionState: vi.fn(),
  onChatEvent: vi.fn(() => () => {}), onChatState: vi.fn(() => () => {}), onChatReplay: vi.fn(() => () => {}), onChatError: vi.fn(() => () => {})
}

function m(id: string, t: string): Message {
  return { messageId: id, conversationId: 'c1', role: 'user', content: 'x', status: 'completed', createdAt: t }
}

describe('cacheStore（spec §4.5）', () => {
  beforeEach(() => { setActivePinia(createPinia()); setDesktopApi(mockApi); mockApi.cacheMessages.mockResolvedValue(undefined) })

  it('hydrate 载入会话列表/快照/上次活动会话', () => {
    const s = useCacheStore()
    const state: SessionPersistenceState = {
      drafts: [], scrollAnchors: {}, lastActiveConversationId: 'c1',
      conversations: [{ id: 'c1', title: 'A', updatedAt: 't' }],
      messageSnapshots: { c1: [m('m1', 't')] }
    }
    s.hydrate(state)
    expect(s.conversations.map((c) => c.id)).toEqual(['c1'])
    expect(s.lastActiveConversationId).toBe('c1')
    expect(s.snapshotMessages('c1')?.[0]?.messageId).toBe('m1')
    expect(s.snapshotMessages('nope')).toBeUndefined()
  })

  it('pushMessages 调 cacheMessages（≤200 条单批）', async () => {
    const s = useCacheStore()
    await s.pushMessages('c1', [m('m1', 't')], 'now')
    expect(mockApi.cacheMessages).toHaveBeenCalledWith({ conversationId: 'c1', messages: [m('m1', 't')], updatedAt: 'now' })
  })

  it('syncConversations 更新内存会话列表（在线 list 后供离线切换判定）', () => {
    const s = useCacheStore()
    s.syncConversations([{ id: 'c9', title: '新', updatedAt: 't' }])
    expect(s.conversations.map((c) => c.id)).toEqual(['c9'])
  })

  it('purge 删会话联动清快照', () => {
    const s = useCacheStore()
    s.hydrate({ drafts: [], scrollAnchors: {}, conversations: [{ id: 'c1', title: 'A', updatedAt: 't' }], messageSnapshots: { c1: [m('m1', 't')] } })
    s.purge('c1')
    expect(s.snapshotMessages('c1')).toBeUndefined()
  })
})

describe('chunkMessages（P1-2 分片：≤200 条/批 + 字节预算；单条超限跳过）', () => {
  it('≤200 条且 ≤预算 → 单批', () => {
    const msgs = Array.from({ length: 5 }, (_, i) => m(`m${i}`, `t${i}`))
    expect(chunkMessages(msgs, MAX_IPC_MESSAGE_BYTES)).toHaveLength(1)
  })
  it('>200 条 → 按 200 分片', () => {
    const msgs = Array.from({ length: 450 }, (_, i) => m(`m${i}`, `t${i}`))
    const chunks = chunkMessages(msgs, MAX_IPC_MESSAGE_BYTES)
    expect(chunks.length).toBe(3)
    expect(chunks[0]).toHaveLength(200)
    expect(chunks[1]).toHaveLength(200)
    expect(chunks[2]).toHaveLength(50)
  })
  it('超预算 → 按字节继续分片；单条超限整条跳过', () => {
    const hugeText = 'x'.repeat(1024 * 1024) // 1MiB 单条 → msgBytes≈1MiB+200
    const big: Message = { ...m('big', 't'), content: hugeText }
    const small: Message = m('s', 't') // msgBytes = 200 + 1 = 201
    const chunks = chunkMessages([big, small], 300) // big 超 300 跳过；small 201 < 300 入批
    expect(chunks).toHaveLength(1)
    expect(chunks[0].map((x) => x.messageId)).toEqual(['s'])
  })
})
