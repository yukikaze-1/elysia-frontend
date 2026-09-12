// tests/unit/message-store-generation-exit.spec.ts
// H-10（2026-09-11）：流式生命周期的**客户端出口**。
//
// 评审核实的缺陷：`message.store.ts` 里 `activeGenerationId` / `status:'streaming'` 一旦置位
// 就永不过期（该文件当时零个 `setTimeout`），Main 的超时全部键在别处（ack/handshake/REST/upload）
// 而没有一条键在 generation 上，IPC invoke 两端也没有超时。于是 WS 仍连着（不触发唯一那条
// 自动恢复路径 `advanceConnectionSession`）而后端卡住或丢终态时，气泡永久 `is-streaming` +
// 「生成中…」；唯一出口是停止按钮，而它要等一个可能永不返回的 IPC 往返；切会话后连这个按钮都没了，
// 用户仍在消耗后端 token 却无法取消。
//
// 本 spec 钉住三条出口：① 静默到期自动收敛；② 取消**乐观**（await 前就落本地状态）；
// ③ 离开会话时通知后端取消（否则本地无入口而后端继续生成）。
//
// 用假定时器推进：真实 50s 窗口无法在单测里等待，而 sleep 既慢又不可复现。
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useMessageStore } from '../../src/renderer/src/stores/message.store'
import { useConversationStore } from '../../src/renderer/src/stores/conversation.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { createDesktopApiMock } from './helpers/desktop-api'
import { GENERATION_SILENCE_TIMEOUT_MS } from '../../src/renderer/src/utils/generation-watchdog'
import type { BackendEvent, GenerationDeltaEvent, GenerationStartedEvent } from '@shared/contracts'

// I-06 / P2-10：原为手搓的 DesktopApiLike 全契约镜像（每个键裸 `vi.fn()`）。
const mockApi = createDesktopApiMock()

vi.spyOn(console, 'warn').mockImplementation(() => {})

function started(): GenerationStartedEvent {
  return { eventId: 'e', sequence: 1, event: 'generation.started', generationId: 'gen-1', messageId: 'msg-1', responseId: 'gen-1', conversationId: 'conv-1', model: 'm1' }
}
function delta(seq: number, text: string): GenerationDeltaEvent {
  return { eventId: 'e', sequence: 2, event: 'generation.delta', generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 0, channel: 'public_reply', kind: 'markdown', deltaSequence: seq, text }
}
function completed(gen = 'gen-1'): BackendEvent {
  return { eventId: 'c', sequence: 3, event: 'generation.completed', generationId: gen, responseId: gen, usage: { input: 1, output: 2, total: 3, source: 'provider_reported' } }
}
function setCurrent(id: string | undefined): void {
  useConversationStore().$patch({ currentId: id })
}

