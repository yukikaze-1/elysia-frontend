// tests/unit/message.store.spec.ts
// Task 4:messageStore 流式应用——generation 守卫/归并(StreamAccumulator)/cancel 乐观置位/断线 in-flight/loadReplay/乐观发送。
// Task 7(批次B):事件归属守卫(generationByConversation)+ loadReplay 纯缓冲(pendingReplay)+ migrateKey 竞态守卫(I1)+ 断线清 local-*(I5)。
// env=node:不触 Electron——store 经 stores/desktop-api 注入 mock api(R2);pinia 用 createPinia + setActivePinia。
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useMessageStore } from '../../src/renderer/src/stores/message.store'
import { useConversationStore } from '../../src/renderer/src/stores/conversation.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import type { BackendEvent, GenerationStartedEvent, Message } from '@shared/contracts'

// mock desktopApi(store 依赖注入)——通过 stores/desktop-api.types.ts 的 DesktopApiLike
const mockApi = {
  connect: vi.fn(), disconnect: vi.fn(), listConversations: vi.fn(), getMessages: vi.fn(),
  send: vi.fn(), cancel: vi.fn(), activate: vi.fn(), createConversation: vi.fn(),
  renameConversation: vi.fn(), deleteConversation: vi.fn(), getConnectionState: vi.fn(),
  getCredentialStatus: vi.fn(), setBackendToken: vi.fn(), clearBackendToken: vi.fn(),
  setEndpoint: vi.fn(), getEndpoint: vi.fn(), getRuntimeInfo: vi.fn(),
  onChatEvent: vi.fn(() => () => {}), onChatState: vi.fn(() => () => {}), onChatReplay: vi.fn(() => () => {}), onChatError: vi.fn(() => () => {}),
  hydratePersistence: vi.fn(), persistSession: vi.fn(), cacheMessages: vi.fn(), openExternal: vi.fn(), attachmentsValidate: vi.fn(), attachmentsUpload: vi.fn(), attachmentsCancel: vi.fn(), attachmentsCheck: vi.fn()
}
// 注入机制定死(P1-3):stores/desktop-api.ts export let api + setDesktopApi;store 惰性 import { api };
// main.ts 调 setDesktopApi(window.desktopApi);测试 beforeEach 里 setDesktopApi(mockApi)(node env 无 window,不触全局)

// 守卫丢弃只记 warn + 计数器,静音避免刷屏(断言走 droppedEvents)
vi.spyOn(console, 'warn').mockImplementation(() => {})

// started 返回 GenerationStartedEvent(而非 BackendEvent 联合):completed 测试里 {...started(), event:'generation.completed'}
// 的联合展开会在缺少 responseId 的成员上无法赋给 BackendEvent,typecheck:node 需精确类型。
function started(): GenerationStartedEvent { return { eventId: 'e', sequence: 1, event: 'generation.started', generationId: 'gen-1', messageId: 'msg-1', responseId: 'gen-1', conversationId: 'conv-1', model: 'm1' } }
function delta(seg: string, seq: number, text: string): BackendEvent { return { eventId: 'e', sequence: 2, event: 'generation.delta', generationId: 'gen-1', segmentId: seg, segmentIndex: 0, channel: 'public_reply', kind: 'markdown', deltaSequence: seq, text } }
function failed(code: string, message: string, retryable?: boolean): BackendEvent { return { eventId: 'e', sequence: 3, event: 'generation.failed', generationId: 'gen-1', error: { code, message, retryable } } }

/** F2:归属守卫依赖 currentId——默认注入当前会话;显式改状态用 setCurrent */
function setCurrent(id: string | undefined): void {
  useConversationStore().$patch({ currentId: id })
}

