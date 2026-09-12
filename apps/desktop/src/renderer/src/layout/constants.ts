// src/renderer/src/layout/constants.ts
// 阶段 3 G1（spec §4.1，决策 D1）：区宽/断点/保护阈值——布局单一事实来源。
// App.vue 不再硬编码列宽；CSS 如需引用区宽经 :style 内联或 CSS 变量注入，不复制数值。
// UII-QQ 设置页批次：应用内标题栏移除（原生系统标题栏承担），TITLEBAR_HEIGHT 删除。
export const NAV_WIDTH = 60
export const CONVERSATION_WIDTH = 260
export const LIVE2D_DEFAULT_WIDTH = 340      // PRD §6.1「默认 340」
export const LIVE2D_MIN_WIDTH = 300          // PRD §6.1「300～420 px」
export const LIVE2D_MAX_WIDTH = 420
export const CHAT_MIN_WIDTH = 500            // doc 03 §3.1 聊天区最小 500
export const MIN_WINDOW_WIDTH = 1100          // 决策 D9
export const MIN_WINDOW_HEIGHT = 700          // 决策 D9

/*
 * 响应式分层现状（2026-09-12 记录，替代已删除的 BREAKPOINTS = { wide: 1200, compact: 736, narrow: 520, extreme: 320 }）：
 *
 * (a) 本应用是**固定布局**：窗口硬最小宽度 1100px（本文件 MIN_WINDOW_WIDTH，执行点
 *     src/main/windows/main-window.ts 的 minWidth），因此 renderer 视口永远不会窄于约 1084px。
 * (b) **窄窗响应式分层并未实现**——这是产品缺口（product gap），不是遗漏（oversight）。
 *     doc 03 §3.1 曾把 1200/736/520/320 四档断点记为"已定案"，但代码中从未有生效的分层；
 *     请勿把本注释或任何残留文档当作"响应式已可用"的依据。
 * (c) M-23 批次删除了 10 处永不匹配的 @media (max-width: 560/680/720/760px) 块，正是因为它们
 *     对外宣告了一份并不存在的能力（`BREAKPOINTS` 也只被自身定义与测试断言引用，构成假信心）。
 *     重新引入任何 max-width < MIN_WINDOW_WIDTH 的媒体查询前，先实现真正的窄窗分层。
 * 回归门禁：tests/unit/layout-breakpoints.spec.ts（按 MIN_WINDOW_WIDTH 实值递归扫描，禁止死媒体查询）。
 */

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
