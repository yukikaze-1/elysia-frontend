// @vitest-environment happy-dom
// tests/unit/cy-voice-consent-dialog.spec.ts
// M-21（2026-09-11 全量评审）：`CyVoiceConsentDialog` 是 `position:fixed; inset:0` 的全屏 modal
// （`role="dialog" aria-modal="true"`），但 91 行文件里零焦点管理——初始焦点留在覆盖层之后的
// 麦克风/录音按钮上（Enter 会重新触发语音动作而不是回答提示）、Tab 走查被遮挡控件、Escape 无效、
// 回焦缺失。本 spec 按仓库既有先例（CyToolApproval：初始焦点在"拒绝"侧 / Tab 陷阱 / 回焦触发元素）
// 钉住这四条行为。
//
// 挂载形状：本组件 `v-if="voiceStore.consentPending"` 在组件内部，宿主（CyChatInput / CySettingsView）
// 里实例常驻——故用例同时覆盖「挂载时 pending 已为 true」（onMounted 门）与「挂载后 true」（watch 门）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import CyVoiceConsentDialog from '../../src/renderer/src/components/CyVoiceConsentDialog.vue'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { useVoiceStore } from '../../src/renderer/src/stores/voice.store'
import { useSettingsStore } from '../../src/renderer/src/stores/settings.store'
import { useConnectionStore } from '../../src/renderer/src/stores/connection.store'
import { createDesktopApiMock } from './helpers/desktop-api'

/** 挂起动作永不 settle：confirmConsent 会 `await action()`，永不 settle 才能稳定观察
 *  `confirmDispatching` 在途窗口（settle 后 try/finally 立即复位）。
 *  I-06：类型须与真实契约一致（`Promise<{ recordingId: string }>`）——原先 `Promise<void>` 是被
 *  `as unknown as DesktopApiLike` 掩盖的签名漂移；"永不 settle" 的语义不变。 */
let neverSettles: Promise<{ recordingId: string }>
const mockApi = {
  onChatEvent: vi.fn(() => () => {}),
  voiceStartRecord: vi.fn(() => neverSettles),
  voiceDiscard: vi.fn(async () => {})
}

beforeEach(() => {
  neverSettles = new Promise<{ recordingId: string }>(() => { /* 有意永不 settle，见上 */ })
  setActivePinia(createPinia())
  setDesktopApi(createDesktopApiMock(mockApi))
  vi.clearAllMocks()
  useConnectionStore().state = { status: 'connected', connectionId: 'cid-1' }
  useSettingsStore().voice.enabled = true
})

/** 触发元素必须在文档里（脱离文档的节点 focus() 不会成为 document.activeElement） */
function attachTrigger(): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.textContent = '普通录音'
  document.body.appendChild(btn)
  btn.focus()
  return btn
}

async function mountOpen(): Promise<{ wrapper: ReturnType<typeof mount>; trigger: HTMLButtonElement }> {
  const trigger = attachTrigger()
  const voice = useVoiceStore()
  voice.consentPending = true
  const wrapper = mount(CyVoiceConsentDialog, { attachTo: document.body })
  await nextTick()
  await nextTick()
  return { wrapper, trigger }
}

