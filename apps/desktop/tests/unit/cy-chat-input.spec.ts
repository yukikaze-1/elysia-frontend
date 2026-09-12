// @vitest-environment happy-dom
// tests/unit/cy-chat-input.spec.ts
// Task 14（spec §5.12 / Minor 24）：CyChatInput 语音三入口守卫/禁用态 + 转写 final 插入。
// 环境 happy-dom：Vue Test Utils 轻量挂载（子组件全部 stub，聚焦 CyChatInput 自身逻辑）；
// store 经 setDesktopApi mock api + createPinia 装配真实 store，按用例改写 state 断言禁用态。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import CyChatInput from '../../src/renderer/src/components/CyChatInput.vue'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { useVoiceStore } from '../../src/renderer/src/stores/voice.store'
import { useSettingsStore } from '../../src/renderer/src/stores/settings.store'
import { useConnectionStore } from '../../src/renderer/src/stores/connection.store'
import { useConversationStore } from '../../src/renderer/src/stores/conversation.store'
import { useDraftStore } from '../../src/renderer/src/stores/draft.store'
import { useMessageStore } from '../../src/renderer/src/stores/message.store'
import { useHistoryViewerStore } from '../../src/renderer/src/stores/historyViewer.store'
import { createDesktopApiMock } from './helpers/desktop-api'

// I-06 / P2-10：原为手搓的 DesktopApiLike 全契约镜像（每个键裸 `vi.fn()`），改用受检工厂。
const mockApi = createDesktopApiMock()

/** 子组件全 stub（聚焦 CyChatInput 自身逻辑）；M-22 起，键盘→焦点相关用例需 attachTo（见下） */
const MOUNT_OPTIONS = {
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
}

function mountInput(): ReturnType<typeof mount> {
  return mount(CyChatInput, MOUNT_OPTIONS)
}

/** M-22：键盘/焦点用例需要组件落在 document 内（脱离文档时 happy-dom 不把 focus 反映到
 *  document.activeElement，`blur` 也不会派发）——既有用例一律用 mountInput（不 attachTo），
 *  保持原挂载形状不动。 */
