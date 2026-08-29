// @vitest-environment happy-dom
// tests/unit/cy-profile-wizard.spec.ts
// UII-QQ 修缮批次：模型向导 Teleport 到 body + 焦点陷阱（评审修复——设置内容区 transform
// 使 position:fixed 退化为局部定位，向导被裁切且双滚动；Teleport 后焦点圈定/回焦须自足）。
// 环境 happy-dom：model store 走真实 Pinia 实例（挂载仅 startEdit/updateDraft，不触 api）。
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import CyProfileWizard from '../../src/renderer/src/components/CyProfileWizard.vue'

function q(sel: string): HTMLElement | null { return document.querySelector<HTMLElement>(sel) }

/** 挂载前放一个触发按钮并聚焦——验证打开捕获触发元素、关闭后焦点回到它 */
async function mountWizard() {
  const trigger = document.createElement('button')
  document.body.appendChild(trigger)
  trigger.focus()
  const w = mount(CyProfileWizard)
  await w.vm.$nextTick()
  await w.vm.$nextTick()
  return { w, trigger }
}

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
})

describe('CyProfileWizard Teleport + 焦点管理（UII-QQ 修缮批次）', () => {
  it('向导渲染到 body——设置内容区 transform 不再构成 fixed 的 containing block', async () => {
    const { w } = await mountWizard()
    const overlay = q('.cy-wizard-overlay')
    expect(overlay).not.toBeNull()
    expect(overlay!.parentElement).toBe(document.body)
    w.unmount()
  })

  it('打开后初始焦点落在名称输入框', async () => {
    const { w } = await mountWizard()
    expect(document.activeElement).toBe(q('input[placeholder="例如 my-llm"]'))
    w.unmount()
  })

  it('Esc 关闭向导（emit close），卸载后焦点回到触发元素', async () => {
    const { w, trigger } = await mountWizard()
    q('.cy-wizard-overlay')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await w.vm.$nextTick()
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
    expect(document.activeElement).toBe(trigger)
  })

  it('Tab 焦点陷阱：末尾 Tab 回拦到首个、首处 shift+Tab 回拦到末尾', async () => {
    const { w } = await mountWizard()
    const overlay = q('.cy-wizard-overlay')!
    const focusables = overlay.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    expect(focusables.length).toBeGreaterThan(1)
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    last.focus()
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(first)
    first.focus()
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
    expect(document.activeElement).toBe(last)
    w.unmount()
  })
})
