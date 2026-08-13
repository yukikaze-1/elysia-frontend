// tests/unit/effective-layout.spec.ts
// Task 2-4:computeEffectiveLayout（spec §4.2）+ gridTemplateFor（spec §4.6 决策 D10，Task 4 追加导入）。
// 纯函数、无 DOM；常数用 LAYOUT_CONSTANTS。
import { describe, expect, it } from 'vitest'
import {
  CHAT_MIN_WIDTH, CONVERSATION_WIDTH, LAYOUT_CONSTANTS, LIVE2D_MAX_WIDTH, LIVE2D_MIN_WIDTH, NAV_WIDTH
} from '../../src/renderer/src/layout/constants'
import {
  computeEffectiveLayout, type LayoutOverrides, type LayoutPrefs
} from '../../src/renderer/src/layout/effective-layout'

const C = LAYOUT_CONSTANTS
const prefs = (p: Partial<LayoutPrefs> = {}): LayoutPrefs => ({ conversationCollapsed: false, live2dVisible: true, live2dWidth: 340, ...p })
const overrides = (o: Partial<LayoutOverrides> = {}): LayoutOverrides => ({ explicitOpenConversation: false, explicitOpenLive2d: false, ...o })

describe('computeEffectiveLayout 偏好与保护（无 override，spec §4.2 步骤1-3）', () => {
  it('W=1160 默认340 → 全四区、聊天 500、无保护触发（全四区阈值 NAV+CONV+340+CHAT_MIN=1160）', () => {
    const e = computeEffectiveLayout(1160, prefs(), overrides(), C)
    expect(e.conversationShown).toBe(true)
    expect(e.live2dShown).toBe(true)
    expect(e.chatWidth).toBe(500)
    expect(e.navWidth).toBe(60)
    expect(e.conversationWidth).toBe(260)
    expect(e.live2dWidth).toBe(340)
    expect(e.autoCollapsedConversation).toBe(false)
    expect(e.autoClosedLive2d).toBe(false)
    expect(e.droppedConversationOverride).toBe(false)
    expect(e.droppedLive2dOverride).toBe(false)
  })
  it('W=1200、live2dWidth=420 → 全四区阈值升到 1240，自动折叠会话栏、聊天 720（P2-1：不再断言 1200 必全四区）', () => {
    const e = computeEffectiveLayout(1200, prefs({ live2dWidth: 420 }), overrides(), C)
    expect(e.conversationShown).toBe(false)
    expect(e.live2dShown).toBe(true)
    expect(e.chatWidth).toBe(720)
    expect(e.autoCollapsedConversation).toBe(true)
    expect(e.autoClosedLive2d).toBe(false)
  })
  it('W=1100 默认 → 保护第1步自动折叠会话栏、聊天 700、Live2D 显示（spec §4.3 行为表行1）', () => {
    const e = computeEffectiveLayout(1100, prefs(), overrides(), C)
    expect(e.conversationShown).toBe(false)
    expect(e.live2dShown).toBe(true)
    expect(e.chatWidth).toBe(700)
    expect(e.autoCollapsedConversation).toBe(true)
    expect(e.autoClosedLive2d).toBe(false)
  })
  it('W=320 防御档 → 两栏均关闭、聊天 260（=W-NAV≥0，不溢出）', () => {
    const e = computeEffectiveLayout(320, prefs(), overrides(), C)
    expect(e.conversationShown).toBe(false)
    expect(e.live2dShown).toBe(false)
    expect(e.chatWidth).toBe(260)
  })
  it('偏好折叠会话栏（collapsed=true）→ 宽窗也不显示会话栏', () => {
    const e = computeEffectiveLayout(1200, prefs({ conversationCollapsed: true }), overrides(), C)
    expect(e.conversationShown).toBe(false)
    expect(e.live2dShown).toBe(true)
    expect(e.chatWidth).toBe(1200 - 60 - 340)
    expect(e.autoCollapsedConversation).toBe(false)
  })
  it('偏好隐藏 Live2D（live2dVisible=false，D5）→ 宽窗不显示 Live2D、聊天回宽、无保护', () => {
    const e = computeEffectiveLayout(1200, prefs({ live2dVisible: false }), overrides(), C)
    expect(e.live2dShown).toBe(false)
    expect(e.conversationShown).toBe(true)
    expect(e.chatWidth).toBe(1200 - 60 - 260)
    expect(e.autoCollapsedConversation).toBe(false)
  })
  it('W=1100、live2dVisible=false → 会话栏显示、聊天 780、无保护', () => {
    const e = computeEffectiveLayout(1100, prefs({ live2dVisible: false }), overrides(), C)
    expect(e.conversationShown).toBe(true)
    expect(e.live2dShown).toBe(false)
    expect(e.chatWidth).toBe(780)
    expect(e.autoCollapsedConversation).toBe(false)
  })
  it('偏好宽度越界被 clamp [300,420]', () => {
    expect(computeEffectiveLayout(1200, prefs({ live2dWidth: 999 }), overrides(), C).live2dWidth).toBe(420)
    expect(computeEffectiveLayout(1200, prefs({ live2dWidth: 100 }), overrides(), C).live2dWidth).toBe(300)
  })
})
