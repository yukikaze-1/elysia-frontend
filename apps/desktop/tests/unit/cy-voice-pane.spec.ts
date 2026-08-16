// @vitest-environment happy-dom
// tests/unit/cy-voice-pane.spec.ts
// Task 14（spec §5.12 / Minor 24）：CyVoicePane——STT 下拉排除 desktop/local_worker profile（D-P20）、
// 开关绑定 settingsStore.voice、测试麦克风点击调 voiceStore.startRecord。
// 环境 happy-dom：Vue Test Utils 挂载（navigator.mediaDevices.enumerateDevices stub 为 []）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import type { ModelProfile } from '@shared/contracts'
import CyVoicePane from '../../src/renderer/src/components/CyVoicePane.vue'
import CyVoicePending from '../../src/renderer/src/components/CyVoicePending.vue'
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
