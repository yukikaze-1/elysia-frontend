// tests/unit/voice-handlers.spec.ts
// Task 9（P4-B）：语音控制帧 11 通道 + voice:audio-chunk 单向 + 麦克风权限纯决策 + settings load/save 全链路。
// 两层覆盖（同 model-handlers.spec.ts）：
//  ① 直接 createIpcHandler 验证「命令 responseSchema + channel」行为；
//  ② vi.mock('electron') 捕获 ipcMain.handle + ipcMain.on 的 listener，setMainWindow 伪造可信 sender 后直接调用
//     真实 registerVoiceHandlers/registerSettingsHandlers 注册出的 executor/listener，验证装配 + audio-chunk 单向守卫
//     （非受信 sender 拒收 / 超 1MiB 丢弃 / 合法 bytes 转发 sendAudioBytes）。
//  ③ decideMicrophoneAllow 纯函数 + registerMicrophonePermission 假 session 接线（D-P7，Important-5）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createIpcHandler } from '../../src/main/ipc/executor'
import { IpcChannels, type IpcResult } from '@shared/contracts'
import { voiceStartRecordSchema, voiceAudioChunkSchema } from '../../src/main/ipc/channels'
import { SettingsStateSchema, DEFAULT_SETTINGS } from '../../src/shared/schemas'
import { decideMicrophoneAllow, registerMicrophonePermission } from '../../src/main/windows/mic-permission'
import type { MessageSanitizer } from '../../src/main/diagnostics/sanitize'
import type { Logger } from '../../src/main/diagnostics/logger'
import type { BackendAdapter } from '../../src/main/transport/backend-adapter'
import { MAX_AUDIO_CHUNK_BYTES } from '../../src/main/voice/voice-handlers'

const sanitize: MessageSanitizer = (m) => m

// —— electron mock：registry 无 getter，经 ipcMain.handle（invoke）/ipcMain.on（单向）捕获 listener 再直接调用（伪造可信 sender）——
const { mockIpcMain, getListeners } = vi.hoisted(() => {
  const listeners = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    mockIpcMain: {
      handle: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void => { listeners.set(channel, listener) }),
      on: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void => { listeners.set(channel, listener) })
    },
    getListeners: () => listeners
  }
})
vi.mock('electron', () => ({ BrowserWindow: class {}, ipcMain: mockIpcMain }))

const fakeMainFrame = { url: 'cyrene://renderer/index.html' } // P2-01：isTrustedSenderFor 要求 senderFrame === webContents.mainFrame 且 URL 受信
const fakeWindow = { isDestroyed: () => false, webContents: { id: 1, mainFrame: fakeMainFrame } }
const fakeEvent = { sender: fakeWindow.webContents, senderFrame: fakeMainFrame }
/** 非受信 frame URL（http 非回环/非白名单）→ isAppRendererUrl false */
const evilEvent = { sender: fakeWindow.webContents, senderFrame: { url: 'http://evil.example/x' } }

beforeEach(() => {
  getListeners().clear()
  mockIpcMain.handle.mockClear()
  mockIpcMain.on.mockClear()
})

function makeVoiceAdapter() {
  const adapter = {
    startRecordVoice: vi.fn(async () => ({ recordingId: 'rec1' })),
    stopRecordVoice: vi.fn(async () => undefined),
    commitVoice: vi.fn(async () => ({ clientRequestId: 'c1', serverMessageId: 'msg-1' })),
    discardVoice: vi.fn(async () => undefined),
    startRealtimeVoice: vi.fn(async () => ({ sessionId: 'vs1' })),
    stopRealtimeVoice: vi.fn(async () => undefined),
    cancelRealtimeVoice: vi.fn(async () => undefined),
    startDictation: vi.fn(async () => ({ clientRequestId: 'd1' })),
    stopDictation: vi.fn(async () => undefined),
    cancelDictation: vi.fn(async () => undefined),
    sendAudioBytes: vi.fn(),
    audioCancel: vi.fn(async () => undefined)
  }
  return adapter
}

interface SettingsLike { load: () => Promise<unknown>; save: (patch: unknown) => Promise<unknown> }

