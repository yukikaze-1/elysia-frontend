// tests/unit/settings.store.spec.ts
// Task 11（spec §5.10）：settingsStore——hydrate（成功覆盖/失败 fail-open）、setVoice/setDictation 本地改 + 500ms 防抖持久化
// （fake timers，patch 累积合并）、saveError/saved、applyDictationInsert（D-P4）写草稿、insertDictationText 纯函数。
// env=node:store 经 stores/desktop-api 注入 mock api(R2);pinia 用 createPinia + setActivePinia。
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { hasPendingPatch, insertDictationText, mergeSettingsPatch, SETTINGS_SAVE_DEBOUNCE_MS, SETTINGS_SAVE_RETRY_MS, useSettingsStore } from '../../src/renderer/src/stores/settings.store'
import { useDraftStore } from '../../src/renderer/src/stores/draft.store'
import { useConversationStore } from '../../src/renderer/src/stores/conversation.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { createDesktopApiMock } from './helpers/desktop-api'
import type { SettingsState } from '@shared/contracts'
import { DEFAULT_LIVE2D } from '../../src/shared/schemas'

// I-06 / P2-10：原为手搓的 DesktopApiLike 全契约镜像（每个键裸 `vi.fn()`）。
const mockApi = createDesktopApiMock()

function state(over: Partial<SettingsState> = {}): SettingsState {
  return {
    version: 1,
    voice: { enabled: true, realtimeEnabled: false, autoReadReply: true, showCaptions: true, consentBackendStt: false, silenceAutoStop: false, silenceStopMs: 2000 },
    dictation: { insertMode: 'append' },
    live2d: { ...DEFAULT_LIVE2D },
    tools: { grants: [] }, // 阶段 6 批次 C（D6C-02）：tools 空子树
    appearance: { fontScale: 100 }, // 外观（2026-09-13）：字号缩放默认 100%
    ...over
  }
}

/** 模拟 Main SettingsService.save 的 patch-merge 语义：返回合并后 state（未提交字段保持现值） */
function applyPatch(
  base: SettingsState,
  patch: { voice?: Partial<SettingsState['voice']>; dictation?: Partial<SettingsState['dictation']>; live2d?: Partial<SettingsState['live2d']>; appearance?: Partial<SettingsState['appearance']> }
): SettingsState {
  return {
    ...base,
    voice: { ...base.voice, ...patch.voice },
    dictation: { ...base.dictation, ...patch.dictation },
    live2d: { ...base.live2d, ...patch.live2d },
    appearance: { ...base.appearance, ...patch.appearance }
  }
}