describe('messageStore 生成出口（H-10）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    setDesktopApi(mockApi)
    setCurrent('conv-1')
    vi.clearAllMocks()
    // 注意：clearAllMocks 只清调用记录，**不清实现**（那是 resetAllMocks）。故必须显式给 cancel
    // 一个会 resolve 的实现——否则用例④注入的「永不 resolve」会跨用例泄漏，让后续 await 全部挂死
    // （本轮实测：用例⑤因此超时 5s，而非断言失败）。
    mockApi.cancel.mockResolvedValue(undefined)
  })
  afterEach(() => { vi.useRealTimers() })

  it('① 静默到期：无任何事件时自动收敛为 interrupted + 可见原因，不再永久「生成中」', () => {
    // 这是本缺陷的核心场景：后端在窗口内一个事件都没发（含丢终态、卡死、completing 滞留）。
    const store = useMessageStore()
    store.applyEvent(started())
    expect(store.byId['msg-1']?.status).toBe('streaming')
    expect(store.activeGenerationId).toBe('gen-1')

    // 窗口未到期：必须仍然是 streaming（否则会把慢首 token 的正常生成误判为卡死）
    vi.advanceTimersByTime(GENERATION_SILENCE_TIMEOUT_MS - 1)
    expect(store.byId['msg-1']?.status, '窗口内不得提前判死').toBe('streaming')

    vi.advanceTimersByTime(1)
    expect(store.byId['msg-1']?.status).toBe('interrupted')
    expect(store.activeGenerationId, '必须释放活动代，否则停止按钮与 canSend 永远卡住').toBeUndefined()
    expect(store.lastError?.code, '必须给出可见原因，而不是静默恢复').toBe('GENERATION_STALLED')
  })

  it('② 事件会重置窗口：持续输出不被打断，静默后才到期', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    // 每 40s 来一个 delta，共三次：累计 120s 远超单个窗口，但每次静默都不足 50s
    for (const seq of [0, 1, 2]) {
      vi.advanceTimersByTime(40_000)
      store.applyEvent(delta(seq, `片段${seq}`))
      expect(store.byId['msg-1']?.status, `第 ${seq + 1} 次事件后仍在生成`).toBe('streaming')
    }
    // 此后停止输出 → 满一个窗口即到期
    vi.advanceTimersByTime(GENERATION_SILENCE_TIMEOUT_MS - 1)
    expect(store.byId['msg-1']?.status).toBe('streaming')
    vi.advanceTimersByTime(1)
    expect(store.byId['msg-1']?.status).toBe('interrupted')
  })

  it('③ 终态解除窗口：completed 后到期不得把已完成的消息改成 interrupted', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.applyEvent(delta(0, '你好'))
    store.applyEvent(completed())
    expect(store.byId['msg-1']?.status).toBe('completed')

    vi.advanceTimersByTime(GENERATION_SILENCE_TIMEOUT_MS * 2)
    expect(store.byId['msg-1']?.status, '终态后看门狗必须已解除（否则会改写已完成消息）').toBe('completed')
    expect(store.lastError).toBeUndefined()
  })

  it('④ 取消是乐观的：api.cancel 永不 resolve 时本地也必须立刻停止', async () => {
    // 原实现先 await api.cancel 再改本地状态，而这条 IPC 两端都没有超时——
    // 后端卡住时点「停止」没反应，正是本缺陷要消除的场景。
    mockApi.cancel.mockReturnValue(new Promise(() => { /* 永不 resolve */ }))
    const store = useMessageStore()
    store.applyEvent(started())

    void store.cancel() // 故意不 await：本地状态必须在 await 之前就落定

    expect(store.byId['msg-1']?.status, '用户点停止必须立刻看到停止').toBe('interrupted')
    expect(store.activeGenerationId).toBeUndefined()
    expect(mockApi.cancel).toHaveBeenCalledWith({ generationId: 'gen-1' })
    await Promise.resolve()
  })

  it('⑤ 取消带归属栅栏：已切走的代不得被旧取消响应标成 interrupted', async () => {
    const store = useMessageStore()
    store.applyEvent(started())
    // 取消发起前会话已被切走（applyCancelLocally 的栅栏读的就是此刻状态）
    setCurrent('conv-other')
    await store.cancel()
    // 该代不再归属当前会话 → 不落 interrupted，也不清理（清理归 resetConversation/断线路径）
    expect(store.byId['msg-1']?.status).toBe('streaming')
  })

  it('⑥ 离开会话时通知后端取消：resetConversation 必须真的调 api.cancel', async () => {
    // 缺陷后果：resetConversation 清掉 activeGenerationId 后停止按钮消失，
    // 而后端仍在生成——用户持续消耗 token 却没有任何取消入口。
    mockApi.cancel.mockResolvedValue(undefined)
    const store = useMessageStore()
    store.applyEvent(started())

    store.resetConversation('conv-2')

    expect(mockApi.cancel, '切会话/删除/断线都必须通知后端取消').toHaveBeenCalledWith({ generationId: 'gen-1' })
    expect(store.activeGenerationId).toBeUndefined()
    expect(store.order).toEqual([])
  })

  it('⑦ 无活动生成时离开会话不产生多余取消请求', () => {
    const store = useMessageStore()
    store.resetConversation('conv-2')
    expect(mockApi.cancel).not.toHaveBeenCalled()
  })

  it('⑧ 断线解除窗口并收敛：断线后到期不得再改动消息', async () => {
    const store = useMessageStore()
    store.applyEvent(started())
    // 断线路径：in-flight → interrupted + 清 activeGenerationId
    const { useConnectionStore } = await import('../../src/renderer/src/stores/connection.store')
    useConnectionStore().$patch({ state: { ...useConnectionStore().state, status: 'disconnected' } })
    store.handleConnectionStateChange(useConnectionStore().state)
    expect(store.byId['msg-1']?.status).toBe('interrupted')

    vi.advanceTimersByTime(GENERATION_SILENCE_TIMEOUT_MS * 2)
    expect(store.byId['msg-1']?.status, '断线已终结该流，看门狗不得再写').toBe('interrupted')
  })
})
