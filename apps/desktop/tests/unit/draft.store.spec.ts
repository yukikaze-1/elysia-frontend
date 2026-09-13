// tests/unit/draft.store.spec.ts —— spec §4.4.1：save/get/超限/防抖持久化/切会话 flush/发送清空/删除清理。
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useDraftStore, DRAFT_MAX_BYTES } from '../../src/renderer/src/stores/draft.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { createDesktopApiMock } from './helpers/desktop-api'
import type { PersistSessionInput, SessionPersistenceState } from '@shared/contracts'

// I-06 / P2-10：原为手搓的 DesktopApiLike 全契约镜像（每个键裸 `vi.fn()`）。
const mockApi = createDesktopApiMock()

/**
 * "任意字符串" 非对称匹配器（`updatedAt` 只断言存在性，不断言取值）。
 *
 * 为什么不直接写 `expect.any(String)`：vitest 把 `expect.any` 的返回类型声明成 `any`
 * （实测 `AsymmetricMatchersContaining.any: (sample?: unknown) => any`），放进 `PersistSessionInput`
 * 这类具名契约里会命中 `no-unsafe-assignment`。运行时 `expect.any(String)` 的返回值确实就是
 * 这个非对称匹配器，故经 `unknown` 收窄到目标类型；预期对象本身仍用真实契约类型标注，
 * 契约漂移照样编译报错。
 */
const anyString = (): string => expect.any(String) as string

/** 空水合态（本组用例只关心 persistenceDegraded，其余字段给最小合法值） */
const EMPTY_STATE: SessionPersistenceState = { drafts: [], scrollAnchors: {}, conversations: [], messageSnapshots: {} }

