// tests/unit/model-handlers.spec.ts
// Task 6（P4-A）：models*/tts* 九通道 handler 接线——list/save/delete/test/activate/get-active-selection + tts list/preview/set。
// 装配验证 + previewTts 组装一次性 cyrene media URL（二进制不越 Main）。
// 两层覆盖（同 chat-handlers.spec.ts）：
//  ① 直接 createIpcHandler 验证「命令 responseSchema + channel」行为（schema 拒绝畸形/凭据回显）；
//  ② vi.mock('electron') 捕获 ipcMain.handle 的 listener，setMainWindow 伪造可信 sender 后直接调用
//     真实 registerModelHandlers 注册出的 executor，验证装配 + previewTts 组装。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createIpcHandler } from '../../src/main/ipc/executor'
import { IpcChannels, type IpcResult } from '@shared/contracts'
import {
  modelsListProfilesSchema,
  modelsSaveProfileSchema,
  ttsPreviewSchema
} from '../../src/main/ipc/channels'
import { ModelProfileSchema, TtsPreviewOutcomeSchema } from '../../src/shared/schemas'
import type { MessageSanitizer } from '../../src/main/diagnostics/sanitize'
import type { Logger } from '../../src/main/diagnostics/logger'
import type { BackendAdapter } from '../../src/main/transport/backend-adapter'

const sanitize: MessageSanitizer = (m) => m

// —— electron mock：registry 无 getter，经 ipcMain.handle 捕获 listener 再直接调用（伪造可信 sender）——
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

const fakeMainFrame = { url: 'cyrene://renderer/index.html' } // P2-01：isTrustedSenderFor 要求 senderFrame === webContents.mainFrame 且 URL 受信
const fakeWindow = { isDestroyed: () => false, webContents: { id: 1, mainFrame: fakeMainFrame } }
const fakeEvent = { sender: fakeWindow.webContents, senderFrame: fakeMainFrame }

beforeEach(() => {
  getListeners().clear()
  mockIpcMain.handle.mockClear()
})

function makeAdapter() {
  const profile = {
    id: 'custom/my-llm', type: 'llm', displayName: 'my-llm', source: 'custom', provider: 'custom', model: 'my-llm',
    models: ['m1'], executionLocation: 'backend', credentialStatus: 'configured', enabled: true, capabilities: ['chat'], builtIn: false
  }
  const adapter = {
    listModelProfiles: vi.fn(async () => [profile]),
    saveModelProfile: vi.fn(async () => profile),
    deleteModelProfile: vi.fn(async () => undefined),
    testModelProfile: vi.fn(async () => ({ profileId: 'custom/my-llm', service: 'llm', level: 'connectivity', ok: true, latencyMs: 42 })),
    activateModelProfile: vi.fn(async () => undefined),
    getActiveModelSelection: vi.fn(() => ({ llmProfileId: 'custom/my-llm' })),
    listTtsVoices: vi.fn(async () => ({ voices: [{ id: 'v1', languages: [], capabilities: [] }], current: 'v1', source: 'static' })),
    previewTts: vi.fn(async () => ({ ok: true, mime: 'audio/wav', bytes: new Uint8Array([1, 2, 3]), durationMs: 500 })),
    setTtsVoice: vi.fn(async () => undefined)
  }
  return { adapter, profile }
}

interface MediaLike { putTtsPreview: (id: string, bytes: Uint8Array, mime: string) => void }

/** 每次 resetModules + 动态 import 拿全新 registry/model-handlers（registry 的 registered Set 模块级，避免重复注册抛错） */
async function registerOnce(adapter: unknown, media: MediaLike): Promise<{ invoke: (channel: string, ...args: unknown[]) => Promise<IpcResult<unknown>> }> {
  vi.resetModules()
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), flush: vi.fn(), close: vi.fn() } as unknown as Logger
  const { setMainWindow } = await import('../../src/main/ipc/registry')
  const { registerModelHandlers } = await import('../../src/main/models/model-handlers')
  setMainWindow(fakeWindow as never)
  registerModelHandlers({ adapter: adapter as BackendAdapter, media, sanitize, logger })
  return {
    invoke: (channel: string, ...args: unknown[]): Promise<IpcResult<unknown>> => {
      const listener = getListeners().get(channel)
      if (!listener) throw new Error(`通道未注册: ${channel}`)
      return listener(fakeEvent as never, ...args) as Promise<IpcResult<unknown>>
    }
  }
}

