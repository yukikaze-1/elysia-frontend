// @vitest-environment happy-dom
// tests/unit/cy-settings-save-status.spec.ts
// M-19（2026-09-13）：设置保存状态必须**用户可见**。
//
// 判别力设计：修前 `settings.store` 的 `saveError` / `saved` 是**死状态**——全仓没有任何组件渲染它们
// （grep 只命中 store 自身），而 Live2D 子页却写着"500ms 自动保存"。故本组用例的失败模式是
// "元素根本不存在"，而不是"文案措辞不对"。另钉两件事：
//   ① 三态**优先级**（失败 > 保存中 > 已保存）：三者同时为真时只显示错误，不允许被"已保存"盖住；
//   ② 文案经 `error-message.ts` 单一来源（store 只说 code），且**降级态**（不可自愈）与
//      **单次写失败**（可重试）给出不同的话——用户该做的事不同。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import CySettingsView from '../../src/renderer/src/components/CySettingsView.vue'
import { useSettingsStore } from '../../src/renderer/src/stores/settings.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { createDesktopApiMock } from './helpers/desktop-api'

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
  setDesktopApi(createDesktopApiMock())
})

function mountSettings() {
  return mount(CySettingsView, {
    global: {
      plugins: [pinia],
      stubs: {
        CyModelServicesPane: true, CyIdentityPane: true, CyCharacterPane: true, CyVoicePane: true,
        CyLive2DPane: true, CySecurityPane: true, CyDiagnosticsPane: true, CyVoiceConsentDialog: true
      }
    }
  })
}

describe('设置保存状态可见（M-19）', () => {
  it('无故障 → 三种状态都不渲染（不制造噪音）', () => {
    const w = mountSettings()
    expect(w.find('[data-testid="settings-save-error"]').exists()).toBe(false)
    expect(w.find('[data-testid="settings-saving"]').exists()).toBe(false)
    expect(w.find('[data-testid="settings-saved"]').exists()).toBe(false)
  })

  it('保存失败 → role=alert + 映射后的文案 + 「改动没丢」的说明', async () => {
    const w = mountSettings()
    useSettingsStore().$patch({ saveError: { code: 'SETTINGS_SAVE_FAILED', message: '本地保存失败（ENOSPC）' } })
    await w.vm.$nextTick()
    const alert = w.find('[data-testid="settings-save-error"]')
    expect(alert.exists()).toBe(true)
    expect(alert.attributes('role')).toBe('alert')
    expect(alert.text()).toContain('设置保存失败')
    expect(alert.text()).toContain('请检查磁盘空间或目录权限后重试')
    expect(alert.text(), '必须告诉用户改动还在队列里，否则他会以为白改了').toContain('改动仍保留在待写队列')
    // 不被其它两态盖住
    expect(w.find('[data-testid="settings-saved"]').exists()).toBe(false)
  })

  it('降级态（不可自愈）与单次写失败给出不同的话', async () => {
    const w = mountSettings()
    useSettingsStore().$patch({ saveError: { code: 'PERSISTENCE_DEGRADED', message: '持久化已降级' } })
    await w.vm.$nextTick()
    expect(w.find('[data-testid="settings-save-error"]').text()).toContain('本地保存已停用')
  })

  it('有未确认写入 → 「正在保存设置…」（role=status，非 alert）', async () => {
    const w = mountSettings()
    useSettingsStore().$patch({ unsaved: true, saved: false })
    await w.vm.$nextTick()
    const status = w.find('[data-testid="settings-saving"]')
    expect(status.exists()).toBe(true)
    expect(status.attributes('role')).toBe('status')
    expect(w.find('[data-testid="settings-saved"]').exists()).toBe(false)
  })

  it('写回成功 → 「设置已保存」', async () => {
    const w = mountSettings()
    useSettingsStore().$patch({ unsaved: false, saved: true })
    await w.vm.$nextTick()
    expect(w.find('[data-testid="settings-saved"]').text()).toContain('设置已保存')
  })

  it('三态同时为真 → 只显示失败（优先级：错误 > 保存中 > 已保存）', async () => {
    const w = mountSettings()
    useSettingsStore().$patch({ saveError: { code: 'SETTINGS_SAVE_FAILED', message: 'x' }, unsaved: true, saved: true })
    await w.vm.$nextTick()
    expect(w.find('[data-testid="settings-save-error"]').exists()).toBe(true)
    expect(w.find('[data-testid="settings-saving"]').exists()).toBe(false)
    expect(w.find('[data-testid="settings-saved"]').exists()).toBe(false)
  })
})