describe('messageStore 流式应用', () => {
  beforeEach(() => { setActivePinia(createPinia()); setDesktopApi(mockApi); setCurrent('conv-1') })   // R2:注入 mock api;F2:默认当前会话

  it('started→delta→completed 归并 assistant 消息(Token/model/emotion 落位)', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.applyEvent(delta('seg-1', 0, '你好'))
    store.applyEvent({ ...started(), event: 'generation.completed', usage: { input: 1, output: 2, total: 3, source: 'provider_reported' }, model: 'm1', emotion: 'happy' })
    expect(store.byId['msg-1']?.role).toBe('assistant')
    expect(store.byId['msg-1']?.assistantSegments?.[0]?.text).toBe('你好')
    expect(store.byId['msg-1']?.status).toBe('completed')
    expect(store.byId['msg-1']?.usage?.total).toBe(3)
    expect(store.byId['msg-1']?.emotion).toBe('happy')
  })

  it('generationId 守卫:跨代 delta 丢弃', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.applyEvent({ ...delta('seg-1', 0, 'ok'), generationId: 'gen-OTHER' })
    expect(store.byId['msg-1']?.assistantSegments).toHaveLength(0)
  })

  it('cancel 乐观置 interrupted', async () => {
    const store = useMessageStore()
    store.applyEvent(started())
    await store.cancel()   // P1-2:与实现顺序一致(await desktopApi.cancel 后置位)
    expect(store.byId['msg-1']?.status).toBe('interrupted')
    expect(store.activeGenerationId).toBeUndefined()
  })

  it('断线且 in-flight → assistant 置 interrupted(P1-6)', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.handleConnectionStateChange({ status: 'reconnecting' })   // 由 onChatState 回调接线调用(P2-1)
    expect(store.byId['msg-1']?.status).toBe('interrupted')
    expect(store.activeGenerationId).toBeUndefined()
  })

  it('cancel 后同代迟到 completed 不复活 interrupted(P2-5)', async () => {
    const store = useMessageStore()
    store.applyEvent(started())
    await store.cancel()
    expect(store.byId['msg-1']?.status).toBe('interrupted')
    // activeGenerationId 已清空,同代迟到 completed 丢弃(accumulator 仍在也不复活)
    store.applyEvent({ ...started(), event: 'generation.completed', usage: { input: 1, output: 2, total: 3, source: 'provider_reported' }, model: 'm1', emotion: 'happy' })
    expect(store.byId['msg-1']?.status).toBe('interrupted')
    expect(store.byId['msg-1']?.usage).toBeUndefined()
  })

  it('断线后同代迟到 delta/completed 丢弃(P2-5)', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.handleConnectionStateChange({ status: 'reconnecting' })
    // 迟到 delta:不追加分段
    store.applyEvent(delta('seg-1', 0, '迟到'))
    expect(store.byId['msg-1']?.assistantSegments).toHaveLength(0)
    // 迟到 completed:不复活为 completed
    store.applyEvent({ ...started(), event: 'generation.completed', usage: { input: 1, output: 2, total: 3, source: 'provider_reported' }, model: 'm1', emotion: 'happy' })
    expect(store.byId['msg-1']?.status).toBe('interrupted')
  })

  it('loadReplay 按 messageId 去重插入(P2-2)', () => {
    const store = useMessageStore()
    const m1 = { messageId: 'msg-r1', conversationId: 'conv-1', role: 'user', content: 'hi', status: 'completed', createdAt: 't' } as Message
    store.loadReplay('conv-1', [m1, { ...m1 }])
    expect(Object.keys(store.byId)).toHaveLength(1)   // 去重
  })

  it('乐观发送:pending → acknowledged(failed 时 failed)', async () => {
    const conv = useConversationStore()
    conv.$patch({ currentId: 'conv-1' })
    mockApi.send.mockResolvedValueOnce({ clientRequestId: 'c1' })   // 无 serverMessageId
    const store = useMessageStore()
    await store.send('hi')
    const msgs = Object.values(store.byId)
    expect(msgs.some((m) => m.role === 'user' && m.status === 'acknowledged')).toBe(true)
  })

  it('generation.failed → lastError 结构化(PublicError:code/message/backendCode/retryable)', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.applyEvent({
      eventId: 'e', sequence: 3, event: 'generation.failed', generationId: 'gen-1',
      error: { code: 'BACKEND_REJECTED', message: '队列已满', retryable: true }
    })
    expect(store.lastError).toEqual({
      code: 'BACKEND_REJECTED', message: '队列已满', backendCode: 'BACKEND_REJECTED', retryable: true
    })
    expect(store.byId['msg-1']?.status).toBe('failed')
  })

  it('send 失败 → lastError 结构化(parsePublicError 反解 IPC 前缀)', async () => {
    const conv = useConversationStore()
    conv.$patch({ currentId: 'conv-1' })
    mockApi.send.mockRejectedValueOnce(new Error('[AUTHENTICATION_FAILED] [backendCode=TOKEN_EXPIRED] token 无效'))
    const store = useMessageStore()
    await store.send('hi')
    expect(store.lastError).toEqual({
      code: 'AUTHENTICATION_FAILED', message: 'token 无效', backendCode: 'TOKEN_EXPIRED'
    })
    expect(Object.values(store.byId).some((m) => m.role === 'user' && m.status === 'failed')).toBe(true)
  })

  // ---------- Task 7(批次B):归属守卫 + 纯缓冲 + 竞态修复 ----------

  it('generation.started 非当前会话 → 丢弃 + droppedEvents 计数', () => {
    setCurrent('conv-2')
    const store = useMessageStore()
    store.applyEvent(started())   // started 属于 conv-1,当前是 conv-2
    expect(store.byId['msg-1']).toBeUndefined()
    expect(store.droppedEvents).toBe(1)
    expect(store.generationByConversation['gen-1']).toBeUndefined()
  })

  it('generation.started 当前会话 → 记录 generationByConversation 并正常处理(正向,M2)', () => {
    const store = useMessageStore()   // beforeEach currentId=conv-1
    store.applyEvent(started())
    expect(store.generationByConversation['gen-1']).toBe('conv-1')
    expect(store.byId['msg-1']?.role).toBe('assistant')
    expect(store.byId['msg-1']?.status).toBe('streaming')
    expect(store.droppedEvents).toBe(0)
  })

  it('中间事件查 generationByConversation:非当前/查无 → 丢弃', () => {
    const store = useMessageStore()
    // 查无:started 未到达,delta 无表可查
    store.applyEvent(delta('seg-1', 0, '你好'))
    expect(store.byId['msg-1']).toBeUndefined()
    expect(store.droppedEvents).toBe(1)
    // 非当前:started 属于 conv-2(当前 conv-1)被丢 → 表无记录 → 其中间事件继续被丢
    store.applyEvent({ ...started(), conversationId: 'conv-2', generationId: 'gen-2' })
    expect(store.droppedEvents).toBe(2)
    store.applyEvent({ ...delta('seg-1', 0, 'x'), generationId: 'gen-2' })
    expect(store.droppedEvents).toBe(3)
    expect(store.byId['msg-1']).toBeUndefined()
  })

  it('当前会话中间事件正常通过(正向,M2)', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.applyEvent(delta('seg-1', 0, '你好'))
    expect(store.byId['msg-1']?.assistantSegments?.[0]?.text).toBe('你好')
    expect(store.droppedEvents).toBe(0)
  })

  it('resetConversation 清 generationByConversation', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    expect(store.generationByConversation['gen-1']).toBe('conv-1')
    store.resetConversation('conv-1')
    expect(store.generationByConversation).toEqual({})
  })

  it('loadReplay 匹配 → 合并;未设 currentId → 纯缓冲;不匹配 → 丢弃', () => {
    const store = useMessageStore()
    const msgA = { messageId: 'msg-a', conversationId: 'conv-1', role: 'user', content: 'a', status: 'completed', createdAt: 't' } as Message
    const msgB = { messageId: 'msg-b', conversationId: 'conv-2', role: 'user', content: 'b', status: 'completed', createdAt: 't' } as Message
    const msgC = { messageId: 'msg-c', conversationId: 'conv-3', role: 'user', content: 'c', status: 'completed', createdAt: 't' } as Message

    // 匹配当前 → 合并进 byId
    store.loadReplay('conv-1', [msgA])   // beforeEach currentId=conv-1
    expect(store.byId['msg-a']).toBeDefined()
    expect(store.pendingReplay).toBeUndefined()

    // 未设 currentId → 纯缓冲,不污染 byId
    setCurrent(undefined)
    store.loadReplay('conv-2', [msgB])
    expect(store.byId['msg-b']).toBeUndefined()
    expect(store.pendingReplay?.conversationId).toBe('conv-2')
    expect(store.pendingReplay?.messages).toHaveLength(1)

    // 不匹配 → 丢弃 + 计数;缓冲区保持原样(m5 由 applyPendingReplay 清空)
    setCurrent('conv-1')
    store.loadReplay('conv-3', [msgC])
    expect(store.byId['msg-c']).toBeUndefined()
    expect(store.droppedEvents).toBe(1)
    expect(store.pendingReplay?.conversationId).toBe('conv-2')
  })

  it('applyPendingReplay 应用并清空;不匹配也清空(m5)', () => {
    const store = useMessageStore()
    // 匹配 → 应用 + 清空
    setCurrent(undefined)
    const msg = { messageId: 'msg-b', conversationId: 'conv-2', role: 'user', content: 'hi', status: 'completed', createdAt: 't' } as Message
    store.loadReplay('conv-2', [msg])
    expect(store.pendingReplay?.conversationId).toBe('conv-2')
    store.applyPendingReplay('conv-2')
    expect(store.byId['msg-b']?.conversationId).toBe('conv-2')
    expect(store.pendingReplay).toBeUndefined()

    // 不匹配 → 不应用,但同样清空(m5 防残留)
    setCurrent(undefined)
    const msg2 = { messageId: 'msg-c', conversationId: 'conv-3', role: 'user', content: 'c', status: 'completed', createdAt: 't' } as Message
    store.loadReplay('conv-3', [msg2])
    expect(store.pendingReplay?.conversationId).toBe('conv-3')
    store.applyPendingReplay('conv-9')
    expect(store.byId['msg-c']).toBeUndefined()
    expect(store.pendingReplay).toBeUndefined()
  })

  it('migrateKey 旧 key 已清(切会话)→ 不重插(I1)', async () => {
    let resolveSend!: (ref: { clientRequestId: string; serverMessageId?: string }) => void
    mockApi.send.mockImplementationOnce(() => new Promise((res) => { resolveSend = res }))
    const store = useMessageStore()
    const p = store.send('hi')   // 乐观 local-* 同步入 byId
    const localKey = Object.keys(store.byId)[0]!
    expect(localKey.startsWith('local-')).toBe(true)
    // 切会话 → resetConversation 清空 byId
    store.resetConversation('conv-2')
    expect(store.byId[localKey]).toBeUndefined()
    // 迟到 ack 带 serverMessageId → migrateKey 旧 key 已清,不得重插(I1)
    resolveSend({ clientRequestId: 'c1', serverMessageId: 'server-1' })
    await p
    expect(store.byId['server-1']).toBeUndefined()
    expect(store.byId[localKey]).toBeUndefined()
  })

  it('handleConnectionStateChange 断线清理 local-* pending 消息(I5)', async () => {
    let resolveSend!: (ref: { clientRequestId: string; serverMessageId?: string }) => void
    mockApi.send.mockImplementationOnce(() => new Promise((res) => { resolveSend = res }))
    const store = useMessageStore()
    const p = store.send('hi')
    const localKey = Object.keys(store.byId)[0]!
    expect(store.byId[localKey]?.status).toBe('pending')
    // 非 pending 的 local-* 与普通消息应保留
    store.loadReplay('conv-1', [
      { messageId: 'local-done', conversationId: 'conv-1', role: 'user', content: 'x', status: 'acknowledged', createdAt: 't' } as Message,
      { messageId: 'msg-normal', conversationId: 'conv-1', role: 'user', content: 'y', status: 'pending', createdAt: 't' } as Message
    ])
    // 断线:无 active generation 也要清理(F11:清理循环插在早退之前)
    store.handleConnectionStateChange({ status: 'reconnecting' })
    expect(store.byId[localKey]).toBeUndefined()
    expect(store.order).not.toContain(localKey)
    expect(store.byId['local-done']).toBeDefined()
    expect(store.byId['msg-normal']).toBeDefined()
    resolveSend({ clientRequestId: 'c1' })
    await p
  })

  // ---------- D2(二次真实联调):replay/REST 同 ID 去重 + 不同 tool_call_id 不碰撞 ----------

  it('replay 与 REST 相同 messageId 两种到达顺序 → store 只有一条（byId 去重）', async () => {
    const m1 = { messageId: 'msg_t1', conversationId: 'conv-1', role: 'tool', content: 'x', tool: { callId: 'call_1', name: 'get_time', success: true }, status: 'completed', createdAt: 't1' } as Message
    // 场景 A：先 loadReplay 再经 REST 到达同 messageId → 仍一条
    const storeA = useMessageStore()
    storeA.loadReplay('conv-1', [{ ...m1 }])
    expect(Object.keys(storeA.byId)).toHaveLength(1)
    storeA.loadPage({ items: [{ ...m1, content: 'y' }], hasMore: false })   // REST 后到,内容覆盖、不新增
    expect(Object.keys(storeA.byId)).toHaveLength(1)
    expect(storeA.byId['msg_t1']?.content).toBe('y')
    // 场景 B：先 REST 后 loadReplay 同 messageId → 仍一条
    const storeB = useMessageStore()
    storeB.loadPage({ items: [{ ...m1, content: 'y' }], hasMore: false })
    storeB.loadReplay('conv-1', [{ ...m1 }])
    expect(Object.keys(storeB.byId)).toHaveLength(1)
    expect(storeB.byId['msg_t1']).toBeDefined()
    expect(storeB.byId['msg_t1']?.content).toBe('x')   // upsert 替换语义:后到 replay 覆盖既有内容,仍一条不新增
  })

  it('两条不同 tool_call_id 不碰撞（各自独立 messageId）', async () => {
    const store = useMessageStore()
    const t1 = { messageId: 'msg_t1', conversationId: 'conv-1', role: 'tool', content: 'x', tool: { callId: 'call_1', name: 'get_time', success: true }, status: 'completed', createdAt: 't1' } as Message
    const t2 = { messageId: 'msg_t2', conversationId: 'conv-1', role: 'tool', content: 'y', tool: { callId: 'call_2', name: 'get_time', success: true }, status: 'completed', createdAt: 't2' } as Message
    store.loadReplay('conv-1', [t1, t2])
    expect(Object.keys(store.byId)).toHaveLength(2)   // byId 两条,不覆盖
    expect(store.byId['msg_t1']?.tool?.callId).toBe('call_1')
    expect(store.byId['msg_t2']?.tool?.callId).toBe('call_2')
  })

  // ---------- D3(二次真实联调):取消码统一 GENERATION_CANCELLED + 取消终态不设 lastError ----------

  it('generation.failed{code:GENERATION_CANCELLED} → interrupted + 无 lastError（D3 正式码）', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.applyEvent(failed('GENERATION_CANCELLED', '用户取消了本次生成', false))
    expect(store.byId['msg-1']?.status).toBe('interrupted')
    expect(store.lastError).toBeUndefined()
    expect(store.activeGenerationId).toBeUndefined()
  })

  it('failed 在 cancel IPC resolve 前到达（交错时序）→ 最终仍 interrupted + 无 lastError', async () => {
    let resolveCancel!: (v?: unknown) => void
    mockApi.cancel.mockImplementationOnce(() => new Promise((res) => { resolveCancel = res }))
    const store = useMessageStore()
    store.applyEvent(started())
    const p = store.cancel()   // cancel IPC 未 resolve,activeGenerationId 仍在
    // 不依赖乐观 cancel:failed 先到,经 failed 路径置 interrupted
    store.applyEvent(failed('GENERATION_CANCELLED', '用户取消了本次生成', false))
    expect(store.byId['msg-1']?.status).toBe('interrupted')
    expect(store.lastError).toBeUndefined()
    resolveCancel()
    await p
    expect(store.byId['msg-1']?.status).toBe('interrupted')
    expect(store.lastError).toBeUndefined()
    expect(store.activeGenerationId).toBeUndefined()
  })

  it('本地乐观 cancel 先完成、failed 后到 → 状态不变 + 无错误横幅', async () => {
    const store = useMessageStore()
    store.applyEvent(started())
    await store.cancel()   // 乐观置 interrupted + 清 activeGenerationId
    expect(store.byId['msg-1']?.status).toBe('interrupted')
    // failed 后到:activeGenerationId 已清,被守卫丢弃(P2-5),不降级 failed
    store.applyEvent(failed('GENERATION_CANCELLED', '用户取消了本次生成', false))
    expect(store.byId['msg-1']?.status).toBe('interrupted')
    expect(store.lastError).toBeUndefined()
    expect(store.activeGenerationId).toBeUndefined()
  })

  it('已收 partial segments 取消后保留', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.applyEvent(delta('seg-1', 0, '部分内容'))
    store.applyEvent(failed('GENERATION_CANCELLED', '用户取消了本次生成', false))
    expect(store.byId['msg-1']?.status).toBe('interrupted')
    expect(store.byId['msg-1']?.assistantSegments?.[0]?.text).toBe('部分内容')
  })

  it('迟到 completed 不把 interrupted 改回 completed', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.applyEvent(failed('GENERATION_CANCELLED', '用户取消了本次生成', false))
    expect(store.byId['msg-1']?.status).toBe('interrupted')
    // 迟到 completed:activeGenerationId 已清,被守卫丢弃(P2-5)
    store.applyEvent({ ...started(), event: 'generation.completed', usage: { input: 1, output: 2, total: 3, source: 'provider_reported' }, model: 'm1', emotion: 'happy' })
    expect(store.byId['msg-1']?.status).toBe('interrupted')
  })

  it('legacy code CANCELLED 仍识别（helper 兼容）', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.applyEvent(failed('CANCELLED', '用户取消了本次生成', false))
    expect(store.byId['msg-1']?.status).toBe('interrupted')
    expect(store.lastError).toBeUndefined()
  })

  it('非取消错误 GENERATION_TIMEOUT → failed + lastError', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.applyEvent(failed('GENERATION_TIMEOUT', '生成超时', true))
    expect(store.byId['msg-1']?.status).toBe('failed')
    expect(store.lastError).toEqual({
      code: 'GENERATION_TIMEOUT', message: '生成超时', backendCode: 'GENERATION_TIMEOUT', retryable: true
    })
  })
})

