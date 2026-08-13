// tests/unit/effective-layout.spec.ts
// Task 2-4:computeEffectiveLayout（spec §4.2）+ gridTemplateFor（spec §4.6 决策 D10，Task 4 追加导入）。
// 纯函数、无 DOM；常数用 LAYOUT_CONSTANTS。
import { describe, expect, it } from 'vitest'
import {
  CHAT_MIN_WIDTH, CONVERSATION_WIDTH, LAYOUT_CONSTANTS, LIVE2D_MAX_WIDTH, LIVE2D_MIN_WIDTH, NAV_WIDTH
} from '../../src/renderer/src/layout/constants'
import {
  computeEffectiveLayout, gridTemplateFor, type LayoutOverrides, type LayoutPrefs
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

describe('computeEffectiveLayout 会话期 override（D3，spec §4.3 行为表）', () => {
  it('W=1100 显式打开会话栏（conv override）→ 跳过保护第1步、自动关闭 Live2D、聊天 780（行为表行2）', () => {
    const e = computeEffectiveLayout(1100, prefs(), overrides({ explicitOpenConversation: true }), C)
    expect(e.conversationShown).toBe(true)
    expect(e.live2dShown).toBe(false)
    expect(e.chatWidth).toBe(780)
    expect(e.autoCollapsedConversation).toBe(false)
    expect(e.autoClosedLive2d).toBe(true)
    expect(e.droppedConversationOverride).toBe(false)
    expect(e.droppedLive2dOverride).toBe(false)
  })
  it('W=1100 双 override 并存（W≥660）→ 聊天 440、用户显式接受 <500、不为负（行为表行3）', () => {
    const e = computeEffectiveLayout(1100, prefs(), overrides({ explicitOpenConversation: true, explicitOpenLive2d: true }), C)
    expect(e.conversationShown).toBe(true)
    expect(e.live2dShown).toBe(true)
    expect(e.chatWidth).toBe(440)
    expect(e.autoCollapsedConversation).toBe(false)
    expect(e.autoClosedLive2d).toBe(false)
    expect(e.droppedConversationOverride).toBe(false)
    expect(e.droppedLive2dOverride).toBe(false)
  })
  it('W=640 双 override → 兜底回退会话栏 override（保留 Live2D）、聊天 240、droppedConversationOverride=true（P1-1，行为表行5）', () => {
    const e = computeEffectiveLayout(640, prefs(), overrides({ explicitOpenConversation: true, explicitOpenLive2d: true }), C)
    expect(e.droppedConversationOverride).toBe(true)
    expect(e.droppedLive2dOverride).toBe(false)
    expect(e.conversationShown).toBe(false)
    expect(e.live2dShown).toBe(true)
    expect(e.chatWidth).toBe(240)
    expect(e.autoCollapsedConversation).toBe(true)
  })
  it('W=350 Live2D override → 单 override 兜底回退、droppedLive2dOverride=true、聊天 290≥260（行为表行6）', () => {
    const e = computeEffectiveLayout(350, prefs(), overrides({ explicitOpenLive2d: true }), C)
    expect(e.droppedLive2dOverride).toBe(true)
    expect(e.droppedConversationOverride).toBe(false)
    expect(e.live2dShown).toBe(false)
    expect(e.chatWidth).toBe(290)
    expect(e.autoClosedLive2d).toBe(true)
  })
  it('W=640 单会话栏 override（无 Live2D override）→ 生效、聊天 320（接受 <500，不为负）', () => {
    const e = computeEffectiveLayout(640, prefs(), overrides({ explicitOpenConversation: true }), C)
    expect(e.droppedConversationOverride).toBe(false)
    expect(e.conversationShown).toBe(true)
    expect(e.live2dShown).toBe(false)
    expect(e.chatWidth).toBe(320)
    expect(e.autoClosedLive2d).toBe(true)
  })
  it('W=300 会话栏 override（W<NAV+CONV=320）→ 回退、droppedConversationOverride=true、聊天 240', () => {
    const e = computeEffectiveLayout(300, prefs(), overrides({ explicitOpenConversation: true }), C)
    expect(e.droppedConversationOverride).toBe(true)
    expect(e.conversationShown).toBe(false)
    expect(e.live2dShown).toBe(false)
    expect(e.chatWidth).toBe(240)
  })
})

describe('computeEffectiveLayout 宽度扫描不变式（W=320..1600 步进10 × 偏好 × override 全组合，spec §4.11/§4.2 不变式）', () => {
  const prefsVariants: LayoutPrefs[] = [
    { conversationCollapsed: false, live2dVisible: true, live2dWidth: 340 },
    { conversationCollapsed: true, live2dVisible: true, live2dWidth: 340 },
    { conversationCollapsed: false, live2dVisible: false, live2dWidth: 340 },
    { conversationCollapsed: false, live2dVisible: true, live2dWidth: 420 }
  ]
  const overrideVariants: LayoutOverrides[] = [
    { explicitOpenConversation: false, explicitOpenLive2d: false },
    { explicitOpenConversation: true, explicitOpenLive2d: false },
    { explicitOpenConversation: false, explicitOpenLive2d: true },
    { explicitOpenConversation: true, explicitOpenLive2d: true }
  ]
  for (const p of prefsVariants) {
    for (const o of overrideVariants) {
      it(`扫描:prefs=${JSON.stringify(p)} override=${JSON.stringify(o)}`, () => {
        for (let W = 320; W <= 1600; W += 10) {
          const e = computeEffectiveLayout(W, p, o, C)
          const liveDesired = p.live2dVisible ? Math.min(LIVE2D_MAX_WIDTH, Math.max(LIVE2D_MIN_WIDTH, p.live2dWidth)) : 0
          const convOverrideEff = o.explicitOpenConversation && !e.droppedConversationOverride
          const liveOverrideEff = o.explicitOpenLive2d && !e.droppedLive2dOverride
          // 网格恒占满；四宽均 ≥ 0；chat ≥ 0 恒成立（spec §4.2 不变式）
          expect(e.navWidth + e.conversationWidth + e.live2dWidth + e.chatWidth).toBe(W)
          expect(e.navWidth).toBeGreaterThanOrEqual(0)
          expect(e.conversationWidth).toBeGreaterThanOrEqual(0)
          expect(e.live2dWidth).toBeGreaterThanOrEqual(0)
          expect(e.chatWidth).toBeGreaterThanOrEqual(0)
          // shown ⟺ width > 0
          expect(e.conversationShown).toBe(e.conversationWidth > 0)
          expect(e.live2dShown).toBe(e.live2dWidth > 0)
          // dropped ⟹ 该 override 确实被置位
          if (e.droppedConversationOverride) expect(o.explicitOpenConversation).toBe(true)
          if (e.droppedLive2dOverride) expect(o.explicitOpenLive2d).toBe(true)
          // 双 override 并存 ⟺ W ≥ NAV+CONV+liveDesired；不满足时至少回退一个；W<NAV+liveDesired 时全回退
          if (o.explicitOpenConversation && o.explicitOpenLive2d) {
            if (W >= NAV_WIDTH + CONVERSATION_WIDTH + liveDesired) {
              expect(e.droppedConversationOverride).toBe(false)
              expect(e.droppedLive2dOverride).toBe(false)
            } else {
              expect(e.droppedConversationOverride || e.droppedLive2dOverride).toBe(true)
              if (W < NAV_WIDTH + liveDesired) {
                expect(e.droppedConversationOverride).toBe(true)
                expect(e.droppedLive2dOverride).toBe(true)
              }
            }
          }
          // 可满足（W ≥ NAV+CHAT_MIN=560）且无有效 override 阻碍保护 → chat ≥ CHAT_MIN
          if (W >= NAV_WIDTH + CHAT_MIN_WIDTH && !convOverrideEff && !liveOverrideEff) {
            expect(e.chatWidth).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH)
          }
          // autoCollapsed ⟹ 偏好未折叠 + 无有效 conv override；autoClosed 同理
          if (e.autoCollapsedConversation) {
            expect(p.conversationCollapsed).toBe(false)
            expect(convOverrideEff).toBe(false)
          }
          if (e.autoClosedLive2d) {
            expect(p.live2dVisible).toBe(true)
            expect(liveOverrideEff).toBe(false)
          }
          // 保护不多触发：偏好全布局已可容纳 → 两个 auto 标记必须 false
          const convDesired = p.conversationCollapsed ? 0 : CONVERSATION_WIDTH
          if (W - NAV_WIDTH - convDesired - liveDesired >= CHAT_MIN_WIDTH) {
            expect(e.autoCollapsedConversation).toBe(false)
            expect(e.autoClosedLive2d).toBe(false)
          }
        }
      })
    }
  }
})

