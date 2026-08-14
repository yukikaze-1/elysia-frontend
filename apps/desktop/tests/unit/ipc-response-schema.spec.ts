import { describe, expect, it } from 'vitest'
import {
  MessageSchema,
  PageSchema,
  ConversationSchema,
  ConnectionStateSchema,
  ReplayPayloadSchema
} from '@shared/schemas'
import {
  ScrollAnchorSchema, PersistSessionInputSchema,
  CacheMessagesInputSchema, OpenExternalInputSchema, SessionPersistenceStateSchema
} from '@shared/schemas'

const assistantMsg = {
  messageId: 'm1',
  conversationId: 'c1',
  role: 'assistant',
  status: 'completed',
  createdAt: 't',
  assistantSegments: [
    { segmentId: 's1', segmentIndex: 0, channel: 'public_reply', kind: 'text', text: 'hi', completed: true }
  ]
}

describe('IPC 领域响应 Schema', () => {
  it('assistant 消息(无 content + assistantSegments text?/completed)通过 MessageSchema', () => {
    expect(MessageSchema.safeParse(assistantMsg).success).toBe(true)
  })

  it('user 消息带 content 通过', () => {
    expect(
      MessageSchema.safeParse({
        messageId: 'm2',
        conversationId: 'c1',
        role: 'user',
        content: 'hi',
        status: 'completed',
        createdAt: 't'
      }).success
    ).toBe(true)
  })

  it('tool 消息带 MessageToolInfo 通过(镜像契约),tool 非对象失败', () => {
    const toolMsg = {
      messageId: 'm4',
      conversationId: 'c1',
      role: 'tool',
      content: 'ls 结果',
      status: 'completed',
      createdAt: 't',
      tool: { callId: 'c1', name: 'desktop.command.run', success: true, durationMs: 12 }
    }
    expect(MessageSchema.safeParse(toolMsg).success).toBe(true)
    expect(MessageSchema.safeParse({ ...toolMsg, tool: 'not-an-object' }).success).toBe(false)
  })

  it('非法:缺 messageId / 缺 completed → 失败', () => {
    const noMessageId = { ...assistantMsg }
    delete (noMessageId as { messageId?: string }).messageId
    expect(MessageSchema.safeParse(noMessageId).success).toBe(false)
    const noCompleted = {
      ...assistantMsg,
      assistantSegments: [
        { segmentId: 's1', segmentIndex: 0, channel: 'public_reply', kind: 'text', text: 'hi' }
      ]
    }
    expect(MessageSchema.safeParse(noCompleted).success).toBe(false)
  })

  it('ConversationSchema:合法项通过(无 unread 依赖)', () => {
    expect(ConversationSchema.safeParse({ id: 'c', title: 't', updatedAt: 'd' }).success).toBe(true)
  })

  it('PageSchema(ConversationSchema) 泛型:合法通过 / items 错形状失败', () => {
    const pageSchema = PageSchema(ConversationSchema)
    expect(pageSchema.safeParse({ items: [{ id: 'c', title: 't', updatedAt: 'd' }], hasMore: false }).success).toBe(true)
    expect(pageSchema.safeParse({ items: [{ id: 'c', title: 't' }], hasMore: false }).success).toBe(false)
  })

  it('ConnectionStateSchema:缺 status 失败、带全部 optional 通过', () => {
    expect(ConnectionStateSchema.safeParse({}).success).toBe(false)
    expect(
      ConnectionStateSchema.safeParse({
        status: 'connected',
        serverUrl: 'ws://localhost:8000/ws',
        protocolVersion: '1.0',
        serverVersion: 'v1.0',
        connectionId: 'conn-1',
        activeConversationId: 'c1',
        lastError: undefined
      }).success
    ).toBe(true)
  })

  it('ReplayPayloadSchema:messages 单条非法 → 整 payload 校验失败(逐条丢弃在 preload 层处理)', () => {
    const bad = {
      conversationId: 'c1',
      messages: [
        { messageId: 'm1', conversationId: 'c1', role: 'user', content: 'hi', status: 'completed', createdAt: 't' },
        { messageId: 'm2', conversationId: 'c1', role: 'assistant', createdAt: 't' }
      ]
    }
    expect(ReplayPayloadSchema.safeParse(bad).success).toBe(false)
  })
})

describe('阶段 3 G2 持久化 Schema（镜像 shared/contracts/persistence.ts）', () => {
  it('ScrollAnchorSchema 通过 {messageId, offset}', () => {
    expect(ScrollAnchorSchema.safeParse({ messageId: 'm1', offset: 120 }).success).toBe(true)
  })
  it('ScrollAnchorSchema 拒绝缺 messageId / 负 offset', () => {
    expect(ScrollAnchorSchema.safeParse({ offset: 0 }).success).toBe(false)
    expect(ScrollAnchorSchema.safeParse({ messageId: 'm1', offset: -1 }).success).toBe(false)
  })
  it('PersistSessionInputSchema 通过完整载荷,scrollAnchor 可 null', () => {
    const ok = PersistSessionInputSchema.safeParse({
      conversationId: 'c1', draft: { text: '你好', updatedAt: 't' }, scrollAnchor: { messageId: 'm1', offset: 0 }
    })
    expect(ok.success).toBe(true)
    const okNull = PersistSessionInputSchema.safeParse({ conversationId: 'c1', draft: { text: '', updatedAt: 't' }, scrollAnchor: null })
    expect(okNull.success).toBe(true)
  })
  it('PersistSessionInputSchema 拒绝 draft.text 超 100_000 码点（Main 再按 UTF-8 字节权威校验）', () => {
    const r = PersistSessionInputSchema.safeParse({ conversationId: 'c1', draft: { text: 'x'.repeat(100_001), updatedAt: 't' }, scrollAnchor: null })
    expect(r.success).toBe(false)
  })
  it('CacheMessagesInputSchema 通过/拒绝（缺 messages 或 messageId 空拒绝）', () => {
    const ok = CacheMessagesInputSchema.safeParse({ conversationId: 'c1', messages: [{ messageId: 'm1', conversationId: 'c1', role: 'user', content: 'hi', status: 'completed', createdAt: 't' }], updatedAt: 't' })
    expect(ok.success).toBe(true)
    expect(CacheMessagesInputSchema.safeParse({ conversationId: 'c1', messages: [], updatedAt: 't' }).success).toBe(true)
    expect(CacheMessagesInputSchema.safeParse({ conversationId: 'c1', messages: [{ messageId: '', conversationId: 'c1', role: 'user', status: 'completed', createdAt: 't' }], updatedAt: 't' }).success).toBe(false)
  })
  it('OpenExternalInputSchema 拒绝非字符串 url', () => {
    expect(OpenExternalInputSchema.safeParse({ url: 'https://example.com' }).success).toBe(true)
    expect(OpenExternalInputSchema.safeParse({ url: 42 }).success).toBe(false)
  })
  it('SessionPersistenceStateSchema 通过完整水合载荷（snapshots 含合法消息）', () => {
    const state = {
      drafts: [{ conversationId: 'c1', text: '草稿', attachmentLocalIds: [], updatedAt: 't' }],
      scrollAnchors: { c1: { messageId: 'm1', offset: 5 } },
      lastActiveConversationId: 'c1',
      conversations: [{ id: 'c1', title: '会话', updatedAt: 't' }],
      messageSnapshots: { c1: [{ messageId: 'm1', conversationId: 'c1', role: 'assistant', status: 'completed', createdAt: 't', assistantSegments: [] }] }
    }
    expect(SessionPersistenceStateSchema.safeParse(state).success).toBe(true)
  })
})
