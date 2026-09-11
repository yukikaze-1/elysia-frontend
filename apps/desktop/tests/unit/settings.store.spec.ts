// tests/unit/settings.store.spec.ts
// Task 11（spec §5.10）：settingsStore——hydrate（成功覆盖/失败 fail-open）、setVoice/setDictation 本地改 + 500ms 防抖持久化
// （fake timers，patch 累积合并）、saveError/saved、applyDictationInsert（D-P4）写草稿、insertDictationText 纯函数。
// env=node:store 经 stores/desktop-api 注入 mock api(R2);pinia 用 createPinia + setActivePinia。
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { insertDictationText, SETTINGS_SAVE_DEBOUNCE_MS, useSettingsStore } from '../../src/renderer/src/stores/settings.store'
import { useDraftStore } from '../../src/renderer/src/stores/draft.store'
import { useConversationStore } from '../../src/renderer/src/stores/conversation.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import type { SettingsState } from '@shared/contracts'
import { DEFAULT_LIVE2D } from '../../src/shared/schemas'

const mockApi = {
  connect: vi.fn(), disconnect: vi.fn(), listConversations: vi.fn(), getMessages: vi.fn(),
  send: vi.fn(), cancel: vi.fn(), activate: vi.fn(), createConversation: vi.fn(),
  renameConversation: vi.fn(), deleteConversation: vi.fn(), getConnectionState: vi.fn(),
  getCredentialStatus: vi.fn(), setBackendToken: vi.fn(), clearBackendToken: vi.fn(),
  setEndpoint: vi.fn(), getEndpoint: vi.fn(), getRuntimeInfo: vi.fn(),
  onChatEvent: vi.fn(() => () => {}), onChatState: vi.fn(() => () => {}), onChatReplay: vi.fn(() => () => {}), onChatError: vi.fn(() => () => {}),
  hydratePersistence: vi.fn(), persistSession: vi.fn(), cacheMessages: vi.fn(), openExternal: vi.fn(),
  attachmentsValidate: vi.fn(), attachmentsUpload: vi.fn(), attachmentsCancel: vi.fn(), attachmentsCheck: vi.fn(),
  queryChatHistory: vi.fn(), getMessageContext: vi.fn(), listStickers: vi.fn(),
  listModelProfiles: vi.fn(), saveModelProfile: vi.fn(), deleteModelProfile: vi.fn(), testModelProfile: vi.fn(), activateModelProfile: vi.fn(), getActiveModelSelection: vi.fn(),
  listTtsVoices: vi.fn(), previewTts: vi.fn(), setTtsVoice: vi.fn(),
  // P4-B 语音/设置面
  voiceStartRecord: vi.fn(), voiceStopRecord: vi.fn(), voiceCommit: vi.fn(), voiceDiscard: vi.fn(),
  voiceStartRealtime: vi.fn(), voiceStopRealtime: vi.fn(), voiceCancelRealtime: vi.fn(),
  voiceStartDictation: vi.fn(), voiceStopDictation: vi.fn(), voiceCancelDictation: vi.fn(),
  audioCancel: vi.fn(), voiceSendAudio: vi.fn(), settingsLoad: vi.fn(), settingsSave: vi.fn(),
  // 阶段 5 批次 A（A6）
  listLive2dModels: vi.fn(), readLive2dModelFile: vi.fn(),
  onToolEvent: vi.fn(() => () => {}), toolDecide: vi.fn(), toolCancel: vi.fn(), toolList: vi.fn(), toolPickSource: vi.fn(), toolConfirmUpload: vi.fn(), toolGrantDirectory: vi.fn(), toolListGrants: vi.fn(), toolRevokeGrant: vi.fn(), toolListHistory: vi.fn(),
  // 阶段 7 批次 A（Task 5）：诊断面（DesktopApiLike 全契约镜像——mock 补键）
  diagnosticsState: vi.fn(), diagnosticsDevModeSet: vi.fn(), diagnosticsOpenLogDir: vi.fn(), diagnosticsClearLogs: vi.fn(), diagnosticsExport: vi.fn(), onDiagnosticsDevEvent: vi.fn(() => () => {}), getLastCrash: vi.fn(),
}

