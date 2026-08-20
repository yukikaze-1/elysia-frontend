// tests/unit/desktop-api-voice.spec.ts
// Task 9（P4-B）：preload desktopApi 语音/设置面——11 控制帧 invoke 信封 + settingsLoad/Save + voiceSendAudio 拷贝（Important-6）。
// env=node:mock 'electron' 的 ipcRenderer（send/invoke/on）。voiceSendAudio 是单向 send：断言发往 voice:audio-chunk、
// payload.bytes 是 fresh Uint8Array（非入参同一引用）、reactive 代理入参不抛 DataCloneError（显式 new Uint8Array(bytes) 拷贝）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { IpcChannels } from '@shared/contracts'

const { mockIpc } = vi.hoisted(() => {
  const mockIpc = {
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn()
  }
  return { mockIpc }
})
vi.mock('electron', () => ({ ipcRenderer: mockIpc }))

async function importDesktopApi() {
  const mod = await import('../../src/preload/desktop-api')
  return { desktopApi: mod.desktopApi, mockIpc }
}

beforeEach(() => {
  mockIpc.invoke.mockReset()
  mockIpc.send.mockReset()
})

describe('desktopApi 语音面（P4-B）', () => {
  it('voice:start-record invoke → 解包 {recordingId}（入参原样）', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValueOnce({ ok: true, data: { recordingId: 'rec1' } })
    const out = await desktopApi.voiceStartRecord({ recordingId: 'rec1' })
    expect(out).toEqual({ recordingId: 'rec1' })
    expect(mockIpc.invoke).toHaveBeenCalledWith(IpcChannels.voiceStartRecord, { recordingId: 'rec1' })
  })
  it('voice:stop-record invoke → void 信封', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValueOnce({ ok: true, data: undefined })
    await desktopApi.voiceStopRecord({ recordingId: 'rec1' })
    expect(mockIpc.invoke).toHaveBeenCalledWith(IpcChannels.voiceStopRecord, { recordingId: 'rec1' })
  })
  it('voice:commit invoke → ClientRequestRef 解包（clientRequestId/serverMessageId）', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValueOnce({ ok: true, data: { clientRequestId: 'c1', serverMessageId: 'msg-1' } })
    const input = { recordingId: 'rec1', text: 't', conversationId: 'conv-1001', clientRequestId: 'c1', clientMessageId: 'm1' }
    const out = await desktopApi.voiceCommit(input)
    expect(out).toEqual({ clientRequestId: 'c1', serverMessageId: 'msg-1' })
    expect(mockIpc.invoke).toHaveBeenCalledWith(IpcChannels.voiceCommit, input)
  })
  it('voice:discard / realtime stop/cancel / dictation stop/cancel / audio:cancel → void 信封', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({ ok: true, data: undefined })
    await desktopApi.voiceDiscard({ recordingId: 'rec1' })
    await desktopApi.voiceStopRealtime({ sessionId: 'vs1' })
    await desktopApi.voiceCancelRealtime({ sessionId: 'vs1' })
    await desktopApi.voiceStopDictation({ clientRequestId: 'd1' })
    await desktopApi.voiceCancelDictation({ clientRequestId: 'd1' })
    await desktopApi.audioCancel({ streamId: 7 })
    mockIpc.invoke.mockResolvedValue({ ok: true, data: { sessionId: 'vs1' } })
    expect(await desktopApi.voiceStartRealtime({ sessionId: 'vs1' })).toEqual({ sessionId: 'vs1' })
    mockIpc.invoke.mockResolvedValue({ ok: true, data: { clientRequestId: 'd1' } })
    expect(await desktopApi.voiceStartDictation({ clientRequestId: 'd1' })).toEqual({ clientRequestId: 'd1' })
    expect(mockIpc.invoke).toHaveBeenCalledWith(IpcChannels.voiceDiscard, { recordingId: 'rec1' })
    expect(mockIpc.invoke).toHaveBeenCalledWith(IpcChannels.voiceStopRealtime, { sessionId: 'vs1' })
    expect(mockIpc.invoke).toHaveBeenCalledWith(IpcChannels.voiceCancelRealtime, { sessionId: 'vs1' })
    expect(mockIpc.invoke).toHaveBeenCalledWith(IpcChannels.voiceStopDictation, { clientRequestId: 'd1' })
    expect(mockIpc.invoke).toHaveBeenCalledWith(IpcChannels.voiceCancelDictation, { clientRequestId: 'd1' })
    expect(mockIpc.invoke).toHaveBeenCalledWith(IpcChannels.audioCancel, { streamId: 7 })
  })
  it('settings:load invoke → SettingsState；settings:save patch → merge 后 state', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    const state = { version: 1, voice: { enabled: true, realtimeEnabled: false, autoReadReply: true, showCaptions: true, consentBackendStt: false }, dictation: { insertMode: 'append' }, live2d: { enabled: true, modelId: null, scale: 1, offsetX: 0, offsetY: 0, mouseTracking: true, autoMotions: true, lipSync: true, performanceMode: 'auto', reduceMotion: false }, tools: { grants: [] } }
    mockIpc.invoke.mockResolvedValueOnce({ ok: true, data: state })
    expect(await desktopApi.settingsLoad()).toEqual(state)
    expect(mockIpc.invoke).toHaveBeenCalledWith(IpcChannels.settingsLoad)
    mockIpc.invoke.mockResolvedValueOnce({ ok: true, data: { ...state, voice: { ...state.voice, enabled: false } } })
    expect(await desktopApi.settingsSave({ voice: { enabled: false } })).toMatchObject({ voice: { enabled: false } })
    expect(mockIpc.invoke).toHaveBeenCalledWith(IpcChannels.settingsSave, { voice: { enabled: false } })
  })

  describe('voiceSendAudio 单向拷贝（Important-6）', () => {
    it('发送 fresh Uint8Array 拷贝（非入参同一引用）且内容一致', async () => {
      const { desktopApi, mockIpc } = await importDesktopApi()
      const input = new Uint8Array([1, 2, 3])
      desktopApi.voiceSendAudio(input)
      expect(mockIpc.send).toHaveBeenCalledTimes(1)
      const [channel, payload] = mockIpc.send.mock.calls[0] as [string, { bytes: Uint8Array }]
      expect(channel).toBe(IpcChannels.voiceAudioChunk)
      expect(payload.bytes).toBeInstanceOf(Uint8Array)
      expect(payload.bytes).not.toBe(input) // fresh copy，非同一引用
      expect(Array.from(payload.bytes)).toEqual([1, 2, 3])
    })
    it('reactive 代理入参不抛 DataCloneError（先拷贝再 send）', async () => {
      const { desktopApi, mockIpc } = await importDesktopApi()
      // Vue reactive 包装 typed array：内部 slot 检查经 Reflect.get(target,..,target) 转发，length/迭代可用；
      // 直传 ipcRenderer.send 的 structured clone 会对 exotic 代理抛 DataCloneError——Uint8Array.from 先拷贝成普通 typed array
      const reactiveBytes = reactive(new Uint8Array([9, 8]))
      expect(() => desktopApi.voiceSendAudio(reactiveBytes)).not.toThrow()
      const [, payload] = mockIpc.send.mock.calls[0] as [string, { bytes: Uint8Array }]
      expect(payload.bytes).toBeInstanceOf(Uint8Array)
      expect(payload.bytes).not.toBe(reactiveBytes)
      expect(Array.from(payload.bytes)).toEqual([9, 8])
    })
  })
})
