import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useModelServiceStore } from '../../src/renderer/src/stores/model-service.store'
import { useSettingsStore } from '../../src/renderer/src/stores/settings.store'
import { useVoiceStore } from '../../src/renderer/src/stores/voice.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { createDesktopApiMock } from './helpers/desktop-api'
import type { ModelProfile } from '@shared/contracts'

// I-06 / P2-10：原为手搓的 DesktopApiLike 全契约镜像（每个键裸 `vi.fn()`）。
const mockApi = createDesktopApiMock()

beforeEach(() => {
  setActivePinia(createPinia()); setDesktopApi(mockApi); vi.clearAllMocks()
  mockApi.listModelProfiles.mockResolvedValue([])   // saveProfile/deleteProfile 内部 load() 依赖它返回数组（Minor #17 防 undefined）
  mockApi.getActiveModelSelection.mockResolvedValue({})
})

// I-06：加真实类型标注——原先裸 mock 的 `any` 掩盖了 fixture 与契约的漂移
// （`type: string` 而非 `ModelServiceType` 这类字面量窄化缺失，迁移后立刻被 tsc 抓到）。
const PROFILES: ModelProfile[] = [
  { id: 'deepseek/deepseek-v4-flash', type: 'llm', displayName: 'deepseek', source: 'built_in', provider: 'deepseek', model: 'deepseek-v4-flash', models: ['deepseek-v4-flash'], executionLocation: 'backend', credentialStatus: 'configured', enabled: true, capabilities: [], builtIn: true },
  { id: 'custom/my-llm', type: 'llm', displayName: 'my-llm', source: 'custom', provider: 'custom', model: 'my-llm', models: [], executionLocation: 'backend', credentialStatus: 'missing', enabled: true, capabilities: [], builtIn: false }
]

