// @vitest-environment happy-dom
// tests/unit/cy-profile-wizard.spec.ts
// UII-QQ 修缮批次：模型向导 Teleport 到 body + 焦点陷阱（评审修复——设置内容区 transform
// 使 position:fixed 退化为局部定位，向导被裁切且双滚动；Teleport 后焦点圈定/回焦须自足）。
// 环境 happy-dom：model store 走真实 Pinia 实例（挂载仅 startEdit/updateDraft，不触 api）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import CyProfileWizard from '../../src/renderer/src/components/CyProfileWizard.vue'
import { useModelServiceStore } from '../../src/renderer/src/stores/model-service.store'

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

  it('表单滚动区与底部操作区分离——保存按钮不随长表单滚出可视区', async () => {
    const { w } = await mountWizard()
    const form = q('.cy-wizard-form')
    const body = q('.cy-wizard-body')
    const actions = q('.cy-wizard-actions')
    expect(form).not.toBeNull()
    expect(body?.parentElement?.classList.contains('cy-wizard-form')).toBe(true)
    expect(actions?.parentElement?.classList.contains('cy-wizard-form')).toBe(true)
    expect(actions?.previousElementSibling?.classList.contains('cy-wizard-body')).toBe(true)
    expect(body?.contains(actions)).toBe(false)
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

// ═══════════════════════════════════════════════════════════════════════════════
// 2026-09-16 审计 P1-5：提交续体的 owner 栅栏
//
// 缺陷：向导的提交动作在组件卸载后继续执行——`await api.saveProfile(...)` 之后无条件走激活路径
// 与本地写，组件卸载不取消续体，且提交进行中「取消」按钮**未禁用**（:215 是全文件唯一没有
// `:disabled` 的动作按钮）。用户点「取消」是明示的不保留意图，实现却当成「关闭界面」：
// 远端仍被写入 profile，**全局激活模型服务被静默切换**（影响后续所有对话的模型选择）。
// 零竞态、必然可达，属用户可见的功能错误而不是竞态边角。
//
// 修法取「栅栏」而不是「提交中禁用取消」：禁用会把用户锁在一个可能永不返回的请求里；
// 栅栏让取消真正生效，同时保留随时可退出的能力。
// ═══════════════════════════════════════════════════════════════════════════════
describe('CyProfileWizard 提交栅栏（2026-09-16 审计 P1-5）', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0))
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void
    const promise = new Promise<void>((r) => { resolve = r })
    return { promise, resolve }
  }
  function actionButton(text: string): HTMLButtonElement {
    const found = [...document.querySelectorAll<HTMLButtonElement>('.cy-wizard-actions button')]
      .find((b) => b.textContent?.trim() === text)
    if (!found) throw new Error(`找不到动作按钮：${text}`)
    return found
  }
  /** 填出可通过 validate 的草稿（name 必填 + baseUrl 必填） */
  function fillValidDraft(): ReturnType<typeof useModelServiceStore> {
    const store = useModelServiceStore()
    store.updateDraft('new', { name: 'my-llm', baseUrl: 'https://api.example.com' })
    return store
  }

  it('「取消」按钮在提交中仍可点（未被禁用）——这正是缺陷的可达路径', async () => {
    const { w } = await mountWizard()
    const store = fillValidDraft()
    vi.spyOn(store, 'saveProfile').mockReturnValue(deferred().promise)
    await w.vm.$nextTick()
    expect(actionButton('取消').disabled, '修法取栅栏而非禁用：取消必须始终可退出').toBe(false)
    w.unmount()
  })

  it('提交中卸载组件：续体不得再切换全局激活模型服务', async () => {
    const { w } = await mountWizard()
    const store = fillValidDraft()
    const gate = deferred()
    const saveProfile = vi.spyOn(store, 'saveProfile').mockReturnValue(gate.promise)
    const activate = vi.spyOn(store, 'activate').mockResolvedValue(undefined)
    await w.vm.$nextTick()

    actionButton('保存并设为当前').click()
    await flush()
    expect(saveProfile, '提交必须已经发出（否则本用例测不到续体）').toHaveBeenCalledTimes(1)

    w.unmount()          // 卸载 = 取消
    gate.resolve()
    await flush()

    expect(activate, '取消后仍切换全局激活模型服务 = P1-5 原缺陷').not.toHaveBeenCalled()
  })

  it('提交中点「取消」：续体不得再切换全局激活模型服务', async () => {
    const { w } = await mountWizard()
    const store = fillValidDraft()
    const gate = deferred()
    vi.spyOn(store, 'saveProfile').mockReturnValue(gate.promise)
    const activate = vi.spyOn(store, 'activate').mockResolvedValue(undefined)
    await w.vm.$nextTick()

    actionButton('保存并设为当前').click()
    await flush()
    actionButton('取消').click()      // 真实用户路径：请求在途时点取消
    await flush()
    expect(w.emitted('close'), '取消必须立刻关掉向导').toHaveLength(1)

    gate.resolve()
    await flush()

    expect(activate, '用户明示取消后不得静默切换全局激活模型服务').not.toHaveBeenCalled()
  })

  it('测试并保存路径同样受栅栏约束：取消后不得落库', async () => {
    const { w } = await mountWizard()
    const store = fillValidDraft()
    const gate = deferred()
    const testProfile = vi.spyOn(store, 'testProfile').mockReturnValue(gate.promise)
    const saveProfile = vi.spyOn(store, 'saveProfile').mockResolvedValue(undefined)
    // 让连通性测试"通过"，否则 saveProfile 本来就不会被调用、用例失去判别力
    store.testResult['custom/my-llm|connectivity'] = { ok: true } as never
    await w.vm.$nextTick()

    actionButton('测试并保存').click()
    await flush()
    expect(testProfile).toHaveBeenCalledTimes(1)

    actionButton('取消').click()
    gate.resolve()
    await flush()

    expect(saveProfile, '取消后不得再远端落库').not.toHaveBeenCalled()
  })

  it('正常路径不受影响：保存成功仍 activate 并关闭向导', async () => {
    const { w } = await mountWizard()
    const store = fillValidDraft()
    vi.spyOn(store, 'saveProfile').mockResolvedValue(undefined)
    const activate = vi.spyOn(store, 'activate').mockResolvedValue(undefined)
    await w.vm.$nextTick()

    actionButton('保存并设为当前').click()
    await flush()
    await flush()

    expect(activate).toHaveBeenCalledWith({ id: 'custom/my-llm', type: 'llm' })
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('关闭向导清掉该草稿的测试结果——不留过期绿灯', async () => {
    const { w } = await mountWizard()
    const store = fillValidDraft()
    store.testResult['custom/my-llm|connectivity'] = { ok: true } as never
    store.testResult['custom/my-llm|usable'] = { ok: true } as never
    await w.vm.$nextTick()

    actionButton('取消').click()

    expect(store.testResult['custom/my-llm|connectivity'], '重开向导不得显示上一次的测试通过').toBeUndefined()
    expect(store.testResult['custom/my-llm|usable']).toBeUndefined()
  })
})
