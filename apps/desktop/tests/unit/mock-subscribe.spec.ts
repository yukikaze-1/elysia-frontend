// tests/unit/mock-subscribe.spec.ts（node）
// 阶段 7 批次 A（Task 3）：MockBackend.subscribe 单槽 → 多处理器 Set 升级（D7A-15/可行 H-4——
// 诊断服务 devTap 作为并列订阅者，单槽会被 chat-service 订阅覆盖导致 mock 下聊天断流）+ 单处理器异常隔离
// + options.replyFixtureText 回复正文覆盖（CYRENE_MOCK_REPLY_FIXTURE env 桥的单元面——集成 markdown-xss 载荷注入）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockBackend } from '../../src/main/transport/mock-backend'
import type { MockBackendOptions } from '../../src/main/transport/mock-backend'

let backend: MockBackend | undefined

afterEach(() => {
  backend?.dispose()
  backend = undefined
})

/** 本地工厂（既有 mock 单测先例：emitDelayMs=1 快回放） */
function makeBackend(opts: Partial<MockBackendOptions> = {}): MockBackend {
  backend = new MockBackend({ emitDelayMs: 1, ...opts })
  return backend
}

describe('BackendAdapter.subscribe 多槽（阶段 7 批次 A 升级）', () => {
  it('两个订阅者互不覆盖；退订只移除自身', async () => {
    const b = makeBackend()
    const h1 = vi.fn()
    const h2 = vi.fn()
    const u1 = b.subscribe(h1)
    b.subscribe(h2)
    await b.connect({ serverUrl: 'mock://local' })
    await b.sendMessage({ conversationId: 'conv-1001', text: 'hi', clientRequestId: 'r1' })
    // 第一代回放完成（两槽都收满 whole generation——覆盖断言防早退）
    await vi.waitFor(() => {
      expect(h1.mock.calls.some(([ev]) => (ev as { event?: string }).event === 'generation.completed')).toBe(true)
      expect(h2.mock.calls.some(([ev]) => (ev as { event?: string }).event === 'generation.completed')).toBe(true)
    })
    u1()
    const h1Before = h1.mock.calls.length
    const h2Before = h2.mock.calls.length
    await b.sendMessage({ conversationId: 'conv-1001', text: 'hi2', clientRequestId: 'r2' })
    // 第二代：h2 继续收、h1 不涨（快照法替代 toBe(1+0)——准确性 MED）
    await vi.waitFor(() => expect(h2.mock.calls.length).toBeGreaterThan(h2Before))
    await vi.waitFor(() => {
      expect(h2.mock.calls.some(([ev]) => (ev as { event?: string }).event === 'generation.completed')).toBe(true)
    })
    await new Promise((r) => setTimeout(r, 50)) // 第二代尾流排空
    expect(h1.mock.calls.length).toBe(h1Before)
  })

  it('单处理器抛错隔离：不中断事件流与其他处理器', async () => {
    const b = makeBackend()
    const h1 = vi.fn(() => { throw new Error('boom') })
    const h2 = vi.fn()
    b.subscribe(h1)
    b.subscribe(h2)
    await b.connect({ serverUrl: 'mock://local' })
    await b.sendMessage({ conversationId: 'conv-1001', text: 'hi', clientRequestId: 'r1' })
    await vi.waitFor(() => {
      expect(h1.mock.calls.length).toBeGreaterThan(0)
      expect(h2.mock.calls.some(([ev]) => (ev as { event?: string }).event === 'generation.completed')).toBe(true)
    })
  })
})

describe('CYRENE_MOCK_REPLY_FIXTURE（回复正文覆盖）', () => {
  it('options.replyFixtureText 覆盖回复正文（public_reply 段文本为夹具内容）', async () => {
    const payload = '<img src=x onerror="window.__xssFired=1">'
    const b = makeBackend({ replyFixtureText: payload })
    const events: unknown[] = []
    b.subscribe((e) => events.push(e))
    await b.connect({ serverUrl: 'mock://local' })
    await b.sendMessage({ conversationId: 'conv-1001', text: 'hi', clientRequestId: 'r1' })
    await vi.waitFor(() => expect(events.some(isGenerationPayload)).toBe(true))
    // 回复正文 = 夹具文本：首个 public_reply delta 全量覆盖、其后 delta 置空（每代一次）
    const replyDeltas = events.filter(isPublicReplyDelta) as Array<{ text: string }>
    expect(replyDeltas.length).toBeGreaterThan(1)
    expect(replyDeltas[0]?.text).toBe(payload)
    // 内声优（inner_voice、kind text）不受覆盖
    const inner = events.filter((e) => (e as { channel?: string }).channel === 'inner_voice')
    expect(inner.some((e) => typeof (e as { text?: unknown }).text === 'string' && (e as { text: string }).text === '让我先整理一下回答思路。')).toBe(true)
  })
})

function isPublicReplyDelta(e: unknown): boolean {
  const ev = e as { event?: string; channel?: string }
  return ev?.event === 'generation.delta' && ev.channel === 'public_reply'
}

function isGenerationPayload(e: unknown): boolean {
  const ev = e as { text?: string }
  return isPublicReplyDelta(e) && typeof ev.text === 'string' && ev.text.includes('<img')
}
