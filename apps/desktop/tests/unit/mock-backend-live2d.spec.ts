// tests/unit/mock-backend-live2d.spec.ts
// 阶段 5 批次 C（C3）：mock 指令消费 env 桥——parseMockDirectiveEnv（CYRENE_MOCK_DIRECTIVE 解析/校验）+
// scheduleReplay 落 generation.completed 后追加 live2d.directive 帧（对齐 emotion 注入点）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MockBackend, parseMockDirectiveEnv } from '../../src/main/transport/mock-backend'
import type { BackendEvent } from '@shared/contracts'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

beforeEach(() => { vi.clearAllMocks() })

describe('parseMockDirectiveEnv（CYRENE_MOCK_DIRECTIVE 解析/校验）', () => {
  it('undefined / 空串 / 非法 JSON / 非对象 → undefined（缺省不发射）', () => {
    expect(parseMockDirectiveEnv(undefined)).toBeUndefined()
    expect(parseMockDirectiveEnv('')).toBeUndefined()
    expect(parseMockDirectiveEnv('   ')).toBeUndefined()
    expect(parseMockDirectiveEnv('not-json')).toBeUndefined()
    expect(parseMockDirectiveEnv('"just-a-string"')).toBeUndefined()
    expect(parseMockDirectiveEnv('42')).toBeUndefined()
    expect(parseMockDirectiveEnv('[1,2,3]')).toBeUndefined()
    expect(parseMockDirectiveEnv('{}')).toBeUndefined() // 空载荷（无 state/expression/motion）→ 不发射
  })

  it('字段校验：state 越界 / priority 越界 / durationMs 越界 / 空字符串 → undefined', () => {
    expect(parseMockDirectiveEnv('{"state":"working"}')).toBeUndefined() // working 非七值
    expect(parseMockDirectiveEnv('{"state":"error"}')).toBeUndefined() // error 已从 DirectiveState 剔除
    expect(parseMockDirectiveEnv('{"state":"happy","priority":5}')).toBeUndefined()
    expect(parseMockDirectiveEnv('{"state":"happy","priority":-1}')).toBeUndefined()
    expect(parseMockDirectiveEnv('{"state":"happy","durationMs":40000}')).toBeUndefined()
    expect(parseMockDirectiveEnv('{"state":"happy","durationMs":-5}')).toBeUndefined()
    expect(parseMockDirectiveEnv('{"state":"happy","expression":""}')).toBeUndefined()
    expect(parseMockDirectiveEnv('{"state":"happy","expression":123}')).toBeUndefined()
  })

  it('合法载荷 → 透传 Omit<RawLive2DDirective, "type">（缺省字段省略，不补默认）', () => {
    expect(parseMockDirectiveEnv('{"state":"happy","expression":"expressions/F01.exp3.json","priority":1}')).toEqual({
      state: 'happy', expression: 'expressions/F01.exp3.json', priority: 1
    })
    expect(parseMockDirectiveEnv('{"state":"thinking","priority":2,"durationMs":8000,"motion":"motions/idle.motion3.json"}')).toEqual({
      state: 'thinking', priority: 2, durationMs: 8000, motion: 'motions/idle.motion3.json'
    })
    // 七值边界 + priority/durationMs 上下限合法
    expect(parseMockDirectiveEnv('{"state":"idle","priority":0,"durationMs":0}')).toEqual({ state: 'idle', priority: 0, durationMs: 0 })
    expect(parseMockDirectiveEnv('{"state":"surprised","priority":3,"durationMs":30000}')).toEqual({ state: 'surprised', priority: 3, durationMs: 30000 })
  })
})

describe('MockBackend.directive（generation.completed 后追加 live2d.directive）', () => {
  it('directive 注入：generation.completed 之后发射 live2d.directive（紧邻 completed）', async () => {
    const backend = new MockBackend({
      emitDelayMs: 1,
      directive: { state: 'happy', expression: 'expressions/F01.exp3.json', priority: 1 }
    })
    const ev: BackendEvent[] = []
    backend.subscribe((e) => ev.push(e))
    await backend.connect({ serverUrl: 'mock://test' })
    await backend.sendMessage({ conversationId: 'conv-1001', text: 'hi', clientRequestId: 'c1' })
    await sleep(60)
    expect(ev.some((e) => e.event === 'generation.completed')).toBe(true)
    const dir = ev.find((e) => e.event === 'live2d.directive')
    expect(dir).toBeDefined()
    expect(dir).toMatchObject({ event: 'live2d.directive', state: 'happy', expression: 'expressions/F01.exp3.json', priority: 1 })
    expect('eventId' in (dir as object)).toBe(true)
    expect('sequence' in (dir as object)).toBe(true)
    // 紧邻 generation.completed（completed 之后、无其它事件夹在中间）
    const iCompleted = ev.findIndex((e) => e.event === 'generation.completed')
    const iDir = ev.findIndex((e) => e.event === 'live2d.directive')
    expect(iDir).toBeGreaterThan(iCompleted)
    expect(iDir - iCompleted).toBe(1)
  })

  it('directive 未注入（缺省 undefined）→ 无 live2d.directive 帧', async () => {
    const backend = new MockBackend({ emitDelayMs: 1 })
    const ev: BackendEvent[] = []
    backend.subscribe((e) => ev.push(e))
    await backend.connect({ serverUrl: 'mock://test' })
    await backend.sendMessage({ conversationId: 'conv-1001', text: 'hi', clientRequestId: 'c1' })
    await sleep(60)
    expect(ev.some((e) => e.event === 'generation.completed')).toBe(true)
    expect(ev.filter((e) => e.event === 'live2d.directive')).toHaveLength(0)
  })
})
