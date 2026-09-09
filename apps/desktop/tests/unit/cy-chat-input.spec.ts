// @vitest-environment happy-dom
// tests/unit/cy-chat-input.spec.ts
// Task 14（spec §5.12 / Minor 24）：CyChatInput 语音三入口守卫/禁用态 + 转写 final 插入。
// 环境 happy-dom：Vue Test Utils 轻量挂载（子组件全部 stub，聚焦 CyChatInput 自身逻辑）；
// store 经 setDesktopApi mock api + createPinia 装配真实 store，按用例改写 state 断言禁用态。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import type { BackendEvent } from '@shared/contracts'
import CyChatInput from '../../src/renderer/src/components/CyChatInput.vue'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { useVoiceStore } from '../../src/renderer/src/stores/voice.store'
import { useSettingsStore } from '../../src/renderer/src/stores/settings.store'
import { useConnectionStore } from '../../src/renderer/src/stores/connection.store'
import { useConversationStore } from '../../src/renderer/src/stores/conversation.store'
import { useDraftStore } from '../../src/renderer/src/stores/draft.store'
import { useHistoryViewerStore } from '../../src/renderer/src/stores/historyViewer.store'

const mockApi = {
  connect: vi.fn(), disconnect: vi.fn(), listConversations: vi.fn(), getMessages: vi.fn(),
  send: vi.fn(), cancel: vi.fn(), activate: vi.fn(), createConversation: vi.fn(),
  renameConversation: vi.fn(), deleteConversation: vi.fn(), getConnectionState: vi.fn(),
  getCredentialStatus: vi.fn(), setBackendToken: vi.fn(), clearBackendToken: vi.fn(),
  setEndpoint: vi.fn(), getEndpoint: vi.fn(), getRuntimeInfo: vi.fn(),
  onChatEvent: vi.fn((_h: (e: BackendEvent) => void) => () => {}), onChatState: vi.fn(() => () => {}), onChatReplay: vi.fn(() => () => {}), onChatError: vi.fn(() => () => {}),
  hydratePersistence: vi.fn(), persistSession: vi.fn(), cacheMessages: vi.fn(), openExternal: vi.fn(),
  attachmentsValidate: vi.fn(), attachmentsUpload: vi.fn(), attachmentsCancel: vi.fn(), attachmentsCheck: vi.fn(),
  queryChatHistory: vi.fn(), getMessageContext: vi.fn(), listStickers: vi.fn(),
  listModelProfiles: vi.fn(), saveModelProfile: vi.fn(), deleteModelProfile: vi.fn(), testModelProfile: vi.fn(), activateModelProfile: vi.fn(), getActiveModelSelection: vi.fn(),
  listTtsVoices: vi.fn(), previewTts: vi.fn(), setTtsVoice: vi.fn(),
  voiceStartRecord: vi.fn(), voiceStopRecord: vi.fn(), voiceCommit: vi.fn(), voiceDiscard: vi.fn(),
  voiceStartRealtime: vi.fn(), voiceStopRealtime: vi.fn(), voiceCancelRealtime: vi.fn(),
  voiceStartDictation: vi.fn(), voiceStopDictation: vi.fn(), voiceCancelDictation: vi.fn(),
  audioCancel: vi.fn(), voiceSendAudio: vi.fn(), settingsLoad: vi.fn(), settingsSave: vi.fn(),
  listLive2dModels: vi.fn(),
  onToolEvent: vi.fn(() => () => {}), toolDecide: vi.fn(), toolCancel: vi.fn(), toolList: vi.fn(), toolPickSource: vi.fn(), toolConfirmUpload: vi.fn(), toolGrantDirectory: vi.fn(), toolListGrants: vi.fn(), toolRevokeGrant: vi.fn(), toolListHistory: vi.fn(),
  // 阶段 7 批次 A（Task 5）：诊断面（DesktopApiLike 全契约镜像——mock 补键）
  diagnosticsState: vi.fn(), diagnosticsDevModeSet: vi.fn(), diagnosticsOpenLogDir: vi.fn(), diagnosticsClearLogs: vi.fn(), diagnosticsExport: vi.fn(), onDiagnosticsDevEvent: vi.fn(() => () => {}), getLastCrash: vi.fn(),
}

