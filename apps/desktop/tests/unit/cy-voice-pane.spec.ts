// @vitest-environment happy-dom
// tests/unit/cy-voice-pane.spec.ts
// Task 14（spec §5.12 / Minor 24）：CyVoicePane——STT 下拉排除 desktop/local_worker profile（D-P20）、
// 开关绑定 settingsStore.voice、测试麦克风点击调 voiceStore.startRecord。
// 环境 happy-dom：Vue Test Utils 挂载（navigator.mediaDevices.enumerateDevices stub 为 []）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import type { ModelProfile } from '@shared/contracts'
import type { PublicError } from '../../src/renderer/src/utils/public-error'
import CyVoicePane from '../../src/renderer/src/components/CyVoicePane.vue'
import CyVoicePending from '../../src/renderer/src/components/CyVoicePending.vue'
import CyRealtimeBar from '../../src/renderer/src/components/CyRealtimeBar.vue'
import CyDictationHint from '../../src/renderer/src/components/CyDictationHint.vue'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { useVoiceStore } from '../../src/renderer/src/stores/voice.store'
import { useSettingsStore } from '../../src/renderer/src/stores/settings.store'
import { useModelServiceStore } from '../../src/renderer/src/stores/model-service.store'

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
  voiceStartRecord: vi.fn(), voiceStopRecord: vi.fn(), voiceCommit: vi.fn(), voiceDiscard: vi.fn(),
  voiceStartRealtime: vi.fn(), voiceStopRealtime: vi.fn(), voiceCancelRealtime: vi.fn(),
  voiceStartDictation: vi.fn(), voiceStopDictation: vi.fn(), voiceCancelDictation: vi.fn(),
  audioCancel: vi.fn(), voiceSendAudio: vi.fn(), settingsLoad: vi.fn(), settingsSave: vi.fn()
}

