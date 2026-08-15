// tests/unit/real-backend-tts.spec.ts
// Task 5 (P4-B):real-backend TTS 播放帧处理(audio_* 文本 JSON 帧 + getTtsMedia sink)。
// 验证:audio_start 建缓冲 + supersede;audio 帧 base64 解码按序拼接;audio_end 写 sink +
// audio.session.ready(streamId/url/format/durationMs);audio_cancelled 清缓冲;无 sink 告警;
// stampEvent 信封(eventId/sequence)与 mapFrame 交错时单调递增。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RealBackend,
  type RealBackendOptions,
  type TtsMediaSink,
  type WebSocketLike
} from '../../src/main/transport/real-backend'
import type { BackendEvent } from '@shared/contracts'
import type { ProtocolWarning } from '@shared/contracts/protocol'

class FakeWs {
  private handlers: Record<string, (arg?: unknown, arg2?: unknown) => void> = {}
  on(ev: string, cb: (arg?: unknown, arg2?: unknown) => void): this { this.handlers[ev] = cb; return this }
  send = vi.fn()
  close = vi.fn()
  readyState = 1
  /** 推文本 JSON 帧（audio_* 是文本帧，第 2 参不给 true，不做 isBinary 分流） */
  push(frame: unknown): void { this.handlers['message']?.(JSON.stringify(frame)) }
}

/** 记录 putTtsAudio 调用的 fake sink */
class FakeSink implements TtsMediaSink {
  calls: { id: string; bytes: Uint8Array; mime?: string }[] = []
  putTtsAudio(id: string, bytes: Uint8Array, mime?: string): { url: string } {
    this.calls.push({ id, bytes, mime })
    return { url: `cyrene://renderer/__cyrene-media/tts/${id}` }
  }
  last(): { id: string; bytes: Uint8Array; mime?: string } { return this.calls[this.calls.length - 1] }
}

interface Ctx {
  backend: RealBackend
  ws: FakeWs
  sink: FakeSink
  warnings: ProtocolWarning[]
  events: BackendEvent[]
}

async function makeBackend(opts: Partial<RealBackendOptions> = {}): Promise<Ctx> {
  const ws = new FakeWs()
  const sink = new FakeSink()
  const warnings: ProtocolWarning[] = []
  const events: BackendEvent[] = []
  const backend = new RealBackend({
    now: () => Date.now(),
    wsFactory: () => ws as WebSocketLike,
    getTtsMedia: () => sink,
    onProtocolWarning: (w) => warnings.push(w),
    ...opts
  })
  backend.subscribe((e) => events.push(e))
  const p = backend.connect({ serverUrl: 'http://test.local', token: 'sk-test' })
  ws.push({ type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 0, byModel: {} } })
  ws.push({ type: 'server_info', protocol_version: '2.0', server_version: '0.4.0', features: {}, services: {}, connectionId: 'conn-1' })
  await p
  return { backend, ws, sink, warnings, events }
}

const readyEventsOf = (events: BackendEvent[]): Extract<BackendEvent, { event: 'audio.session.ready' }>[] =>
  events.filter((e) => e.event === 'audio.session.ready') as Extract<BackendEvent, { event: 'audio.session.ready' }>[]

const startedEventsOf = (events: BackendEvent[]): Extract<BackendEvent, { event: 'audio.session.started' }>[] =>
  events.filter((e) => e.event === 'audio.session.started') as Extract<BackendEvent, { event: 'audio.session.started' }>[]

beforeEach(() => { vi.clearAllMocks() })