describe('G2 历史懒加载：有序插入 / loadOlder / loadSnapshot（spec §4.3.3 P0-1）', () => {
  function pageMsg(id: string, createdAt: string, role: 'user' | 'assistant' = 'user'): Message {
    return { messageId: id, conversationId: 'conv-1', role, status: 'completed', createdAt, ...(role === 'user' ? { content: id } : { assistantSegments: [] }) }
  }

  beforeEach(() => { setActivePinia(createPinia()); setDesktopApi(mockApi); setCurrent('conv-1') })

  it('upsertMessage 有序插入：before 页（更旧）前插，order 恒 (createdAt, messageId) 升序', () => {
    const store = useMessageStore()
    store.loadPage({ items: [pageMsg('m3', 't3'), pageMsg('m1', 't1')], hasMore: true, nextCursor: 'c1' }) // 防御性排序
    expect(store.order).toEqual(['m1', 'm3'])
    store.loadPage({ items: [pageMsg('m2', 't2'), pageMsg('m0', 't0')], hasMore: false, nextCursor: undefined }) // 更早页前插
    expect(store.order).toEqual(['m0', 'm1', 'm2', 'm3'])
    expect(store.byId['m1']?.content).toBe('m1')
  })

  it('重复 messageId 原位替换不重插（loadPage 二次去重）', () => {
    const store = useMessageStore()
    store.loadPage({ items: [pageMsg('m1', 't1'), pageMsg('m2', 't2')], hasMore: false, nextCursor: undefined })
    store.loadPage({ items: [{ ...pageMsg('m2', 't2'), content: 'updated' }], hasMore: false, nextCursor: undefined })
    expect(store.order).toEqual(['m1', 'm2'])
    expect(store.byId['m2']?.content).toBe('updated')
  })

  it('非时间序页免疫：乱序 items 合并后仍升序', () => {
    const store = useMessageStore()
    store.loadPage({ items: [pageMsg('b', 't2'), pageMsg('a', 't1'), pageMsg('c', 't3')], hasMore: false, nextCursor: undefined })
    expect(store.order).toEqual(['a', 'b', 'c'])
  })

  it('setPageMeta 首页 nextCursor → hasMoreBefore/beforeCursor（激活首屏后初始化）', () => {
    const store = useMessageStore()
    store.setPageMeta({ items: [pageMsg('m1', 't1')], hasMore: true, nextCursor: 'cur-x' })
    expect(store.hasMoreBefore).toBe(true)
    expect(store.beforeCursor).toBe('cur-x')
  })

  it('loadOlder 携带 before 游标拉更早页并入 + 推进游标；防重入', async () => {
    const store = useMessageStore()
    // 首页 items 必须经 loadPage 插入（order 由 loadPage/loadSnapshot 维护）；setPageMeta 只初始化游标、不载入 items（评审 P0-1）
    store.loadPage({ items: [pageMsg('m2', 't2'), pageMsg('m3', 't3')], hasMore: true, nextCursor: 'cur-1' })
    store.setPageMeta({ items: [pageMsg('m2', 't2'), pageMsg('m3', 't3')], hasMore: true, nextCursor: 'cur-1' })
    expect(store.order).toEqual(['m2', 'm3']) // setPageMeta 不改 order
    mockApi.getMessages.mockResolvedValue({ items: [pageMsg('m1', 't1')], hasMore: false, nextCursor: undefined })
    await store.loadOlder()
    expect(mockApi.getMessages).toHaveBeenCalledWith({ conversationId: 'conv-1', before: 'cur-1' })
    expect(store.order).toEqual(['m1', 'm2', 'm3']) // 新页 items 有序前插
    expect(store.hasMoreBefore).toBe(false)
    expect(store.beforeCursor).toBeUndefined()
    expect(store.loadingOlder).toBe(false)
  })

  it('loadOlder 失败保留游标 + lastError 公开（可重试），不改已渲染消息', async () => {
    const store = useMessageStore()
    store.loadPage({ items: [pageMsg('m2', 't2')], hasMore: true, nextCursor: 'cur-1' }) // 先载入已渲染消息（评审 P0-1）
    store.setPageMeta({ items: [pageMsg('m2', 't2')], hasMore: true, nextCursor: 'cur-1' })
    mockApi.getMessages.mockRejectedValue(new Error('网络错误'))
    await store.loadOlder()
    expect(store.beforeCursor).toBe('cur-1')
    expect(store.hasMoreBefore).toBe(true)
    expect(store.lastError?.message).toContain('网络错误')
    expect(store.order).toEqual(['m2']) // 失败不改已渲染 order
  })

  it('loadSnapshot 排序载入 + hasMoreBefore=false（离线水合/离线切换，P1-1）', () => {
    const store = useMessageStore()
    store.loadSnapshot('conv-1', [pageMsg('m2', 't2'), pageMsg('m0', 't0')]) // 非时间序快照
    expect(store.order).toEqual(['m0', 'm2'])
    expect(store.hasMoreBefore).toBe(false)
    expect(store.beforeCursor).toBeUndefined()
  })

  it('resetConversation 清 pagination 状态', () => {
    const store = useMessageStore()
    store.setPageMeta({ items: [pageMsg('m1', 't1')], hasMore: true, nextCursor: 'c' })
    store.resetConversation('conv-1')
    expect(store.hasMoreBefore).toBe(false)
    expect(store.beforeCursor).toBeUndefined()
    expect(store.loadingOlder).toBe(false)
  })
})

