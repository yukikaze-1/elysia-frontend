// tests/unit/mock-real-contract.spec.ts
//
// 2026-09-16 审计 P2「Mock 与 Real 是两套平级实现，且零共享契约测试」/ 立项 AUD-02（方案 C）。
//
// 缺口：302 个 spec 里"同文件同时出现两个实现类名"命中 **0**——「两实现可互换」这个核心不变量
// **没有任何自动化证据**；接口只覆盖两者的交集，差集静默上浮到装配根（`instanceof MockBackend`、
// `toolRequestSink` vs `onToolRequest`）。本 spec 就是那条共享契约。
//
// 做法：**同一个场景**两侧各走自己的真实路径，然后比对产出的**领域事件序列**。
//   · mock：读内置领域夹具（`fixtures/domain/streaming-reply.jsonl`，11 条领域事件）直接 emit；
//   · real：由真实 `WebSocketServer` 发**等价的 wire 帧**，经 `FrameMapper` 映射成领域事件。
// 场景内容按夹具逐条对齐（段、delta 序号、终态用量都同值），故两侧本应产出**同构**序列。
//
// 为什么不是"逐字节相等"：两侧的身份/序号字段来源不同（mock 自造 `mock-<ts>-<n>`，real 用 wire 的
// `generationId`/`messageId`），且领域契约里本就有可选字段。故断言分三层：
//   ① **事件种类序列**：把 real 的 `generation.segment.started` 滤掉后，必须与 mock **完全一致**；
//   ② **已登记的差异恰好一条**：real 会发段边界事件、默认夹具不发——数量与种类都钉死；
//   ③ **语义不变量两侧一致**：token 来源标签、`total = input + output`、会话累计来源与总量。
// 今后的任何漂移（夹具补上了段边界、real 丢了 messageId、某侧换了来源标签）都会让本 spec 变红，
// 从而把"两实现悄悄分叉"变成一次**必须显式处理**的变更。
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { MockBackend } from '../../src/main/transport/mock-backend'
import { RealBackend } from '../../src/main/transport/real-backend'
import type { BackendEvent } from '@shared/contracts/events'
import type { TokenUsage, ConversationTokenUsage } from '@shared/contracts'

const CONV = 'conv-1001'
const GEN = 'gen-1'
const MODEL = 'cyrene-llm-v1'

/**
 * 内置夹具 `streaming-reply.jsonl` 的 **wire 等价物**。
 *
 * 顺序逐条对齐夹具（段边界事件按"某段的第一个 delta 之前"插入，`segment.completed` 落在夹具里
 * 它出现的位置），这样滤掉段边界后两侧序列应当逐项相同。数字也与夹具同值：
 * 用量 rounds 合计 input 120 / output 88 / total 208，会话累计 total 2100。
 */
const WIRE_SCRIPT: unknown[] = [
  { type: 'generation.started', generationId: GEN, messageId: 'msg-2001', conversationId: CONV, model: MODEL },
  { type: 'generation.segment.started', generationId: GEN, segmentId: 'seg-iv-1', segmentIndex: 0, channel: 'inner_voice', kind: 'text' },
  { type: 'generation.delta', generationId: GEN, segmentId: 'seg-iv-1', segmentIndex: 0, deltaSequence: 0, delta: '让我先整理一下回答思路。' },
  { type: 'generation.segment.started', generationId: GEN, segmentId: 'seg-pr-1', segmentIndex: 1, channel: 'public_reply', kind: 'markdown' },
  { type: 'generation.delta', generationId: GEN, segmentId: 'seg-pr-1', segmentIndex: 1, deltaSequence: 0, delta: '好的，我来回答你关于**流式回复**的问题。' },
  { type: 'generation.delta', generationId: GEN, segmentId: 'seg-pr-1', segmentIndex: 1, deltaSequence: 1, delta: '\n\n一次 AI 回复只建立一个父消息。' },
  { type: 'generation.delta', generationId: GEN, segmentId: 'seg-iv-1', segmentIndex: 0, deltaSequence: 1, delta: '（要点：按 responseId 归组、segmentIndex 排序）' },
  { type: 'generation.segment.completed', generationId: GEN, segmentId: 'seg-iv-1', segmentIndex: 0, channel: 'inner_voice', kind: 'text' },
  { type: 'generation.segment.started', generationId: GEN, segmentId: 'seg-pr-2', segmentIndex: 2, channel: 'public_reply', kind: 'markdown' },
  { type: 'generation.delta', generationId: GEN, segmentId: 'seg-pr-2', segmentIndex: 2, deltaSequence: 0, delta: '第一，`deltaSequence` 只在分段内累计；' },
  { type: 'generation.delta', generationId: GEN, segmentId: 'seg-pr-2', segmentIndex: 2, deltaSequence: 1, delta: '第二，`segmentIndex` 决定全局展示顺序。' },
  { type: 'generation.segment.completed', generationId: GEN, segmentId: 'seg-pr-1', segmentIndex: 1, channel: 'public_reply', kind: 'markdown' },
  { type: 'generation.segment.completed', generationId: GEN, segmentId: 'seg-pr-2', segmentIndex: 2, channel: 'public_reply', kind: 'markdown' },
  {
    type: 'generation.completed', generationId: GEN, messageId: 'msg-2001', channel: 'public_reply', finishReason: 'stop',
    usage: { rounds: [{ model: MODEL, input_tokens: 120, output_tokens: 88, total_tokens: 208, round_num: 1 }], turn_total: 208 },
    model: MODEL, completeness: 'complete', conversationId: CONV,
    conversationUsage: { total: 2100, byModel: { [MODEL]: 2100 } }
  }
]

