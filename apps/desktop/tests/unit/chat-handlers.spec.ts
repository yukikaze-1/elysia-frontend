// tests/unit/chat-handlers.spec.ts
// Task 3(批次C):chat-handlers 各命令 responseSchema 组合 + registerChatHandlers logger/channel 接线。
// 两层覆盖:
//  ① 直接 createIpcHandler 验证「各命令 responseSchema + channel 组合」的行为(镜像 spec §4.1.2;接口核验 F1,不依赖 electron);
//  ② vi.mock('electron') 捕获 ipcMain.handle 的 listener,setMainWindow 伪造可信 sender 后直接调用
//     真实 registerChatHandlers 注册出的 executor,验证实现实际接线(responseSchema/必填 endpoint/channel/logger 透传)。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createIpcHandler } from '../../src/main/ipc/executor'
import { ConnectionStateSchema, MessagePageSchema, PageSchema, ConversationSchema, ChatHistoryPageSchema, StickerManifestSchema } from '@shared/schemas'
import { IpcChannels, type IpcResult } from '@shared/contracts'
import { chatListStickersSchema, chatQueryHistorySchema, chatSetEndpointSchema } from '../../src/main/ipc/channels'
import type { Logger } from '../../src/main/diagnostics/logger'
import type { ChatService } from '../../src/main/chat/chat-service'

const sanitize = (m: string): string => m

// —— electron mock:registry 无 getter,经 ipcMain.handle 捕获 listener 再直接调用(触发 isTrustedSender 需伪造可信 sender)——
const { mockIpcMain, getListeners } = vi.hoisted(() => {
  const listeners = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    mockIpcMain: {
      handle: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void => {
        listeners.set(channel, listener)
      })
    },
    getListeners: () => listeners
  }
})
vi.mock('electron', () => ({ BrowserWindow: class {}, ipcMain: mockIpcMain }))

const fakeMainFrame = { url: 'cyrene://renderer/index.html' } // P2-01:isTrustedSenderFor 要求 senderFrame === webContents.mainFrame 且 URL 受信
const fakeWindow = { isDestroyed: () => false, webContents: { id: 1, mainFrame: fakeMainFrame } }
const fakeEvent = { sender: fakeWindow.webContents, senderFrame: fakeMainFrame }

beforeEach(() => {
  getListeners().clear()
  mockIpcMain.handle.mockClear()
})

