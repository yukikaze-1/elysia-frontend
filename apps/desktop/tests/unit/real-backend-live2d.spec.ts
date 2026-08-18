// tests/unit/real-backend-live2d.spec.ts
// 阶段 5 批次 C（C3）：real-backend live2d.directive 分发 canary——复用 real-backend-voice.spec 协议桩模式：
// 冻结契约形状的帧按 Task 1 raw-schema → FrameMapper → Live2DDirectiveEvent emit；旧契约/畸形形状经
// raw-schema .strict() fail-closed 丢弃（RAW_FRAME_INVALID 告警，不 emit、不崩）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RealBackend, type WebSocketLike } from '../../src/main/transport/real-backend'
import type { BackendEvent } from '@shared/contracts'
import type { ProtocolWarning } from '@shared/contracts/protocol'

class FakeWs {
  private handlers: Record<string, (arg?: unknown) => void> = {}
  send = vi.fn()
  close = vi.fn()
  readyState = 1
  on(ev: string, cb: (arg?: unknown) => void): this { this.handlers[ev] = cb; return this }
  push(frame: unknown): void { this.handlers['message']?.(JSON.stringify(frame)) }
}

async function makeBackend(): Promise<{
  backend: RealBackend
  ws: FakeWs
  warnings: ProtocolWarning[]
  events: BackendEvent[]
}> {
  const ws = new FakeWs()
  const warnings: ProtocolWarning[] = []
  const events: BackendEvent[] = []
  const backend = new RealBackend({
    now: () => Date.now(),
    wsFactory: () => ws as WebSocketLike,
    onProtocolWarning: (w) => warnings.push(w)
  })
  backend.subscribe((e) => events.push(e))
  const p = backend.connect({ serverUrl: 'http://test.local', token: 'sk-test' })
  ws.push({ type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 0, byModel: {} } })
  ws.push({ type: 'server_info', protocol_version: '2.0', server_version: '0.4.0', features: {}, services: {}, connectionId: 'conn-1' })
  await p
  return { backend, ws, warnings, events }
}

beforeEach(() => { vi.clearAllMocks() })

describe('RealBackend live2d.directive 分发（C3 canary）', () => {
  it('冻结契约形状：live2d.directive 帧 → Live2DDirectiveEvent（expression/state/priority 透传 + 信封）', async () => {
    const { ws, events } = await makeBackend()
    ws.push({ type: 'live2d.directive', state: 'happy', expression: 'expressions/F01.exp3.json', priority: 1 })
    const dir = events.find((e) => e.event === 'live2d.directive')
    expect(dir).toBeDefined()
    expect(dir).toMatchObject({ event: 'live2d.directive', state: 'happy', expression: 'expressions/F01.exp3.json', priority: 1 })
    expect(typeof (dir as { eventId?: string }).eventId).toBe('string')
    expect(typeof (dir as { sequence?: number }).sequence).toBe('number')
  })

  it('冻结契约形状：motion/durationMs 可选字段透传', async () => {
    const { ws, events } = await makeBackend()
    ws.push({ type: 'live2d.directive', state: 'thinking', motion: 'motions/idle.motion3.json', priority: 2, durationMs: 8000 })
    const dir = events.find((e) => e.event === 'live2d.directive')
    expect(dir).toMatchObject({ event: 'live2d.directive', state: 'thinking', motion: 'motions/idle.motion3.json', priority: 2, durationMs: 8000 })
  })

  it('旧契约/畸形形状：raw-schema fail-closed 丢弃（不 emit、不崩）', async () => {
    const { ws, warnings, events } = await makeBackend()
    // 旧契约：嵌套 payload 包装（live2d.directive 契约已扁平化，旧形状 type 不符 .strict()）
    ws.push({ type: 'live2d.directive', payload: { state: 'happy', expression: 'expressions/F01.exp3.json' } })
    // 越界 state（error 已从七值剔除）
    ws.push({ type: 'live2d.directive', state: 'error', priority: 1 })
    // priority 越界（字面量联合 0|1|2|3 拒 5）
    ws.push({ type: 'live2d.directive', state: 'happy', priority: 5 })
    expect(events.filter((e) => e.event === 'live2d.directive')).toHaveLength(0)
    expect(warnings.some((w) => w.code === 'RAW_FRAME_INVALID')).toBe(true)
  })
})