describe('gridTemplateFor（D10：grid-template-areas 按有效布局切换，spec §4.6）', () => {
  it('会话栏 + Live2D 均显（W=1160 默认）', () => {
    const g = gridTemplateFor(computeEffectiveLayout(1160, prefs(), overrides(), C))
    expect(g.gridTemplateColumns).toBe('60px 260px minmax(0, 1fr) 340px')
    expect(g.gridTemplateAreas).toBe('"title title title title" "nav conv chat live"')
  })
  it('仅会话栏（W=1200、live2dVisible=false）', () => {
    const g = gridTemplateFor(computeEffectiveLayout(1200, prefs({ live2dVisible: false }), overrides(), C))
    expect(g.gridTemplateColumns).toBe('60px 260px minmax(0, 1fr)')
    expect(g.gridTemplateAreas).toBe('"title title title" "nav conv chat"')
  })
  it('仅 Live2D（W=1100 默认：会话栏被自动折叠）', () => {
    const g = gridTemplateFor(computeEffectiveLayout(1100, prefs(), overrides(), C))
    expect(g.gridTemplateColumns).toBe('60px minmax(0, 1fr) 340px')
    expect(g.gridTemplateAreas).toBe('"title title title" "nav chat live"')
  })
  it('均隐藏（W=320 防御档）', () => {
    const g = gridTemplateFor(computeEffectiveLayout(320, prefs(), overrides(), C))
    expect(g.gridTemplateColumns).toBe('60px minmax(0, 1fr)')
    expect(g.gridTemplateAreas).toBe('"title title" "nav chat"')
  })
  it('live2dWidth=420 时列宽用有效栏宽（W=1240、宽度 420 全四区）', () => {
    const g = gridTemplateFor(computeEffectiveLayout(1240, prefs({ live2dWidth: 420 }), overrides(), C))
    expect(g.gridTemplateColumns).toBe('60px 260px minmax(0, 1fr) 420px')
  })
  it('列数 = areas 每行列数（一致性）', () => {
    for (const w of [320, 520, 736, 900, 1100, 1200, 1240, 1600]) {
      const g = gridTemplateFor(computeEffectiveLayout(w, prefs(), overrides(), C))
      // 列数统计对括号内空格免疫：minmax(0, 1fr) 内的空格不参与 split（否则 60px 260px minmax(0, 1fr) 340px 会被拆成 5 token 而非 4 列）
      const nCols = g.gridTemplateColumns.replace(/\([^)]*\)/g, '()').split(' ').length
      for (const row of g.gridTemplateAreas.match(/"([^"]*)"/g)!) {
        expect(row.replace(/"/g, '').trim().split(/\s+/).length).toBe(nCols)
      }
    }
  })
})