describe('settingsStore', () => {
  beforeEach(() => { setActivePinia(createPinia()); setDesktopApi(mockApi); vi.clearAllMocks() })
  afterEach(() => { vi.useRealTimers() })

  it('hydrate 成功覆盖 state + loaded=true', async () => {
    mockApi.settingsLoad.mockResolvedValue(state({
      voice: { enabled: false, realtimeEnabled: true, autoReadReply: false, showCaptions: false, consentBackendStt: true, micDeviceId: 'dev-1', silenceAutoStop: true, silenceStopMs: 3500 },
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

  it('setVoice 失败 → saveError 置位（code 形态）+ 本地改保留（fail-open UI 可展示）', async () => {
    vi.useFakeTimers()
    mockApi.settingsSave.mockRejectedValue(new Error('[IPC_ERROR] [UNKNOWN] 写盘失败'))
    const s = useSettingsStore()
    s.setVoice({ showCaptions: false })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS)
    // M-19（2026-09-13）：形态由原始 message 改为 **code**（措辞归 UI 层的 error-message.ts）。
    // 注意 parsePublicError 取**第一个**方括号段为 code：跨进程原文 '[IPC_ERROR] [UNKNOWN] 写盘失败'
    // 解析出的是 IPC_ERROR（这是既有语义，不是本批引入的）。
    expect(s.saveError?.code).toBe('IPC_ERROR')
    expect(s.saveError?.message).toContain('写盘失败')
    expect(s.saved).toBe(false)
    expect(s.unsaved).toBe(true)                 // 未确认写入：UI 据此说真话
    expect(s.voice.showCaptions).toBe(false)     // 本地改不回滚
  })

  // —— M-19（2026-09-13）：设置保存失败必须**可见**且**不丢改动** ——
  //
  // 修前的两处事实（都是实测）：① `pending = {}` 在 `await` **之前**执行 ⇒ 保存失败即丢弃该 patch，
  // 用户看到开关生效、重启后被静默还原；② `saveError` / `saved` 全仓**没有任何组件渲染**
  // （grep 只命中 store 自身），而 Live2D 子页写着"500ms 自动保存"。故作两组判别用例：
  // 「失败的那一份必须在后续保存里出现」与「状态必须能被 UI 读到」。
  describe('保存失败可见且不丢改动（M-19）', () => {
    it('失败后 patch 不丢：下一次保存把失败的那一份一起写下去【判别用例】', async () => {
      vi.useFakeTimers()
      mockApi.settingsSave.mockRejectedValueOnce(new Error('[PERSISTENCE_WRITE_FAILED] 本地保存失败（ENOSPC）'))
      mockApi.settingsSave.mockImplementation(async (patch: Parameters<typeof applyPatch>[1]) => applyPatch(state(), patch))
      const s = useSettingsStore()
      s.setVoice({ showCaptions: false })
      await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS)         // 第一次落盘失败
      expect(s.saveError?.code).toBe('PERSISTENCE_WRITE_FAILED')
      expect(s.unsaved).toBe(true)
      // 在自动重试之前用户又改了一次：两次改动必须合并提交（修复前只提交后一次，前一次永久丢失）
      s.setVoice({ autoReadReply: false })
      await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS)
      expect(mockApi.settingsSave).toHaveBeenLastCalledWith({ voice: { showCaptions: false, autoReadReply: false } })
      expect(s.saveError, '写回成功后应清掉错误状态').toBeUndefined()
      expect(s.unsaved).toBe(false)
    })

    it('失败后自动重试一次并恢复（错误状态清除 + saved 置位）', async () => {
      vi.useFakeTimers()
      mockApi.settingsSave.mockRejectedValueOnce(new Error('[SETTINGS_SAVE_FAILED] 本地保存失败（EACCES）'))
      mockApi.settingsSave.mockImplementation(async (patch: Parameters<typeof applyPatch>[1]) => applyPatch(state(), patch))
      const s = useSettingsStore()
      s.setVoice({ enabled: false })
      await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS)
      expect(mockApi.settingsSave).toHaveBeenCalledTimes(1)
      expect(s.saveError?.code).toBe('SETTINGS_SAVE_FAILED')
      await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_RETRY_MS)             // 自动重试
      expect(mockApi.settingsSave).toHaveBeenCalledTimes(2)
      expect(mockApi.settingsSave).toHaveBeenLastCalledWith({ voice: { enabled: false } })
      expect(s.saveError).toBeUndefined()
      expect(s.saved).toBe(true)
      expect(s.unsaved).toBe(false)
    })

    it('持续失败只自动重试一次（不按防抖节奏热循环打盘），改动留在队列里', async () => {
      vi.useFakeTimers()
      mockApi.settingsSave.mockRejectedValue(new Error('[SETTINGS_SAVE_FAILED] 本地保存失败（ENOSPC）'))
      const s = useSettingsStore()
      s.setVoice({ enabled: false })
      await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS)
      await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_RETRY_MS)
      await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_RETRY_MS * 10)
      expect(mockApi.settingsSave, '首次 + 恰好一次重试').toHaveBeenCalledTimes(2)
      expect(s.unsaved, '改动仍在待写队列（由下一次修改 / 退出 flush 再试）').toBe(true)
      expect(s.saveError?.code).toBe('SETTINGS_SAVE_FAILED')
    })

    it('退出 flush 会把失败保留的 patch 再试一次（H-04 与 M-19 的交点）', async () => {
      vi.useFakeTimers()
      mockApi.settingsSave.mockRejectedValueOnce(new Error('[SETTINGS_SAVE_FAILED] 本地保存失败（ENOSPC）'))
      mockApi.settingsSave.mockImplementation(async (patch: Parameters<typeof applyPatch>[1]) => applyPatch(state(), patch))
      const s = useSettingsStore()
      s.setVoice({ autoReadReply: false })
      await s.flush()                                   // 第一次失败
      expect(s.saveError?.code).toBe('SETTINGS_SAVE_FAILED')
      await s.flush()                                   // 同一次退出流程 / 下一次 flush 重试
      expect(mockApi.settingsSave).toHaveBeenLastCalledWith({ voice: { autoReadReply: false } })
      expect(s.saveError).toBeUndefined()
      expect(s.saved).toBe(true)
    })

    it('mergeSettingsPatch：等待期间的新改动优先（重试不会把新值覆盖回旧值）', () => {
      expect(mergeSettingsPatch(
        { voice: { enabled: false, autoReadReply: true }, live2d: { modelId: 'old' } },
        { voice: { autoReadReply: false } }
      )).toEqual({ voice: { enabled: false, autoReadReply: false }, dictation: undefined, live2d: { modelId: 'old' }, tools: undefined, appearance: undefined })
      expect(hasPendingPatch({})).toBe(false)
      expect(hasPendingPatch({ appearance: { fontScale: 90 } })).toBe(true)
      expect(hasPendingPatch({ tools: { grants: [] } })).toBe(true)   // tools 子树也计入（早退判据收口到一处）
    })
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

  // —— 外观（2026-09-13，doc 03 §12.4 / doc 11 §7.2）：全局字体缩放子树 ——
  it('hydrate 读回 appearance 段（fontScale 130）', async () => {
    mockApi.settingsLoad.mockResolvedValue(state({ appearance: { fontScale: 130 } }))
    const s = useSettingsStore()
    await s.hydrate()
    expect(s.appearance.fontScale).toBe(130)
  })

  it('setAppearance 本地立即生效 + 500ms 防抖持久化 appearance 子树', async () => {
    vi.useFakeTimers()
    mockApi.settingsSave.mockImplementation(async (patch) => applyPatch(state(), patch))
    const s = useSettingsStore()
    s.setAppearance({ fontScale: 115 })
    expect(s.appearance.fontScale).toBe(115) // 即时预览：本地先改（根变量由 main.ts 的 watch 落）
    expect(mockApi.settingsSave).not.toHaveBeenCalled() // 防抖窗口内不写
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS)
    expect(mockApi.settingsSave).toHaveBeenCalledWith({ appearance: { fontScale: 115 } })
    expect(s.appearance.fontScale).toBe(115) // 回写 merge 结果
  })

  it('仅 appearance patch 时 persist 不早退（第四键早退条件）', async () => {
    vi.useFakeTimers()
    mockApi.settingsSave.mockImplementation(async (patch) => applyPatch(state(), patch))
    const s = useSettingsStore()
    s.setAppearance({ fontScale: 90 })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS)
    expect(mockApi.settingsSave).toHaveBeenCalledTimes(1) // 未被 if(!pending.appearance) 早退跳过
    expect(s.appearance.fontScale).toBe(90)
  })

  it('跨子树累积：setVoice + setAppearance 同窗口 → 单次 save 含两棵子树', async () => {
    vi.useFakeTimers()
    mockApi.settingsSave.mockImplementation(async (patch) => applyPatch(state(), patch))
    const s = useSettingsStore()
    s.setVoice({ autoReadReply: false })
    s.setAppearance({ fontScale: 130 })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS)
    expect(mockApi.settingsSave).toHaveBeenCalledTimes(1)
    expect(mockApi.settingsSave).toHaveBeenCalledWith({ voice: { autoReadReply: false }, appearance: { fontScale: 130 } })
    expect(s.appearance.fontScale).toBe(130)
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

  // —— H-04（2026-09-11）：退出前 flush。此前无任何退出 flush，拨动开关后 ≤500ms 内关窗
  // 的修改静默丢失，重启才发现被还原。——
  it('flush 立即落盘待写 patch（不等 500ms）且不重复写（H-04）', async () => {
    vi.useFakeTimers()
    mockApi.settingsSave.mockImplementation(async (patch: Parameters<typeof applyPatch>[1]) => applyPatch(state(), patch))
    const s = useSettingsStore()
    s.setVoice({ autoReadReply: false })
    expect(mockApi.settingsSave).not.toHaveBeenCalled()      // 500ms 防抖未到
    await s.flush()
    expect(mockApi.settingsSave).toHaveBeenCalledTimes(1)
    expect(mockApi.settingsSave).toHaveBeenCalledWith({ voice: { autoReadReply: false } })
    vi.advanceTimersByTime(SETTINGS_SAVE_DEBOUNCE_MS * 2)
    expect(mockApi.settingsSave).toHaveBeenCalledTimes(1)     // 定时器已取消
  })

  it('flush 无待写 patch → no-op', async () => {
    const s = useSettingsStore()
    await s.flush()
    expect(mockApi.settingsSave).not.toHaveBeenCalled()
  })
})
