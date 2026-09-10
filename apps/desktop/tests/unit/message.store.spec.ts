// tests/unit/message.store.spec.ts
// Task 4:messageStore 流式应用——generation 守卫/归并(StreamAccumulator)/cancel 乐观置位/断线 in-flight/loadReplay/乐观发送。
// Task 7(批次B):事件归属守卫(generationByConversation)+ loadReplay 纯缓冲(pendingReplay)+ migrateKey 竞态守卫(I1)+ 断线清 local-*(I5)。
// env=node:不触 Electron——store 经 stores/desktop-api 注入 mock api(R2);pinia 用 createPinia + setActivePinia。
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useMessageStore } from '../../src/renderer/src/stores/message.store'
import { useConversationStore } from '../../src/renderer/src/stores/conversation.store'
import { useConnectionStore } from '../../src/renderer/src/stores/connection.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import type { BackendEvent, GenerationDeltaEvent, GenerationStartedEvent, Message } from '@shared/contracts'

// mock desktopApi(store 依赖注入)——通过 stores/desktop-api.types.ts 的 DesktopApiLike
const mockApi = {
  connect: vi.fn(), disconnect: vi.fn(), listConversations: vi.fn(), getMessages: vi.fn(),
  send: vi.fn(), cancel: vi.fn(), activate: vi.fn(), createConversation: vi.fn(),
  renameConversation: vi.fn(), deleteConversation: vi.fn(), getConnectionState: vi.fn(),
  getCredentialStatus: vi.fn(), setBackendToken: vi.fn(), clearBackendToken: vi.fn(),
  setEndpoint: vi.fn(), getEndpoint: vi.fn(), getRuntimeInfo: vi.fn(),
  onChatEvent: vi.fn(() => () => {}), onChatState: vi.fn(() => () => {}), onChatReplay: vi.fn(() => () => {}), onChatError: vi.fn(() => () => {}),
  hydratePersistence: vi.fn(), persistSession: vi.fn(), cacheMessages: vi.fn(), openExternal: vi.fn(), attachmentsValidate: vi.fn(), attachmentsUpload: vi.fn(), attachmentsCancel: vi.fn(), attachmentsCheck: vi.fn(),
  queryChatHistory: vi.fn(), getMessageContext: vi.fn(), listStickers: vi.fn(),
  listModelProfiles: vi.fn(), saveModelProfile: vi.fn(), deleteModelProfile: vi.fn(), testModelProfile: vi.fn(), activateModelProfile: vi.fn(), getActiveModelSelection: vi.fn(),
  listTtsVoices: vi.fn(), previewTts: vi.fn(), setTtsVoice: vi.fn(),
  // P4-B 语音/设置面
  voiceStartRecord: vi.fn(), voiceStopRecord: vi.fn(), voiceCommit: vi.fn(), voiceDiscard: vi.fn(),
  voiceStartRealtime: vi.fn(), voiceStopRealtime: vi.fn(), voiceCancelRealtime: vi.fn(),
  voiceStartDictation: vi.fn(), voiceStopDictation: vi.fn(), voiceCancelDictation: vi.fn(),
  audioCancel: vi.fn(), voiceSendAudio: vi.fn(), settingsLoad: vi.fn(), settingsSave: vi.fn(),
  listLive2dModels: vi.fn(),
  onToolEvent: vi.fn(() => () => {}), toolDecide: vi.fn(), toolCancel: vi.fn(), toolList: vi.fn(), toolPickSource: vi.fn(), toolConfirmUpload: vi.fn(), toolGrantDirectory: vi.fn(), toolListGrants: vi.fn(), toolRevokeGrant: vi.fn(), toolListHistory: vi.fn(),
  // 阶段 7 批次 A（Task 5）：诊断面（DesktopApiLike 全契约镜像——mock 补键）
  diagnosticsState: vi.fn(), diagnosticsDevModeSet: vi.fn(), diagnosticsOpenLogDir: vi.fn(), diagnosticsClearLogs: vi.fn(), diagnosticsExport: vi.fn(), onDiagnosticsDevEvent: vi.fn(() => () => {}), getLastCrash: vi.fn(),
}
// 注入机制定死(P1-3):stores/desktop-api.ts export let api + setDesktopApi;store 惰性 import { api };
// main.ts 调 setDesktopApi(window.desktopApi);测试 beforeEach 里 setDesktopApi(mockApi)(node env 无 window,不触全局)

