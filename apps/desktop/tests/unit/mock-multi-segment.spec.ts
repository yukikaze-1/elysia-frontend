// tests/unit/mock-multi-segment.spec.ts
// Task 4: CYRENE_MOCK_MULTI_SEGMENT env 解析 + generateMultiSegmentEvents 多分段 seed 生成（阶段 7 批次 C）
import { describe, expect, it } from 'vitest'
import { MockBackend, parseMockMultiSegmentEnv } from '../../src/main/transport/mock-backend'

describe('CYRENE_MOCK_MULTI_SEGMENT env 解析（Task 4）', () => {
  it('未设/空串/非法 → undefined（不注入）', () => {
    expect(parseMockMultiSegmentEnv(undefined)).toBeUndefined()
    expect(parseMockMultiSegmentEnv('')).toBeUndefined()
    expect(parseMockMultiSegmentEnv('abc')).toBeUndefined()
  })
  it('正整数 → 分段数 N', () => {
    expect(parseMockMultiSegmentEnv('100')).toBe(100)
    expect(parseMockMultiSegmentEnv('3')).toBe(3)
  })
  it('0/负数/NaN → undefined（不允许空 seed）', () => {
    expect(parseMockMultiSegmentEnv('0')).toBeUndefined()
    expect(parseMockMultiSegmentEnv('-5')).toBeUndefined()
    expect(parseMockMultiSegmentEnv('5.5')).toBeUndefined()
  })
})

describe('CYRENE_MOCK_MULTI_SEGMENT seed 生成（Task 4）', () => {
  it('multiSegmentCount=5 时 generateMultiSegmentEvents 生成 5 个 public_reply 分段，segmentIndex 0..4 有序无重复 + completed 在末 + 文本可读', () => {
    const mock = new MockBackend({ multiSegmentCount: 5 })
    const segs = mock.generateMultiSegmentEvents('g1', 'm1', 'r1', 'c1')
    // 准确 r2 + 符合 N-1 修正：调用实现定义的纯方法 generateMultiSegmentEvents（非未定义的 Cells helper）
    expect(segs.filter((e) => e.event === 'generation.segment.started').length).toBe(5)
    const idxs = segs.filter((e) => e.event === 'generation.segment.started').map((e) => e.segmentIndex)
    expect(idxs).toEqual([0, 1, 2, 3, 4])   // 有序无重复
    expect(new Set(idxs).size).toBe(5)
    // completed 在末
    expect(segs[segs.length - 1].event).toBe('generation.completed')
    // 文本可读确定性（避 base64 黑名单，安全 M-4）
    const firstDelta = segs.find((e) => e.event === 'generation.delta')
    expect(firstDelta!.text).toMatch(/^模拟命中文本 \d+$/)
    // generation.started 首位（renderer 归属守卫唯一带 conversationId 的事件——缺了后续事件全被丢弃）
    expect(segs[0].event).toBe('generation.started')
  })
  it('multiSegmentCount 经 sendMessage→scheduleReplay 重放：发送顺序与 generateMultiSegmentEvents 一致，completed 居末（M-7）', async () => {
    const events: string[] = []
    const mock = new MockBackend({ multiSegmentCount: 3, emitDelayMs: 0 })
    mock.subscribe((e) => events.push(e.event))
    mock.connect({ serverUrl: 'mock://local', token: 't' })
    await mock.sendMessage({ conversationId: 'conv-1001', clientRequestId: 'cr-1', text: '测试多分段' })
    // 等待重放完成（emitDelayMs=0，逐条 setTimeout(0)——flush 微任务）
    await new Promise((r) => setTimeout(r, 20))
    expect(events.filter((e) => e === 'generation.segment.started')).toHaveLength(3)
    expect(events[0]).toBe('generation.started')
    // 夹具 public_reply 段被取代：不应出现夹具段（seg-pr-1 等不再产生 public_reply 文本）
    expect(events[events.length - 1]).toBe('generation.completed')
    // completed 之前所有 segment 均已 completed（无 gap → renderer 标 completed 非 completing）
    const lastSegmentCompleted = events.lastIndexOf('generation.segment.completed')
    expect(lastSegmentCompleted).toBeGreaterThan(-1)
    expect(events.slice(lastSegmentCompleted + 1).every((e) => e === 'generation.completed')).toBe(true)
  })
})