function sttProfile(id: string, over: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id, type: 'stt', displayName: id, source: 'built_in', provider: 'stt', model: id,
    models: [], executionLocation: 'backend', credentialStatus: 'configured', enabled: true,
    capabilities: [], builtIn: true, ...over
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  setDesktopApi(mockApi)
  vi.clearAllMocks()
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { enumerateDevices: vi.fn(async () => []) },
    configurable: true
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('CyVoicePane', () => {
  it('STT 下拉只列 enabled+backend profile，排除 desktop/local_worker（D-P20）', async () => {
    useModelServiceStore().$patch({
      profiles: [
        sttProfile('backend-a'),
        sttProfile('desktop-b', { executionLocation: 'desktop' }),
        sttProfile('local-c', { executionLocation: 'local_worker' }),
        sttProfile('disabled-d', { enabled: false })
      ]
    })
    const wrapper = mount(CyVoicePane)
    await wrapper.vm.$nextTick()
    const selects = wrapper.findAll('select')
    const sttSelect = selects[1] // index 0 = 麦克风设备
    const options = sttSelect.findAll('option')
    // 「使用全局活动 STT」空项 + 仅 backend 一项
    expect(options).toHaveLength(2)
    expect(options[0].text()).toBe('使用全局活动 STT')
    expect(options[1].attributes('value')).toBe('stt/backend-a')
    wrapper.unmount()
  })

  it('开关绑定 settingsStore.voice.autoReadReply：勾选态随 store，变更写回 store', async () => {
    const s = useSettingsStore()
    s.voice.autoReadReply = true
    const wrapper = mount(CyVoicePane)
    const autoRead = wrapper.findAll('input[type="checkbox"]')[2]
    expect((autoRead.element as HTMLInputElement).checked).toBe(true)
    await autoRead.setValue(false)
    expect(s.voice.autoReadReply).toBe(false)
    wrapper.unmount()
  })

  it('测试麦克风点击 → voiceStore.startRecord', async () => {
    const voice = useVoiceStore()
    const startSpy = vi.spyOn(voice, 'startRecord').mockImplementation(async () => {
      voice.mode = 'recording'
    })
    const wrapper = mount(CyVoicePane)
    await wrapper.find('button').trigger('click')
    expect(startSpy).toHaveBeenCalledTimes(1)
    // unmount 清 micTestTimer（onBeforeUnmount），不残留 3s 真实定时器
    wrapper.unmount()
    startSpy.mockRestore()
  })

  it('consent 挂起超时不漏录音：>5s 后确认 → 迟到 recording 仍武装 3s 自停（评审 Important）', async () => {
    vi.useFakeTimers()
    const voice = useVoiceStore()
    // startRecord 模拟 consent 挂起：只置 pending，mode 保持 idle
    const startSpy = vi.spyOn(voice, 'startRecord').mockImplementation(async () => {
      voice.consentPending = true
    })
    // confirmConsent 模拟：清 pending + 迟到恢复进入 recording（confirmConsent 重发挂起动作的等价态）
    const confirmSpy = vi.spyOn(voice, 'confirmConsent').mockImplementation(async () => {
      voice.consentPending = false
      voice.mode = 'recording'
    })
    const stopSpy = vi.spyOn(voice, 'stopRecord').mockResolvedValue(undefined)
    const discardSpy = vi.spyOn(voice, 'discardRecord').mockResolvedValue(undefined)

    const wrapper = mount(CyVoicePane)
    await wrapper.find('button').trigger('click')
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(voice.consentPending).toBe(true)
    expect(wrapper.find('button').text()).toBe('录音中…')

    // 用户停留 >5s：不得误判失败、不得提前自停、按钮保持等待态（评审竞态的根因修复）
    await vi.advanceTimersByTimeAsync(6000)
    expect(stopSpy).not.toHaveBeenCalled()
    expect(discardSpy).not.toHaveBeenCalled()
    expect(wrapper.find('button').text()).toBe('录音中…')

    // 点击「同意」→ 迟到进入 recording → 仍须武装 3s 自停（修复前此处永远丢失）
    await voice.confirmConsent()
    await vi.advanceTimersByTimeAsync(0)
    expect(voice.mode).toBe('recording')
    await vi.advanceTimersByTimeAsync(3000)
    expect(stopSpy).toHaveBeenCalledTimes(1)
    expect(discardSpy).toHaveBeenCalledTimes(1)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('button').text()).toBe('测试麦克风')

    wrapper.unmount()
    startSpy.mockRestore()
    confirmSpy.mockRestore()
    stopSpy.mockRestore()
    discardSpy.mockRestore()
  })

  it('consent 取消 → 测试收口：不启动录音、按钮回 idle + 失败提示', async () => {
    vi.useFakeTimers()
    const voice = useVoiceStore()
    const startSpy = vi.spyOn(voice, 'startRecord').mockImplementation(async () => {
      voice.consentPending = true
    })
    const stopSpy = vi.spyOn(voice, 'stopRecord').mockResolvedValue(undefined)
    const wrapper = mount(CyVoicePane)
    await wrapper.find('button').trigger('click')
    expect(voice.consentPending).toBe(true)

    // dismissConsent：清 pending + confirmDispatching 保持 false → waitForRecording 立即判失败收口（无宽限）
    voice.dismissConsent()
    await vi.advanceTimersByTimeAsync(0)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('button').text()).toBe('测试麦克风')
    expect(stopSpy).not.toHaveBeenCalled() // 从未进入录音
    expect(wrapper.text()).toContain('麦克风启动失败')

    wrapper.unmount()
    startSpy.mockRestore()
    stopSpy.mockRestore()
  })

  it('confirm 重发中（confirmDispatching=true）慢 getUserMedia >3s 不误判失败 → 迟到 recording 仍武装 3s 自停（评审轮3）', async () => {
    vi.useFakeTimers()
    const voice = useVoiceStore()
    const startSpy = vi.spyOn(voice, 'startRecord').mockImplementation(async () => {
      voice.consentPending = true
    })
    const stopSpy = vi.spyOn(voice, 'stopRecord').mockResolvedValue(undefined)
    const discardSpy = vi.spyOn(voice, 'discardRecord').mockResolvedValue(undefined)
    const wrapper = mount(CyVoicePane)
    await wrapper.find('button').trigger('click')
    expect(voice.consentPending).toBe(true)

    // 模拟 store confirmConsent：清 pending + confirmDispatching=true（同帧批处理，无瞬时窗）
    voice.consentPending = false
    voice.confirmDispatching = true
    await vi.advanceTimersByTimeAsync(0)
    // 慢 getUserMedia 权限提示：mode 保持 idle 超过 3s——不得误判失败、不得提前自停
    await vi.advanceTimersByTimeAsync(6000)
    expect(wrapper.find('button').text()).toBe('录音中…')
    expect(stopSpy).not.toHaveBeenCalled()

    // getUserMedia 授权 → 进入 recording + 动作 settle（confirmDispatching=false）→ 武装 3s 自停
    voice.mode = 'recording'
    voice.confirmDispatching = false
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(3000)
    expect(stopSpy).toHaveBeenCalledTimes(1)
    expect(discardSpy).toHaveBeenCalledTimes(1)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('button').text()).toBe('测试麦克风')

    wrapper.unmount()
    startSpy.mockRestore()
    stopSpy.mockRestore()
    discardSpy.mockRestore()
  })

  it('startRecord 失败（mode idle + 无 consent，初始态已定格）→ 立即判失败：按钮回 idle + 错误展示（评审 re-review）', async () => {
    const voice = useVoiceStore()
    // 模拟「早退/拒绝」：startRecord 不改任何状态（mode 保持 idle、无 consent 挂起、无 micError）
    const startSpy = vi.spyOn(voice, 'startRecord').mockImplementation(async () => { /* no-op */ })
    const wrapper = mount(CyVoicePane)
    await wrapper.find('button').trigger('click')
    await wrapper.vm.$nextTick()
    expect(startSpy).toHaveBeenCalledTimes(1)
    // 修复前：waitForRecording 无变化事件可触发 → 永久挂起「录音中…」
    expect(wrapper.find('button').text()).toBe('测试麦克风')
    expect(wrapper.text()).toContain('麦克风启动失败')
    wrapper.unmount()
    startSpy.mockRestore()
  })

  it('startRecord 权限拒绝（micError 置位）→ 展示具体错误（评审 re-review）', async () => {
    const voice = useVoiceStore()
    const startSpy = vi.spyOn(voice, 'startRecord').mockImplementation(async () => {
      voice.micError = { message: '麦克风权限被拒绝' } as PublicError
    })
    const wrapper = mount(CyVoicePane)
    await wrapper.find('button').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('button').text()).toBe('测试麦克风')
    expect(wrapper.text()).toContain('麦克风权限被拒绝')
    wrapper.unmount()
    startSpy.mockRestore()
  })
})

