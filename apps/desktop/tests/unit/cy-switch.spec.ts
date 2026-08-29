// @vitest-environment happy-dom
// tests/unit/cy-switch.spec.ts
// UII-QQ 设置页批次：CySwitch 布尔开关组件——role=switch/aria-checked、鼠标/Enter 切换、disabled、change 事件载荷。
// 环境 happy-dom：原生 checkbox 在 happy-dom 可触发 change（Vue Test Utils trigger）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import CySwitch from '../../src/renderer/src/components/CySwitch.vue'

function mountSwitch(props: { modelValue?: boolean; disabled?: boolean } = {}) {
  return mount(CySwitch, { props: { 'onUpdate:modelValue': vi.fn(), onChange: vi.fn(), ...props } })
}

beforeEach(() => { vi.clearAllMocks() })

describe('CySwitch（布尔功能开关）', () => {
  it('渲染为 checkbox + role=switch + aria-checked 同步', () => {
    const on = mountSwitch({ modelValue: true })
    const el = on.find('input').element as HTMLInputElement
    expect(el.type).toBe('checkbox')
    expect(el.getAttribute('role')).toBe('switch')
    expect(el.getAttribute('aria-checked')).toBe('true')
    expect((on.find('input').element as HTMLInputElement).checked).toBe(true)
  })

  it('点击 → emit update:modelValue(false) 与 change(false)（当前开 → 关）', async () => {
    const w = mountSwitch({ modelValue: true })
    await w.find('input').trigger('change')
    expect(w.emitted('update:modelValue')![0]).toEqual([false])
    expect(w.emitted('change')![0]).toEqual([false])
  })

  it('Enter 键 → 切换并 emit（Space 走原生 change）', async () => {
    const w = mountSwitch({ modelValue: false })
    await w.find('input').trigger('keydown', { key: 'Enter' })
    expect(w.emitted('update:modelValue')![0]).toEqual([true])
    expect(w.emitted('change')![0]).toEqual([true])
  })

  it('disabled → 点击不 emit', async () => {
    const w = mountSwitch({ modelValue: false, disabled: true })
    await w.find('input').trigger('change')
    await w.find('input').trigger('keydown', { key: 'Enter' })
    expect(w.emitted('update:modelValue')).toBeUndefined()
    expect(w.emitted('change')).toBeUndefined()
  })

  it('aria-label 透传（无障碍名可由父级指定）', () => {
    const w = mount(CySwitch, { props: { modelValue: false, ariaLabel: '启用语音输入' } })
    expect(w.find('input').attributes('aria-label')).toBe('启用语音输入')
  })
})