// 守卫丢弃只记 warn + 计数器,静音避免刷屏(断言走 droppedEvents)
vi.spyOn(console, 'warn').mockImplementation(() => {})

// started 返回 GenerationStartedEvent(而非 BackendEvent 联合):completed 测试里 {...started(), event:'generation.completed'}
// 的联合展开会在缺少 responseId 的成员上无法赋给 BackendEvent,typecheck:node 需精确类型。
function started(): GenerationStartedEvent { return { eventId: 'e', sequence: 1, event: 'generation.started', generationId: 'gen-1', messageId: 'msg-1', responseId: 'gen-1', conversationId: 'conv-1', model: 'm1' } }
// delta 用精确 GenerationDeltaEvent（而非 BackendEvent 联合）：Task 4 后 BackendEvent 含无 generationId 的
// result 事件，{ ...delta(), generationId: 'gen-X' } 的联合展开会报 TS2345；精确类型下 spread 仍保持同一事件。
function delta(seg: string, seq: number, text: string): GenerationDeltaEvent { return { eventId: 'e', sequence: 2, event: 'generation.delta', generationId: 'gen-1', segmentId: seg, segmentIndex: 0, channel: 'public_reply', kind: 'markdown', deltaSequence: seq, text } }
function failed(code: string, message: string, retryable?: boolean): BackendEvent { return { eventId: 'e', sequence: 3, event: 'generation.failed', generationId: 'gen-1', error: { code, message, retryable } } }