let server: Server
let wss: WebSocketServer
let port: number

beforeAll(async () => {
  server = createServer((_req, res) => { res.writeHead(404); res.end() })
  wss = new WebSocketServer({ server, path: '/ws' })
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'server_info', protocol_version: '2.0', server_version: 'v', features: {}, services: {}, connectionId: 'conn-contract' }))
    ws.on('message', () => { for (const frame of WIRE_SCRIPT) ws.send(JSON.stringify(frame)) })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(async () => { wss.close(); server.close() })

const kindsOf = (events: BackendEvent[]): string[] => events.map((e) => String((e as { event: string }).event))
const completedOf = (events: BackendEvent[]): { usage?: TokenUsage; conversationUsage?: ConversationTokenUsage } =>
  events.find((e) => (e as { event: string }).event === 'generation.completed') as never

async function driveMock(): Promise<BackendEvent[]> {
  const events: BackendEvent[] = []
  const backend = new MockBackend({ emitDelayMs: 1 })
  backend.subscribe((e) => events.push(e))
  await backend.connect({ serverUrl: 'mock://local' })
  await backend.sendMessage({ conversationId: CONV, text: 'hi', clientRequestId: 'req-mock' })
  await new Promise((r) => setTimeout(r, 300))   // 夹具回放完毕
  await backend.disconnect()
  return events
}

async function driveReal(): Promise<BackendEvent[]> {
  const events: BackendEvent[] = []
  const backend = new RealBackend({ now: () => Date.now() })
  backend.subscribe((e) => events.push(e))
  await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tk' })
  void backend.sendMessage({ conversationId: CONV, text: 'hi', clientRequestId: 'req-real' }).catch(() => { /* 脚本最后会回 ack 之外的帧，超时无所谓 */ })
  await new Promise((r) => setTimeout(r, 300))
  await backend.disconnect()
  return events
}

describe('mock 与 real 的共享领域契约（AUD-02 方案 C）', () => {
  it('同一场景下两侧产出同构的领域事件序列（唯一差异是已登记的段边界事件）', async () => {
    const mockEvents = await driveMock()
    const realEvents = await driveReal()
    const mockKinds = kindsOf(mockEvents)
    const realKinds = kindsOf(realEvents)

    // ① 主体序列必须逐项相同（real 滤掉段边界后与 mock 完全一致）
    const realWithoutSegmentStarted = realKinds.filter((k) => k !== 'generation.segment.started')
    expect(realWithoutSegmentStarted, `real=${JSON.stringify(realKinds)}\nmock=${JSON.stringify(mockKinds)}`).toEqual(mockKinds)

    // ② 已登记的差异：real 发段边界、默认夹具不发（数量也钉死，夹具或 mapper 一变就红）
    expect(realKinds.filter((k) => k === 'generation.segment.started')).toHaveLength(3)
    expect(mockKinds, '默认夹具目前 0 帧段边界——这是已登记的差异，不是通过').not.toContain('generation.segment.started')
  })

  it('两侧对 Token 的**来源与口径**完全一致（这是"可互换"的实质主张）', async () => {
    const mockDone = completedOf(await driveMock())
    const realDone = completedOf(await driveReal())

    for (const [label, done] of [['mock', mockDone], ['real', realDone]] as const) {
      expect(done.usage, `${label}: 终态必须带用量`).toBeDefined()
      expect(done.usage?.source, `${label}: 回复级来源标签`).toBe('provider_reported')
      expect(done.usage?.total, `${label}: total 取后端 turn_total`).toBe(208)
      expect(done.usage?.input, `${label}: input 由 rounds 求和`).toBe(120)
      expect(done.usage?.output, `${label}: output 由 rounds 求和`).toBe(88)
      expect(done.usage?.total, `${label}: total = input + output`).toBe((done.usage?.input ?? 0) + (done.usage?.output ?? 0))

      expect(done.conversationUsage?.source, `${label}: 会话累计必须标服务端口径（不得谎称本机累计）`).toBe('server_aggregate')
      expect(done.conversationUsage?.total, `${label}: 会话累计取服务端聚合值，不是前端求和`).toBe(2100)
      expect(done.conversationUsage?.byModel).toEqual({ [MODEL]: 2100 })
    }
  })

  it('两侧的终态都是 generation.completed 且是最后一条（父终态语义一致）', async () => {
    const mockKinds = kindsOf(await driveMock())
    const realKinds = kindsOf(await driveReal())
    expect(mockKinds.at(-1)).toBe('generation.completed')
    expect(realKinds.at(-1)).toBe('generation.completed')
    expect(mockKinds[0]).toBe('generation.started')
    // real 的首条是段边界（wire 脚本先发段再发 started）——这里只钉"generation.started 必须存在且早于任何 delta"
    expect(realKinds.indexOf('generation.started')).toBeLessThan(realKinds.indexOf('generation.delta'))
  })
})
