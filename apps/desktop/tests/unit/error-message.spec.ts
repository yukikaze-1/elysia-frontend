// tests/unit/error-message.spec.ts（多套 UI 基础，2026-09-10）
//
// errorMessage 是「错误码 → 用户可读文案」的单一来源。本文件钉住它的**回退链顺序**，
// 因为顺序本身就是正确性的一部分：
//   ① backendCode 映射（后端语义更精确）→ ② code 映射 → ③ 错误原文 → ④ 调用方兜底。
//
// 特别钉住 ③：来自 Main 的已公开错误原文必须能显示。跨国进程错误没有本地映射，
// 若被兜底吞掉，界面会变成空白错误提示——这比显示一句不够漂亮的原文更糟。
import { describe, expect, it } from 'vitest'
import { errorMessage } from '../../src/renderer/src/utils/error-message'
import type { PublicError } from '../../src/renderer/src/utils/public-error'
import { characterErrorMessage } from '../../src/renderer/src/components/characters/character-error'

const FALLBACK = '操作失败，请稍后重试。'

function err(partial: Partial<PublicError> & { code: string }): PublicError {
  return { message: '', ...partial }
}

describe('errorMessage：回退链顺序', () => {
  it('① backendCode 优先于 code（后端语义更精确）', () => {
    // code 为通用包装码 BACKEND_REJECTED，backendCode 指明真实原因 → 取 backendCode 文案
    expect(errorMessage(err({ code: 'BACKEND_REJECTED', backendCode: 'CHARACTER_ARCHIVED' }), FALLBACK))
      .toBe('该角色已归档，不能继续编辑或用于新会话。')
  })

  it('② 无 backendCode 时按 code 映射', () => {
    expect(errorMessage(err({ code: 'CHARACTER_REQUIRED' }), FALLBACK)).toBe('请先选择一个角色再新建会话。')
    expect(errorMessage(err({ code: 'IDENTITY_REQUIRED' }), FALLBACK)).toBe('请先完成「我的档案」初始化，再新建角色会话。')
    expect(errorMessage(err({ code: 'OFFLINE_NOT_CACHED' }), FALLBACK)).toBe('该会话离线不可读。')
  })

  it('③ 无映射时显示来自 Main 的已公开原文（不得被兜底吞掉）', () => {
    expect(errorMessage(err({ code: 'SOME_BACKEND_ONLY_CODE', message: 'backend said no' }), FALLBACK))
      .toBe('backend said no')
  })

  it('④ 无映射且无原文时用调用方兜底', () => {
    expect(errorMessage(err({ code: 'SOME_BACKEND_ONLY_CODE' }), FALLBACK)).toBe(FALLBACK)
    expect(errorMessage(undefined, FALLBACK)).toBe(FALLBACK)
  })

  it('功能层本地产出的诊断标识（LOCAL:xxx）绝不会显示给用户', () => {
    // stores 现在对本地错误填写 'LOCAL:<CODE>' 作为诊断标识；这些 code 都已被映射覆盖，
    // 故用户永远看不到该标识。本用例遍历全部本地码，防止将来新增码时漏配映射导致标识外泄。
    const localCodes = [
      'CHARACTER_REQUIRED', 'IDENTITY_REQUIRED', 'OFFLINE_VIEW', 'OFFLINE_NOT_CACHED',
      'CHARACTER_GENERATION_PROTOCOL_MISMATCH', 'MESSAGE_PROTOCOL_MISMATCH',
      'CHARACTER_DRAFT_STORAGE_UNAVAILABLE', 'SCHEMA_VALIDATION_FAILED', 'IDENTITY_SAVE_STALE'
    ]
    for (const code of localCodes) {
      const text = errorMessage(err({ code, message: `LOCAL:${code}` }), FALLBACK)
      expect(text, `${code} 应有映射文案`).not.toBe(`LOCAL:${code}`)
      expect(text, `${code} 不得回显诊断标识`).not.toContain('LOCAL:')
      expect(text.length, `${code} 文案不得为空`).toBeGreaterThan(0)
    }
  })

  it('通用包装码 BACKEND_REJECTED / UNKNOWN 不编泛化文案，必须回退公开原文', () => {
    // 给它们编一句「后端拒绝了本次操作。」会盖住后端真正给出的说明——这是实测过的回归。
    expect(errorMessage(err({ code: 'BACKEND_REJECTED', message: '后端返回的可公开说明' }), FALLBACK))
      .toBe('后端返回的可公开说明')
    expect(errorMessage(err({ code: 'UNKNOWN', message: '某条上游说明' }), FALLBACK)).toBe('某条上游说明')
    // 无原文时仍须兜底，不得空白
    expect(errorMessage(err({ code: 'BACKEND_REJECTED' }), FALLBACK)).toBe(FALLBACK)
  })

  it('角色域映射未因收口而丢失（characterErrorMessage 是 errorMessage 的别名）', () => {
    const cases: Array<[string, string]> = [
      ['CHARACTER_NOT_FOUND', '角色已不存在，请返回目录刷新。'],
      ['CHARACTER_IMMUTABLE', '内置角色不可修改，请先克隆为自定义角色。'],
      ['CHARACTER_ARCHIVED', '该角色已归档，不能继续编辑或用于新会话。'],
      ['CHARACTER_REVISION_CONFLICT', '角色版本已更新。请重新加载最新版本，或选择另存为新角色。'],
      ['CHARACTER_PREVIEW_FAILED', '临时预览失败，请检查连接或稍后重试。'],
      ['CHARACTER_OFFLINE', '当前未连接；远端角色操作不可用，但仍可保存本地草稿。'],
      ['CHARACTER_VALIDATION', '角色校验未通过，请按下方问题修正后再保存。']
    ]
    for (const [backendCode, expected] of cases) {
      expect(characterErrorMessage(err({ code: 'BACKEND_REJECTED', backendCode }), FALLBACK)).toBe(expected)
    }
  })
})