describe('draftStore（spec §4.4.1）', () => {
  beforeEach(() => { setActivePinia(createPinia()); setDesktopApi(mockApi); vi.useFakeTimers(); mockApi.persistSession.mockReset(); mockApi.persistSession.mockResolvedValue({}) })
  afterEach(() => { vi.useRealTimers() })

  it('saveDraft 写入内存 + 800ms 防抖后 persistSession（携带草稿+锚点）', async () => {
    const s = useDraftStore()
    s.setScrollAnchor('c1', { messageId: 'm1', offset: 5 })
    expect(s.saveDraft('c1', '你好')).toBe(true)
    expect(s.drafts['c1']).toBe('你好')
    expect(mockApi.persistSession).not.toHaveBeenCalled()
    vi.advanceTimersByTime(800)
    expect(mockApi.persistSession).toHaveBeenCalledTimes(1)
    const expectedWrite: PersistSessionInput = {
      conversationId: 'c1', draft: { text: '你好', updatedAt: anyString() }, scrollAnchor: { messageId: 'm1', offset: 5 }
    }
    expect(mockApi.persistSession).toHaveBeenCalledWith(expectedWrite)
  })

  it('超限（UTF-8 字节 >100KB）拒绝写入 + overLimit 置位，不静默截断', () => {
    const s = useDraftStore()
    const big = '汉'.repeat(Math.ceil(DRAFT_MAX_BYTES / 3)) // 100KB 字节 → 码点 <100k，按字节算超限
    expect(s.saveDraft('c1', big)).toBe(false)
    expect(s.drafts['c1']).toBeUndefined()
    expect(s.overLimit['c1']).toBe(true)
  })

  it('flush 立即持久化并取消待写防抖（切会话/发送路径）', async () => {
    const s = useDraftStore()
    s.saveDraft('c1', 'x')
    vi.advanceTimersByTime(300)
    await s.flush('c1')
    expect(mockApi.persistSession).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2000)
    expect(mockApi.persistSession).toHaveBeenCalledTimes(1) // 防抖已取消
  })

  it('clear 持久化空串（发送成功清空）；hydrate 水合草稿+锚点', async () => {
    const s = useDraftStore()
    s.saveDraft('c1', 'typing')
    s.clear('c1')
    expect(s.drafts['c1']).toBeUndefined()
    await s.flush('c1')
    const expectedClear: PersistSessionInput = {
      conversationId: 'c1', draft: { text: '', updatedAt: anyString() }, scrollAnchor: null
    }
    expect(mockApi.persistSession).toHaveBeenLastCalledWith(expectedClear)
    const state: SessionPersistenceState = {
      drafts: [{ conversationId: 'c9', text: '旧草稿', attachmentLocalIds: [], updatedAt: 't' }],
      scrollAnchors: { c9: { messageId: 'm9', offset: 3 } }, conversations: [], messageSnapshots: {}
    }
    s.hydrate(state)
    expect(s.drafts['c9']).toBe('旧草稿')
    expect(s.scrollAnchors['c9']).toEqual({ messageId: 'm9', offset: 3 })
  })

  it('removeConversations 清被淘汰项 + evictionNotice 置位（P2-1 不静默）', () => {
    const s = useDraftStore()
    s.saveDraft('old', 'x'); s.saveDraft('new', 'y')
    s.removeConversations(['old'])
    expect(s.drafts['old']).toBeUndefined()
    expect(s.evictionNotice).toContain('old')
  })

  it('purge 删会话联动：清内存草稿/锚点 + 取消待写', () => {
    const s = useDraftStore()
    s.saveDraft('c1', 'x'); s.setScrollAnchor('c1', { messageId: 'm1', offset: 0 })
    s.purge('c1')
    expect(s.drafts['c1']).toBeUndefined()
    expect(s.scrollAnchors['c1']).toBeUndefined()
  })

  // —— H-04（2026-09-11）：退出前 flush。此前 flush 只有「切会话」「断线」两个调用点，
  // 键入后立刻关窗时定时器未到期，内容无提示消失。——
  it('flushAll 把仍在防抖窗口内的所有会话一次落盘（H-04）', async () => {
    const s = useDraftStore()
    s.saveDraft('c1', 'a'); s.saveDraft('c2', 'b')
    vi.advanceTimersByTime(300)                                  // 未到 800ms，防抖未触发
    expect(mockApi.persistSession).not.toHaveBeenCalled()
    await s.flushAll()
    expect(mockApi.persistSession).toHaveBeenCalledTimes(2)
    // 逐次断言 c1/c2 的落盘载荷（原为两次 `expect.objectContaining`——vitest 把它的返回类型声明成
    // `any`，放进具名契约会命中 no-unsafe-assignment；这里改成按调用序取载荷，断言等价且载荷类型真实）
    const [callC1, callC2] = mockApi.persistSession.mock.calls
    const payloadC1: PersistSessionInput = callC1[0]
    const payloadC2: PersistSessionInput = callC2[0]
    expect(payloadC1.conversationId).toBe('c1')
    expect(payloadC1.draft.text).toBe('a')
    expect(payloadC2.conversationId).toBe('c2')
    expect(payloadC2.draft.text).toBe('b')
    vi.advanceTimersByTime(2000)
    expect(mockApi.persistSession).toHaveBeenCalledTimes(2)       // 定时器已取消，不重复写
  })

  it('flushAll 无待写会话 → no-op（不产生空写）', async () => {
    const s = useDraftStore()
    await s.flushAll()
    expect(mockApi.persistSession).not.toHaveBeenCalled()
  })

  // —— H-11b renderer 半边（2026-09-13）：持久化失败不再静默 ——
  // 修复前 `persistNow` 的 catch 无条件 fail-open：保内存态、下次重试、不告诉任何人。
  // 对单次抖动这是对的；对"降级态（本进程内不会自愈）"则意味着用户会一直以为草稿存着。
  describe('持久化故障可见性（H-11b renderer 半边）', () => {
    it('写入被拒（PERSISTENCE_DEGRADED）→ persistenceFailure 置位，且内存态仍保留（fail-open 不退化）', async () => {
      const s = useDraftStore()
      mockApi.persistSession.mockRejectedValueOnce(new Error('[PERSISTENCE_DEGRADED] 持久化已降级（drafts-v1.json：schema-version-mismatch:99），已拒绝写入以保留现场'))
      s.saveDraft('c1', '没存住的内容')
      await s.flush('c1')
      expect(s.persistenceFailure).toMatchObject({ code: 'PERSISTENCE_DEGRADED' })
      expect(s.drafts['c1'], 'fail-open：内存态必须保留，否则用户当场丢字').toBe('没存住的内容')
    })

    it('单次写失败（PERSISTENCE_WRITE_FAILED）→ 置位；下一次成功写回后清除', async () => {
      const s = useDraftStore()
      mockApi.persistSession.mockRejectedValueOnce(new Error('[PERSISTENCE_WRITE_FAILED] 本地保存失败（ENOSPC）'))
      s.saveDraft('c1', 'a')
      await s.flush('c1')
      expect(s.persistenceFailure).toMatchObject({ code: 'PERSISTENCE_WRITE_FAILED' })
      s.saveDraft('c1', 'ab')
      await s.flush('c1')
      expect(mockApi.persistSession).toHaveBeenCalledTimes(2)
      expect(s.persistenceFailure, '恢复可写后必须撤下横幅，否则提示变成噪音').toBeUndefined()
    })

    it('降级态不会被一次"成功"响应清掉（Main 侧条件本进程内不可自愈）', async () => {
      const s = useDraftStore()
      s.hydrate({ ...EMPTY_STATE, persistenceDegraded: { file: 'drafts-v1.json', reason: 'schema-version-mismatch:99' } })
      expect(s.persistenceFailure).toMatchObject({ code: 'PERSISTENCE_DEGRADED', file: 'drafts-v1.json' })
      s.saveDraft('c1', 'x')
      await s.flush('c1')   // mock 默认 resolve({})
      expect(s.persistenceFailure?.code).toBe('PERSISTENCE_DEGRADED')
    })

    it('启动水合即显示降级态（不是等到下一次键入触发拒绝才显示）', () => {
      const s = useDraftStore()
      expect(s.persistenceFailure).toBeUndefined()
      s.hydrate({ ...EMPTY_STATE, persistenceDegraded: { file: 'message-cache-v1.json', reason: 'read-failed:unknown' } })
      expect(s.persistenceFailure).toEqual({ code: 'PERSISTENCE_DEGRADED', file: 'message-cache-v1.json', reason: 'read-failed:unknown' })
    })

    it('水合正常时清除上次故障（一次成功水合 = 持久化可用）', () => {
      const s = useDraftStore()
      s.hydrate({ ...EMPTY_STATE, persistenceDegraded: { file: 'drafts-v1.json', reason: 'not-an-object' } })
      s.hydrate(EMPTY_STATE)
      expect(s.persistenceFailure).toBeUndefined()
    })
  })
})
