// src/renderer/src/layout/effective-layout.ts
// 阶段 3 G1（spec §4.2，决策 D2/D3）：有效布局 = 纯函数推导，无 DOM、无副作用、可单测。
// 保护（自动折叠/自动关闭）不写回持久偏好（D2），只经 autoCollapsed*/autoClosed* 标记；
// dropped* 标记由 store 依它同步清除会话期 override（Task 3 实现步骤 0 兜底）。
import type { LayoutConstants } from './constants'

export interface LayoutPrefs {
  conversationCollapsed: boolean // 用户偏好（持久化），默认 false
  live2dVisible: boolean         // 用户偏好（持久化），默认 true（D5）
  live2dWidth: number            // 用户偏好（持久化），默认 340，读入时 clamp [300,420]
}

export interface LayoutOverrides {
  explicitOpenConversation: boolean // 会话期显式打开标记（D3），不持久化
  explicitOpenLive2d: boolean
}

export interface EffectiveLayout {
  navWidth: number
  conversationWidth: number       // 260 或 0
  chatWidth: number               // 剩余宽度，永远 ≥ 0
  live2dWidth: number             // 有效栏宽，关闭时为 0
  conversationShown: boolean
  live2dShown: boolean
  autoCollapsedConversation: boolean // 本次因保护自动折叠
  autoClosedLive2d: boolean          // 本次因保护自动关闭
  droppedConversationOverride: boolean // 双 override 兜底回退会话栏 override（P1-1）
  droppedLive2dOverride: boolean       // 双 override 兜底回退 Live2D override
}

export function clampLive2dWidth(w: number, constants: LayoutConstants): number {
  return Math.min(constants.LIVE_MAX, Math.max(constants.LIVE_MIN, Math.round(w)))
}

export function computeEffectiveLayout(
  viewportWidth: number,
  prefs: LayoutPrefs,
  overrides: LayoutOverrides,
  constants: LayoutConstants
): EffectiveLayout {
  const { NAV, CONV, CHAT_MIN } = constants
  const liveDesired = prefs.live2dVisible ? clampLive2dWidth(prefs.live2dWidth, constants) : 0
  const nav = NAV

  // 0) override 生效性兜底（P1-1）：override 只在「当前宽度能同时容纳对应栏」时生效，
  //    否则按优先序回退——先回退会话栏 override（保留 Live2D），仍不够再回退 Live2D override。
  //    回退掉的 override 本轮推导中视为未置位，并经 dropped* 字段通知 store 同步清除会话期标记。
  let effConvOverride = overrides.explicitOpenConversation
  let effLiveOverride = overrides.explicitOpenLive2d
  let droppedConvOverride = false
  let droppedLiveOverride = false
  if (effConvOverride && effLiveOverride && viewportWidth < NAV + CONV + liveDesired) {
    // 双 override 并存但宽度不足：优先保留 Live2D override
    if (viewportWidth >= NAV + liveDesired) {
      effConvOverride = false; droppedConvOverride = true
    } else {
      // 连 Live2D 单栏都装不下（W < NAV + liveDesired）→ 全部回退
      effConvOverride = false; effLiveOverride = false
      droppedConvOverride = true; droppedLiveOverride = true
    }
  } else {
    // 单 override 各自仍需能放下：会话栏需 W ≥ NAV+CONV；Live2D 需 W ≥ NAV+liveDesired
    if (effConvOverride && viewportWidth < NAV + CONV) { effConvOverride = false; droppedConvOverride = true }
    if (effLiveOverride && viewportWidth < NAV + liveDesired) { effLiveOverride = false; droppedLiveOverride = true }
  }

  // 1) 目标布局（偏好）
  let conv = prefs.conversationCollapsed ? 0 : CONV
  let live = liveDesired
  let autoCollapsed = false
  let autoClosed = false
  let chat = viewportWidth - nav - conv - live

  // 2) 保护第 1 步：先自动折叠会话列表保护聊天区（有效 override 存在时跳过，D3）
  if (chat < CHAT_MIN && conv > 0 && !effConvOverride) {
    conv = 0; autoCollapsed = true
    chat = viewportWidth - nav - live
  }
  // 3) 保护第 2 步：仍不够则自动关闭 Live2D（有效 override 存在时跳过，D3）
  if (chat < CHAT_MIN && live > 0 && !effLiveOverride) {
    live = 0; autoClosed = true
    chat = viewportWidth - nav - conv
  }
  return {
    navWidth: nav, conversationWidth: conv, live2dWidth: live, chatWidth: chat,
    conversationShown: conv > 0, live2dShown: live > 0,
    autoCollapsedConversation: autoCollapsed, autoClosedLive2d: autoClosed,
    droppedConversationOverride: droppedConvOverride, droppedLive2dOverride: droppedLiveOverride
  }
}