function state(over: Partial<SettingsState> = {}): SettingsState {
  return {
    version: 1,
    voice: { enabled: true, realtimeEnabled: false, autoReadReply: true, showCaptions: true, consentBackendStt: false },
    dictation: { insertMode: 'append' },
    live2d: { ...DEFAULT_LIVE2D },
    tools: { grants: [] }, // 阶段 6 批次 C（D6C-02）：tools 空子树
    ...over
  }
}

/** 模拟 Main SettingsService.save 的 patch-merge 语义：返回合并后 state（未提交字段保持现值） */
function applyPatch(
  base: SettingsState,
  patch: { voice?: Partial<SettingsState['voice']>; dictation?: Partial<SettingsState['dictation']>; live2d?: Partial<SettingsState['live2d']> }
): SettingsState {
  return {
    ...base,
    voice: { ...base.voice, ...patch.voice },
    dictation: { ...base.dictation, ...patch.dictation },
    live2d: { ...base.live2d, ...patch.live2d }
  }
}

describe('settingsStore', () => {
  beforeEach(() => { setActivePinia(createPinia()); setDesktopApi(mockApi); vi.clearAllMocks() })
  afterEach(() => { vi.useRealTimers() })

  it('hydrate 成功覆盖 state + loaded=true', async () => {
    mockApi.settingsLoad.mockResolvedValue(state({
      voice: { enabled: false, realtimeEnabled: true, autoReadReply: false, showCaptions: false, consentBackendStt: true, micDeviceId: 'dev-1' },
      dictation: { sttProfileId: 'p/m', insertMode: 'replace_selection' }
    }))
    const s = useSettingsStore()
    await s.hydrate()
    expect(s.loaded).toBe(true)
    expect(s.voice.enabled).toBe(false)
    expect(s.voice.micDeviceId).toBe('dev-1')
    expect(s.dictation.insertMode).toBe('replace_selection')
    expect(s.dictation.sttProfileId).toBe('p/m')
  })

  it('hydrate 失败 fail-open：保留默认 + loaded=true（不抛错）', async () => {
    mockApi.settingsLoad.mockRejectedValue(new Error('[IPC_ERROR] 读盘失败'))
    const s = useSettingsStore()
    await expect(s.hydrate()).resolves.toBeUndefined()
    expect(s.loaded).toBe(true)
    expect(s.voice.enabled).toBe(true)          // DEFAULT_SETTINGS 默认
    expect(s.dictation.insertMode).toBe('append')
  })

  it('setVoice 本地改 + 500ms 防抖持久化（窗口内不触发）', async () => {
    vi.useFakeTimers()
    mockApi.settingsSave.mockImplementation(async (patch) => applyPatch(state(), patch))
    const s = useSettingsStore()
    s.setVoice({ enabled: false })
    expect(s.voice.enabled).toBe(false)                // 本地立即生效
    expect(s.saved).toBe(false)
    expect(mockApi.settingsSave).not.toHaveBeenCalled() // 500ms 内不落盘
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS)
    expect(mockApi.settingsSave).toHaveBeenCalledTimes(1)
    expect(mockApi.settingsSave).toHaveBeenCalledWith({ voice: { enabled: false } })
    expect(s.saved).toBe(true)
    expect(s.voice.enabled).toBe(false) // 回包 merge 后保持
  })

  it('防抖窗口内多次 setVoice → 单次 save 且 patch 累积合并（不丢字段）', async () => {
    vi.useFakeTimers()
    mockApi.settingsSave.mockImplementation(async (patch) => applyPatch(state(), patch))
    const s = useSettingsStore()
    s.setVoice({ enabled: false })
    s.setVoice({ autoReadReply: false })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS)
    expect(mockApi.settingsSave).toHaveBeenCalledTimes(1)
    expect(mockApi.settingsSave).toHaveBeenCalledWith({ voice: { enabled: false, autoReadReply: false } })
    expect(s.voice.enabled).toBe(false)
    expect(s.voice.autoReadReply).toBe(false)
  })

  it('setDictation 持久化 dictation 子树（独立于 voice）', async () => {
    vi.useFakeTimers()
    mockApi.settingsSave.mockImplementation(async (patch) => applyPatch(state(), patch))
    const s = useSettingsStore()
    s.setDictation({ insertMode: 'replace_selection' })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS)
    expect(mockApi.settingsSave).toHaveBeenCalledWith({ dictation: { insertMode: 'replace_selection' } })
    expect(s.dictation.insertMode).toBe('replace_selection')
  })

  it('跨子树累积：setDictation 后紧跟 setVoice → 单次 save 载荷含两棵子树修改（评审 Important-1）', async () => {
    vi.useFakeTimers()
    mockApi.settingsSave.mockImplementation(async (patch) => applyPatch(state(), patch))
    const s = useSettingsStore()
    s.setDictation({ sttProfileId: 'stt/p1' })
    s.setVoice({ autoReadReply: false })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS)
    expect(mockApi.settingsSave).toHaveBeenCalledTimes(1)
    expect(mockApi.settingsSave).toHaveBeenCalledWith({
      voice: { autoReadReply: false },
      dictation: { sttProfileId: 'stt/p1' }
    })
    expect(s.voice.autoReadReply).toBe(false)
    expect(s.dictation.sttProfileId).toBe('stt/p1')
  })

  it('setVoice 失败 → saveError 置位 + 本地改保留（fail-open UI 可展示）', async () => {
    vi.useFakeTimers()
    mockApi.settingsSave.mockRejectedValue(new Error('[IPC_ERROR] [UNKNOWN] 写盘失败'))
    const s = useSettingsStore()
    s.setVoice({ showCaptions: false })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS)
    expect(s.saveError).toContain('写盘失败')
    expect(s.saved).toBe(false)
    expect(s.voice.showCaptions).toBe(false) // 本地改不回滚
  })

  // —— 阶段 5 批次 A（A6，D5A-10）：live2d 子树三处接线 ——
  it('hydrate 读回 live2d 段（enabled/modelId）', async () => {
    mockApi.settingsLoad.mockResolvedValue(state({ live2d: { ...DEFAULT_LIVE2D, enabled: false, modelId: 'haru' } }))
    const s = useSettingsStore()
    await s.hydrate()
    expect(s.live2d.enabled).toBe(false)
    expect(s.live2d.modelId).toBe('haru')
  })

  it('setLive2d 本地改 + 500ms 防抖持久化 live2d 子树', async () => {
    vi.useFakeTimers()
    mockApi.settingsSave.mockImplementation(async (patch) => applyPatch(state(), patch))
    const s = useSettingsStore()
    s.setLive2d({ modelId: 'haru' })
    expect(s.live2d.modelId).toBe('haru') // 本地立即生效
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS)
    expect(mockApi.settingsSave).toHaveBeenCalledTimes(1)
    expect(mockApi.settingsSave).toHaveBeenCalledWith({ live2d: { modelId: 'haru' } })
    expect(s.live2d.enabled).toBe(true) // 回写 merge 保留未提交字段
    expect(s.live2d.modelId).toBe('haru')
  })

  it('跨子树累积：setVoice + setLive2d 同窗口 → 单次 save 含两棵子树（I1 防混改丢子树）', async () => {
    vi.useFakeTimers()
    mockApi.settingsSave.mockImplementation(async (patch) => applyPatch(state(), patch))
    const s = useSettingsStore()
    s.setVoice({ autoReadReply: false })
    s.setLive2d({ enabled: false })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS)
    expect(mockApi.settingsSave).toHaveBeenCalledTimes(1)
    expect(mockApi.settingsSave).toHaveBeenCalledWith({
      voice: { autoReadReply: false },
      live2d: { enabled: false }
    })
    expect(s.voice.autoReadReply).toBe(false)
    expect(s.live2d.enabled).toBe(false)
  })

  it('仅 live2d patch 时 persist 不早退（第三键早退条件）', async () => {
    vi.useFakeTimers()
    mockApi.settingsSave.mockImplementation(async (patch) => applyPatch(state(), patch))
    const s = useSettingsStore()
    s.setLive2d({ modelId: 'lil' })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS)
    expect(mockApi.settingsSave).toHaveBeenCalledTimes(1) // 未被 if(!pending.live2d) 早退跳过
    expect(s.live2d.modelId).toBe('lil')
  })
})

