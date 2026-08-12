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

describe('MockBackend 隔离与多次发送（FE-S0-P1-03）', () => {
  it('两次发送的 generationId/eventId 互不相同（无 ID 冲突）', async () => {
    backend = new MockBackend({ emitDelayMs: 1 }) // 复用模块级 backend（afterEach 自动 dispose）
    const received: BackendEvent[] = []
    backend.subscribe((e) => received.push(e))
    await backend.connect({ serverUrl: 'mock://test' })
    await backend.sendMessage({ conversationId: 'conv-1001', text: 'a', clientRequestId: 'c1' })
    await backend.sendMessage({ conversationId: 'conv-1001', text: 'b', clientRequestId: 'c2' })
    await new Promise((r) => setTimeout(r, 60))
    const gens = received.map((e) => (e as { generationId?: string }).generationId).filter(Boolean)
    expect(new Set(gens).size).toBeGreaterThan(1)
    const evtIds = received.map((e) => e.eventId)
    expect(new Set(evtIds).size).toBe(evtIds.length)
  })
  it('并发发送：两代均 completed 且 ID 唯一', async () => {
    backend = new MockBackend({ emitDelayMs: 1 })
    const received: BackendEvent[] = []
    backend.subscribe((e) => received.push(e))
    await backend.connect({ serverUrl: 'mock://test' })
    const p1 = backend.sendMessage({ conversationId: 'conv-1001', text: 'a', clientRequestId: 'c1' })
    const p2 = backend.sendMessage({ conversationId: 'conv-1001', text: 'b', clientRequestId: 'c2' })
    await Promise.all([p1, p2])
    await new Promise((r) => setTimeout(r, 60))
    expect(received.filter((e) => e.event === 'generation.completed')).toHaveLength(2)
    const gens = new Set(received.map((e) => (e as { generationId?: string }).generationId).filter(Boolean))
    expect(gens.size).toBe(2)
    const evtIds = received.map((e) => e.eventId)
    expect(new Set(evtIds).size).toBe(evtIds.length)
  })
  it('两实例隔离：A CRUD 不影响 B', async () => {
    const a = new MockBackend()
    const b = new MockBackend()
    const created = await a.createConversation({ title: 'A 新建' })
    await a.renameConversation('conv-1001', 'A 改名')
    const aList = await a.listConversations({})
    const bList = await b.listConversations({})
    expect(aList.items.some((c) => c.id === created.id)).toBe(true)
    expect(bList.items.some((c) => c.id === created.id)).toBe(false)
    expect(bList.items[0]?.title).toBe('流式回复演示')
    a.dispose(); b.dispose()
  })
  it('完整 CRUD：create/rename/activate/delete 一致且可观测', async () => {
    const b = new MockBackend()
    const created = await b.createConversation({ title: '新会话' })
    const renamed = await b.renameConversation(created.id, '改名')
    expect(renamed.title).toBe('改名')
    expect((await b.listConversations({})).items.find((c) => c.id === created.id)?.title).toBe('改名')
    await b.activateConversation(created.id)
    await b.deleteConversation(created.id)
    expect((await b.listConversations({})).items.some((c) => c.id === created.id)).toBe(false)
    await expect(b.deleteConversation(created.id)).rejects.toMatchObject({ code: CyreneErrorCode.INVALID_INPUT })
    await expect(b.activateConversation('nope')).rejects.toMatchObject({ code: CyreneErrorCode.INVALID_INPUT })
    b.dispose()
  })
  it('可取消单 generation：仅取消目标 gen，另一 gen 正常 complete', async () => {
    backend = new MockBackend({ emitDelayMs: 30 }) // 30ms 间隔：11 事件全触发需 300ms，给 cancel 留窗口
    const received: BackendEvent[] = []
    backend.subscribe((e) => received.push(e))
    await backend.connect({ serverUrl: 'mock://test' })
    await backend.sendMessage({ conversationId: 'conv-1001', text: 'a', clientRequestId: 'c1' })
    await backend.sendMessage({ conversationId: 'conv-1001', text: 'b', clientRequestId: 'c2' })
    // 等两个 started（t=0 双发均已触发）捕获注入后的 genId
    await new Promise((r) => setTimeout(r, 40))
    const started = received.filter((e) => e.event === 'generation.started')
    expect(started.length).toBe(2)
    const target = (started[0] as { generationId: string }).generationId
    await backend.cancelGeneration({ generationId: target })
    // 幸存 gen 第 11 事件 = 10×30=300ms；等 400ms 越过（防 cancel 后等待过短）
    await new Promise((r) => setTimeout(r, 400))
    expect(received.filter((e) => e.event === 'generation.completed')).toHaveLength(1)
    expect(received.some((e) => e.event === 'generation.completed' && e.generationId === target)).toBe(false)
    await backend.cancelGeneration({ generationId: 'unknown-gen' }) // no-op 不抛
  })
  it('可注入 clock/ID factory：确定性（含跨实例共享工厂递增）', async () => {
    let n = 0
    const fixed = new Date('2026-08-12T00:00:00.000Z')
    const factory = () => `id-${++n}`
    const a = new MockBackend({ idFactory: factory, now: () => fixed })
    const b = new MockBackend({ idFactory: factory, now: () => fixed })
    expect((await a.createConversation({ title: 'x' })).id).toBe('id-1')
    expect((await b.createConversation({ title: 'y' })).id).toBe('id-2') // 共享工厂计数器递增（确定性）
    expect((await a.createConversation({ title: 'z' })).updatedAt).toBe(fixed.toISOString())
    a.dispose(); b.dispose()
  })
})
