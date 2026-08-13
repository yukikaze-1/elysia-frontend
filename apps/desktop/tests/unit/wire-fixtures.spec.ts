import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseRawFrame, rawSchemasFingerprint } from '../../src/main/transport/protocol-v2/raw-schemas'
import { FrameMapper } from '../../src/main/transport/protocol-v2/frame-mapper'
import { RestMapper } from '../../src/main/transport/protocol-v2/rest-mapper'
import { parseBackendEvent, MessageSchema } from '@shared/schemas'
import { StreamAccumulator } from '@shared/domain'

const FIXTURES = join(__dirname, '../../src/main/fixtures/wire-v2')

function readLines(name: string): unknown[] {
  const raw = readFileSync(join(FIXTURES, name), 'utf8')
  return raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0).map((l) => JSON.parse(l))
}

interface WireManifest {
  backendCommit: string
  protocol: string
  serverProtocolVersion: string
  schemaHash: string
  verified: boolean
  scenario?: string
}

function readManifest(name: string): WireManifest {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
}

const VERIFIED_COMMIT = 'beeba5776413dde9761375c2fd9541d6636f180d'

const VERIFIED_FIXTURES = [
  'handshake.jsonl',
  'chat-no-delta-inner-voice.jsonl',
  'chat-tts-public-completed-only.jsonl',
  'chat-failed.jsonl'
]

const NEW_FIXTURES = [
  'rejected-ack-empty-messageid.jsonl',
  'rejected-ack-storage-unavailable.jsonl',
  'server-info-full.jsonl',
  'chat-replay-nonempty.jsonl',
  'chat-cancelled.jsonl',
  'chat-reconnect-replay.jsonl',
  'chat-no-delta-public-reply.jsonl',
  'state-typing.jsonl'
]

const fixtures = [...VERIFIED_FIXTURES, ...NEW_FIXTURES]
const replayFixtures = ['chat-replay-nonempty.jsonl', 'chat-reconnect-replay.jsonl']

describe('wire fixture 两层校验', () => {
  it('① 每行过 raw schema', () => {
    for (const f of fixtures) {
      for (const [i, line] of readLines(f).entries()) {
        const r = parseRawFrame(line)
        expect(r.success, `${f} 第 ${i + 1} 行: ${JSON.stringify(line)}`).toBe(true)
      }
    }
  })

  it('manifest schemaHash 与当前 rawSchemasFingerprint 一致 + verified 为 boolean(门禁)', () => {
    const fp = rawSchemasFingerprint()
    for (const f of fixtures) {
      const m = readManifest(f.replace(/\.jsonl$/, '.manifest.json'))
      expect(m.schemaHash, `${f} manifest schemaHash 门禁`).toBe(fp)
      expect(typeof m.verified).toBe('boolean')
    }
  })

  it('manifest verified/backendCommit:既有 4 组 verified:true+beeba577,新增 8 组 verified:false+unverified', () => {
    for (const f of VERIFIED_FIXTURES) {
      const m = readManifest(f.replace(/\.jsonl$/, '.manifest.json'))
      expect(m.verified).toBe(true)
      expect(m.backendCommit).toBe(VERIFIED_COMMIT)
      expect(m.protocol).toBe('2')
      expect(m.serverProtocolVersion).toBe('2.0')
    }
    for (const f of NEW_FIXTURES) {
      const m = readManifest(f.replace(/\.jsonl$/, '.manifest.json'))
      expect(m.verified).toBe(false)
      expect(m.backendCommit).toBe('unverified')
      expect(m.protocol).toBe('2')
      expect(m.serverProtocolVersion).toBe('2.0')
      expect(typeof m.scenario).toBe('string')
    }
  })

  it('② 经 mapper 后每事件过领域 schema,并推进 accumulator', () => {
    for (const f of fixtures) {
      const mapper = new FrameMapper({ connectionId: 'fixture-conn', activeConversationId: 'conv-1' })
      const acc = new StreamAccumulator()
      for (const [i, line] of readLines(f).entries()) {
        const raw = parseRawFrame(line)
        if (!raw.success) throw new Error('raw 应已通过(前一用例)')
        const domain = mapper.mapFrame(raw.data)
        if (domain === null) continue // 握手帧/status 段
        const parsed = parseBackendEvent(domain)
        expect(parsed.success, `${f} 第 ${i + 1} 行映射后: ${JSON.stringify(domain)}`).toBe(true)
        if (parsed.success) acc.apply(parsed.data)
      }
      // accumulator 无异常即通过;chat 各类 final 状态断言
      if (f === 'chat-no-delta-inner-voice.jsonl') {
        const segs = acc.toAssistantSegments()
        expect(segs.length).toBeGreaterThan(0)
        expect(segs.some((s) => s.channel === 'inner_voice' && (s.text ?? '').length > 0)).toBe(true)
      }
      if (f === 'chat-tts-public-completed-only.jsonl') {
        const segs = acc.toAssistantSegments()
        expect(segs.length).toBeGreaterThan(0)
        expect(segs.some((s) => s.channel === 'public_reply' && (s.text ?? '').length > 0)).toBe(true)
      }
      if (f === 'chat-failed.jsonl') {
        expect(acc.getState().status).toBe('failed')
        const segs = acc.toAssistantSegments()
        expect(segs.some((s) => (s.text ?? '').includes('部分内容已生成'))).toBe(true) // partial delta 保留
      }
      if (f === 'chat-cancelled.jsonl') {
        expect(acc.getState().status).toBe('failed')
        const segs = acc.toAssistantSegments()
        expect(segs.some((s) => (s.text ?? '').includes('已生成的部分内容'))).toBe(true) // 取消前 delta 保留
      }
      if (f === 'chat-no-delta-public-reply.jsonl') {
        const segs = acc.toAssistantSegments()
        expect(segs.length).toBeGreaterThan(0)
        expect(segs.some((s) => s.channel === 'public_reply' && (s.text ?? '').length > 0)).toBe(true) // segment.completed 权威 content
      }
    }
  })

  it('replay 场景交叉校验:session 帧显式非空 conversationId + messages 经 toDomainMessageFromReplay → MessageSchema.safeParse 通过(I5/C1)', () => {
    const restMapper = new RestMapper({ onProtocolWarning: () => {} })
    for (const f of replayFixtures) {
      for (const [i, line] of readLines(f).entries()) {
        const raw = parseRawFrame(line)
        if (!raw.success || raw.data.type !== 'session') continue
        const conversationId = raw.data.conversationId
        expect(conversationId, `${f} 第 ${i} 行 session 帧 conversationId 显式非空`).toBeTruthy()
        expect(raw.data.messages.length, `${f} 第 ${i} 行 replay 非空`).toBeGreaterThan(0)
        for (const m of raw.data.messages) {
          const dom = restMapper.toDomainMessageFromReplay(m, conversationId as string)
          expect(MessageSchema.safeParse(dom).success, `${f} 第 ${i} 行`).toBe(true)
        }
      }
    }
  })

  it('handshake 三帧 mapFrame()===null(握手帧不产生领域事件)', () => {
    const mapper = new FrameMapper({ connectionId: 'fixture-conn' })
    for (const line of readLines('handshake.jsonl')) {
      const raw = parseRawFrame(line)
      if (raw.success) expect(mapper.mapFrame(raw.data)).toBeNull()
    }
  })
})