describe('RealBackend TTS audio_* 帧缓冲 + sink（Task 5）', () => {
  it('audio_start + 两个 audio 帧按序拼接 + audio_end → sink 收到精确 bytes + mime audio/wav + ready{streamId,url,format}', async () => {
    const { ws, sink, events } = await makeBackend()
    const part1 = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00])   // "RIFF\x00"
    const part2 = new Uint8Array([0x57, 0x41, 0x56, 0x45, 0x66])   // "WAVEf"
    ws.push({ type: 'audio_start', stream_id: 1, format: 'wav', durationMs: 1234 })
    ws.push({ type: 'audio', stream_id: 1, seq: 0, data: Buffer.from(part1).toString('base64'), is_final: false })
    ws.push({ type: 'audio', stream_id: 1, seq: 1, data: Buffer.from(part2).toString('base64'), is_final: false })
    ws.push({ type: 'audio_end', stream_id: 1, format: 'wav' })

    // sink：一次调用，bytes 为两帧按序拼接
    expect(sink.calls).toHaveLength(1)
    const call = sink.last()
    expect(Array.from(call.bytes)).toEqual([...part1, ...part2])
    expect(call.mime).toBe('audio/wav')
    expect(call.id).toMatch(/^tts-[0-9a-f-]{36}$/)

    // started + ready 事件
    expect(startedEventsOf(events)).toHaveLength(1)
    expect(startedEventsOf(events)[0]).toMatchObject({ event: 'audio.session.started', streamId: 1, format: 'wav' })
    expect(readyEventsOf(events)).toHaveLength(1)
    expect(readyEventsOf(events)[0]).toMatchObject({
      event: 'audio.session.ready',
      streamId: 1,
      url: `cyrene://renderer/__cyrene-media/tts/${call.id}`,
      format: 'wav',
      durationMs: 1234
    })
  })

  it('ready 带 eventId/sequence（stampEvent 信封）且与 started 交错单调递增', async () => {
    const { ws, events } = await makeBackend()
    ws.push({ type: 'audio_start', stream_id: 1, format: 'wav', durationMs: 10 })
    ws.push({ type: 'audio', stream_id: 1, seq: 0, data: Buffer.from([1, 2, 3]).toString('base64'), is_final: false })
    ws.push({ type: 'audio_end', stream_id: 1, format: 'wav' })
    const started = startedEventsOf(events)[0]
    const ready = readyEventsOf(events)[0]
    expect(typeof (started as { eventId: string }).eventId).toBe('string')
    const seqs = [started, ready].map((e) => (e as { sequence: number }).sequence)
    expect(seqs[0]).toBeLessThan(seqs[1])   // 严格递增
    // eventId 与 sequence 同源（`${connectionId}:${sequence}` 形状；connectionId 为 serverUrl，非定值）
    expect((ready as { eventId: string }).eventId.endsWith(`:${(ready as { sequence: number }).sequence}`)).toBe(true)
  })

  it('durationMs 缺省（audio_start 未设）→ ready 不带 durationMs 键；mp3 → mime audio/mpeg', async () => {
    const { ws, sink, events } = await makeBackend()
    ws.push({ type: 'audio_start', stream_id: 2, format: 'mp3' })   // 无 durationMs
    ws.push({ type: 'audio', stream_id: 2, seq: 0, data: Buffer.from([9, 9]).toString('base64'), is_final: false })
    ws.push({ type: 'audio_end', stream_id: 2, format: 'mp3' })
    expect(sink.last().mime).toBe('audio/mpeg')
    const ready = readyEventsOf(events)[0]
    expect(ready.format).toBe('mp3')
    expect('durationMs' in ready).toBe(false)
  })

  it('新 audio_start supersede 旧缓冲（同 stream_id 覆盖：旧 chunk 不进入新 ready）', async () => {
    const { ws, sink, events } = await makeBackend()
    ws.push({ type: 'audio_start', stream_id: 3, format: 'wav' })
    ws.push({ type: 'audio', stream_id: 3, seq: 0, data: Buffer.from([0xAA, 0xBB]).toString('base64'), is_final: false })
    // 新 audio_start（同 stream 重开）→ 旧 chunk 丢弃
    ws.push({ type: 'audio_start', stream_id: 3, format: 'wav', durationMs: 5 })
    ws.push({ type: 'audio', stream_id: 3, seq: 0, data: Buffer.from([0x11]).toString('base64'), is_final: false })
    ws.push({ type: 'audio_end', stream_id: 3, format: 'wav' })
    expect(sink.calls).toHaveLength(1)
    expect(Array.from(sink.last().bytes)).toEqual([0x11])   // 仅新流 chunk
    expect(readyEventsOf(events)).toHaveLength(1)
    expect(readyEventsOf(events)[0].durationMs).toBe(5)
  })

  it('audio_cancelled → 清缓冲 + emit cancelled（不产生 ready/sink 写入）', async () => {
    const { ws, sink, events, warnings } = await makeBackend()
    ws.push({ type: 'audio_start', stream_id: 4, format: 'wav' })
    ws.push({ type: 'audio', stream_id: 4, seq: 0, data: Buffer.from([1]).toString('base64'), is_final: false })
    ws.push({ type: 'audio_cancelled', stream_id: 4 })
    const cancelled = events.filter((e) => e.event === 'audio.session.cancelled')
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0]).toMatchObject({ event: 'audio.session.cancelled', streamId: 4 })
    expect(sink.calls).toHaveLength(0)
    expect(readyEventsOf(events)).toHaveLength(0)
    // cancelled 后同 stream 再发 chunk/end → 无缓冲（不误写入）
    ws.push({ type: 'audio', stream_id: 4, seq: 0, data: Buffer.from([2]).toString('base64'), is_final: false })
    ws.push({ type: 'audio_end', stream_id: 4, format: 'wav' })
    expect(sink.calls).toHaveLength(0)
    expect(warnings.some((w) => w.code === 'AUDIO_END_NO_BUFFER')).toBe(true)
  })

  it('无 sink → TTS_MEDIA_SINK_MISSING 告警 + 不 emit ready（缓冲已删）', async () => {
    const { ws, sink, warnings, events } = await makeBackend({ getTtsMedia: () => undefined })
    ws.push({ type: 'audio_start', stream_id: 5, format: 'wav' })
    ws.push({ type: 'audio', stream_id: 5, seq: 0, data: Buffer.from([1]).toString('base64'), is_final: false })
    ws.push({ type: 'audio_end', stream_id: 5, format: 'wav' })
    expect(sink.calls).toHaveLength(0)
    expect(readyEventsOf(events)).toHaveLength(0)
    expect(warnings.some((w) => w.code === 'TTS_MEDIA_SINK_MISSING')).toBe(true)
  })

  it('audio_end 无缓冲 → AUDIO_END_NO_BUFFER 告警，不崩', async () => {
    const { ws, warnings, sink } = await makeBackend()
    ws.push({ type: 'audio_end', stream_id: 999, format: 'wav' })
    expect(sink.calls).toHaveLength(0)
    expect(warnings.some((w) => w.code === 'AUDIO_END_NO_BUFFER')).toBe(true)
  })
})
