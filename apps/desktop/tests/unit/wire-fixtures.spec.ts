import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseRawFrame } from '../../src/main/transport/protocol-v2/raw-schemas'
import { FrameMapper } from '../../src/main/transport/protocol-v2/frame-mapper'
import { parseBackendEvent } from '@shared/schemas'
import { StreamAccumulator } from '@shared/domain'

const FIXTURES = join(__dirname, '../../src/main/fixtures/wire-v2')

function readLines(name: string): unknown[] {
  const raw = readFileSync(join(FIXTURES, name), 'utf8')
  return raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0).map((l) => JSON.parse(l))
}

function readManifest(name: string): { backendCommit: string; protocol: string; serverProtocolVersion: string } {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
}

describe('wire fixture 两层校验', () => {
  const fixtures = [
    'handshake.jsonl',
    'chat-no-delta-inner-voice.jsonl',
    'chat-tts-public-completed-only.jsonl',
    'chat-failed.jsonl'
  ]

  it('① 每行过 raw schema', () => {
    for (const f of fixtures) {
      for (const [i, line] of readLines(f).entries()) {
        const r = parseRawFrame(line)
        expect(r.success, `${f} 第 ${i + 1} 行: ${JSON.stringify(line)}`).toBe(true)
      }
    }
  })

  it('manifest 记录 backendCommit', () => {
    for (const f of fixtures) {
      const m = readManifest(f.replace(/\.jsonl$/, '.manifest.json'))
      expect(m.backendCommit).toBe('beeba5776413dde9761375c2fd9541d6636f180d')
      expect(m.protocol).toBe('2')
      expect(m.serverProtocolVersion).toBe('2.0')
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
      // accumulator 无异常即通过;chat 两类 final 状态断言
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