describe('insertDictationText（D-P4 纯函数）', () => {
  it('append 模式 → 草稿末尾追加', () => {
    expect(insertDictationText('hello ', 'world', 'append')).toBe('hello world')
    expect(insertDictationText('', 'abc', 'append')).toBe('abc')
  })

  it('replace_selection 且有选区 → 替换区间', () => {
    expect(insertDictationText('hello world', 'X', 'replace_selection', { start: 6, end: 11 })).toBe('hello X')
    expect(insertDictationText('abc', 'Y', 'replace_selection', { start: 0, end: 3 })).toBe('Y')
  })

  it('replace_selection 无选区 → 回退追加', () => {
    expect(insertDictationText('hello', 'X', 'replace_selection')).toBe('helloX')
  })

  it('选区越界/倒置/空 → 回退追加', () => {
    expect(insertDictationText('hello', 'X', 'replace_selection', { start: 5, end: 2 })).toBe('helloX')  // 倒置
    expect(insertDictationText('hello', 'X', 'replace_selection', { start: 0, end: 0 })).toBe('helloX')  // 空选区
    expect(insertDictationText('hello', 'X', 'replace_selection', { start: 10, end: 20 })).toBe('helloX') // 越界钳制后无区间
    expect(insertDictationText('hello', 'X', 'replace_selection', { start: -5, end: 100 })).toBe('X')    // 越界钳制后覆盖全串
  })
})

