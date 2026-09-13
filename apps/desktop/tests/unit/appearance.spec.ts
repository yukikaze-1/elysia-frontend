// tests/unit/appearance.spec.ts
// 「外观」设置的第一项：全局字体缩放（2026-09-13，doc 03 §12.4 / doc 11 §7.2）。
// 纯函数 + 注入 DOM 面 ⇒ 真值表可以直接断言，不把语义藏在 DOM 副作用里（与 reduce-motion 同款）。
import { describe, expect, it, vi } from 'vitest'
import {
  applyFontScale,
  clampFontScale,
  fontScaleToRatio,
  FONT_SCALE_DEFAULT,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FONT_SCALE_STEP,
  USER_FONT_SCALE_VAR
} from '../../src/renderer/src/utils/appearance'

describe('clampFontScale：收窄到 [90,130] 并取整', () => {
  it('真值表：区间内取整、越界夹取、非有限数回默认', () => {
    expect(clampFontScale(100)).toBe(100)
    expect(clampFontScale(105)).toBe(105)
    expect(clampFontScale(FONT_SCALE_MIN)).toBe(90)
    expect(clampFontScale(FONT_SCALE_MAX)).toBe(130)
    expect(clampFontScale(89)).toBe(90)         // 越下界
    expect(clampFontScale(131)).toBe(130)       // 越上界
    expect(clampFontScale(1e9)).toBe(130)
    expect(clampFontScale(-40)).toBe(90)
    expect(clampFontScale(104.6)).toBe(105)     // 取整（滑杆可能给小数）
    expect(clampFontScale(Number.NaN)).toBe(FONT_SCALE_DEFAULT)
    expect(clampFontScale(Number.POSITIVE_INFINITY)).toBe(FONT_SCALE_DEFAULT)
    expect(clampFontScale(Number.NEGATIVE_INFINITY)).toBe(FONT_SCALE_DEFAULT)
  })

  it('退化哨兵：成功取值不会是 NaN（NaN 会写进 CSS 变量，被浏览器静默丢弃 ⇒ 字号"没反应"）', () => {
    for (const v of [Number.NaN, 0, -0, 1e308]) {
      expect(Number.isFinite(clampFontScale(v))).toBe(true)
    }
  })
})

describe('fontScaleToRatio：百分比 → CSS 乘数', () => {
  it('默认与边界', () => {
    expect(fontScaleToRatio(100)).toBe('1')
    expect(fontScaleToRatio(90)).toBe('0.9')
    expect(fontScaleToRatio(130)).toBe('1.3')
  })

  it('不产生浮点尾巴（130/100 = 1.3 而非 1.2999999999999998）', () => {
    for (let p = FONT_SCALE_MIN; p <= FONT_SCALE_MAX; p += FONT_SCALE_STEP) {
      expect(fontScaleToRatio(p)).not.toMatch(/\d{5,}/)
    }
  })

  it('越界值先夹取再换算（不产生 0.01 这种把界面缩没的乘数）', () => {
    expect(fontScaleToRatio(1)).toBe('0.9')
    expect(fontScaleToRatio(100000)).toBe('1.3')
  })
})

describe('applyFontScale：写到根节点内联样式', () => {
  it('设置 --cy-user-font-scale，并返回实际生效的乘数', () => {
    const setProperty = vi.fn()
    const root = { style: { setProperty } }
    expect(applyFontScale(root, 115)).toBe('1.15')
    expect(setProperty).toHaveBeenCalledWith(USER_FONT_SCALE_VAR, '1.15')
  })

  it('越界/非法输入写的是夹取后的值（不会把 NaN 写进 CSS）', () => {
    const setProperty = vi.fn()
    const root = { style: { setProperty } }
    applyFontScale(root, 999)
    applyFontScale(root, Number.NaN)
    expect(setProperty).toHaveBeenNthCalledWith(1, USER_FONT_SCALE_VAR, '1.3')
    expect(setProperty).toHaveBeenNthCalledWith(2, USER_FONT_SCALE_VAR, '1')
  })
})
