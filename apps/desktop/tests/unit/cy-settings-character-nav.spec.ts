// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import CySettingsView from '../../src/renderer/src/components/CySettingsView.vue'
import { useIdentityStore } from '../../src/renderer/src/stores/identity.store'
import { useCharacterEditorStore } from '../../src/renderer/src/stores/character-editor.store'

vi.mock('../../src/renderer/src/components/CyModelServicesPane.vue', () => ({ default: { template: '<div />' } }))
vi.mock('../../src/renderer/src/components/CyVoicePane.vue', () => ({ default: { template: '<div />' } }))
vi.mock('../../src/renderer/src/components/CyLive2DPane.vue', () => ({ default: { template: '<div />' } }))
vi.mock('../../src/renderer/src/components/CySecurityPane.vue', () => ({ default: { template: '<div />' } }))
vi.mock('../../src/renderer/src/components/CyDiagnosticsPane.vue', () => ({ default: { template: '<div />' } }))
vi.mock('../../src/renderer/src/components/CyVoiceConsentDialog.vue', () => ({ default: { template: '<div />' } }))
vi.mock('../../src/renderer/src/components/characters/CyIdentityPane.vue', () => ({ default: { template: '<div />' } }))
vi.mock('../../src/renderer/src/components/characters/CyCharacterPane.vue', () => ({ default: { template: '<div />' } }))

let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
})

function mountSettings() {
  return mount(CySettingsView, {
    global: {
      plugins: [pinia],
      stubs: {
        CyModelServicesPane: { template: '<div>model-pane</div>' },
        CyIdentityPane: { template: '<div>identity-pane</div>' },
        CyCharacterPane: { template: '<div>character-pane</div>' },
        CyVoicePane: { template: '<div>voice-pane</div>' },
        CyLive2DPane: { template: '<div>live2d-pane</div>' },
        CySecurityPane: { template: '<div>security-pane</div>' },
        CyDiagnosticsPane: { template: '<div>diagnostics-pane</div>' },
        CyVoiceConsentDialog: true
      }
    }
  })
}

function navButton(wrapper: ReturnType<typeof mountSettings>, label: string) {
  return wrapper.findAll('.cy-settings-nav-item').find((button) => button.text().includes(label))!
}

describe('CySettingsView FE-C 导航', () => {
  it('拆分我的档案/角色/外观与 Live2D，并同步面包屑与未完成标记', async () => {
    const identity = useIdentityStore()
    identity.profile = {
      userId: 'u', displayName: '我', locale: 'zh-CN', timezone: 'Asia/Shanghai', initialized: false,
      revision: 1, createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z'
    }
    const wrapper = mountSettings()
    expect(wrapper.text()).toContain('我的档案')
    expect(wrapper.text()).toContain('外观与 Live2D')
    expect(wrapper.text()).not.toContain('角色与外观')
    expect(navButton(wrapper, '我的档案').text()).toContain('未完成')

    await navButton(wrapper, '我的档案').trigger('click')
    expect(wrapper.text()).toContain('identity-pane')
    expect(wrapper.find('.cy-settings-title').text()).toContain('我的档案')
    await navButton(wrapper, '角色').trigger('click')
    expect(wrapper.text()).toContain('character-pane')
    await navButton(wrapper, '外观与 Live2D').trigger('click')
    expect(wrapper.text()).toContain('live2d-pane')
    wrapper.unmount()
  })

  it('我的档案脏表单离开时确认，拒绝确认则保持当前页', async () => {
    const wrapper = mountSettings()
    await navButton(wrapper, '我的档案').trigger('click')
    useIdentityStore().dirty = true
    const confirm = vi.fn(() => false)
    Object.defineProperty(window, 'confirm', { configurable: true, value: confirm })
    await navButton(wrapper, '角色').trigger('click')
    expect(wrapper.text()).toContain('identity-pane')
    expect(confirm).toHaveBeenCalled()
    confirm.mockReturnValue(true)
    await navButton(wrapper, '角色').trigger('click')
    expect(wrapper.text()).toContain('character-pane')
    delete (window as { confirm?: typeof window.confirm }).confirm
    wrapper.unmount()
  })

  it('角色编辑器脏草稿关闭设置或切换分组时确认，拒绝则保持角色页', async () => {
    const wrapper = mountSettings()
    await navButton(wrapper, '角色').trigger('click')
    useCharacterEditorStore().dirty = true
    const confirm = vi.fn(() => false)
    Object.defineProperty(window, 'confirm', { configurable: true, value: confirm })
    await navButton(wrapper, '模型服务').trigger('click')
    expect(wrapper.text()).toContain('character-pane')
    expect(confirm).toHaveBeenCalled()
    confirm.mockReturnValue(true)
    await navButton(wrapper, '模型服务').trigger('click')
    expect(wrapper.text()).toContain('model-pane')
    delete (window as { confirm?: typeof window.confirm }).confirm
    wrapper.unmount()
  })

  it('角色脏草稿关闭按钮与 Esc 都遵守确认，接受离开会立即触发本地 flush', async () => {
    const wrapper = mountSettings()
    await navButton(wrapper, '角色').trigger('click')
    const editor = useCharacterEditorStore()
    editor.dirty = true
    const flushDraft = vi.spyOn(editor, 'flushDraft').mockResolvedValue(true)
    const confirm = vi.fn(() => false)
    Object.defineProperty(window, 'confirm', { configurable: true, value: confirm })

    await wrapper.get('.cy-close-btn').trigger('click')
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(flushDraft).not.toHaveBeenCalled()

    confirm.mockReturnValue(true)
    await wrapper.get('.cy-close-btn').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(flushDraft).toHaveBeenCalledTimes(1)

    editor.dirty = true
    confirm.mockReturnValue(false)
    await wrapper.get('.cy-settings-overlay').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(confirm).toHaveBeenCalledTimes(3)

    confirm.mockReturnValue(true)
    await wrapper.get('.cy-settings-overlay').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(2)
    expect(flushDraft).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })
})