describe('chat 命令 responseSchema 组合(createIpcHandler 直接镜像)', () => {
  it('chatGetState 的 responseSchema 拒绝畸形 ConnectionState(SCHEMA_VALIDATION_FAILED)', async () => {
    const h = createIpcHandler(z.undefined(), ConnectionStateSchema, () => ({ status: 'bogus' }), { sanitize, channel: IpcChannels.chatGetState })
    const res = await h(undefined)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('SCHEMA_VALIDATION_FAILED')
  })
  it('chatListConversations 的 PageSchema(ConversationSchema) 拒绝畸形 page', async () => {
    const h = createIpcHandler(z.undefined(), PageSchema(ConversationSchema), () => ({ items: [{ id: 'c', title: 't' }], hasMore: false }), { sanitize, channel: IpcChannels.chatListConversations })
    const res = await h(undefined)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('SCHEMA_VALIDATION_FAILED')
  })
  it('chatGetMessages 的 MessagePageSchema 拒绝缺 items', async () => {
    const h = createIpcHandler(z.undefined(), MessagePageSchema, () => ({}), { sanitize, channel: IpcChannels.chatGetMessages })
    const res = await h(undefined)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('SCHEMA_VALIDATION_FAILED')
  })
  it('chatDisconnect 的 z.undefined() 接受成功 undefined', async () => {
    const h = createIpcHandler(z.undefined(), z.undefined(), () => undefined, { sanitize, channel: IpcChannels.chatDisconnect })
    expect((await h(undefined)).ok).toBe(true)
  })
  it('chatSetEndpoint 用必填 schema z.object({endpoint:z.string()})——拒绝缺 endpoint(可执行性 7/N7)', async () => {
    const h = createIpcHandler(chatSetEndpointSchema, z.object({ endpoint: z.string() }), () => ({}), { sanitize, channel: IpcChannels.chatSetEndpoint })
    const res = await h({ serverUrl: 'http://127.0.0.1:1' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('SCHEMA_VALIDATION_FAILED')
  })
})

describe('registerChatHandlers 真实接线(electron mock 捕获 ipcMain.handle)', () => {
  /** 每次 resetModules + 动态 import 拿全新 registry/chat-handlers(registry 的 registered Set 模块级,单次注册避免重复注册抛错);返回 invoke + 本次 logger */
  async function registerOnce(svc: unknown): Promise<{ invoke: (channel: string, ...args: unknown[]) => Promise<IpcResult<unknown>>; logger: Logger }> {
    vi.resetModules()
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), flush: vi.fn(), close: vi.fn() } as unknown as Logger
    const { setMainWindow } = await import('../../src/main/ipc/registry')
    const { registerChatHandlers } = await import('../../src/main/chat/chat-handlers')
    setMainWindow(fakeWindow as never)
    registerChatHandlers({ svc: svc as ChatService, sanitize, logger })
    return {
      logger,
      invoke: (channel: string, ...args: unknown[]): Promise<IpcResult<unknown>> => {
        const listener = getListeners().get(channel)
        if (!listener) throw new Error(`通道未注册: ${channel}`)
        return listener(fakeEvent, ...args) as Promise<IpcResult<unknown>>
      }
    }
  }

  it('chatSetEndpoint 接线必填 endpoint——svc 返回缺 endpoint → SCHEMA_VALIDATION_FAILED', async () => {
    const { invoke } = await registerOnce({ setEndpoint: () => ({}) })
    const res = await invoke(IpcChannels.chatSetEndpoint, { serverUrl: 'http://127.0.0.1:1' })
    expect(res).toMatchObject({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED' } })
  })

  it('chatGetState 接线 ConnectionStateSchema + channel/logger 透传——畸形 status → SCHEMA_VALIDATION_FAILED + ipc:response-invalid 日志', async () => {
    const { invoke, logger } = await registerOnce({ getConnectionState: () => ({ status: 'bogus' }) })
    const res = await invoke(IpcChannels.chatGetState)
    expect(res).toMatchObject({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED' } })
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith('ipc:response-invalid', expect.objectContaining({ channel: IpcChannels.chatGetState }))
  })

  it('chatDisconnect 接线 z.undefined()——成功 undefined → ok:true', async () => {
    const { invoke } = await registerOnce({ disconnect: async () => undefined })
    expect((await invoke(IpcChannels.chatDisconnect)).ok).toBe(true)
  })

  it('chatConnect 接线 BackendSessionSchema——合法 session → ok:true', async () => {
    const { invoke } = await registerOnce({ connect: async () => ({ sessionId: 's1', protocolVersion: '1.0', serverUrl: 'http://127.0.0.1:8000' }) })
    const res = await invoke(IpcChannels.chatConnect)
    expect(res).toMatchObject({ ok: true, data: { sessionId: 's1' } })
  })

  it('chatListConversations 接线 PageSchema(ConversationSchema)——合法 page → ok:true', async () => {
    const { invoke } = await registerOnce({ listConversations: async () => ({ items: [{ id: 'c1', title: 't', updatedAt: 'd' }], hasMore: false }) })
    const res = await invoke(IpcChannels.chatListConversations, {})
    expect(res).toMatchObject({ ok: true, data: { items: [{ id: 'c1' }], hasMore: false } })
  })
})

describe('G4 历史/上下文/表情通道（registerChatHandlers 真实接线）', () => {
  it('chatQueryHistory 响应 ChatHistoryPageSchema 拒绝畸形页', async () => {
    const h = createIpcHandler(chatQueryHistorySchema, ChatHistoryPageSchema, () => ({ items: [{ conversationId: 'c1' }], hasMore: false }), { sanitize, channel: IpcChannels.chatQueryHistory })
    const res = await h({ scope: { type: 'all_conversations' }, timeZone: 'UTC', category: 'all', limit: 50 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('SCHEMA_VALIDATION_FAILED')
  })
  it('chatListStickers 响应 StickerManifestSchema 拒绝畸形（P0-2：stickers 形状）', async () => {
    const h = createIpcHandler(chatListStickersSchema, StickerManifestSchema, () => ({ stickers: [{ stickerId: '' }] }), { sanitize, channel: IpcChannels.chatListStickers })
    expect((await h(undefined)).ok).toBe(false)
  })
})
