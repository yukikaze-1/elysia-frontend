// tests/unit/real-backend-session-usage.spec.ts
// C2 展示半边（2026-09-15）：`session.token_stats` → 领域 `ConversationTokenUsage`，随回放交给装配层。
//
// 为什么单列一条：这个字段此前**被 schema 接纳后整段丢弃**（`raw-schemas` 校验、`raw-types` 有类型、
// 无任何消费方），于是"会话级累计"只在本次连接内生成过一次之后才存在，重连/重启打开历史会话时是空的。
// 本文件钉住三件事：①有记录 → 映射出带来源标签的领域对象；②**无记录 → undefined（≠ 0）**；
// ③形状漂移 → 整帧拒绝（不猜、不降级成半截数字）。
import { describe, expect, it, vi } from 'vitest'
import { RealBackend, type WebSocketLike } from '../../src/main/transport/real-backend'
import type { ConversationTokenUsage, Message } from '@shared/contracts'

type Handler = (arg?: unknown, arg2?: unknown) => void
type HandlerSet = Partial<Record<'open' | 'message' | 'close' | 'error' | 'unexpected-response', Handler>>

interface Replay { conversationId: string; messages: Message[]; usage?: ConversationTokenUsage }

function harness(): {
  backend: RealBackend
  push: (frame: unknown) => void
  replays: Replay[]
  warnings: string[]
} {
  const handlers: HandlerSet = {}
  const ws: WebSocketLike = {
    on: (event, callback) => { handlers[event] = callback },
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1
  }
  const replays: Replay[] = []
  const warnings: string[] = []
  const backend = new RealBackend({
    now: () => Date.now(),
    wsFactory: () => ws,
    // 帧校验失败经 onProtocolWarning 上报（不是 logger——logger 只承接映射期异常）
    onProtocolWarning: (warning) => { warnings.push(warning.code) },
    onSessionReplay: (conversationId, messages, usage) => { replays.push({ conversationId, messages, usage }) }
  })
  return { backend, push: (frame) => handlers.message?.(Buffer.from(JSON.stringify(frame))), replays, warnings }
}

async function connectWith(
  h: ReturnType<typeof harness>,
  sessionFrame: unknown
): Promise<void> {
  const pending = h.backend.connect({ serverUrl: 'http://backend.example', token: 't' })
  h.push(sessionFrame)
  h.push({ type: 'server_info', protocol_version: '2.0', server_version: 'v', features: {}, services: {}, connectionId: 'conn-1' })
  await pending
}

describe('session.token_stats → 会话级累计', () => {
  it('有记录 → 映射为 {total, byModel, source: server_aggregate}', async () => {
    const h = harness()
    await connectWith(h, {
      type: 'session',
      conversationId: 'conv-1',
      messages: [],
      token_stats: { total: 1234, byModel: { 'm-a': 1000, 'm-b': 234 } }
    })
    expect(h.replays).toHaveLength(1)
    expect(h.replays[0].conversationId).toBe('conv-1')
    expect(h.replays[0].usage).toEqual({
      total: 1234,
      byModel: { 'm-a': 1000, 'm-b': 234 },
      source: 'server_aggregate'
    })
    await h.backend.disconnect()
  })

  it('无记录（token_stats 缺省）→ usage undefined：不是"累计 0"，消费方据此隐藏整条', async () => {
    const h = harness()
    await connectWith(h, { type: 'session', conversationId: 'conv-1', messages: [] })
    expect(h.replays).toHaveLength(1)
    expect(h.replays[0].usage).toBeUndefined()
    await h.backend.disconnect()
  })

  it('byModel 形状漂移 → 整帧拒绝（不降级成半截数字），回放不投递', async () => {
    const h = harness()
    await connectWith(h, {
      type: 'session',
      conversationId: 'conv-1',
      messages: [],
      token_stats: { total: 5, byModel: { 'm-a': 'not-a-number' } }
    })
    expect(h.replays).toHaveLength(0)
    expect(h.warnings).toContain('RAW_FRAME_INVALID')
    await h.backend.disconnect()
  })

  it('token_stats 为 null → 帧校验失败（严格 schema：缺省才是"没有记录"，null 是协议漂移）', async () => {
    const h = harness()
    await connectWith(h, { type: 'session', conversationId: 'conv-1', messages: [], token_stats: null })
    expect(h.replays).toHaveLength(0)
    expect(h.warnings).toContain('RAW_FRAME_INVALID')
    await h.backend.disconnect()
  })

  it('TTS/音频等其它帧不受影响：同一连接上非 session 帧仍按原路径处理', async () => {
    const h = harness()
    await connectWith(h, { type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 7, byModel: { 'm-a': 7 } } })
    // state/typing 是契约识别但有意不消费的帧；它们到达不得改变回放结果或触发额外回放
    h.push({ type: 'state', state: 'idle' })
    h.push({ type: 'typing', typing: true })
    expect(h.replays).toHaveLength(1)
    expect(h.replays[0].usage?.total).toBe(7)
    await h.backend.disconnect()
  })
})