describe('CyVoicePending 待发送语音条（spec §5.12 / Minor 24）', () => {
  it('transcript 空 → 确认发送禁用 + 显示「未识别，请重试」', () => {
    const voice = useVoiceStore()
    voice.mode = 'record_pending'
    voice.record.transcript = undefined
    const wrapper = mount(CyVoicePending)
    expect(wrapper.text()).toContain('未识别，请重试')
    const confirmBtn = wrapper.findAll('button').find((b) => b.text().includes('确认发送'))
    expect(confirmBtn).toBeDefined()
    expect((confirmBtn!.element as HTMLButtonElement).disabled).toBe(true)
    wrapper.unmount()
  })

  it('transcript 非空 → 显示字幕 + 确认发送可用', () => {
    const voice = useVoiceStore()
    voice.mode = 'record_pending'
    voice.record.transcript = '这是一段转写'
    const wrapper = mount(CyVoicePending)
    expect(wrapper.text()).toContain('这是一段转写')
    expect(wrapper.text()).not.toContain('未识别，请重试')
    const confirmBtn = wrapper.findAll('button').find((b) => b.text().includes('确认发送'))
    expect((confirmBtn!.element as HTMLButtonElement).disabled).toBe(false)
    wrapper.unmount()
  })
})

describe('CyVoicePending 待发送语音条——错误展示（final-review Important-1a）', () => {
  it('record_pending + voiceStore.error（STT 明确失败）→ 展示 error.message，不显示「未识别，请重试」', () => {
    const voice = useVoiceStore()
    voice.mode = 'record_pending'
    voice.record.transcript = undefined
    voice.error = { code: 'STT_UNAVAILABLE', message: 'STT 服务不可用' }
    const wrapper = mount(CyVoicePending)
    expect(wrapper.text()).toContain('STT 服务不可用')
    expect(wrapper.text()).not.toContain('未识别，请重试')
    wrapper.unmount()
  })

  it('record_pending + micError（麦克风权限拒绝）→ 展示 micError.message', () => {
    const voice = useVoiceStore()
    voice.mode = 'record_pending'
    voice.record.transcript = undefined
    voice.micError = { code: 'MIC_ACCESS_DENIED', message: '麦克风权限被拒绝' }
    const wrapper = mount(CyVoicePending)
    expect(wrapper.text()).toContain('麦克风权限被拒绝')
    expect(wrapper.text()).not.toContain('未识别，请重试')
    wrapper.unmount()
  })

  it('record_pending + error 置位 + transcript 存在 → 错误与字幕并存，确认发送仍可用', () => {
    const voice = useVoiceStore()
    voice.mode = 'record_pending'
    voice.record.transcript = '转写字幕'
    voice.error = { code: 'STT_UNAVAILABLE', message: 'STT 服务不可用' }
    const wrapper = mount(CyVoicePending)
    expect(wrapper.text()).toContain('STT 服务不可用')
    expect(wrapper.text()).toContain('转写字幕')
    const confirmBtn = wrapper.findAll('button').find((b) => b.text().includes('确认发送'))
    expect((confirmBtn!.element as HTMLButtonElement).disabled).toBe(false)
    wrapper.unmount()
  })

  it('Minor-2：showCaptions=false → 待发送条 transcript 仍渲染（确认发送内容必须可见）', () => {
    useSettingsStore().voice.showCaptions = false
    const voice = useVoiceStore()
    voice.mode = 'record_pending'
    voice.record.transcript = '确认发送内容'
    const wrapper = mount(CyVoicePending)
    expect(wrapper.text()).toContain('确认发送内容')
    wrapper.unmount()
  })
})