/** 每次 resetModules + 动态 import 拿全新 registry/voice-handlers/settings-handlers（registry 的 registered Set 模块级，避免重复注册抛错） */
async function registerOnce(adapter: unknown, settings: SettingsLike): Promise<{ invoke: (channel: string, ...args: unknown[]) => Promise<IpcResult<unknown>>; emitOneWay: (channel: string, event: unknown, payload: unknown) => void; logger: Logger }> {
  vi.resetModules()
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), flush: vi.fn(), close: vi.fn() } as unknown as Logger
  const { setMainWindow } = await import('../../src/main/ipc/registry')
  const { registerVoiceHandlers } = await import('../../src/main/voice/voice-handlers')
  const { registerSettingsHandlers } = await import('../../src/main/settings/settings-handlers')
  setMainWindow(fakeWindow as never)
  registerVoiceHandlers({ adapter: adapter as BackendAdapter, media: {} as never, sanitize, logger })
  registerSettingsHandlers({ settings: settings as never, sanitize, logger })
  return {
    invoke: (channel: string, ...args: unknown[]): Promise<IpcResult<unknown>> => {
      const listener = getListeners().get(channel)
      if (!listener) throw new Error(`通道未注册: ${channel}`)
      return listener(fakeEvent as never, ...args) as Promise<IpcResult<unknown>>
    },
    emitOneWay: (channel: string, event: unknown, payload: unknown): void => {
      const listener = getListeners().get(channel)
      if (!listener) throw new Error(`通道未注册: ${channel}`)
      listener(event as never, payload)
    },
    logger
  }
}

