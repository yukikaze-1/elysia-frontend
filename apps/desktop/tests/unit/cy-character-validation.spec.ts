// @vitest-environment happy-dom
// tests/unit/cy-character-validation.spec.ts
// CyCharacterValidation：校验面板的四态（idle/loading/error/result）优先级、valid=false 阻断文案、
// estimatedPromptChars 展示、issue 严重度标签与「点击定位」emit 契约（editor 依赖它聚焦字段）。
// 环境 happy-dom：只挂载本组件，不触达 store/API（props 驱动为主）。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { CharacterValidationResult } from '@shared/contracts'
import CyCharacterValidation from '../../src/renderer/src/components/characters/CyCharacterValidation.vue'

function mountValidation(props: Record<string, unknown>) {
  return mount(CyCharacterValidation, { props })
}

describe('CyCharacterValidation 校验面板', () => {
  it('idle 且无结果时提示尚未运行；loading 时按钮禁用并改文案，不重复触发校验', async () => {
    const idle = mountValidation({ status: 'idle' })
    expect(idle.get('.cy-validation-empty').text()).toBe('尚未运行校验。')
    const runButton = idle.get('.cy-validation > header button')
    expect(runButton.text()).toBe('运行校验')
    expect(runButton.attributes('disabled')).toBeUndefined()
    await runButton.trigger('click')
    expect(idle.emitted('validate')).toHaveLength(1)
    idle.unmount()

    const loading = mountValidation({ status: 'loading' })
    expect(loading.get('.cy-validation-empty').text()).toBe('正在校验当前草稿…')
    expect(loading.get('.cy-validation > header button').text()).toBe('校验中…')
    expect(loading.get('.cy-validation > header button').attributes('disabled')).toBeDefined()
    await loading.get('.cy-validation > header button').trigger('click')
    expect(loading.emitted('validate')).toBeUndefined()
    loading.unmount()
  })

  it('valid=false 显示阻断摘要与 invalid 样式；valid=true 展示估算字符数', () => {
    const invalid: CharacterValidationResult = {
      valid: false,
      issues: [{ severity: 'error', code: 'NAME_REQUIRED', path: '/displayName', message: '请填写角色名称' }]
    }
    const invalidWrapper = mountValidation({ result: invalid, status: 'success' })
    const summary = invalidWrapper.get('.cy-validation-summary')
    expect(summary.text()).toContain('草稿未通过校验，暂不能保存')
    expect(summary.classes()).toContain('invalid')
    invalidWrapper.unmount()

    const validWrapper = mountValidation({
      result: { valid: true, issues: [], estimatedPromptChars: 1234 } satisfies CharacterValidationResult,
      status: 'success'
    })
    const validSummary = validWrapper.get('.cy-validation-summary')
    expect(validSummary.text()).toContain('草稿可以提交（请留意提醒）')
    expect(validSummary.text()).toContain('约 1234 字符')
    expect(validSummary.classes()).not.toContain('invalid')
    expect(validWrapper.get('.cy-validation-empty').text()).toBe('没有发现问题。')
    validWrapper.unmount()
  })

  it('issue 列表按严重度标注错误/提醒，空 path 显示全局占位，点击 emit 原始 path', async () => {
    const result: CharacterValidationResult = {
      valid: false,
      issues: [
        { severity: 'error', code: 'EXAMPLE_ITEM', path: '/promptProfile/examples/0', message: '示例不完整' },
        { severity: 'warning', code: 'GLOBAL', path: '', message: '请检查整份草稿' }
      ]
    }
    const wrapper = mountValidation({ result, status: 'success' })
    const items = wrapper.findAll('.cy-issue-list li')
    expect(items).toHaveLength(2)
    expect(items[0].classes()).toContain('error')
    expect(items[0].attributes('data-issue-path')).toBe('/promptProfile/examples/0')
    expect(items[0].text()).toContain('错误')
    expect(items[0].find('code').text()).toBe('/promptProfile/examples/0')
    expect(items[1].classes()).toContain('warning')
    expect(items[1].text()).toContain('提醒')
    expect(items[1].find('code').text()).toBe('（全局）')

    await items[0].get('button').trigger('click')
    await items[1].get('button').trigger('click')
    expect(wrapper.emitted('focus')).toEqual([[ '/promptProfile/examples/0' ], [ '' ]])
    wrapper.unmount()
  })

  it('校验请求失败时错误提示优先于旧结果，并保持 role=alert', () => {
    const stale: CharacterValidationResult = {
      valid: true,
      issues: [],
      estimatedPromptChars: 10
    }
    const wrapper = mountValidation({
      result: stale,
      status: 'error',
      error: { code: 'BACKEND_REJECTED', message: '角色校验失败，请稍后重试。' }
    })
    const alert = wrapper.get('.cy-validation-error')
    expect(alert.attributes('role')).toBe('alert')
    expect(alert.text()).toBe('角色校验失败，请稍后重试。')
    // 失败态不展示可能已过期的上一次结果，避免用户误以为草稿仍通过
    expect(wrapper.find('.cy-validation-summary').exists()).toBe(false)
    expect(wrapper.find('.cy-issue-list').exists()).toBe(false)
    wrapper.unmount()
  })
})
