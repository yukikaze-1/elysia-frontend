// tests/unit/persistence-handlers.spec.ts —— 四通道接线 + openExternal http/https 白名单 + responseSchema 镜像。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createIpcHandler } from '../../src/main/ipc/executor'
import type { IpcResult } from '@shared/contracts'
import { SessionPersistenceStateSchema, PersistSessionInputSchema, PersistSessionResultSchema, CacheMessagesInputSchema, OpenExternalInputSchema } from '@shared/schemas'
import { openExternal } from '../../src/main/persistence/persistence-handlers'

const sanitize = (m: string): string => m

const { mockShell } = vi.hoisted(() => ({ mockShell: { openExternal: vi.fn() } }))
vi.mock('electron', () => ({ shell: mockShell, BrowserWindow: class {}, ipcMain: { handle: vi.fn() } }))

describe('openExternal（spec §4.2 http/https 白名单）', () => {
  beforeEach(() => mockShell.openExternal.mockClear())
  it('http/https 通过 → shell.openExternal', () => {
    openExternal('https://example.com/')
    expect(mockShell.openExternal).toHaveBeenCalledWith('https://example.com/')
  })
  it('非 http/https scheme（file:/cyrene:/javascript:）拒绝', () => {
    expect(() => openExternal('file:///etc/passwd')).toThrow()
    expect(() => openExternal('cyrene://x')).toThrow()
    expect(() => openExternal('javascript:alert(1)')).toThrow()
    expect(mockShell.openExternal).not.toHaveBeenCalled()
  })
  it('非法 URL / 超 2048 字符拒绝', () => {
    expect(() => openExternal('not a url')).toThrow()
    expect(() => openExternal('https://e.com/' + 'a'.repeat(2100))).toThrow()
  })

  // H-12（2026-09-11）：此前是裸 `void shell.openExternal(...)`——拒绝逃逸成主进程未捕获异常，
  // 既不进日志也不进审计，而 renderer 早已收到 {ok:true}（UI 认为链接打开了）。
  it('shell.openExternal 拒绝 → 记 warn 日志且不外抛（UI 契约不变，失败不再静默）', async () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), flush: vi.fn(), close: vi.fn() }
    mockShell.openExternal.mockRejectedValueOnce(new Error('no browser handler'))
    expect(() => openExternal('https://example.com/', { logger, sanitize })).not.toThrow()
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledTimes(1))
    expect(logger.warn).toHaveBeenCalledWith('open-external-failed', { message: 'no browser handler' })
  })

  it('未注入 logger 时拒绝仍被吞掉（不产生未捕获异常）', async () => {
    mockShell.openExternal.mockRejectedValueOnce(new Error('boom'))
    expect(() => openExternal('https://example.com/')).not.toThrow()
    await Promise.resolve()
  })
})

describe('persistence 四通道接线（request/response schema 组合）', () => {
  it('chatHydratePersistence 无参 + SessionPersistenceStateSchema 响应', async () => {
    const h = createIpcHandler(z.undefined(), SessionPersistenceStateSchema, () => ({ drafts: [], scrollAnchors: {}, conversations: [], messageSnapshots: {} }), { sanitize })
    const res = (await h(undefined)) as IpcResult<unknown>
    expect(res.ok).toBe(true)
  })
  it('chatPersistSession 用 PersistSessionInputSchema 入参 + PersistSessionResultSchema 响应（含 evictedConversationIds）', async () => {
    const h = createIpcHandler(
      PersistSessionInputSchema,
      PersistSessionResultSchema,
      () => ({ evictedConversationIds: ['old'] }),
      { sanitize }
    )
    const res = (await h({ conversationId: 'c1', draft: { text: 'x', updatedAt: 't' }, scrollAnchor: null })) as IpcResult<unknown>
    expect(res.ok).toBe(true)
    expect((res as { ok: true; data: { evictedConversationIds: string[] } }).data.evictedConversationIds).toEqual(['old'])
  })
  it('chatCacheMessages 入参 schema 拒绝非法消息（空 messageId）', async () => {
    const h = createIpcHandler(CacheMessagesInputSchema, z.undefined(), () => {}, { sanitize })
    const bad = await h({ conversationId: 'c1', messages: [{ messageId: '', conversationId: 'c1', role: 'user', status: 'completed', createdAt: 't' }], updatedAt: 't' })
    expect(bad.ok).toBe(false)
  })
  it('appOpenExternal 入参 schema（OpenExternalInputSchema）', async () => {
    const h = createIpcHandler(OpenExternalInputSchema, z.undefined(), () => {}, { sanitize })
    expect((await h({ url: 'https://e.com' })).ok).toBe(true)
    expect((await h({ url: 42 })).ok).toBe(false)
  })
})