describe('G3 附件发送编排（spec §4.4/§5）', () => {
  beforeEach(() => { setActivePinia(createPinia()); setDesktopApi(mockApi); setCurrent('conv-1') })   // 独立 describe：与流式/懒加载 describe 同级，需自带 pinia

  it('send 携带附件 → 乐观消息带 attachments + api.send 带 refs（kind/mime 提示值）', async () => {
    const conv = useConversationStore()
    conv.$patch({ currentId: 'conv-1' })
    mockApi.send.mockResolvedValueOnce({ clientRequestId: 'c1', serverMessageId: 'msg-srv' })
    const store = useMessageStore()
    await store.send('hi', { attachments: [{ attachmentId: 'att_1', kind: 'image', mediaType: 'image/png', name: 'a.png' }] })
    const msgs = Object.values(store.byId)
    const user = msgs.find((m) => m.role === 'user')
    expect(user?.attachments).toEqual([{ attachmentId: 'att_1', kind: 'image', mediaType: 'image/png', name: 'a.png' }])
    expect(mockApi.send).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [{ attachmentId: 'att_1', kind: 'image', mime: 'image/png' }]
    }))
    expect(user?.status).toBe('acknowledged')
    expect(store.byId['msg-srv']).toBeDefined()   // migrateKey 后正式 ID
  })

  it('send 失败（附件已上传）→ 乐观消息 failed，附件不重复回退', async () => {
    const conv = useConversationStore()
    conv.$patch({ currentId: 'conv-1' })
    mockApi.send.mockRejectedValueOnce(new Error('[BACKEND_REJECTED] 队列已满'))
    const store = useMessageStore()
    await store.send('hi', { attachments: [{ attachmentId: 'att_1', kind: 'file', mediaType: 'application/pdf' }] })
    const user = Object.values(store.byId).find((m) => m.role === 'user')
    expect(user?.status).toBe('failed')
    expect(user?.attachments?.[0]?.attachmentId).toBe('att_1')
  })

  it('无附件时 send 行为不变（attachments 缺省）', async () => {
    const conv = useConversationStore()
    conv.$patch({ currentId: 'conv-1' })
    mockApi.send.mockResolvedValueOnce({ clientRequestId: 'c1' })
    const store = useMessageStore()
    await store.send('hi')
    expect(mockApi.send).toHaveBeenCalledWith(expect.not.objectContaining({ attachments: expect.anything() }))
  })
})