describe('voice 控制帧 responseSchema 组合（createIpcHandler 直接镜像）', () => {
  it('voice:start-record 拒绝空 recordingId（SCHEMA_VALIDATION_FAILED）', async () => {
    const h = createIpcHandler(voiceStartRecordSchema, z.object({ recordingId: z.string() }), async () => ({ recordingId: 'x' }), { sanitize, channel: IpcChannels.voiceStartRecord })
    const res = await h({ recordingId: '' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('SCHEMA_VALIDATION_FAILED')
  })
  it('voice:audio-chunk schema：bytes 非 Uint8Array 拒绝', () => {
    expect(voiceAudioChunkSchema.safeParse({ bytes: 'not-bytes' }).success).toBe(false)
    expect(voiceAudioChunkSchema.safeParse({ bytes: new Uint8Array(2) }).success).toBe(true)
  })
})

describe('registerVoiceHandlers 真实接线（electron mock 捕获 ipcMain.handle/on）', () => {
  it('voice:start-record 接线——adapter.startRecordVoice + {recordingId} 响应', async () => {
    const adapter = makeVoiceAdapter()
    const { invoke } = await registerOnce(adapter, { load: vi.fn(), save: vi.fn() })
    const res = await invoke(IpcChannels.voiceStartRecord, { recordingId: 'rec1' })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data).toEqual({ recordingId: 'rec1' })
    expect(adapter.startRecordVoice).toHaveBeenCalledWith({ recordingId: 'rec1' })
  })
  it('voice:stop-record 接线——z.undefined() 响应 + adapter 调用', async () => {
    const adapter = makeVoiceAdapter()
    const { invoke } = await registerOnce(adapter, { load: vi.fn(), save: vi.fn() })
    const res = await invoke(IpcChannels.voiceStopRecord, { recordingId: 'rec1' })
    expect(res.ok).toBe(true)
    expect(adapter.stopRecordVoice).toHaveBeenCalledWith({ recordingId: 'rec1' })
  })
  it('voice:commit 接线——adapter.commitVoice + ClientRequestRef 响应', async () => {
    const adapter = makeVoiceAdapter()
    const { invoke } = await registerOnce(adapter, { load: vi.fn(), save: vi.fn() })
    const input = { recordingId: 'rec1', text: 't', conversationId: 'conv-1001', clientRequestId: 'c1', clientMessageId: 'm1' }
    const res = await invoke(IpcChannels.voiceCommit, input)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data).toEqual({ clientRequestId: 'c1', serverMessageId: 'msg-1' })
    expect(adapter.commitVoice).toHaveBeenCalledWith(input)
  })
  it('voice:commit 接线——畸形响应（缺 clientRequestId）→ SCHEMA_VALIDATION_FAILED', async () => {
    const adapter = makeVoiceAdapter()
    adapter.commitVoice.mockResolvedValueOnce({ serverMessageId: 'msg-1' } as never)
    const { invoke } = await registerOnce(adapter, { load: vi.fn(), save: vi.fn() })
    const res = await invoke(IpcChannels.voiceCommit, { recordingId: 'rec1', text: 't', conversationId: 'conv-1001', clientRequestId: 'c1', clientMessageId: 'm1' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('SCHEMA_VALIDATION_FAILED')
  })
  it('voice:discard 接线——z.undefined() + adapter 调用', async () => {
    const adapter = makeVoiceAdapter()
    const { invoke } = await registerOnce(adapter, { load: vi.fn(), save: vi.fn() })
    const res = await invoke(IpcChannels.voiceDiscard, { recordingId: 'rec1' })
    expect(res.ok).toBe(true)
    expect(adapter.discardVoice).toHaveBeenCalledWith({ recordingId: 'rec1' })
  })
  it('voice:start-realtime 接线——conversationId optional 透传', async () => {
    const adapter = makeVoiceAdapter()
    const { invoke } = await registerOnce(adapter, { load: vi.fn(), save: vi.fn() })
    const res = await invoke(IpcChannels.voiceStartRealtime, { sessionId: 'vs1', conversationId: 'conv-1001' })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data).toEqual({ sessionId: 'vs1' })
    expect(adapter.startRealtimeVoice).toHaveBeenCalledWith({ sessionId: 'vs1', conversationId: 'conv-1001' })
  })
  it('voice:stop/cancel-realtime 接线——z.undefined() + adapter 调用', async () => {
    const adapter = makeVoiceAdapter()
    const { invoke } = await registerOnce(adapter, { load: vi.fn(), save: vi.fn() })
    const stopRes = await invoke(IpcChannels.voiceStopRealtime, { sessionId: 'vs1' })
    expect(stopRes.ok).toBe(true)
    expect(adapter.stopRealtimeVoice).toHaveBeenCalledWith({ sessionId: 'vs1' })
    const cancelRes = await invoke(IpcChannels.voiceCancelRealtime, { sessionId: 'vs1' })
    expect(cancelRes.ok).toBe(true)
    expect(adapter.cancelRealtimeVoice).toHaveBeenCalledWith({ sessionId: 'vs1' })
  })
  it('voice:start-dictation 接线——sttProfileId optional', async () => {
    const adapter = makeVoiceAdapter()
    const { invoke } = await registerOnce(adapter, { load: vi.fn(), save: vi.fn() })
    const res = await invoke(IpcChannels.voiceStartDictation, { clientRequestId: 'd1', sttProfileId: 'x/y' })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data).toEqual({ clientRequestId: 'd1' })
    expect(adapter.startDictation).toHaveBeenCalledWith({ clientRequestId: 'd1', sttProfileId: 'x/y' })
  })
  it('voice:stop/cancel-dictation 接线——z.undefined() + adapter 调用', async () => {
    const adapter = makeVoiceAdapter()
    const { invoke } = await registerOnce(adapter, { load: vi.fn(), save: vi.fn() })
    await invoke(IpcChannels.voiceStopDictation, { clientRequestId: 'd1' })
    expect(adapter.stopDictation).toHaveBeenCalledWith({ clientRequestId: 'd1' })
    await invoke(IpcChannels.voiceCancelDictation, { clientRequestId: 'd1' })
    expect(adapter.cancelDictation).toHaveBeenCalledWith({ clientRequestId: 'd1' })
  })
  it('audio:cancel 接线——z.undefined() + adapter.audioCancel', async () => {
    const adapter = makeVoiceAdapter()
    const { invoke } = await registerOnce(adapter, { load: vi.fn(), save: vi.fn() })
    const res = await invoke(IpcChannels.audioCancel, { streamId: 7 })
    expect(res.ok).toBe(true)
    expect(adapter.audioCancel).toHaveBeenCalledWith({ streamId: 7 })
  })
  it('voice:start-record 非法参数（recordingId 数字）→ SCHEMA_VALIDATION_FAILED 且不调 adapter', async () => {
    const adapter = makeVoiceAdapter()
    const { invoke } = await registerOnce(adapter, { load: vi.fn(), save: vi.fn() })
    const res = await invoke(IpcChannels.voiceStartRecord, { recordingId: 123 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('SCHEMA_VALIDATION_FAILED')
    expect(adapter.startRecordVoice).not.toHaveBeenCalled()
  })
})

describe('voice:audio-chunk 单向通道守卫（registerOneWayHandler）', () => {
  it('受信 sender + 合法 bytes → adapter.sendAudioBytes 转发', async () => {
    const adapter = makeVoiceAdapter()
    const { emitOneWay } = await registerOnce(adapter, { load: vi.fn(), save: vi.fn() })
    const bytes = new Uint8Array([1, 2, 3, 4])
    emitOneWay(IpcChannels.voiceAudioChunk, fakeEvent, { bytes })
    expect(adapter.sendAudioBytes).toHaveBeenCalledTimes(1)
    expect(adapter.sendAudioBytes).toHaveBeenCalledWith(bytes)
  })
  it('非受信 sender → 拒收 + warn（ipc:oneway-untrusted），不调 adapter（trusted-sender guard）', async () => {
    const adapter = makeVoiceAdapter()
    const { emitOneWay, logger } = await registerOnce(adapter, { load: vi.fn(), save: vi.fn() })
    emitOneWay(IpcChannels.voiceAudioChunk, evilEvent, { bytes: new Uint8Array(4) })
    expect(adapter.sendAudioBytes).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith('ipc:oneway-untrusted', expect.objectContaining({ channel: IpcChannels.voiceAudioChunk }))
  })
  it('超 1MiB → 丢弃 + warn（voice:audio-chunk-too-large），不调 adapter', async () => {
    const adapter = makeVoiceAdapter()
    const { emitOneWay, logger } = await registerOnce(adapter, { load: vi.fn(), save: vi.fn() })
    emitOneWay(IpcChannels.voiceAudioChunk, fakeEvent, { bytes: new Uint8Array(MAX_AUDIO_CHUNK_BYTES + 1) })
    expect(adapter.sendAudioBytes).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith('voice:audio-chunk-too-large', expect.objectContaining({ bytes: MAX_AUDIO_CHUNK_BYTES + 1 }))
  })
  it('恰 1MiB → 放行转发（上限含边界）', async () => {
    const adapter = makeVoiceAdapter()
    const { emitOneWay } = await registerOnce(adapter, { load: vi.fn(), save: vi.fn() })
    const bytes = new Uint8Array(MAX_AUDIO_CHUNK_BYTES)
    emitOneWay(IpcChannels.voiceAudioChunk, fakeEvent, { bytes })
    expect(adapter.sendAudioBytes).toHaveBeenCalledTimes(1)
    expect(adapter.sendAudioBytes).toHaveBeenCalledWith(bytes)
  }, 10000) // 7D 门禁收口：全量单测下 registerOnce(resetModules+动态 import) 累计耗时使该用例越过默认 5s（7D 验收记录既有 flaky），单列 10s 上限
  it('payload 畸形（bytes 非 Uint8Array）→ 丢弃 + warn（ipc:oneway-invalid）', async () => {
    const adapter = makeVoiceAdapter()
    const { emitOneWay, logger } = await registerOnce(adapter, { load: vi.fn(), save: vi.fn() })
    emitOneWay(IpcChannels.voiceAudioChunk, fakeEvent, { bytes: 'not-bytes' })
    expect(adapter.sendAudioBytes).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith('ipc:oneway-invalid', expect.objectContaining({ channel: IpcChannels.voiceAudioChunk }))
  })
})

describe('settings load/save 全链路（registerSettingsHandlers 接线）', () => {
  it('settings:load → SettingsStateSchema 合法响应（DEFAULT_SETTINGS）', async () => {
    const settings = { load: vi.fn(async () => DEFAULT_SETTINGS), save: vi.fn() }
    const { invoke } = await registerOnce(makeVoiceAdapter(), settings)
    const res = await invoke(IpcChannels.settingsLoad)
    expect(res.ok).toBe(true)
    if (res.ok) {
      const parsed = SettingsStateSchema.safeParse(res.data)
      expect(parsed.success).toBe(true)
    }
    expect(settings.load).toHaveBeenCalledTimes(1)
  })
  it('settings:save patch merge → 返回 merge 后新 state，patch 原样入参', async () => {
    const merged = { ...DEFAULT_SETTINGS, voice: { ...DEFAULT_SETTINGS.voice, enabled: false } }
    const settings = { load: vi.fn(), save: vi.fn(async () => merged) }
    const { invoke } = await registerOnce(makeVoiceAdapter(), settings)
    const res = await invoke(IpcChannels.settingsSave, { voice: { enabled: false } })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data).toMatchObject({ voice: { enabled: false } })
    expect(settings.save).toHaveBeenCalledWith({ voice: { enabled: false } })
  })
  it('settings:save 畸形 patch（voice.enabled 非 boolean）→ SCHEMA_VALIDATION_FAILED 且不调 svc', async () => {
    const settings = { load: vi.fn(), save: vi.fn() }
    const { invoke } = await registerOnce(makeVoiceAdapter(), settings)
    const res = await invoke(IpcChannels.settingsSave, { voice: { enabled: 'yes' } })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('SCHEMA_VALIDATION_FAILED')
    expect(settings.save).not.toHaveBeenCalled()
  })
  it('批次 C（FINAL-MED）：settings:save 带 tools.grants patch → GRANT_WRITE_DENIED 且不调 svc（GrantStore 唯一写者）', async () => {
    const settings = { load: vi.fn(), save: vi.fn() }
    const { invoke } = await registerOnce(makeVoiceAdapter(), settings)
    // expiresAt 用「合法但远超 30d 白名单上限」的时间戳（约 +100 年，< zod int MAX_SAFE_INTEGER 上限故过 schema）——
    // 平行写面若放行即成事实永久 grant（「无永久 grant」保证旁路）
    const res = await invoke(IpcChannels.settingsSave, { tools: { grants: [{ id: 'g1', toolName: 'desktop.file.write', scope: { directory: '/home/u' }, backendIdentity: 'http://h', expiresAt: Date.now() + 100 * 365 * 86_400_000, createdAt: 'x', source: 'directory' }] } })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('GRANT_WRITE_DENIED')   // 平行写面关闭——防绕过「无永久 grant」保证
    expect(settings.save).not.toHaveBeenCalled()
  })
})

describe('麦克风权限纯决策 + 接线（D-P7，Important-5）', () => {
  const trusted = new Set(['http://localhost', 'http://127.0.0.1', 'http://[::1]'])
  it('非 media 权限 → false', () => {
    expect(decideMicrophoneAllow({ permission: 'geolocation', url: 'cyrene://renderer/index.html', trusted })).toBe(false)
  })
  it('video → false（check mediaType 单数与 request mediaTypes 数组两形态）', () => {
    expect(decideMicrophoneAllow({ permission: 'media', mediaType: 'video', url: 'cyrene://renderer/index.html', trusted })).toBe(false)
    expect(decideMicrophoneAllow({ permission: 'media', mediaTypes: ['audio', 'video'], url: 'cyrene://renderer/index.html', trusted })).toBe(false)
  })
  it('audio + 受信 origin → true（cyrene://renderer 与 dev 回环 http）', () => {
    expect(decideMicrophoneAllow({ permission: 'media', mediaType: 'audio', url: 'cyrene://renderer/index.html', trusted })).toBe(true)
    expect(decideMicrophoneAllow({ permission: 'media', mediaType: 'audio', url: 'http://localhost:5173/index.html', trusted })).toBe(true)
  })
  it('非受信 origin → false', () => {
    expect(decideMicrophoneAllow({ permission: 'media', mediaType: 'audio', url: 'https://evil.example', trusted })).toBe(false)
  })
  it('registerMicrophonePermission 接线：check/request 处理器按纯决策放行', () => {
    const handlers: { check?: (...args: unknown[]) => boolean; request?: (...args: unknown[]) => void } = {}
    const fakeSes = {
      setPermissionCheckHandler: (h: (...args: unknown[]) => boolean) => { handlers.check = h },
      setPermissionRequestHandler: (h: (...args: unknown[]) => void) => { handlers.request = h }
    }
    registerMicrophonePermission(fakeSes as never)
    // check handler：(wc, permission, origin, details)
    expect(handlers.check?.('', 'media', 'cyrene://renderer/index.html', { mediaType: 'audio' })).toBe(true)
    expect(handlers.check?.('', 'media', 'cyrene://renderer/index.html', { mediaType: 'video' })).toBe(false)
    expect(handlers.check?.('', 'geolocation', 'cyrene://renderer/index.html', {})).toBe(false)
    // request handler：(wc, permission, callback, details.requestingUrl/mediaTypes)
    let granted: boolean | undefined
    handlers.request?.('', 'media', (g: boolean) => { granted = g }, { requestingUrl: 'cyrene://renderer/index.html', mediaTypes: ['audio'] })
    expect(granted).toBe(true)
    let denied: boolean | undefined
    handlers.request?.('', 'media', (g: boolean) => { denied = g }, { requestingUrl: 'http://evil.example/x', mediaTypes: ['audio'] })
    expect(denied).toBe(false)
  })
})