function completedWithoutConversationId(generationId = 'gen-1', responseId = generationId): BackendEvent {
  return {
    eventId: `completed-${generationId}`,
    sequence: 3,
    event: 'generation.completed',
    generationId,
    responseId,
    usage: { input: 1, output: 2, total: 3, source: 'provider_reported' }
  }
}

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

  it('generation.completed 缺 conversationId 仍按 started 的 generation 归属完成，不回退 currentId', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.applyEvent(delta('seg-1', 0, '按 started 归属'))
    store.applyEvent(completedWithoutConversationId())

    expect(store.byId['msg-1']?.conversationId).toBe('conv-1')
    expect(store.byId['msg-1']?.status).toBe('completed')
    expect(store.byId['msg-1']?.assistantSegments?.[0]?.text).toBe('按 started 归属')
    expect(store.generationByConversation['gen-1']).toBeUndefined()
    expect(store.droppedEvents).toBe(0)
  })

  it('切换当前会话后 A 的无 conversationId terminal 不会写入 B', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.applyEvent(delta('segment-a', 0, 'A 的部分内容'))

    // The renderer intentionally has one active accumulator.  Starting B
    // closes A locally; a late A terminal must be rejected by generationId
    // ownership instead of being interpreted in the newly active session.
    setCurrent('conv-2')
    store.applyEvent({
      ...started(),
      generationId: 'gen-b',
      messageId: 'msg-b',
      responseId: 'gen-b',
      conversationId: 'conv-2'
    })
    store.applyEvent(completedWithoutConversationId('gen-b'))
    store.applyEvent(completedWithoutConversationId('gen-1'))

    expect(store.byId['msg-1']?.status).toBe('interrupted')
    expect(store.byId['msg-1']?.assistantSegments?.[0]?.text).toBe('A 的部分内容')
    expect(store.byId['msg-b']?.conversationId).toBe('conv-2')
    expect(store.byId['msg-b']?.status).toBe('completed')
    expect(store.byId['msg-b']?.assistantSegments).toEqual([])
    expect(store.droppedEvents).toBe(1)
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

  it('旧 cancel IPC 迟到不应中断新 generation', async () => {
    let resolveCancel!: () => void
    mockApi.cancel.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveCancel = resolve }))
    const store = useMessageStore()
    store.applyEvent(started())
    const cancelTask = store.cancel()

    // A newer generation takes ownership while the old cancel request is in
    // flight.  Its accumulator must remain streaming when the old response
    // finally settles.
    store.applyEvent({ ...started(), generationId: 'gen-2', messageId: 'msg-2', responseId: 'gen-2' })
    resolveCancel()
    await cancelTask

    expect(store.activeGenerationId).toBe('gen-2')
    expect(store.byId['msg-2']?.status).toBe('streaming')
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

  it('乐观贴图消息 ACK ID 迁移后保留 stickerId；恢复对象合并不重复不丢（P0-03 §5.4）', async () => {
    const conv = useConversationStore()
    conv.$patch({ currentId: 'conv-1' })
    mockApi.send.mockResolvedValueOnce({ clientRequestId: 'c1', serverMessageId: 'msg-srv-1' })
    const store = useMessageStore()
    await store.send('', 'st_1')
    const optimistic = Object.values(store.byId).find((m) => m.role === 'user')
    expect(optimistic?.messageId).toBe('msg-srv-1')      // migrateKey 迁移
    expect(optimistic?.stickerId).toBe('st_1')            // stickerId 保留
    const recovered: Message = { messageId: 'msg-srv-1', conversationId: 'conv-1', role: 'user', status: 'completed', createdAt: optimistic!.createdAt, stickerId: 'st_1' }
    store.loadReplay('conv-1', [recovered])
    const msgs = Object.values(store.byId).filter((m) => m.messageId === 'msg-srv-1')
    expect(msgs).toHaveLength(1)                          // 不重复
    expect(msgs[0].stickerId).toBe('st_1')                // 不丢
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

  it('FE-E2 connected A→B 同会话：旧 send ACK 迟到不得迁移/缓存/解锁 B 请求', async () => {
    mockApi.send.mockReset()
    mockApi.cacheMessages.mockReset()
    let resolveOld!: (ref: { clientRequestId: string; serverMessageId?: string }) => void
    let resolveNew!: (ref: { clientRequestId: string; serverMessageId?: string }) => void
    mockApi.send
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve }))
    const connectionStore = useConnectionStore()
    connectionStore.setState({ status: 'connected', serverUrl: 'http://backend-a', connectionId: 'A' })
    const store = useMessageStore()

    const oldRequest = store.send('来自 A')
    expect(store.sending).toBe(true)
    connectionStore.setState({ status: 'connected', serverUrl: 'http://backend-b', connectionId: 'B' })
    store.handleConnectionStateChange(connectionStore.state)
    const newRequest = store.send('来自 B')
    expect(store.sending).toBe(true)

    resolveOld({ clientRequestId: 'old', serverMessageId: 'server-old' })
    expect(await oldRequest).toBe(false)
    expect(store.byId['server-old']).toBeUndefined()
    expect(store.sending).toBe(true)
    expect(store.lastError).toBeUndefined()
    expect(mockApi.cacheMessages).not.toHaveBeenCalled()

    resolveNew({ clientRequestId: 'new', serverMessageId: 'server-new' })
    expect(await newRequest).toBe(true)
    expect(store.byId['server-new']).toBeDefined()
    expect(store.sending).toBe(false)
    expect(mockApi.cacheMessages).toHaveBeenCalledTimes(1)
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

  it('loadOlder 旧会话迟到页不会写入新会话，也不能解锁新请求', async () => {
    const store = useMessageStore()
    const conversations = useConversationStore()
    mockApi.getMessages.mockClear()
    store.loadPage({ items: [pageMsg('old-current', 't2')], hasMore: true, nextCursor: 'old-cursor' })
    store.setPageMeta({ items: [pageMsg('old-current', 't2')], hasMore: true, nextCursor: 'old-cursor' })
    let resolveOld!: (page: unknown) => void
    let resolveNew!: (page: unknown) => void
    mockApi.getMessages
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve }))

    const oldTask = store.loadOlder()
    await vi.waitFor(() => expect(mockApi.getMessages).toHaveBeenCalledTimes(1))
    conversations.$patch({ currentId: 'new-conversation' })
    store.resetConversation('new-conversation')
    store.$patch({ hasMoreBefore: true, beforeCursor: 'new-cursor' })
    const newTask = store.loadOlder()
    await vi.waitFor(() => expect(mockApi.getMessages).toHaveBeenCalledTimes(2))

    resolveOld({ items: [pageMsg('old-late', 't0')], hasMore: false })
    await oldTask
    expect(store.loadingOlder).toBe(true)
    expect(store.byId['old-late']).toBeUndefined()

    resolveNew({ items: [{ ...pageMsg('new-message', 't1'), conversationId: 'new-conversation' }], hasMore: false })
    await newTask
    expect(store.loadingOlder).toBe(false)
    expect(store.byId['new-message']).toBeDefined()
    expect(store.beforeCursor).toBeUndefined()
  })

  it('loadEarlier 的旧 owner 跨会话迟到不覆盖新游标/状态', async () => {
    const store = useMessageStore()
    const conversations = useConversationStore()
    mockApi.getMessages.mockClear()
    store.$patch({ nextCursor: 'old-earlier' })
    let resolveOld!: (page: unknown) => void
    let resolveNew!: (page: unknown) => void
    mockApi.getMessages
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve }))
    const oldTask = store.loadEarlier()
    await vi.waitFor(() => expect(mockApi.getMessages).toHaveBeenCalledTimes(1))

    conversations.$patch({ currentId: 'new-conversation' })
    store.resetConversation('new-conversation')
    store.$patch({ nextCursor: 'new-earlier' })
    const newTask = store.loadEarlier()
    await vi.waitFor(() => expect(mockApi.getMessages).toHaveBeenCalledTimes(2))

    resolveOld({ items: [{ ...pageMsg('old-earlier-message', 't0'), conversationId: 'conv-1' }], hasMore: false })
    await oldTask
    expect(store.loadingEarlier).toBe(true)
    expect(store.byId['old-earlier-message']).toBeUndefined()
    expect(store.nextCursor).toBe('new-earlier')

    resolveNew({ items: [{ ...pageMsg('new-earlier-message', 't1'), conversationId: 'new-conversation' }], hasMore: false })
    await newTask
    expect(store.loadingEarlier).toBe(false)
    expect(store.nextCursor).toBeUndefined()
    expect(store.byId['new-earlier-message']).toBeDefined()
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