function mountInputAttached(): ReturnType<typeof mount> {
  return mount(CyChatInput, { ...MOUNT_OPTIONS, attachTo: document.body })
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

describe('CyChatInput 发送门控（H-10，2026-09-11）', () => {
  it('常态：会话就绪 + 有草稿 → 发送按钮**可用**（既有用例只测了禁用方向，故本方向此前无人守）', () => {
    // 这条断言是有代价换来的：H-10 里我给 canSend 加了 `!hasActiveGeneration`，
    // 漏写 `.value` ⇒ 表达式恒为 false ⇒ **所有用户的发送按钮永久禁用**。
    // 当时 223 个测试文件全绿——因为既有的发送按钮用例只断言「busy 时禁用」，
    // 没有任何用例断言「正常时可用」。绿不等于对，这就是那次的证据。
    useDraftStore().drafts['conv-1'] = '可以发送的消息'
    const wrapper = mountInput()
    expect(isDisabled(wrapper, '[aria-label="发送"]'), '正常态下发送按钮必须可用').toBe(false)
    wrapper.unmount()
  })

  it('生成进行中：发送按钮禁用 + 显示停止按钮（渲染器只有一个 accumulator，再发会掐掉当前回复）', () => {
    useDraftStore().drafts['conv-1'] = '生成中不该能再发'
    useMessageStore().activeGenerationId = 'gen-1'
    const wrapper = mountInput()
    expect(isDisabled(wrapper, '[aria-label="发送"]')).toBe(true)
    expect(wrapper.find('.cy-stop-btn').exists(), '生成中应同时给出停止入口').toBe(true)
    wrapper.unmount()
  })

  it('生成结束（活动代释放）后发送按钮恢复可用', () => {
    useDraftStore().drafts['conv-1'] = '回到可发送'
    const store = useMessageStore()
    store.activeGenerationId = 'gen-1'
    const wrapper = mountInput()
    expect(isDisabled(wrapper, '[aria-label="发送"]')).toBe(true)
    store.activeGenerationId = undefined
    return wrapper.vm.$nextTick().then(() => {
      expect(isDisabled(wrapper, '[aria-label="发送"]')).toBe(false)
      wrapper.unmount()
    })
  })
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

// M-22（2026-09-11 全量评审）：按住说话按钮此前只绑 pointer 链，原生 <button> 看似可操作，
// 但键盘唯一能产生的 click 无 handler ⇒ WCAG 2.1.1 失败且无替代路径。以下钉住新增的键盘等价语义，
// 并且**两个方向都断言**：键盘能起/停采集（正向），以及"不重复起采集 / 不干扰指针路径"（负向）。
describe('CyChatInput 按住说话键盘可操作（M-22）', () => {
  const VOICE_BTN = '[aria-label="输入法转写（按住说话）"]'

  /** 以真实 store 动作做替身：start 同步置 dictating、stop 同步回 idle——这样能观察到"采集是否被重复开启"
   *  （第二次 start 会再次落 mode/调用计数），而不是只看到一个 mock 调用次数。 */
  function stubDictation(): { start: ReturnType<typeof vi.spyOn>; stop: ReturnType<typeof vi.spyOn> } {
    const voice = useVoiceStore()
    const start = vi.spyOn(voice, 'startDictation').mockImplementation(() => { voice.mode = 'dictating'; return Promise.resolve() })
    const stop = vi.spyOn(voice, 'stopDictation').mockImplementation(() => { voice.mode = 'idle'; return Promise.resolve() })
    return { start, stop }
  }

  it('常态（idle + 语音开启 + 已连接）：按住说话按钮**可用**且 aria-pressed=false（正向方向）', () => {
    const wrapper = mountInputAttached()
    const btn = wrapper.find(VOICE_BTN)
    expect(btn.exists(), '按钮必须存在').toBe(true)
    expect(isDisabled(wrapper, VOICE_BTN), '常态下按住说话按钮必须可用').toBe(false)
    expect(btn.attributes('aria-pressed')).toBe('false')
    wrapper.unmount()
  })

  it('Enter keydown 起采集 / keyup 提交；采集期间 aria-pressed=true（键盘用户真的有入口）', async () => {
    const { start, stop } = stubDictation()
    const wrapper = mountInputAttached()
    const btn = wrapper.find(VOICE_BTN)
    await btn.trigger('keydown', { key: 'Enter' })
    expect(start, 'keydown 必须真的开始采集').toHaveBeenCalledTimes(1)
    expect(useVoiceStore().mode, '按下期间处于转写态（UI 可解释）').toBe('dictating')
    expect(btn.attributes('aria-pressed'), '按住中 aria-pressed=true').toBe('true')
    await btn.trigger('keyup', { key: 'Enter' })
    expect(stop, 'keyup 必须真的提交').toHaveBeenCalledTimes(1)
    await nextTick()
    expect(btn.attributes('aria-pressed')).toBe('false')
    wrapper.unmount()
  })

  it('Space 与 Enter 等价（keydown 起 / keyup 停）', async () => {
    const { start, stop } = stubDictation()
    const wrapper = mountInputAttached()
    const btn = wrapper.find(VOICE_BTN)
    await btn.trigger('keydown', { key: ' ' })
    expect(start).toHaveBeenCalledTimes(1)
    await btn.trigger('keyup', { key: ' ' })
    expect(stop).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('按键自动重复（keydown repeat）不重入采集', async () => {
    const { start } = stubDictation()
    const wrapper = mountInputAttached()
    const btn = wrapper.find(VOICE_BTN)
    await btn.trigger('keydown', { key: 'Enter' })
    await btn.trigger('keydown', { key: 'Enter', repeat: true })
    await btn.trigger('keydown', { key: 'Enter', repeat: true })
    expect(start, 'auto-repeat 的重复 keydown 不得再次开始采集').toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('keyboardHolding 门被清（按住中失焦）后，仍处于物理按住状态的 repeat keydown 不得重开采集', async () => {
    const { start, stop } = stubDictation()
    const wrapper = mountInputAttached()
    const btn = wrapper.find(VOICE_BTN)
    await btn.trigger('keydown', { key: 'Enter' })          // 物理按下
    await btn.trigger('blur')                                // 失焦 → 提交并清 keyboardHolding（keyup 永不再到达）
    expect(stop).toHaveBeenCalledTimes(1)
    await btn.trigger('keydown', { key: 'Enter', repeat: true })   // 手指仍按着 → 系统继续发 repeat keydown
    expect(start, 'e.repeat 门必须独立成立：此时 keyboardHolding 已被清，只剩它能挡重入').toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('keyup 之后浏览器补发的合成 click 不会二次进入（本按钮无 click handler，采集不被重新开启）', async () => {
    const { start, stop } = stubDictation()
    const wrapper = mountInputAttached()
    const btn = wrapper.find(VOICE_BTN)
    await btn.trigger('keydown', { key: 'Enter' })
    await btn.trigger('keyup', { key: 'Enter' })
    await btn.trigger('click')   // Enter/Space 的默认激活产物（模板 .prevent 已抑制；此处置为不该有反应）
    expect(start, 'click 不得重新开始采集').toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(useVoiceStore().mode, 'keyup 之后必须停在 idle，不得被 click 拉回转写态').toBe('idle')
    wrapper.unmount()
  })

  it('指针路径一字未改：pointerdown 起采集 + setPointerCapture，pointerup 提交', async () => {
    const { start, stop } = stubDictation()
    const wrapper = mountInputAttached()
    const btn = wrapper.find(VOICE_BTN)
    const el = btn.element as HTMLButtonElement
    const capture = vi.fn()
    el.setPointerCapture = capture
    await btn.trigger('pointerdown', { pointerId: 7, clientY: 100 })
    expect(start, 'pointerdown 仍必须开始采集').toHaveBeenCalledTimes(1)
    expect(capture, 'pointerdown 仍必须捕获指针（上滑取消语义依赖它）').toHaveBeenCalledWith(7)
    await btn.trigger('pointerup')
    expect(stop, 'pointerup 仍必须提交').toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('上滑取消（pointermove 越过 60px 阈值 → 置 cancel → pointerup 走 cancelDictation）不变', async () => {
    const { stop } = stubDictation()
    const voice = useVoiceStore()
    const cancel = vi.spyOn(voice, 'cancelDictation').mockImplementation(() => Promise.resolve())
    const wrapper = mountInputAttached()
    const btn = wrapper.find(VOICE_BTN)
    await btn.trigger('pointerdown', { pointerId: 1, clientY: 200 })
    await btn.trigger('pointermove', { pointerId: 1, clientY: 100 })   // 上滑 100px > 60
    await btn.trigger('pointerup')
    expect(cancel, '上滑后松手必须取消而非提交').toHaveBeenCalledTimes(1)
    expect(stop).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('禁用门与指针路径一致：语音总开关关 → 键盘 keydown 不开始采集（DOM 禁用 + 处理器自身的 dictationDisabled 门）', async () => {
    const { start } = stubDictation()
    useSettingsStore().voice.enabled = false
    const wrapper = mountInputAttached()
    const btn = wrapper.find(VOICE_BTN)
    expect(isDisabled(wrapper, VOICE_BTN), 'DOM 层：语音关闭时按钮必须禁用').toBe(true)
    await btn.trigger('keydown', { key: 'Enter' })
    expect(start, '禁用态下键盘不得开始采集').not.toHaveBeenCalled()
    // 去掉 DOM 层的 disabled 再按一次：此时只剩处理器内的 dictationDisabled 门（两层门都要真的成立，
    // 否则"看起来禁用了"会掩盖"逻辑上没拦"）
    ;(btn.element as HTMLButtonElement).removeAttribute('disabled')
    await btn.trigger('keydown', { key: 'Enter' })
    expect(start, '处理器自身也必须拦（不能只靠 disabled 属性）').not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('键盘按住期间到达的指针事件不得二次起采集（两条路径不同时开始），但 pointerup 仍是「松手」信号', async () => {
    const { start, stop } = stubDictation()
    const wrapper = mountInputAttached()
    const btn = wrapper.find(VOICE_BTN)
    await btn.trigger('keydown', { key: 'Enter' })
    expect(start, '键盘 keydown 起采集').toHaveBeenCalledTimes(1)
    await btn.trigger('pointerdown', { pointerId: 3, clientY: 50 })
    expect(start, '键盘已按住时 pointerdown 不得再次开始采集（不重复进入采集）').toHaveBeenCalledTimes(1)
    // 语义说明：dictationHold 是"按住中"的唯一真值（键盘按住也置位），pointerup 因此同样收尾——
    // 这是刻意的：松手/松键都是用户"说完了"的表达，收尾重复调用是幂等的，重复**开始**才是问题。
    await btn.trigger('pointerup')
    expect(stop, 'pointerup 作为松手信号收尾一次').toHaveBeenCalledTimes(1)
    expect(useVoiceStore().mode).toBe('idle')
    wrapper.unmount()
  })

  it('键盘按住期间失焦（Tab 走开，keyup 不再到达）→ 提交收尾，不留无 UI 解释的持续采集', async () => {
    const { start, stop } = stubDictation()
    const wrapper = mountInputAttached()
    const btn = wrapper.find(VOICE_BTN)
    await btn.trigger('keydown', { key: 'Enter' })
    expect(start).toHaveBeenCalledTimes(1)
    await btn.trigger('blur')
    expect(stop, '失焦必须收尾（否则采集会一直留在 dictating）').toHaveBeenCalledTimes(1)
    await nextTick()
    expect(btn.attributes('aria-pressed'), '收尾后必须回落到 false（不得卡在按住态）').toBe('false')
    wrapper.unmount()
  })
})