describe('CyVoiceConsentDialog 焦点管理（M-21）', () => {
  it('打开即把焦点移入对话框——初始焦点在「取消」（安全默认，防未读提示就 Enter 同意）', async () => {
    const { wrapper, trigger } = await mountOpen()
    const cancel = wrapper.find('[data-testid="consent-cancel"]')
    const confirm = wrapper.find('[data-testid="consent-confirm"]')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    expect(document.activeElement).toBe(cancel.element)
    // 正向的"对"而不是只断言"不是触发元素"：焦点确实进了窗内
    expect(wrapper.find('[role="dialog"]').element.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(trigger)
    expect(document.activeElement).not.toBe(confirm.element)
    wrapper.unmount()
    trigger.remove()
  })

  it('关闭（取消）后回焦到打开前的活动元素', async () => {
    const { wrapper, trigger } = await mountOpen()
    expect(document.activeElement).toBe(wrapper.find('[data-testid="consent-cancel"]').element)
    await wrapper.find('[data-testid="consent-cancel"]').trigger('click')
    expect(useVoiceStore().consentPending).toBe(false)
    expect(document.activeElement, '关闭后焦点必须回到触发元素').toBe(trigger)
    wrapper.unmount()
    trigger.remove()
  })

  it('关闭（同意）后同样回焦触发元素（confirm 走 await，回焦在 finally）', async () => {
    const { wrapper, trigger } = await mountOpen()
    // 不设 pendingAction：confirmConsent 立即返回（不执行任何动作），回焦路径与真实一致
    await wrapper.find('[data-testid="consent-confirm"]').trigger('click')
    await nextTick()
    expect(useVoiceStore().consentPending).toBe(false)
    expect(useSettingsStore().voice.consentBackendStt, '同意 = 持久化「不再提示」').toBe(true)
    expect(document.activeElement).toBe(trigger)
    wrapper.unmount()
    trigger.remove()
  })

  it('Tab 从最后一个可聚焦元素回绕到第一个；Shift+Tab 反向回绕（焦点陷阱）', async () => {
    const { wrapper, trigger } = await mountOpen()
    const cancel = wrapper.find('[data-testid="consent-cancel"]').element as HTMLElement
    const confirm = wrapper.find('[data-testid="consent-confirm"]').element as HTMLElement
    // Tab（焦点在最后一个 = 同意）→ 回绕到取消
    confirm.focus()
    expect(document.activeElement).toBe(confirm)
    await wrapper.find('[role="dialog"]').trigger('keydown', { key: 'Tab' })
    expect(document.activeElement, 'Tab 必须留在对话框内').toBe(cancel)
    // Shift+Tab（焦点在第一个 = 取消）→ 反向回绕到同意
    cancel.focus()
    await wrapper.find('[role="dialog"]').trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement, 'Shift+Tab 必须留在对话框内').toBe(confirm)
    wrapper.unmount()
    trigger.remove()
  })

  it('Escape = 拒绝（与「取消」同一路径：dismissConsent，不置位「不再提示」）+ 回焦', async () => {
    const { wrapper, trigger } = await mountOpen()
    const voice = useVoiceStore()
    await wrapper.find('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    expect(voice.consentPending).toBe(false)
    expect(voice.pendingAction, '拒绝不得执行挂起动作').toBeNull()
    // 语义钉子：Escape 是"拒绝"而非"绕过同意"——什么都没持久化，下次语音操作仍会重新弹窗
    expect(useSettingsStore().voice.consentBackendStt).toBe(false)
    expect(document.activeElement).toBe(trigger)
    wrapper.unmount()
    trigger.remove()
  })

  it('挂载后 pending 才置位（宿主常驻形状）→ 同样聚焦取消按钮', async () => {
    const trigger = attachTrigger()
    const wrapper = mount(CyVoiceConsentDialog, { attachTo: document.body })
    await nextTick()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    useVoiceStore().consentPending = true
    await nextTick()
    await nextTick()
    expect(document.activeElement).toBe(wrapper.find('[data-testid="consent-cancel"]').element)
    wrapper.unmount()
    trigger.remove()
  })

  it('Escape 不回冒给宿主（设置中心宿主下，一次 Escape 不得连带关掉整个设置页）', async () => {
    const trigger = attachTrigger()
    const voice = useVoiceStore()
    voice.consentPending = true
    const hostEscape = vi.fn()
    // 等价于 CySettingsView：宿主 overlay 自己监听 Escape
    const host = mount({
      template: '<div class="host-overlay" @keydown="onKeydown"><CyVoiceConsentDialog /></div>',
      components: { CyVoiceConsentDialog },
      setup: () => ({ onKeydown: (e: KeyboardEvent) => { if (e.key === 'Escape') hostEscape() } })
    }, { attachTo: document.body })
    await nextTick()
    await nextTick()
    const dialog = host.find('[role="dialog"]')
    expect(dialog.exists()).toBe(true)
    await dialog.trigger('keydown', { key: 'Escape' })
    expect(voice.consentPending, '本对话框自身仍要关闭').toBe(false)
    expect(hostEscape, 'Escape 不得冒泡给宿主（否则设置页会被一并关闭）').not.toHaveBeenCalled()
    host.unmount()
    trigger.remove()
  })

  it('同意已派发（confirmDispatching）时 Escape 不再关闭：那次操作已在途，"取消"不再等价于拒绝', async () => {
    const { wrapper } = await mountOpen()
    const voice = useVoiceStore()
    // 造出真实的在途态：consentPending=true + 挂起动作（永不 settle）
    voice.pendingAction = async () => { await neverSettles }
    await wrapper.find('[data-testid="consent-confirm"]').trigger('click')
    expect(voice.consentPending).toBe(false)   // confirmConsent 已清 pending（overlay 随之下线）
    expect(voice.confirmDispatching).toBe(true)
    voice.consentPending = true               // 让 overlay 仍在，单独考 Escape 的门
    await nextTick()
    await wrapper.find('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    expect(voice.consentPending, '在途期间的 Escape 不得关闭对话框').toBe(true)
    wrapper.unmount()
  })
})
