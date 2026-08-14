// tests/unit/ime-guard.spec.ts
// Task 3:IME 组合守卫纯函数（spec §4.7，D14 硬化②）——isComposing / keyCode 229 / 正常 Enter 三分支。
// env=node：守卫只读事件字段，可传普通对象 cast KeyboardEvent。
import { describe, expect, it } from 'vitest'
import { isCompositionEnter } from '../../src/shared/domain/ime-guard'

describe('isCompositionEnter（IME 组词确认不触发发送/搜索）', () => {
  it('isComposing true（中文输入法组词中）→ true', () => {
    expect(isCompositionEnter({ isComposing: true, keyCode: 13 } as KeyboardEvent)).toBe(true)
  })
  it('keyCode 229（legacy IME 标记）→ true', () => {
    expect(isCompositionEnter({ isComposing: false, keyCode: 229 } as KeyboardEvent)).toBe(true)
  })
  it('正常 Enter（非组词）→ false', () => {
    expect(isCompositionEnter({ isComposing: false, keyCode: 13 } as KeyboardEvent)).toBe(false)
  })
})
