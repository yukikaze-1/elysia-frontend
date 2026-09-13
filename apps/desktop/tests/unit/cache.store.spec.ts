// tests/unit/cache.store.spec.ts —— spec §4.1/§4.5：离线水合、分片推送、快照查询、列表同步。
import { describe, expect, it, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCacheStore, chunkMessages } from '../../src/renderer/src/stores/cache.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { createDesktopApiMock } from './helpers/desktop-api'
import { MAX_IPC_MESSAGE_BYTES } from '@shared/contracts'
import type { Message, SessionPersistenceState } from '@shared/contracts'

// I-06 / P2-10：原为手搓的 DesktopApiLike 全契约镜像（每个键裸 `vi.fn()`）。
const mockApi = createDesktopApiMock()

function m(id: string, t: string): Message {
  return { messageId: id, conversationId: 'c1', role: 'user', content: 'x', status: 'completed', createdAt: t }
}

describe('cacheStore（spec §4.5）', () => {
  beforeEach(() => { setActivePinia(createPinia()); setDesktopApi(mockApi); mockApi.cacheMessages.mockResolvedValue(undefined) })

  it('hydrate 载入会话列表/快照/上次活动会话', () => {
    const s = useCacheStore()
    const state: SessionPersistenceState = {
      drafts: [], scrollAnchors: {}, lastActiveConversationId: 'c1',
      conversations: [{ id: 'c1', title: 'A', updatedAt: 't' }],
      messageSnapshots: { c1: [m('m1', 't')] }
    }
    s.hydrate(state)
    expect(s.conversations.map((c) => c.id)).toEqual(['c1'])
    expect(s.lastActiveConversationId).toBe('c1')
    expect(s.snapshotMessages('c1')?.[0]?.messageId).toBe('m1')
    expect(s.snapshotMessages('nope')).toBeUndefined()
  })

  it('pushMessages 调 cacheMessages（≤200 条单批）', async () => {
    const s = useCacheStore()
    await s.pushMessages('c1', [m('m1', 't')], 'now')
    expect(mockApi.cacheMessages).toHaveBeenCalledWith({ conversationId: 'c1', messages: [m('m1', 't')], updatedAt: 'now' })
  })

  it('pushMessages 在 await 前及成功后都隔离调用方嵌套 mutation', async () => {
    let resolveCache!: () => void
    mockApi.cacheMessages.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveCache = resolve }))
    const source: Message = {
      ...m('nested', 't'),
      content: '原始正文',
      assistantSegments: [{ segmentId: 'seg-1', segmentIndex: 0, channel: 'public_reply', kind: 'markdown', text: '原始分段', completed: true }],
      character: {
        characterId: 'builtin/elysia', characterInstanceId: 'instance-elysia', characterRevision: 1,
        displayName: 'Elysia', presentation: { themeColor: '#f2a7c6' }
      }
    }
    const task = useCacheStore().pushMessages('c1', [source], 'now')
    source.content = 'await 中改写'
    source.assistantSegments![0].text = 'await 中分段改写'
    source.character!.displayName = 'await 中角色改写'
    resolveCache()
    await task

    // I-06：mock 变类型化后 `calls.at(-1)?.[0]` 的类型是 `CacheMessagesInput | undefined`（原先裸 mock
    // 给的是 any）。本用例是一次 pushMessages 触发**两次**写（await 前的乐观写 + 成功后的终态写），
    // `.at(-1)` 取的是成功后那次；这里用 `!` 断言「确实写过」，与原来的任何隐式假设等价、不放宽。
    const sent = mockApi.cacheMessages.mock.calls.at(-1)![0]
    expect(sent.messages[0]).toMatchObject({
      content: '原始正文',
      assistantSegments: [{ text: '原始分段' }],
      character: { displayName: 'Elysia' }
    })
    source.content = '成功后改写'
    source.assistantSegments![0].text = '成功后分段改写'
    source.character!.presentation!.themeColor = '#000000'
    expect(useCacheStore().snapshotMessages('c1')?.[0]).toMatchObject({
      content: '原始正文',
      assistantSegments: [{ text: '原始分段' }],
      character: { presentation: { themeColor: '#f2a7c6' } }
    })
  })

  it('syncConversations 更新内存会话列表（在线 list 后供离线切换判定）', () => {
    const s = useCacheStore()
    s.syncConversations([{ id: 'c9', title: '新', updatedAt: 't' }])
    expect(s.conversations.map((c) => c.id)).toEqual(['c9'])
  })

  it('purge 删会话联动清快照', () => {
    const s = useCacheStore()
    s.hydrate({ drafts: [], scrollAnchors: {}, conversations: [{ id: 'c1', title: 'A', updatedAt: 't' }], messageSnapshots: { c1: [m('m1', 't')] } })
    s.purge('c1')
    expect(s.snapshotMessages('c1')).toBeUndefined()
  })

  // —— H-11b 残余（2026-09-13）：快照推送失败不再无声 ——
  // 修前是 `catch { /* 缓存缺落由后端调和兜底 */ }`：best-effort 语义没问题，但用户拿不到任何信号，
  // 与草稿域（H-11b）不对称。现记进本 store 的 persistenceFailure，由全局横幅聚合显示；
  // **操作级 fail-open 未变**（失败不影响发送/加载，仍由后端调和兜底）。
  describe('快照推送失败的可见性（H-11b 残余）', () => {
    it('推送失败 → persistenceFailure 置位（code 形态），且不影响调用方', async () => {
      mockApi.cacheMessages.mockRejectedValueOnce(new Error('[PERSISTENCE_WRITE_FAILED] 本地保存失败（ENOSPC）'))
      const s = useCacheStore()
      await expect(s.pushMessages('c1', [m('m1', 't')], 'now')).resolves.toBeUndefined()
      expect(s.persistenceFailure).toEqual({ code: 'PERSISTENCE_WRITE_FAILED' })
    })

    it('后续推送成功 → 清除单次失败（提示不常驻）', async () => {
      mockApi.cacheMessages.mockRejectedValueOnce(new Error('[PERSISTENCE_WRITE_FAILED] 本地保存失败（ENOSPC）'))
      const s = useCacheStore()
      await s.pushMessages('c1', [m('m1', 't')], 'now')
      expect(s.persistenceFailure).toBeDefined()
      await s.pushMessages('c1', [m('m2', 't')], 'now2')
      expect(s.persistenceFailure).toBeUndefined()
    })

    it('降级态不会被一次"成功"推送清掉（Main 侧持续条件）', async () => {
      const s = useCacheStore()
      await s.pushMessages('c1', [m('m1', 't')], 'now')
      s.persistenceFailure = { code: 'PERSISTENCE_DEGRADED', file: 'message-cache-v1.json', reason: 'read-failed:unknown' }
      await s.pushMessages('c1', [m('m2', 't')], 'now2')
      expect(s.persistenceFailure?.code).toBe('PERSISTENCE_DEGRADED')
      expect(s.persistenceFailure?.file).toBe('message-cache-v1.json')
    })
  })
})