describe('CyRealtimeBar 实时条——错误展示 + 字幕门控（final-review Important-1a / Minor-2）', () => {
  it('realtime + voiceStore.error → 条内展示 error.message，不再显示「聆听中」误导态', () => {
    const voice = useVoiceStore()
    voice.mode = 'realtime'
    voice.realtime.caption = '实时字幕'
    voice.error = { code: 'VOICE_SESSION_CONFLICT', message: '已有语音会话' }
    const wrapper = mount(CyRealtimeBar)
    expect(wrapper.text()).toContain('已有语音会话')
    expect(wrapper.text()).not.toContain('聆听中')
    expect(wrapper.text()).toContain('停止')   // 停止按钮仍在（可终止会话）
    wrapper.unmount()
  })

  it('realtime 无错误 → 正常显示「聆听中」+ 字幕（showCaptions=true 默认）', () => {
    useSettingsStore().voice.showCaptions = true
    const voice = useVoiceStore()
    voice.mode = 'realtime'
    voice.realtime.caption = '实时字幕'
    const wrapper = mount(CyRealtimeBar)
    expect(wrapper.text()).toContain('聆听中')
    expect(wrapper.text()).toContain('实时字幕')
    wrapper.unmount()
  })

  it('Minor-2：showCaptions=false → 实时 live caption 不渲染（聆听中/轮次仍显示）', () => {
    useSettingsStore().voice.showCaptions = false
    const voice = useVoiceStore()
    voice.mode = 'realtime'
    voice.realtime.caption = '实时字幕'
    const wrapper = mount(CyRealtimeBar)
    expect(wrapper.text()).not.toContain('实时字幕')
    expect(wrapper.text()).toContain('聆听中')
    expect(wrapper.text()).toContain('已说 0 轮')
    wrapper.unmount()
  })
})

describe('CyDictationHint 转写浮层——错误展示 + 字幕门控（final-review Important-1a / Minor-2）', () => {
  it('dictating + voiceStore.error → 浮层展示 error.message', () => {
    const voice = useVoiceStore()
    voice.mode = 'dictating'
    voice.dictation.caption = '转写中字幕'
    voice.error = { code: 'DICTATION_NOT_FOUND', message: '转写会话不存在' }
    const wrapper = mount(CyDictationHint)
    expect(wrapper.text()).toContain('转写会话不存在')
    wrapper.unmount()
  })

  it('showCaptions=true（默认）→ dictation partial caption 渲染', () => {
    useSettingsStore().voice.showCaptions = true
    const voice = useVoiceStore()
    voice.mode = 'dictating'
    voice.dictation.caption = '转写中字幕'
    const wrapper = mount(CyDictationHint)
    expect(wrapper.text()).toContain('转写中字幕')
    wrapper.unmount()
  })

  it('Minor-2：showCaptions=false → dictation partial caption 不渲染（提示语仍显示）', () => {
    useSettingsStore().voice.showCaptions = false
    const voice = useVoiceStore()
    voice.mode = 'dictating'
    voice.dictation.caption = '转写中字幕'
    const wrapper = mount(CyDictationHint)
    expect(wrapper.text()).not.toContain('转写中字幕')
    expect(wrapper.text()).toContain('松开提交 · 上滑取消')
    wrapper.unmount()
  })
})