function mountInput(): ReturnType<typeof mount> {
  return mount(CyChatInput, {
    global: {
      stubs: {
        CyAttachmentQueue: true,
        CyDropOverlay: true,
        CyEmojiPicker: true,
        CyVoicePending: true,
        CyRealtimeBar: true,
        CyDictationHint: true,
        CyVoiceConsentDialog: true
      }
    }
  })
}

/** 组件按钮禁用态：DOMWrapper<Element> 无 disabled，按 HTMLButtonElement 取 */
function isDisabled(wrapper: ReturnType<typeof mount>, selector: string): boolean {
  return (wrapper.find(selector).element as HTMLButtonElement).disabled
}

beforeEach(() => {
  setActivePinia(createPinia())
  setDesktopApi(mockApi)
  vi.clearAllMocks()
  useConnectionStore().state = { status: 'connected', connectionId: 'cid-1' }
  useConversationStore().$patch({ currentId: 'conv-1', ready: true })
  const s = useSettingsStore()
  s.voice.enabled = true
  s.voice.realtimeEnabled = false
  s.voice.consentBackendStt = true
})

describe('CyChatInput 语音入口守卫（Minor 24，UII02rev 独立按钮）', () => {
  it('会话激活请求在途时禁用发送，避免消息落到旧活动会话', () => {
    useDraftStore().drafts['conv-1'] = '等待切换完成'
    useConversationStore().$patch({ busy: true })
    const wrapper = mountInput()
    expect(isDisabled(wrapper, '[aria-label="发送"]')).toBe(true)
    wrapper.unmount()
  })

  it('realtimeEnabled=false 时 🎧 实时会话禁用、🎤 普通录音(独立按钮)不禁用', () => {
    useSettingsStore().voice.realtimeEnabled = false
    const wrapper = mountInput()
    expect(isDisabled(wrapper, '[aria-label="实时会话"]')).toBe(true)
    expect(isDisabled(wrapper, '[aria-label="普通录音"]')).toBe(false)
  })

  it('voice.enabled=false 时 🎤/🎧/⌨️ 三入口全部禁用', () => {
    useSettingsStore().voice.enabled = false
    const wrapper = mountInput()
    expect(isDisabled(wrapper, '[aria-label="普通录音"]')).toBe(true)
    expect(isDisabled(wrapper, '[aria-label="实时会话"]')).toBe(true)
    expect(isDisabled(wrapper, '[aria-label="输入法转写（按住说话）"]')).toBe(true)
  })

  it('realtimeEnabled=true 时 🎧 实时会话可用', () => {
    useSettingsStore().voice.realtimeEnabled = true
    const wrapper = mountInput()
    expect(isDisabled(wrapper, '[aria-label="实时会话"]')).toBe(false)
  })

  it('录音中录音钮变「停止录音」+ 显示时长 + textarea/发送禁用', () => {
    const voice = useVoiceStore()
    voice.mode = 'recording'
    voice.record.elapsedMs = 7000
    const wrapper = mountInput()
    const recBtn = wrapper.find('[aria-label="停止录音"]')
    expect(recBtn.exists()).toBe(true)
    expect(recBtn.text()).toContain('00:07')
    // 语音活跃 → 文本输入/发送禁用
    expect((wrapper.find('[aria-label="消息输入框"]').element as HTMLTextAreaElement).disabled).toBe(true)
    expect(isDisabled(wrapper, '[aria-label="发送"]')).toBe(true)
    expect(isDisabled(wrapper, '[aria-label="添加文件"]')).toBe(true)
  })
})