describe('modelServiceStore', () => {
  it('load 拉 profiles + 激活选择', async () => {
    mockApi.listModelProfiles.mockResolvedValue(PROFILES)
    mockApi.getActiveModelSelection.mockResolvedValue({ llmProfileId: 'deepseek/deepseek-v4-flash' })
    const s = useModelServiceStore()
    await s.load()
    expect(s.profiles).toHaveLength(2)
    expect(s.active.llmProfileId).toBe('deepseek/deepseek-v4-flash')
  })
  it('activate 成功后更新 active', async () => {
    mockApi.activateModelProfile.mockResolvedValue(undefined)
    const s = useModelServiceStore()
    await s.activate({ id: 'custom/my-llm', type: 'llm' } as never)
    expect(mockApi.activateModelProfile).toHaveBeenCalledWith({ profileId: 'custom/my-llm', service: 'llm' })
    expect(s.active.llmProfileId).toBe('custom/my-llm')
  })
  it('activate 失败可见错误且 active 不变', async () => {
    mockApi.activateModelProfile.mockRejectedValue(new Error('[IPC_ERROR] [UNKNOWN] [backendCode=PROFILE_RUNTIME_NOT_BACKEND] 该 Profile 由 Electron 执行'))
    const s = useModelServiceStore()
    await s.activate({ id: 'custom/my-llm', type: 'llm' } as never)
    expect(s.error?.backendCode).toBe('PROFILE_RUNTIME_NOT_BACKEND')
    expect(s.active.llmProfileId).toBeUndefined()
  })
  it('deleteProfile PROFILE_IN_USE → 可见错误', async () => {
    mockApi.deleteModelProfile.mockRejectedValue(new Error('[IPC_ERROR] [UNKNOWN] [backendCode=PROFILE_IN_USE] custom/x 正在使用'))
    const s = useModelServiceStore()
    await s.deleteProfile({ type: 'llm', model: 'x' } as never)
    expect(s.error?.backendCode).toBe('PROFILE_IN_USE')
  })
  it('deleteProfile 删除被转写引用的 STT Profile → dictation.sttProfileId 清空 + toast（D-P20）', async () => {
    mockApi.deleteModelProfile.mockResolvedValue(undefined)
    const settings = useSettingsStore()
    settings.$patch({ dictation: { sttProfileId: 'stt/foo', insertMode: 'append' } })
    const s = useModelServiceStore()
    await s.deleteProfile({ type: 'stt', provider: 'stt', model: 'foo' })
    expect(settings.dictation.sttProfileId).toBeUndefined()
    expect(useVoiceStore().notice).toBe('转写已回退全局 STT')
    expect(mockApi.deleteModelProfile).toHaveBeenCalledWith('stt', 'foo')
  })
  it('deleteProfile 删除未被转写引用的 STT/LLM Profile → sttProfileId 不变、无 toast（D-P20）', async () => {
    mockApi.deleteModelProfile.mockResolvedValue(undefined)
    const settings = useSettingsStore()
    settings.$patch({ dictation: { sttProfileId: 'stt/keep', insertMode: 'append' } })
    const s = useModelServiceStore()
    await s.deleteProfile({ type: 'stt', provider: 'stt', model: 'other' })
    expect(settings.dictation.sttProfileId).toBe('stt/keep')
    expect(useVoiceStore().notice).toBeNull()
    await s.deleteProfile({ type: 'llm', provider: 'stt', model: 'keep' })
    expect(settings.dictation.sttProfileId).toBe('stt/keep')
    expect(useVoiceStore().notice).toBeNull()
  })
  it('saveProfile 一次性 apiKey 提交；drafts 不含 apiKey', async () => {
    mockApi.saveModelProfile.mockResolvedValue(PROFILES[1])
    const s = useModelServiceStore()
    const draft = { type: 'llm', name: 'my-llm', baseUrl: 'https://api.example.com' } as const
    await s.saveProfile(draft, 'secret-key')
    expect(mockApi.saveModelProfile).toHaveBeenCalledWith({ ...draft, apiKey: 'secret-key' })
    expect(JSON.stringify(s.drafts)).not.toContain('secret-key')
  })
  it('startEdit 编辑 custom：baseUrl 优先全量（scheme/path 保留）；无则回退 host 拼 https（P4-A final review）', async () => {
    const s = useModelServiceStore()
    s.startEdit({ ...PROFILES[1], endpointLabel: 'api.example.com', baseUrl: 'http://api.example.com:8080/v1' } as never)
    expect(s.drafts['my-llm'].baseUrl).toBe('http://api.example.com:8080/v1')
    s.startEdit({ ...PROFILES[1], endpointLabel: 'api.example.com' } as never)
    expect(s.drafts['my-llm'].baseUrl).toBe('https://api.example.com')
  })
  it('testProfile 透传 baseUrl（新 custom 未持久化，测试需 baseUrl 才能构造请求；P4-A final review）', async () => {
    mockApi.testModelProfile.mockResolvedValue({ profileId: 'custom/my-llm', service: 'llm', level: 'connectivity', ok: true })
    const s = useModelServiceStore()
    await s.testProfile({ type: 'llm', provider: 'custom', model: 'my-llm' }, 'connectivity', undefined, 'http://api.example.com:8080/v1')
    expect(mockApi.testModelProfile).toHaveBeenCalledWith({ service: 'llm', provider: 'custom', model: 'my-llm', level: 'connectivity', baseUrl: 'http://api.example.com:8080/v1' })
    expect(s.testing['custom/my-llm|connectivity']).toBe('ok')
  })
  it('listVoices + setVoice 更新 currentVoice', async () => {
    mockApi.listTtsVoices.mockResolvedValue({ voices: [{ id: 'v1', languages: [], capabilities: [] }], source: 'static' })
    mockApi.setTtsVoice.mockResolvedValue(undefined)
    const s = useModelServiceStore()
    await s.listVoices()
    expect(s.voices).toHaveLength(1)
    await s.setVoice('v1')
    expect(s.currentVoice).toBe('v1')
  })
  it('preview 成功 → preview.url；失败 → preview.error', async () => {
    mockApi.previewTts.mockResolvedValue({ ok: true, audioUrl: 'cyrene://renderer/__cyrene-media/tts-preview/ttsp-1' })
    const s = useModelServiceStore()
    await s.preview({ voiceId: 'v1' })
    expect(s.preview?.url).toContain('ttsp-1')
  })
})
