// @vitest-environment happy-dom
// tests/unit/cy-connection-panel.spec.ts
// UII-QQ 设置页批次：连接面板两级结构 + 「保存并重新连接」语义（评审修复 #2/#3）——
// 同 origin 只换 Token 时也必须先断开再连接（新凭据立即生效）；连接失败经 store.error 进编辑态错误框。
// 环境 happy-dom：api 全 mock，connection store 走真实 Pinia 实例。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import type { BackendEvent } from '@shared/contracts'
import CyConnectionPanel from '../../src/renderer/src/components/CyConnectionPanel.vue'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { useConnectionStore } from '../../src/renderer/src/stores/connection.store'

function makeApi() {
  const api = {
    connect: vi.fn(), disconnect: vi.fn(), listConversations: vi.fn(), getMessages: vi.fn(),
    send: vi.fn(), cancel: vi.fn(), activate: vi.fn(), createConversation: vi.fn(),
    renameConversation: vi.fn(), deleteConversation: vi.fn(), getConnectionState: vi.fn(),
    getCredentialStatus: vi.fn(async () => 'available' as const), setBackendToken: vi.fn(async () => 'available' as const), clearBackendToken: vi.fn(),
    setEndpoint: vi.fn(async (u: string) => ({ endpoint: u })), getEndpoint: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:8765' })), getRuntimeInfo: vi.fn(async () => ({ mode: 'real' as const, packaged: false })),
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
    listLive2dModels: vi.fn(), readLive2dModelFile: vi.fn(),
    onToolEvent: vi.fn(() => () => {}), toolDecide: vi.fn(), toolCancel: vi.fn(), toolList: vi.fn(), toolPickSource: vi.fn(), toolConfirmUpload: vi.fn(), toolGrantDirectory: vi.fn(), toolListGrants: vi.fn(), toolRevokeGrant: vi.fn(), toolListHistory: vi.fn(),
    diagnosticsState: vi.fn(), diagnosticsDevModeSet: vi.fn(), diagnosticsOpenLogDir: vi.fn(), diagnosticsClearLogs: vi.fn(), diagnosticsExport: vi.fn(), onDiagnosticsDevEvent: vi.fn(() => () => {}), getLastCrash: vi.fn()
  }
  return api
}

function mountPanel() {
  return mount(CyConnectionPanel, { attachTo: document.body })
}

async function openPopover(w: ReturnType<typeof mount>) {
  await w.find('.cy-conn-badge').trigger('click')
  await w.vm.$nextTick()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('CyConnectionPanel 两级结构（UII-QQ 设置页批次）', () => {
  it('摘要态：状态文字 + 地址摘要 + 版本 + 连接设置入口（无 Endpoint/Token 输入）', async () => {
    const api = makeApi()
    setDesktopApi(api)
    useConnectionStore().state = { status: 'connected', connectionId: 'c1', serverVersion: '0.1.0+abc', protocolVersion: '2.0' }
    const w = mountPanel()
    await openPopover(w)
    await w.vm.$nextTick()
    expect(w.find('.cy-conn-summary').exists()).toBe(true)
    expect(w.find('.cy-conn-status-row .cy-status-text').text()).toContain('已连接')
    expect(w.find('.cy-conn-facts').text()).toContain('127.0.0.1:8765')
    expect(w.find('.cy-conn-facts').text()).toContain('0.1.0+abc')
    expect(w.find('input.cy-input').exists()).toBe(false)   // 编辑态才出现输入框
    w.unmount()
  })

  it('修复#2：已连接 + 同 origin 只换 Token → 保存并重新连接 = disconnect → setBackendToken → connect', async () => {
    const api = makeApi()
    setDesktopApi(api)
    const store = useConnectionStore()
    store.state = { status: 'connected', connectionId: 'c1' }
    const w = mountPanel()
    await openPopover(w)
    await w.find('.cy-conn-summary-actions .cy-btn-secondary').trigger('click')   // 连接设置 → 编辑态
    await w.vm.$nextTick()
    const tokenInput = w.find('.cy-conn-edit input[type="password"]')
    expect(tokenInput.exists()).toBe(true)
    await tokenInput.setValue('brand-new-token')
    const order: string[] = []
    api.disconnect.mockImplementation(async () => { order.push('disconnect'); store.state = { status: 'disconnected' } })
    api.connect.mockImplementation(async () => { order.push('connect'); store.state = { status: 'connected', connectionId: 'c2' } })
    await w.find('form.cy-conn-edit').trigger('submit')
    await vi.waitFor(() => { expect(order).toEqual(['disconnect', 'connect']) })
    expect(api.setBackendToken).toHaveBeenCalledWith('brand-new-token')
    w.unmount()
  })

  it('修复#3：connect 失败归档 store.error → 编辑态错误框展示消息（store 不 rethrow 也有提示）', async () => {
    const api = makeApi()
    setDesktopApi(api)
    const store = useConnectionStore()
    store.state = { status: 'connected', connectionId: 'c1' }
    api.disconnect.mockImplementation(async () => { store.state = { status: 'disconnected' } })
    // connect 失败由 store 内部吞掉归档 error（真实 store 语义），此处直接预置 store.error 模拟归档结果
    const w = mountPanel()
    store.setError({ code: 'CONNECT_FAILED', message: '后端无法连接', retryable: true })
    await openPopover(w)
    await w.vm.$nextTick()
    // 编辑态
    await w.find('.cy-conn-summary-actions .cy-btn-secondary').trigger('click')
    await w.vm.$nextTick()
    const err = w.find('.cy-conn-edit .cy-conn-error')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('后端无法连接')
    expect(err.text()).toContain('重试')
    w.unmount()
  })

  it('摘要态已连接时提供次要「断开」；点击调用断开', async () => {
    const api = makeApi()
    setDesktopApi(api)
    const store = useConnectionStore()
    store.state = { status: 'connected', connectionId: 'c1' }
    api.disconnect.mockImplementation(async () => { store.state = { status: 'disconnected' } })
    const w = mountPanel()
    await openPopover(w)
    const danger = w.find('.cy-conn-summary-actions .cy-btn-danger')
    expect(danger.text()).toBe('断开')
    await danger.trigger('click')
    await vi.waitFor(() => { expect(api.disconnect).toHaveBeenCalled() })
    w.unmount()
  })
})