describe('message.store 高亮与上下文窗口（spec §4.5，D5/D6/P2-3）', () => {
  beforeEach(() => { setActivePinia(createPinia()); setDesktopApi(mockApi); setCurrent('conv-1') })

  it('setHighlight/clearHighlight 维护高亮状态（含分段）', () => {
    const store = useMessageStore()
    store.setHighlight('m1', 'seg1')
    expect(store.highlightMessageId).toBe('m1')
    expect(store.highlightSegmentId).toBe('seg1')
    store.clearHighlight()
    expect(store.highlightMessageId).toBeUndefined()
  })
  it('loadContextWindow：getMessageContext 窗口 + 首页游标初始化 + 去重合并', async () => {
    setDesktopApi({
      getMessageContext: async () => ({ items: [
        { messageId: 'm1', conversationId: 'c1', role: 'user', status: 'completed', createdAt: '2026-08-14T02:00:00.000Z', content: '命中' },
        { messageId: 'm2', conversationId: 'c1', role: 'assistant', status: 'completed', createdAt: '2026-08-14T02:00:10.000Z' }
      ], hasMore: false }),
      getMessages: async () => ({ items: [
        { messageId: 'm1', conversationId: 'c1', role: 'user', status: 'completed', createdAt: '2026-08-14T02:00:00.000Z', content: '命中' },
        { messageId: 'm0', conversationId: 'c1', role: 'user', status: 'completed', createdAt: '2026-08-14T01:00:00.000Z', content: '更早' }
      ], hasMore: true, nextCursor: 'cur-1' })
    } as never)
    const conversationStore = useConversationStore()
    conversationStore.$patch({ currentId: 'c1' })
    const store = useMessageStore()
    store.resetConversation('c1')
    const ok = await store.loadContextWindow('m1')
    expect(ok).toBe(true)
    expect(store.nextCursor).toBe('cur-1')
    // P1-2：首页游标经 setPageMeta 初始化 hasMoreBefore/beforeCursor——跳转后顶部哨兵可据此续接更早历史
    expect(store.hasMoreBefore).toBe(true)
    expect(store.beforeCursor).toBe('cur-1')
    // P1-1：getMessageContext 返回 [m1,m2] + 首页 getMessages 返回 [m1,m0]，loadPage 按 messageId 去重合并 → m0/m1/m2 共 3 条
    expect(store.order.length).toBe(3)
    expect(store.byId.m1).toBeDefined()
  })
  it('P1-4：loadContextWindow 中途切会话 → 上下文页不污染新会话列表（await 后 currentId 守卫）', async () => {
    let resolveCtx!: (v: unknown) => void
    setDesktopApi({ getMessageContext: () => new Promise((r) => { resolveCtx = r }) } as never)
    const conversationStore = useConversationStore()
    conversationStore.$patch({ currentId: 'c1' })
    const store = useMessageStore()
    store.resetConversation('c1')
    const p = store.loadContextWindow('m1')
    // 中途切到 c2（activate 会 resetConversation）
    conversationStore.$patch({ currentId: 'c2' })
    store.resetConversation('c2')
    resolveCtx({ items: [
      { messageId: 'm1', conversationId: 'c1', role: 'user', status: 'completed', createdAt: 't', content: 'x' }
    ], hasMore: false })
    const ok = await p
    expect(ok).toBe(false)          // 守卫丢弃 → 返回 false（不提交上下文）
    expect(store.byId.m1).toBeUndefined()   // c1 上下文不得进入 c2 列表
    expect(store.order).toHaveLength(0)
  })
  it('FE-E2：同会话同连接的上下文请求 latest-wins，A 不得覆盖 B 的消息或 cursor', async () => {
    let resolveCtxA!: (value: unknown) => void
    let resolveCtxB!: (value: unknown) => void
    let resolveFirstB!: (value: unknown) => void
    const getMessageContext = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveCtxA = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveCtxB = resolve }))
    const getMessages = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirstB = resolve }))
    setDesktopApi({ getMessageContext, getMessages } as never)
    const conversationStore = useConversationStore()
    conversationStore.$patch({ currentId: 'c1' })
    const store = useMessageStore()
    store.resetConversation('c1')

    const requestA = store.loadContextWindow('anchor-a')
    const requestB = store.loadContextWindow('anchor-b')
    expect(getMessageContext).toHaveBeenCalledTimes(2)

    resolveCtxB({ items: [
      { messageId: 'b-context', conversationId: 'c1', role: 'user', status: 'completed', createdAt: '2026-08-14T02:00:00.000Z', content: 'B context' }
    ], hasMore: false })
    await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(1))
    resolveFirstB({ items: [
      { messageId: 'b-first', conversationId: 'c1', role: 'assistant', status: 'completed', createdAt: '2026-08-14T02:00:10.000Z', content: 'B first' }
    ], hasMore: true, nextCursor: 'cursor-b' })
    expect(await requestB).toBe(true)

    // A resumes only after B has committed.  Its owner check is expected to
    // stop it before loadPage/reorder or the second REST request.
    resolveCtxA({ items: [
      { messageId: 'a-context', conversationId: 'c1', role: 'user', status: 'completed', createdAt: '2026-08-14T01:00:00.000Z', content: 'A context' }
    ], hasMore: false })
    expect(await requestA).toBe(false)
    expect(getMessages).toHaveBeenCalledTimes(1)
    expect(store.byId['b-context']).toBeDefined()
    expect(store.byId['b-first']).toBeDefined()
    expect(store.byId['a-context']).toBeUndefined()
    expect(store.nextCursor).toBe('cursor-b')
  })
  it('P1-4：loadPage 跳过非当前会话消息（迟到的异流 REST 页不污染列表）', () => {
    const conversationStore = useConversationStore()
    conversationStore.$patch({ currentId: 'conv-1' })
    const store = useMessageStore()
    store.loadPage({ items: [
      { messageId: 'mine', conversationId: 'conv-1', role: 'user', content: 'x', status: 'completed', createdAt: 't' } as Message,
      { messageId: 'other', conversationId: 'conv-2', role: 'user', content: 'y', status: 'completed', createdAt: 't' } as Message
    ], hasMore: false })
    expect(store.byId.mine).toBeDefined()
    expect(store.byId.other).toBeUndefined()
    expect(store.order).toEqual(['mine'])
  })
  it('P1-2：loadEarlier 成功后同步 hasMoreBefore/beforeCursor（哨兵两路径状态一致，防 nextCursor 耗尽后回退 loadOlder 用陈旧游标）', async () => {
    let called = 0
    setDesktopApi({ getMessages: async () => { called++; return { items: [], hasMore: false, nextCursor: undefined } } } as never)
    const conversationStore = useConversationStore()
    conversationStore.$patch({ currentId: 'c1' })
    const store = useMessageStore()
    store.resetConversation('c1')
    store.$patch({ nextCursor: 'cur-1', hasMoreBefore: true, beforeCursor: 'cur-1' })   // 模拟 loadContextWindow 后初始状态
    await store.loadEarlier()
    expect(called).toBe(1)
    expect(store.nextCursor).toBeUndefined()
    expect(store.hasMoreBefore).toBe(false)      // 同步：与 nextCursor 一致，不回退陈旧 loadOlder
    expect(store.beforeCursor).toBeUndefined()
  })
  it('loadEarlier：!nextCursor 早退（镜像 getMore）；成功后更新游标', async () => {
    let called = 0
    setDesktopApi({ getMessages: async () => { called++; return { items: [], hasMore: false, nextCursor: undefined } } } as never)
    const conversationStore = useConversationStore()
    conversationStore.$patch({ currentId: 'c1' })
    const store = useMessageStore()
    store.resetConversation('c1')
    await store.loadEarlier()          // 无 nextCursor → 早退
    expect(called).toBe(0)
    store.$patch({ nextCursor: 'cur-1' })
    await store.loadEarlier()
    expect(called).toBe(1)
  })
  it('send 携带 stickerId 透传 + 乐观消息标记', async () => {
    const sent: unknown[] = []
    setDesktopApi({ send: async (input: unknown) => { sent.push(input); return { clientRequestId: 'cr1', serverMessageId: 'sm1' } } } as never)
    const conversationStore = useConversationStore()
    conversationStore.$patch({ currentId: 'c1' })
    const store = useMessageStore()
    store.resetConversation('c1')
    await store.send('', 'st_1')
    expect(sent[0]).toMatchObject({ conversationId: 'c1', text: '', stickerId: 'st_1' })
  })
})

