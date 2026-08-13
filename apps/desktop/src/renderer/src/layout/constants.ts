// src/renderer/src/layout/constants.ts
// 阶段 3 G1（spec §4.1，决策 D1）：区宽/断点/保护阈值——布局单一事实来源。
// App.vue 不再硬编码列宽；CSS 如需引用区宽经 :style 内联或 CSS 变量注入，不复制数值。
export const TITLEBAR_HEIGHT = 36
export const NAV_WIDTH = 60
export const CONVERSATION_WIDTH = 260
export const LIVE2D_DEFAULT_WIDTH = 340      // PRD §6.1「默认 340」
export const LIVE2D_MIN_WIDTH = 300          // PRD §6.1「300～420 px」
export const LIVE2D_MAX_WIDTH = 420
export const CHAT_MIN_WIDTH = 500            // doc 03 §3.1 聊天区最小 500
export const MIN_WINDOW_WIDTH = 1100          // 决策 D9
export const MIN_WINDOW_HEIGHT = 700          // 决策 D9
export const BREAKPOINTS = { wide: 1200, compact: 736, narrow: 520, extreme: 320 } as const

/** computeEffectiveLayout 使用的常数集合（spec §4.2 算法解构 {NAV, CONV, CHAT_MIN, LIVE_MIN, LIVE_MAX}） */
export interface LayoutConstants {
  NAV: number
  CONV: number
  CHAT_MIN: number
  LIVE_MIN: number
  LIVE_MAX: number
}

export const LAYOUT_CONSTANTS: LayoutConstants = {
  NAV: NAV_WIDTH,
  CONV: CONVERSATION_WIDTH,
  CHAT_MIN: CHAT_MIN_WIDTH,
  LIVE_MIN: LIVE2D_MIN_WIDTH,
  LIVE_MAX: LIVE2D_MAX_WIDTH
}
