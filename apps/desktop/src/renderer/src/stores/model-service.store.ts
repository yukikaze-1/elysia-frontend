// src/renderer/src/stores/model-service.store.ts
// 阶段 4 批次 A：模型服务设置中心 store——profiles/激活/测试/试听/草稿编排。
// apiKey 一次性红线：store 状态与 drafts 永不持有 apiKey，仅经 saveProfile/testProfile 命令字段瞬时透传，
// 提交后即清（组件局部 ref 持有输入，成功/失败后清空）。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ActiveModelSelection, ModelProfile, ModelProfileTestResult, ModelServiceType, TtsPreviewCommand, TtsVoice, UpsertModelProfileCommand } from '@shared/contracts'
import { api } from './desktop-api'
import { useSettingsStore } from './settings.store'
import { useVoiceStore } from './voice.store'
import { parsePublicError, type PublicError } from '../utils/public-error'

export interface ProfileDraft {
  type: ModelServiceType
  name: string
  baseUrl?: string
  apiKeyEnv?: string
  models?: string[]
  capabilities?: string[]
  executionLocation?: 'backend' | 'desktop' | 'local_worker'
}

function messageOf(e: unknown): string { return e instanceof Error ? e.message : String(e) }

export const useModelServiceStore = defineStore('modelService', () => {
  const profiles = ref<ModelProfile[]>([])
  const active = ref<ActiveModelSelection>({})
  const voices = ref<TtsVoice[] | null>(null)
  const voiceSource = ref<'static' | 'api' | null>(null)
  const currentVoice = ref<string | null>(null)
  const voicesError = ref<PublicError>()        // 错误态一律 PublicError（repo 惯例，UI 渲染 .message）
  const loading = ref(false)
  const testing = ref<Record<string, 'idle' | 'running' | 'ok' | 'error'>>({})
  const testResult = ref<Record<string, ModelProfileTestResult | undefined>>({})
  const previewing = ref(false)
  const saving = ref(false)
  const deleting = ref(false)
  const activating = ref<Record<ModelServiceType, boolean>>({ llm: false, stt: false, tts: false })
  const error = ref<PublicError>()
  const drafts = ref<Record<string, ProfileDraft>>({})
  const validation = ref<Record<string, string[]>>({})
  // 试听结果状态（preview 句柄经 getter 读取，见 preview 定义）
  const previewState = ref<{ url?: string; error?: string } | null>(null)

  function byType(type: ModelServiceType): ModelProfile[] { return profiles.value.filter((p) => p.type === type) }
  function customProfiles(type: ModelServiceType): ModelProfile[] { return byType(type).filter((p) => p.source === 'custom') }
  function activeProfileId(type: ModelServiceType): string | undefined {
    return type === 'llm' ? active.value.llmProfileId : type === 'tts' ? active.value.ttsProfileId : active.value.voiceSttProfileId
  }

  async function load(): Promise<void> {
    loading.value = true; error.value = undefined
    try {
      const [list, sel] = await Promise.all([api.listModelProfiles(), api.getActiveModelSelection()])
      profiles.value = list; active.value = sel
    } catch (e) { error.value = parsePublicError(messageOf(e)) } finally { loading.value = false }
  }

  async function activate(profile: Pick<ModelProfile, 'id' | 'type'>): Promise<void> {
    if (activating.value[profile.type]) return
    activating.value[profile.type] = true; error.value = undefined
    try {
      await api.activateModelProfile({ profileId: profile.id, service: profile.type })
      if (profile.type === 'llm') active.value = { ...active.value, llmProfileId: profile.id }
      else if (profile.type === 'tts') active.value = { ...active.value, ttsProfileId: profile.id }
      else active.value = { ...active.value, voiceSttProfileId: profile.id }
    } catch (e) { error.value = parsePublicError(messageOf(e)) } finally { activating.value[profile.type] = false }
  }

  async function testProfile(profile: Pick<ModelProfile, 'type' | 'provider' | 'model'>, level: 'connectivity' | 'usable', apiKeyInput?: string, baseUrl?: string): Promise<void> {
    const key = `${profile.provider}/${profile.model}|${level}`
    testing.value[key] = 'running'; error.value = undefined
    try {
      // P4-A final review：新 custom 未保存 YAML 条目时后端无法按名解析，需透传 baseUrl 供 test 构造请求 base_url
      const r = await api.testModelProfile({ service: profile.type, provider: profile.provider, model: profile.model, level, ...(apiKeyInput ? { apiKey: apiKeyInput } : {}), ...(baseUrl ? { baseUrl } : {}) })
      testResult.value[key] = r
      testing.value[key] = r.ok ? 'ok' : 'error'
      if (!r.ok) error.value = { message: r.error ?? '测试失败' } as PublicError
    } catch (e) { testing.value[key] = 'error'; testResult.value[key] = undefined; error.value = parsePublicError(messageOf(e)) }
  }

  async function saveProfile(draft: ProfileDraft, apiKeyInput?: string): Promise<void> {
    saving.value = true; error.value = undefined
    try {
      // 显式构造纯对象命令：draft 来自 reactive 容器（drafts.value[key]），其 models/capabilities 是 reactive 数组代理，
      // 直接 {...draft} 展开会把这些 Proxy 送进 contextBridge→ipcRenderer.invoke 的 structured-clone → DataCloneError「An object could not be cloned.」
      // （Task 10 真实 Electron 集成测试暴露；Task 8 单测因不经 contextBridge 未覆盖）。此处克隆数组为普通数组。
      const cmd: UpsertModelProfileCommand = {
        type: draft.type,
        name: draft.name,
        ...(draft.baseUrl !== undefined ? { baseUrl: draft.baseUrl } : {}),
        ...(draft.apiKeyEnv !== undefined ? { apiKeyEnv: draft.apiKeyEnv } : {}),
        ...(draft.models !== undefined ? { models: [...draft.models] } : {}),
        ...(draft.capabilities !== undefined ? { capabilities: [...draft.capabilities] } : {}),
        ...(draft.executionLocation !== undefined ? { executionLocation: draft.executionLocation } : {}),
        ...(apiKeyInput ? { apiKey: apiKeyInput } : {})
      }
      await api.saveModelProfile(cmd)
      delete drafts.value[draft.name]
      delete validation.value[draft.name]
      await load()
    } catch (e) { error.value = parsePublicError(messageOf(e)) } finally { saving.value = false }
  }

  async function deleteProfile(profile: Pick<ModelProfile, 'type' | 'model' | 'provider'>): Promise<void> {
    deleting.value = true; error.value = undefined
    try {
      await api.deleteModelProfile(profile.type, profile.model)
      await load()
      // D-P20：删除被转写引用的 STT Profile → 回退全局活动 STT + toast（I4：无 id，比较须拼 <provider>/<model>）
      if (profile.type === 'stt') {
        const sttRef = `${profile.provider}/${profile.model}`
        if (useSettingsStore().dictation.sttProfileId === sttRef) {
          useSettingsStore().setDictation({ sttProfileId: undefined })
          useVoiceStore().setNotice('转写已回退全局 STT')
        }
      }
    } catch (e) { error.value = parsePublicError(messageOf(e)) } finally { deleting.value = false }
  }

  async function listVoices(): Promise<void> {
    voicesError.value = undefined
    try {
      const r = await api.listTtsVoices()
      voices.value = r.voices; voiceSource.value = r.source
      currentVoice.value = r.current ?? null; voicesError.value = r.error ? { message: r.error } as PublicError : undefined
    } catch (e) { voicesError.value = parsePublicError(messageOf(e)) }
  }

  async function runPreview(input: TtsPreviewCommand): Promise<void> {
    previewing.value = true; previewState.value = null; error.value = undefined
    try {
      const r = await api.previewTts(input)
      previewState.value = r.ok ? { url: r.audioUrl } : { error: r.error ?? '试听失败' }
    } catch (e) { previewState.value = { error: parsePublicError(messageOf(e)).message } } finally { previewing.value = false }
  }

  async function setVoice(voice: string): Promise<void> {
    error.value = undefined
    try { await api.setTtsVoice({ voice }); currentVoice.value = voice } catch (e) { error.value = parsePublicError(messageOf(e)) }
  }

  function startEdit(profile?: ModelProfile): void {
    const key = profile?.model ?? 'new'
    drafts.value[key] = profile && profile.source === 'custom'
      // P4-A final review：编辑回填优先用全量 baseUrl（scheme/path 保留），无则回退 host 拼 https（旧行为兜底）
      ? { type: profile.type, name: profile.model, baseUrl: profile.baseUrl ?? (profile.endpointLabel ? `https://${profile.endpointLabel}` : undefined), models: profile.models, capabilities: profile.capabilities }
      : { type: profile?.type ?? 'llm', name: '', models: [], capabilities: [] }
    validation.value[key] = []
  }
  function updateDraft(key: string, patch: Partial<ProfileDraft>): void {
    drafts.value[key] = { ...drafts.value[key], ...patch }
  }
  function cancelEdit(key: string): void { delete drafts.value[key]; delete validation.value[key] }

  // preview 双用句柄（Task 9 消费约定，brief 同源）：动作调用 preview({voiceId})，结果读取 preview.url / preview.error。
  // 以 ref 状态暴露：Pinia 对 ref 状态按值透出（不套 action 包装），getter 得以保留；状态单一来源 previewState ref 保持响应式。
  interface PreviewHandle { (input: TtsPreviewCommand): Promise<void>; url?: string; error?: string }
  const previewHandle = runPreview as PreviewHandle
  Object.defineProperty(previewHandle, 'url', { get: () => previewState.value?.url, configurable: true })
  Object.defineProperty(previewHandle, 'error', { get: () => previewState.value?.error, configurable: true })
  const preview = ref<PreviewHandle>(previewHandle)

  return {
    profiles, active, voices, voiceSource, currentVoice, voicesError, loading, testing, testResult, previewing, preview,
    saving, deleting, activating, error, drafts, validation,
    byType, customProfiles, activeProfileId, load, activate, testProfile, saveProfile, deleteProfile,
    listVoices, setVoice, startEdit, updateDraft, cancelEdit
  }
})