describe('models*/tts* 命令 responseSchema 组合（createIpcHandler 直接镜像）', () => {
  it('models:list-profiles 拒绝非法 type（SCHEMA_VALIDATION_FAILED）', async () => {
    const h = createIpcHandler(modelsListProfilesSchema, z.array(ModelProfileSchema), () => [], { sanitize, channel: IpcChannels.modelsListProfiles })
    const res = await h({ type: 'gpu' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('SCHEMA_VALIDATION_FAILED')
  })
  it('models:save-profile 响应 schema 拒绝畸形 ModelProfile（缺 id）', async () => {
    const h = createIpcHandler(modelsSaveProfileSchema, ModelProfileSchema, () => ({ type: 'llm' }), { sanitize, channel: IpcChannels.modelsSaveProfile })
    const res = await h({ type: 'llm', name: 'x' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('SCHEMA_VALIDATION_FAILED')
  })
  it('tts:preview 响应 TtsPreviewOutcomeSchema——ok:false + error 透传（IPC 信封仍成功）', async () => {
    const h = createIpcHandler(ttsPreviewSchema, TtsPreviewOutcomeSchema, () => ({ ok: false, error: '试听生成失败' }), { sanitize, channel: IpcChannels.ttsPreview })
    const res = await h({})
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data).toEqual({ ok: false, error: '试听生成失败' })
  })
})

describe('registerModelHandlers 真实接线（electron mock 捕获 ipcMain.handle）', () => {
  it('models:list-profiles 接线——adapter 列表原样透传（type 参数透传）', async () => {
    const { adapter } = makeAdapter()
    const { invoke } = await registerOnce(adapter, { putTtsPreview: vi.fn() })
    const res = await invoke(IpcChannels.modelsListProfiles, { type: 'llm' })
    expect(res.ok).toBe(true)
    if (res.ok) expect((res.data as unknown[])).toHaveLength(1)
    expect(adapter.listModelProfiles).toHaveBeenCalledWith('llm')
  })
  it('models:save-profile 接线——调 adapter.saveModelProfile 并返回 ModelProfile', async () => {
    const { adapter, profile } = makeAdapter()
    const { invoke } = await registerOnce(adapter, { putTtsPreview: vi.fn() })
    const input = { type: 'llm', name: 'my-llm', apiKey: 'k' }
    const res = await invoke(IpcChannels.modelsSaveProfile, input)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data).toEqual(profile)
    expect(adapter.saveModelProfile).toHaveBeenCalledWith(input)
  })
  it('models:save-profile 凭据回显防护——响应剥离 apiKey 字段（schema strip）', async () => {
    const { adapter, profile } = makeAdapter()
    adapter.saveModelProfile.mockResolvedValueOnce({ ...profile, apiKey: 'sk-secret' } as never)
    const { invoke } = await registerOnce(adapter, { putTtsPreview: vi.fn() })
    const res = await invoke(IpcChannels.modelsSaveProfile, { type: 'llm', name: 'my-llm', apiKey: 'sk-secret' })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(JSON.stringify(res.data)).not.toContain('apiKey')
      expect(JSON.stringify(res.data)).not.toContain('sk-secret')
    }
  })
  it('models:delete-profile 接线——z.undefined() 响应 + adapter 解构调用', async () => {
    const { adapter } = makeAdapter()
    const { invoke } = await registerOnce(adapter, { putTtsPreview: vi.fn() })
    const res = await invoke(IpcChannels.modelsDeleteProfile, { service: 'llm', name: 'my-llm' })
    expect(res.ok).toBe(true)
    expect(adapter.deleteModelProfile).toHaveBeenCalledWith('llm', 'my-llm')
  })
  it('models:test-profile 接线——adapter 测试结果透传', async () => {
    const { adapter } = makeAdapter()
    const { invoke } = await registerOnce(adapter, { putTtsPreview: vi.fn() })
    const res = await invoke(IpcChannels.modelsTestProfile, { service: 'llm', provider: 'custom', model: 'my-llm', level: 'connectivity' })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data).toMatchObject({ profileId: 'custom/my-llm', ok: true })
    expect(adapter.testModelProfile).toHaveBeenCalledWith(expect.objectContaining({ level: 'connectivity' }))
  })
  it('models:activate-profile 接线——z.undefined() 响应 + adapter 调用', async () => {
    const { adapter } = makeAdapter()
    const { invoke } = await registerOnce(adapter, { putTtsPreview: vi.fn() })
    const res = await invoke(IpcChannels.modelsActivateProfile, { profileId: 'custom/my-llm', service: 'llm' })
    expect(res.ok).toBe(true)
    expect(adapter.activateModelProfile).toHaveBeenCalledWith({ profileId: 'custom/my-llm', service: 'llm' })
  })
  it('models:get-active-selection 接线——0 参 + ActiveModelSelection', async () => {
    const { adapter } = makeAdapter()
    const { invoke } = await registerOnce(adapter, { putTtsPreview: vi.fn() })
    const res = await invoke(IpcChannels.modelsGetActiveSelection)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data).toEqual({ llmProfileId: 'custom/my-llm' })
    expect(adapter.getActiveModelSelection).toHaveBeenCalled()
  })
  it('tts:list-voices 接线——0 参 + TtsVoiceListResult', async () => {
    const { adapter } = makeAdapter()
    const { invoke } = await registerOnce(adapter, { putTtsPreview: vi.fn() })
    const res = await invoke(IpcChannels.ttsListVoices)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data).toMatchObject({ current: 'v1', source: 'static' })
    expect(adapter.listTtsVoices).toHaveBeenCalled()
  })
  it('tts:preview 接线——成功组装一次性 cyrene media URL（二进制不越 Main）', async () => {
    const { adapter } = makeAdapter()
    const putTtsPreview = vi.fn((id: string, _bytes: Uint8Array, _mime: string): string => id)
    const { invoke } = await registerOnce(adapter, { putTtsPreview })
    const res = await invoke(IpcChannels.ttsPreview, { voiceId: 'v1' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data).toMatchObject({ ok: true, durationMs: 500 })
    expect((res.data as { audioUrl?: string }).audioUrl).toMatch(/^cyrene:\/\/renderer\/__cyrene-media\/tts-preview\/ttsp-[0-9a-f-]{36}$/)
    const id = (res.data as { audioUrl?: string }).audioUrl?.split('/').pop()
    expect(putTtsPreview).toHaveBeenCalledTimes(1)
    expect(putTtsPreview).toHaveBeenCalledWith(id, new Uint8Array([1, 2, 3]), 'audio/wav')
    expect(adapter.previewTts).toHaveBeenCalledWith({ voiceId: 'v1' })
    // 传输面永不回传二进制/明文
    expect(JSON.stringify(res.data)).not.toMatch(/bytes|base64|audio\/wav/i)
  })
  it('tts:preview 接线——adapter 返回 ok:false → 数据层透传 + 不写 media', async () => {
    const { adapter } = makeAdapter()
    adapter.previewTts.mockResolvedValueOnce({ ok: false, error: '试听生成失败' } as never)
    const putTtsPreview = vi.fn()
    const { invoke } = await registerOnce(adapter, { putTtsPreview })
    const res = await invoke(IpcChannels.ttsPreview, {})
    expect(res.ok).toBe(true) // IPC 信封成功；TtsPreviewOutcome.ok=false 在 data 内
    if (res.ok) expect(res.data).toEqual({ ok: false, error: '试听生成失败' })
    expect(putTtsPreview).not.toHaveBeenCalled()
  })
  it('tts:preview 非法参数（voiceId 非字符串）→ SCHEMA_VALIDATION_FAILED', async () => {
    const { adapter } = makeAdapter()
    const { invoke } = await registerOnce(adapter, { putTtsPreview: vi.fn() })
    const res = await invoke(IpcChannels.ttsPreview, { voiceId: 123 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('SCHEMA_VALIDATION_FAILED')
    expect(adapter.previewTts).not.toHaveBeenCalled()
  })
  it('tts:set-voice 接线——z.undefined() 响应 + adapter 调用', async () => {
    const { adapter } = makeAdapter()
    const { invoke } = await registerOnce(adapter, { putTtsPreview: vi.fn() })
    const res = await invoke(IpcChannels.ttsSetVoice, { voice: 'v2' })
    expect(res.ok).toBe(true)
    expect(adapter.setTtsVoice).toHaveBeenCalledWith({ voice: 'v2' })
  })
})