describe('P4-B 语音扩展：voice_session.turn + sendVoiceCommit（spec §5.11）', () => {
  function turn(msgId: string, text: string, conversationId?: string): BackendEvent {
    return { eventId: 'e', sequence: 9, event: 'voice_session.turn', sessionId: 'sess-1', turnId: 1, messageId: msgId, conversationId, text }
  }

  beforeEach(() => { setActivePinia(createPinia()); setDesktopApi(mockApi); setCurrent('conv-1'); vi.clearAllMocks() })

  it('voice_session.turn 匹配当前会话 → 插入 user acknowledged 消息（后端预分配 messageId，非乐观）', () => {
    const store = useMessageStore()
    store.applyEvent(turn('msg-v1', '实时语音内容', 'conv-1'))
    expect(store.byId['msg-v1']).toBeDefined()
    expect(store.byId['msg-v1']?.role).toBe('user')
    expect(store.byId['msg-v1']?.status).toBe('acknowledged')
    expect(store.byId['msg-v1']?.content).toBe('实时语音内容')
    expect(store.byId['msg-v1']?.conversationId).toBe('conv-1')
    expect(store.droppedEvents).toBe(0)
  })

  it('voice_session.turn 无 conversationId → 归属当前会话插入', () => {
    const store = useMessageStore()
    store.applyEvent(turn('msg-v2', '无会话字段'))
    expect(store.byId['msg-v2']?.conversationId).toBe('conv-1')
    expect(store.droppedEvents).toBe(0)
  })

  it('voice_session.turn 归属不匹配 → guardDropEvent 丢弃 + 计数', () => {
    setCurrent('conv-2')
    const store = useMessageStore()
    store.applyEvent(turn('msg-v3', '别的会话', 'conv-1'))
    expect(store.byId['msg-v3']).toBeUndefined()
    expect(store.droppedEvents).toBe(1)
  })

  it('voice_session.turn 无活动会话 → 丢弃（不插入无 conversationId 消息）', () => {
    setCurrent(undefined)
    const store = useMessageStore()
    store.applyEvent(turn('msg-v4', '无会话'))
    expect(store.byId['msg-v4']).toBeUndefined()
    expect(store.droppedEvents).toBe(1)
  })

  it('sendVoiceCommit 乐观 pending → migrateKey + acknowledged + push cache → true', async () => {
    const conv = useConversationStore()
    conv.$patch({ currentId: 'conv-1' })
    mockApi.voiceCommit.mockResolvedValue({ clientRequestId: 'c1', serverMessageId: 'msg-voice-1' })
    const store = useMessageStore()
    const ok = await store.sendVoiceCommit('rec-1', '语音内容')
    expect(ok).toBe(true)
    expect(mockApi.voiceCommit).toHaveBeenCalledWith(expect.objectContaining({
      recordingId: 'rec-1', text: '语音内容', conversationId: 'conv-1',
      clientRequestId: expect.any(String), clientMessageId: expect.any(String)
    }))
    expect(store.byId['msg-voice-1']).toBeDefined()   // migrateKey 后正式 ID
    expect(store.byId['msg-voice-1']?.role).toBe('user')
    expect(store.byId['msg-voice-1']?.status).toBe('acknowledged')
    expect(store.byId['msg-voice-1']?.content).toBe('语音内容')
    expect(store.order).not.toContain(expect.stringMatching(/^local-/))
  })

  it('FE-E2 connected A→B 同会话：旧 voice ACK 迟到不得迁移，且不得解锁新的 text send', async () => {
    mockApi.voiceCommit.mockReset()
    mockApi.send.mockReset()
    mockApi.cacheMessages.mockReset()
    let resolveOld!: (ref: { clientRequestId: string; serverMessageId?: string }) => void
    let resolveNew!: (ref: { clientRequestId: string; serverMessageId?: string }) => void
    mockApi.voiceCommit.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
    mockApi.send.mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve }))
    const connectionStore = useConnectionStore()
    connectionStore.setState({ status: 'connected', serverUrl: 'http://backend-a', connectionId: 'A' })
    const store = useMessageStore()

    const oldRequest = store.sendVoiceCommit('recording-a', '来自 A 的语音')
    connectionStore.setState({ status: 'connected', serverUrl: 'http://backend-b', connectionId: 'B' })
    store.handleConnectionStateChange(connectionStore.state)
    const newRequest = store.send('来自 B 的文字')
    expect(store.sending).toBe(true)

    resolveOld({ clientRequestId: 'old-voice', serverMessageId: 'server-old-voice' })
    expect(await oldRequest).toBe(false)
    expect(store.byId['server-old-voice']).toBeUndefined()
    expect(store.sending).toBe(true)
    expect(store.lastError).toBeUndefined()
    expect(mockApi.cacheMessages).not.toHaveBeenCalled()

    resolveNew({ clientRequestId: 'new-text', serverMessageId: 'server-new-text' })
    expect(await newRequest).toBe(true)
    expect(store.byId['server-new-text']).toBeDefined()
    expect(store.sending).toBe(false)
    expect(mockApi.cacheMessages).toHaveBeenCalledTimes(1)
  })

  it('sendVoiceCommit 失败 → failed + lastError + false（调用方保留待发送条）', async () => {
    const conv = useConversationStore()
    conv.$patch({ currentId: 'conv-1' })
    mockApi.voiceCommit.mockRejectedValue(new Error('[BACKEND_REJECTED] 队列已满'))
    const store = useMessageStore()
    const ok = await store.sendVoiceCommit('rec-1', '语音内容')
    expect(ok).toBe(false)
    const user = Object.values(store.byId).find((m) => m.role === 'user')
    expect(user?.status).toBe('failed')
    expect(store.lastError?.message).toContain('队列已满')
    expect(store.sending).toBe(false)
  })

  it('sendVoiceCommit 无活动会话 → false 且不插入消息', async () => {
    setCurrent(undefined)
    const store = useMessageStore()
    const ok = await store.sendVoiceCommit('rec-1', 'x')
    expect(ok).toBe(false)
    expect(mockApi.voiceCommit).not.toHaveBeenCalled()
    expect(Object.keys(store.byId)).toHaveLength(0)
  })

  it('sendVoiceCommit 断线清理（I5 同口径）：未确认乐观消息随断线移除', async () => {
    let resolveCommit!: (ref: { clientRequestId: string; serverMessageId?: string }) => void
    mockApi.voiceCommit.mockImplementationOnce(() => new Promise((res) => { resolveCommit = res }))
    const conv = useConversationStore()
    conv.$patch({ currentId: 'conv-1' })
    const store = useMessageStore()
    const p = store.sendVoiceCommit('rec-1', '语音')
    const localKey = Object.keys(store.byId).find((k) => k.startsWith('local-'))
    expect(localKey).toBeDefined()
    expect(store.byId[localKey!]?.status).toBe('pending')
    store.handleConnectionStateChange({ status: 'reconnecting' })
    expect(store.byId[localKey!]).toBeUndefined()   // pending local-* 乐观消息被清
    resolveCommit({ clientRequestId: 'c1', serverMessageId: 'msg-voice-1' })
    await p
    expect(store.byId['msg-voice-1']).toBeUndefined() // I1：旧 key 已清，migrate 不重插
  })
})
