import { describe, expect, it } from 'vitest'
import {
  MessageSchema,
  PageSchema,
  ConversationSchema,
  ConnectionStateSchema,
  ReplayPayloadSchema
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
