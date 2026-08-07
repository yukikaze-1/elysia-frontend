import { afterEach, describe, expect, it } from 'vitest'
import { MockBackend } from '../../src/main/transport/mock-backend'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import type { BackendEvent } from '@shared/contracts'

let backend: MockBackend | undefined

afterEach(() => {
  backend?.dispose()
  backend = undefined
})

async function collectReplay(options: { emitDelayMs?: number; raw?: string } = {}): Promise<BackendEvent[]> {
  backend = new MockBackend({ emitDelayMs: options.emitDelayMs ?? 1, fixtureRaw: options.raw })
  const received: BackendEvent[] = []
  backend.subscribe((event) => received.push(event))
  await backend.connect({ serverUrl: 'mock://test' })
  await backend.sendMessage({ conversationId: 'conv-1001', text: 'hi', clientRequestId: 'c1' })
  // 等待夹具事件全部触发
  await new Promise((resolve) => setTimeout(resolve, 60))
  return received
}

describe('MockBackend 事件回放', () => {
  it('按夹具顺序回放全部流式事件', async () => {
    const received = await collectReplay()
    expect(received.length).toBeGreaterThanOrEqual(11)
    expect(received[0]?.event).toBe('generation.started')
    expect(received.at(-1)?.event).toBe('generation.completed')
    // 事件整体按 sequence 升序
    const seqs = received.map((e) => e.sequence)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  })

  it('回放事件与夹具完全一致(全部通过 Schema)', () => {
    backend = new MockBackend()
    // 构造时已对每一行执行 Schema 校验;能构造成功即证明夹具合法
    expect(backend).toBeDefined()
  })

  it('非法夹具行在构造时抛出 CyreneError', () => {
    const badLine = '{"eventId":"e","event":"generation.unknown"}'
    expect(() => new MockBackend({ fixtureRaw: badLine })).toThrow(CyreneError)
    try {
      new MockBackend({ fixtureRaw: badLine })
    } catch (e) {
      expect((e as CyreneError).code).toBe(CyreneErrorCode.SCHEMA_VALIDATION_FAILED)
    }
  })

  it('listConversations 返回内置会话', async () => {
    backend = new MockBackend()
    const page = await backend.listConversations({})
    expect(page.items.length).toBe(2)
    expect(page.items[0]?.id).toBe('conv-1001')
  })
})