describe('chunkMessages（P1-2 分片：≤200 条/批 + 字节预算；单条超限跳过）', () => {
  it('≤200 条且 ≤预算 → 单批', () => {
    const msgs = Array.from({ length: 5 }, (_, i) => m(`m${i}`, `t${i}`))
    expect(chunkMessages(msgs, MAX_IPC_MESSAGE_BYTES)).toHaveLength(1)
  })
  it('>200 条 → 按 200 分片', () => {
    const msgs = Array.from({ length: 450 }, (_, i) => m(`m${i}`, `t${i}`))
    const chunks = chunkMessages(msgs, MAX_IPC_MESSAGE_BYTES)
    expect(chunks.length).toBe(3)
    expect(chunks[0]).toHaveLength(200)
    expect(chunks[1]).toHaveLength(200)
    expect(chunks[2]).toHaveLength(50)
  })
  it('超预算 → 按字节继续分片；单条超限整条跳过', () => {
    const hugeText = 'x'.repeat(1024 * 1024) // 1MiB 单条 → msgBytes≈1MiB+200
    const big: Message = { ...m('big', 't'), content: hugeText }
    const small: Message = m('s', 't') // msgBytes = 200 + 1 = 201
    const chunks = chunkMessages([big, small], 300) // big 超 300 跳过；small 201 < 300 入批
    expect(chunks).toHaveLength(1)
    expect(chunks[0].map((x) => x.messageId)).toEqual(['s'])
  })
})