describe('CyChatInput 转写 final 插入（D-P4）', () => {
  it('finalText 置位 → applyDictationInsert 写草稿 + clearDictationFinal 清态', async () => {
    const voice = useVoiceStore()
    const wrapper = mountInput()
    voice.dictation.finalText = '你好世界'
    await wrapper.vm.$nextTick()
    const draftStore = useDraftStore()
    expect(draftStore.drafts['conv-1']).toBe('你好世界')
    expect(voice.dictation.finalText).toBeUndefined()
    expect(voice.mode).toBe('idle')
    void draftStore.flush('conv-1')
  })
})

describe('CyChatInput 会话入口（UII-QQ 收尾：纯图标）', () => {
  it('accessible name 保留：button[aria-label] 可定位两个入口，title 同名（集成按 getByRole name 查找，不得改名）', () => {
    const wrapper = mountInput()
    const history = wrapper.find('button[aria-label="聊天记录"]')
    const media = wrapper.find('button[aria-label="图片/视频"]')
    expect(history.exists()).toBe(true)
    expect(media.exists()).toBe(true)
    expect(history.attributes('title')).toBe('聊天记录')
    expect(media.attributes('title')).toBe('图片/视频')
    wrapper.unmount()
  })

  it('纯图标：按钮内无可见文字（.cy-entry-label 已删），只保留 SVG', () => {
    const wrapper = mountInput()
    for (const sel of ['button[aria-label="聊天记录"]', 'button[aria-label="图片/视频"]']) {
      const btn = wrapper.find(sel)
      expect(btn.find('svg').exists()).toBe(true)
      expect(btn.find('.cy-entry-label').exists()).toBe(false)
      expect((btn.element.textContent ?? '').trim()).toBe('')
    }
    wrapper.unmount()
  })

  it('点击聊天记录 → historyStore.openViewer()（无参 = 当前会话全部）', async () => {
    const wrapper = mountInput()
    const store = useHistoryViewerStore()
    const spy = vi.spyOn(store, 'openViewer')
    await wrapper.find('button[aria-label="聊天记录"]').trigger('click')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]).toHaveLength(0)
    wrapper.unmount()
  })

  it('点击图片/视频 → historyStore.openViewer("image_video")', async () => {
    const wrapper = mountInput()
    const store = useHistoryViewerStore()
    const spy = vi.spyOn(store, 'openViewer')
    await wrapper.find('button[aria-label="图片/视频"]').trigger('click')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe('image_video')
    wrapper.unmount()
  })
})

describe('CyChatInput 麦克风拒绝 composer banner（final-review round2）', () => {
  it('voice.micError 置位（mode idle）→ 输入区上方 banner 展示 micError.message（麦克风拒绝不再静默）', () => {
    const voice = useVoiceStore()
    voice.mode = 'idle'
    voice.micError = { code: 'MIC_ACCESS_DENIED', message: '麦克风权限被拒绝' }
    const wrapper = mountInput()
    const banner = wrapper.find('.cy-mic-error-banner')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('麦克风权限被拒绝')
    expect(banner.attributes('role')).toBe('alert')
    wrapper.unmount()
  })

  it('micError 清空（下次 start* 开头清陈旧错误，Task 12）→ banner 随之消失', async () => {
    const voice = useVoiceStore()
    voice.mode = 'idle'
    voice.micError = { code: 'MIC_ACCESS_DENIED', message: '麦克风权限被拒绝' }
    const wrapper = mountInput()
    expect(wrapper.find('.cy-mic-error-banner').exists()).toBe(true)
    // start* 新操作开头 micError=undefined（voice.store 已测），此处验证组件响应式隐藏
    voice.micError = undefined
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.cy-mic-error-banner').exists()).toBe(false)
    wrapper.unmount()
  })

  it('micError 未置位 → 无 banner', () => {
    const wrapper = mountInput()
    expect(wrapper.find('.cy-mic-error-banner').exists()).toBe(false)
    wrapper.unmount()
  })
})
