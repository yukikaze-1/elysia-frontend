import { describe, expect, expectTypeOf, it } from 'vitest'
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
import {
  DEFAULT_LIVE2D, DEFAULT_SETTINGS, SettingsStateSchema, SettingsPatchSchema,
  Live2DModelSummarySchema, Live2DListResponseSchema
} from '@shared/schemas'
import type { Live2DModelSummary } from '@shared/contracts'

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

describe('阶段 5 批次 A live2d 设置 schema（D5A-10，A6）', () => {
  it('DEFAULT_LIVE2D 形状 + DEFAULT_SETTINGS 引用同一对象', () => {
    expect(DEFAULT_LIVE2D).toEqual({
      enabled: true, modelId: null, scale: 1, offsetX: 0, offsetY: 0,
      mouseTracking: true, autoMotions: true, lipSync: true,
      performanceMode: 'auto', reduceMotion: false
    })
    expect(DEFAULT_SETTINGS.live2d).toBe(DEFAULT_LIVE2D)
  })

  it('SettingsStateSchema：缺 live2d 段 → .default(DEFAULT_LIVE2D) 补齐（旧 file 兼容，不 corrupt）', () => {
    const r = SettingsStateSchema.safeParse({
      version: 1,
      voice: { enabled: true, realtimeEnabled: false, autoReadReply: true, showCaptions: true, consentBackendStt: false },
      dictation: { insertMode: 'append' }
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.live2d).toEqual(DEFAULT_LIVE2D)
  })

  it('SettingsStateSchema：live2d 合法值通过 / 非法（modelId 非 string|null）拒绝', () => {
    const base = {
      version: 1,
      voice: { enabled: true, realtimeEnabled: false, autoReadReply: true, showCaptions: true, consentBackendStt: false },
      dictation: { insertMode: 'append' }
    }
    expect(SettingsStateSchema.safeParse({ ...base, live2d: { enabled: false, modelId: 'haru' } }).success).toBe(true)
    expect(SettingsStateSchema.safeParse({ ...base, live2d: { enabled: false, modelId: null } }).success).toBe(true)
    expect(SettingsStateSchema.safeParse({ ...base, live2d: { enabled: true, modelId: 42 } }).success).toBe(false)
    expect(SettingsStateSchema.safeParse({ ...base, live2d: { enabled: 'x' } }).success).toBe(false)
  })

  it('SettingsPatchSchema：live2d 嵌套 partial 放行 / 缺省放行 / 非法形状拒绝', () => {
    expect(SettingsPatchSchema.safeParse({ live2d: { enabled: false } }).success).toBe(true)
    expect(SettingsPatchSchema.safeParse({ live2d: { modelId: 'haru' } }).success).toBe(true)
    expect(SettingsPatchSchema.safeParse({}).success).toBe(true)               // 无 live2d patch 正常
    expect(SettingsPatchSchema.safeParse({ live2d: 'x' }).success).toBe(false)  // 非对象拒绝
    expect(SettingsPatchSchema.safeParse({ live2d: { modelId: 42 } }).success).toBe(false)
  })

  it('IP-1：patch 路径不注入已默认字段默认值（防单字段 patch clobber 已持久化非默认字段）', () => {
    // 单字段 patch 只带回该字段，其余字段必须为 undefined（不带 .default() 默认注入）
    const r = SettingsPatchSchema.safeParse({ live2d: { enabled: false } })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.live2d).toEqual({ enabled: false }) // scale/lipSync/offsetX/performanceMode 等不得被填默认
    }
    // performanceMode 显式旧值 'high' 在 patch 保存路径仍归一四值（IP-1 保留归一语义）
    const r2 = SettingsPatchSchema.safeParse({ live2d: { performanceMode: 'high' } })
    expect(r2.success).toBe(true)
    if (r2.success) expect(r2.data.live2d?.performanceMode).toBe('quality')
  })

  it('Live2DModelSummarySchema / Live2DListResponseSchema：合法摘要通过，缺字段拒绝', () => {
    const ok = {
      id: 'haru', displayName: 'Haru', preview: 'preview.png', version: '1.0',
      available: true, licenseRef: 'LICENSE.txt', integrityState: 'verified'
    }
    expect(Live2DModelSummarySchema.safeParse(ok).success).toBe(true)
    expect(Live2DListResponseSchema.safeParse([ok, { ...ok, id: 'lil', preview: null, reason: 'missing_file', integrityState: 'unverified', available: false }]).success).toBe(true)
    expect(Live2DModelSummarySchema.safeParse({ ...ok, integrityState: 'bogus' }).success).toBe(false)
    expect(Live2DModelSummarySchema.safeParse({ ...ok, id: undefined }).success).toBe(false)
  })

  it('M4：reason 闭合枚举——三码放行、非三码字符串拒（防字符串注入 UI）', () => {
    const base = {
      id: 'x', displayName: 'X', preview: null, version: '1.0', available: false,
      licenseRef: 'LICENSE.txt', integrityState: 'failed'
    }
    for (const code of ['missing_file', 'size_mismatch', 'hash_mismatch']) {
      expect(Live2DModelSummarySchema.safeParse({ ...base, reason: code }).success).toBe(true)
    }
    expect(Live2DModelSummarySchema.safeParse({ ...base, reason: 'other_error' }).success).toBe(false)
    expect(Live2DModelSummarySchema.safeParse({ ...base, reason: '' }).success).toBe(false)
    // 消费端类型收窄：Live2DModelSummary['reason'] 为三码闭合联合（编译期约束，运行期为可赋性守卫）
    expectTypeOf<Live2DModelSummary['reason']>().toEqualTypeOf<'missing_file' | 'size_mismatch' | 'hash_mismatch' | undefined>()
  })
})
