// tests/unit/character-error.spec.ts
// 角色公开错误文案映射（character-error.ts 纯函数，env=node 无需 DOM）：
// Main 已公开的 backendCode/code → 可执行的中文下一步；未知码只回退公开 message，
// 缺 message 时回退调用方 fallback；绝不把内部异常或后端正文改写成另一种说法。
import { describe, expect, it } from 'vitest'
import { characterErrorMessage } from '../../src/renderer/src/components/characters/character-error'

describe('characterErrorMessage（角色错误文案映射）', () => {
  it('未收到错误时使用调用方 fallback', () => {
    expect(characterErrorMessage(undefined, '保存失败，请检查校验结果后重试。'))
      .toBe('保存失败，请检查校验结果后重试。')
  })

  it('每个已登记 backendCode 映射为固定可执行提示，且不泄露后端 message 正文', () => {
    const expected: Array<[string, string]> = [
      ['CHARACTER_NOT_FOUND', '角色已不存在，请返回目录刷新。'],
      ['CHARACTER_IMMUTABLE', '内置角色不可修改，请先克隆为自定义角色。'],
      ['CHARACTER_ARCHIVED', '该角色已归档，不能继续编辑或用于新会话。'],
      ['CHARACTER_REVISION_CONFLICT', '角色版本已更新。请重新加载最新版本，或选择另存为新角色。'],
      ['CHARACTER_STATE_CONFLICT', '角色版本已更新。请重新加载最新版本，或选择另存为新角色。'],
      ['CHARACTER_STORAGE_UNAVAILABLE', '本地草稿存储暂时不可用；请稍后重试。'],
      ['STORAGE_UNAVAILABLE', '本地草稿存储暂时不可用；请稍后重试。'],
      ['CHARACTER_PREVIEW_FAILED', '临时预览失败，请检查连接或稍后重试。'],
      ['CHARACTER_MUTATION_IN_PROGRESS', '角色正在处理中，请等待当前操作完成。'],
      ['CHARACTER_BUSY', '角色正在处理中，请等待当前操作完成。'],
      ['CHARACTER_OFFLINE', '当前未连接；远端角色操作不可用，但仍可保存本地草稿。'],
      ['CHARACTER_VALIDATION', '角色校验未通过，请按下方问题修正后再保存。']
    ]
    for (const [backendCode, message] of expected) {
      expect(characterErrorMessage({ code: 'BACKEND_REJECTED', backendCode, message: '内部异常：C:\\secret\\path' }, 'fallback'))
        .toBe(message)
    }
  })

  it('backendCode 优先于 code（两者同时存在时以更具体的后端码为准）', () => {
    expect(characterErrorMessage({ code: 'CHARACTER_OFFLINE', backendCode: 'CHARACTER_IMMUTABLE', message: 'x' }, 'fallback'))
      .toBe('内置角色不可修改，请先克隆为自定义角色。')
  })

  it('缺少 backendCode 时按 code 匹配', () => {
    expect(characterErrorMessage({ code: 'CHARACTER_OFFLINE', message: 'x' }, 'fallback'))
      .toBe('当前未连接；远端角色操作不可用，但仍可保存本地草稿。')
  })

  it('未知码回退公开 message；message 为空时回退 fallback', () => {
    expect(characterErrorMessage({ code: 'BACKEND_REJECTED', message: '后端返回的可公开说明' }, 'fallback'))
      .toBe('后端返回的可公开说明')
    expect(characterErrorMessage({ code: 'BACKEND_REJECTED', message: '' }, 'fallback')).toBe('fallback')
  })
})
