// tests/unit/layout-constants.spec.ts
// Task 1:布局常量（spec §4.1 决策 D1）——区宽/保护阈值单一事实来源，锁定设计数值。
// M-23（2026-09-12）：删除 BREAKPOINTS 四档断言——它只断言死常量自身的数值，制造"响应式分层存在"的
// 假信心（常量无任何生产引用的注释见 src/renderer/src/layout/constants.ts）。窄窗媒体查询的回归门禁
// 见 tests/unit/layout-breakpoints.spec.ts；MIN_WINDOW_WIDTH 是真实不变量，断言保留。
import { describe, expect, it } from 'vitest'
import {
  CHAT_MIN_WIDTH, CONVERSATION_WIDTH, LAYOUT_CONSTANTS,
  LIVE2D_DEFAULT_WIDTH, LIVE2D_MAX_WIDTH, LIVE2D_MIN_WIDTH,
  MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, NAV_WIDTH
} from '../../src/renderer/src/layout/constants'

describe('layout/constants（D1 单一事实来源）', () => {
  it('区宽/保护阈值与 spec §4.1 锁定值一致', () => {
    expect(NAV_WIDTH).toBe(60)
    expect(CONVERSATION_WIDTH).toBe(260)
    expect(LIVE2D_DEFAULT_WIDTH).toBe(340)
    expect(LIVE2D_MIN_WIDTH).toBe(300)
    expect(LIVE2D_MAX_WIDTH).toBe(420)
    expect(CHAT_MIN_WIDTH).toBe(500)
    expect(MIN_WINDOW_WIDTH).toBe(1100)
    expect(MIN_WINDOW_HEIGHT).toBe(700)
  })
  it('LAYOUT_CONSTANTS 与常量一致（computeEffectiveLayout 使用）', () => {
    expect(LAYOUT_CONSTANTS.NAV).toBe(60)
    expect(LAYOUT_CONSTANTS.CONV).toBe(260)
    expect(LAYOUT_CONSTANTS.CHAT_MIN).toBe(500)
    expect(LAYOUT_CONSTANTS.LIVE_MIN).toBe(300)
    expect(LAYOUT_CONSTANTS.LIVE_MAX).toBe(420)
  })
})