describe('applyDictationInsert（写草稿）', () => {
  beforeEach(() => { setActivePinia(createPinia()); setDesktopApi(mockApi); vi.clearAllMocks() })

  it('append 模式 → saveDraft 追加草稿末尾', () => {
    const conv = useConversationStore()
    conv.$patch({ currentId: 'conv-1' })
    const draftStore = useDraftStore()
    draftStore.saveDraft('conv-1', '已有草稿')
    const s = useSettingsStore()
    s.applyDictationInsert('，追加')
    expect(draftStore.drafts['conv-1']).toBe('已有草稿，追加')
    void draftStore.flush('conv-1') // 清 draft persist 定时器
  })

  it('replace_selection 有选区 → 替换区间；无选区回退追加', () => {
    const conv = useConversationStore()
    conv.$patch({ currentId: 'conv-1' })
    const draftStore = useDraftStore()
    draftStore.saveDraft('conv-1', 'abcdef')
    const s = useSettingsStore()
    s.$patch({ dictation: { insertMode: 'replace_selection' } }) // 直接置模式，不走防抖 save
    s.applyDictationInsert('X', { start: 2, end: 5 })
    expect(draftStore.drafts['conv-1']).toBe('abXf')
    s.applyDictationInsert('!') // 无选区 → 追加
    expect(draftStore.drafts['conv-1']).toBe('abXf!')
    void draftStore.flush('conv-1')
  })

  it('无活动会话 → no-op 不改草稿', () => {
    useConversationStore().$patch({ currentId: undefined })
    const draftStore = useDraftStore()
    draftStore.saveDraft('conv-1', '草稿')
    const s = useSettingsStore()
    s.applyDictationInsert('文字')
    expect(draftStore.drafts['conv-1']).toBe('草稿') // 不写入任何会话
    void draftStore.flush('conv-1')
  })
})
