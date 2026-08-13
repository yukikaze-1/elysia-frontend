# 阶段 3 G1：四区布局与响应式设计 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 App.vue 硬编码四区网格（`58px 174px minmax(292px,1fr) 208px`）升级为可折叠、可调整、响应式、有布局记忆的主布局：会话栏 260 可折叠、Live2D 右栏 340 可拖拽调整（[300,420]）且默认显示、1200/736/520/320 四档断点、窄窗保护（先折叠会话栏、仍不够自动关闭 Live2D）、布局记忆（Renderer localStorage）、窗口最小 1100×700、两个开关键盘可达。

**Architecture:** 新增 `apps/desktop/src/renderer/src/layout/` 纯逻辑层（`constants.ts` 区宽单一事实来源 / `effective-layout.ts` 纯函数有效布局推导 + `gridTemplateFor` / `layout-storage.ts` localStorage 存取，可注入 storage 单测）+ `stores/layout.store.ts`（Pinia setup store）。有效布局由 `computeEffectiveLayout(viewportWidth, prefs, overrides, constants)` 纯函数推导（保护不写回持久偏好 D2，会话期 override D3，双 override 兜底 P1-1 保证任何 W 下 chat≥0）；`gridTemplateFor(effective)` 返回 `grid-template-columns/areas` 由 App.vue 绑定（D10，杜绝 display:none + auto-placement 错位）。App.vue 挂 ResizeObserver 喂 viewportWidth，store 首帧用 `window.innerWidth` 播种（P2-2）。布局记忆走 Renderer localStorage，key `cyrene.layout.v1`（D6，不新增 IPC）；Main 唯一改动是 `main-window.ts` 最小尺寸 1100×700（D9）。组件改造（NavRail 折叠开关 D7、聊天顶栏角色开关 D7、Live2D 拖拽手柄 D8、聊天头部容器查询窄宽防御 D10）只使用现有 tokens.css token，不新增颜色。

**Tech Stack:** Vue 3 + TypeScript（strict，`tsconfig.web.json` 已启用）+ Pinia（setup store）+ Vitest（node 环境，`vitest.config.mts` 自动纳入 `tests/unit/**/*.spec.ts`）+ electron-vite。**不新增运行时依赖**（无虚拟列表库/无高亮库；只用现有 vue/pinia/marked）。视觉/响应式验收用 Playwright MCP 视口 + mimo-vision MCP（docs/17 用法）。

**Spec:** `docs/superpowers/specs/2026-08-14-phase3-layout-responsive-design.md`（v2.1，已闭环：双 override 兜底/toggle 目标态/localStorage 布局记忆/断点算法/首帧播种/toggleLive2d 清位）。实施者以 spec 为准；本计划每任务引用对应 spec 章节（§4.1~§4.11、§5、§6、§7）与 §4.3 行为表行号。

---

## Global Constraints（subagent 必须遵守，逐条绑定）

1. **TypeScript 严格**：新增/修改文件必须过 `pnpm -F @cyrene/desktop typecheck`（typecheck:web 覆盖 renderer 全部 `src/renderer/src/**`）。
2. **zod 只在 IPC 边界**：G1 不新增 IPC/Preload 面，layout 相关代码一律不用 zod；localStorage 读入用形状手检 + fail-safe（spec §4.9 场景 1）。
3. **不新增运行时依赖**：只用现有 vue/pinia；无虚拟列表库、无高亮库、无状态管理库。
4. **Renderer localStorage 仅存 UI 偏好**：只存 `{version, conversationCollapsed, live2dVisible, live2dWidth}`（key `cyrene.layout.v1`）；override（会话期）、notice、viewportWidth 一律不持久化（spec §4.5）。
5. **设计 token 在 `tokens.css` 单一来源**：组件不新增颜色 token；新控件只用现有 `--cy-pane/--cy-surface/--cy-surface-hover/--cy-muted/--cy-accent/--cy-border/--cy-accent-strong/--cy-danger/--cy-shadow/--cy-accent-text` 等（spec §4.7「界面风格」）。
6. **信任边界**：layout 是 Renderer 纯 UI 状态；Main 只改 `main-window.ts` 最小尺寸两行（D9）。**不新增 IPC/Preload**。
7. **Live2D 必须是布局列，不是覆盖层**：四区恒为 grid 列，禁止为 Live2D 引入任何 `position: fixed/absolute` 覆盖层遮住消息/滚动条/输入区（spec §4.6 禁止项 + §4.9 无覆盖保证）。
8. **保护不写回持久偏好（D2）**：自动折叠/自动关闭只经返回值 `autoCollapsedConversation`/`autoClosedLive2d` 标记；唯一例外是 `dropped*` 标记由 store 依它清会话期 override（spec §4.2 保护/偏好分离语义）。
9. **单测命名与位置**：新测试放 `apps/desktop/tests/unit/`，命名 `<module>.spec.ts`，与现有 47 个 spec 对齐；import 相对路径 `../../src/renderer/src/layout/...`。
10. **TDD 红-绿-提交**：每任务内先写失败测试→跑（FAIL）→最小实现→跑（PASS）→commit；commit 消息 `feat/fix/test/docs(...)`，中文说明（如 `feat(G1 layout): ...`）。
11. **文档编辑保持中文**（docs 集约定）。
12. **门禁**（Task 12 全量复跑）：`typecheck` / `lint`（`--max-warnings=0`）/ `test`（527 现有 + 本组新增）/ `test:integration`（23，预期不回退）/ `build` / `check:contract`（13/13，纯前端布局无 wire 变化）/ `package` + `verify:artifact --smoke`（Main 最小尺寸改动波及打包路径，必须复跑）。
13. **三态状态源**：G1 无真实后端联调对象，本地门禁全绿 + Playwright/vision-MCP 视觉记录后标「已验证」。

---

## 文件结构（新建 / 修改）

**新建（renderer 纯逻辑层）：**
- `apps/desktop/src/renderer/src/layout/constants.ts` —— 区宽/断点/保护阈值单一事实来源（spec §4.1，D1）
- `apps/desktop/src/renderer/src/layout/effective-layout.ts` —— `computeEffectiveLayout` 纯函数 + `clampLive2dWidth` + `gridTemplateFor`（spec §4.2/§4.6，D2/D3/D10）
- `apps/desktop/src/renderer/src/layout/layout-storage.ts` —— localStorage 存取（spec §4.5，D6），可注入 storage
- `apps/desktop/src/renderer/src/stores/layout.store.ts` —— Pinia store（spec §4.5，P1-2/P2-2）

**新建（测试）：**
- `apps/desktop/tests/unit/layout-constants.spec.ts`
- `apps/desktop/tests/unit/effective-layout.spec.ts`
- `apps/desktop/tests/unit/layout-storage.spec.ts`
- `apps/desktop/tests/unit/layout.store.spec.ts`

**修改：**
- `apps/desktop/src/renderer/src/main.ts` —— createPinia 后、mount 前 `hydrate()`
- `apps/desktop/src/renderer/src/App.vue` —— 布局宿主（grid 绑定、v-show、ResizeObserver、toast）
- `apps/desktop/src/renderer/src/components/CyTitleBar.vue` —— `grid-area: title`
- `apps/desktop/src/renderer/src/components/CyNavRail.vue` —— `grid-area: nav` + 会话栏折叠开关
- `apps/desktop/src/renderer/src/components/CyConversationList.vue` —— `grid-area: conv`
- `apps/desktop/src/renderer/src/components/CyChatView.vue` —— 角色开关 + 头部窄宽防御
- `apps/desktop/src/renderer/src/components/CyConnectionPanel.vue` —— 容器查询紧凑规则
- `apps/desktop/src/renderer/src/components/CyLive2DPanel.vue` —— `grid-area: live` + 折叠接线 + 拖拽手柄
- `apps/desktop/src/main/windows/main-window.ts` —— `minWidth: 1100, minHeight: 700`（D9）

**文档（Task 13）：** `docs/06`（§2/§3/§8.1/§8，P1-3 实质修订）、`docs/16`（§6 勾选 + 变更记录）、`docs/03`（§3.1/§3.2 注记）、`docs/13`（item 11 定案登记）、`README.md` / `CLAUDE.md`（三态状态源）。

**范围外（不做）：** Live2D SDK（阶段 5）、窗口 bounds 持久化（Main 窗口组，spec §6 开放项）、消息级窄屏（聊天/媒体组）、全局快捷键 / ESC 关面板 / 拖拽键盘 resize（P1，spec §6）。

---

### Task 1: `layout/constants.ts` —— 区宽/断点/保护阈值单一事实来源（D1）

**Files:**
- Create: `apps/desktop/src/renderer/src/layout/constants.ts`
- Test: `apps/desktop/tests/unit/layout-constants.spec.ts`

**Interfaces:**
- Produces（后续 Task 2-7、10 消费）：
  - `export const TITLEBAR_HEIGHT = 36`
  - `export const NAV_WIDTH = 60`
  - `export const CONVERSATION_WIDTH = 260`
  - `export const LIVE2D_DEFAULT_WIDTH = 340`
  - `export const LIVE2D_MIN_WIDTH = 300`
  - `export const LIVE2D_MAX_WIDTH = 420`
  - `export const CHAT_MIN_WIDTH = 500`
  - `export const MIN_WINDOW_WIDTH = 1100`
  - `export const MIN_WINDOW_HEIGHT = 700`
  - `export const BREAKPOINTS = { wide: 1200, compact: 736, narrow: 520, extreme: 320 } as const`
  - `export interface LayoutConstants { NAV: number; CONV: number; CHAT_MIN: number; LIVE_MIN: number; LIVE_MAX: number }`
  - `export const LAYOUT_CONSTANTS: LayoutConstants`

- [ ] **Step 1: 写失败测试** —— `apps/desktop/tests/unit/layout-constants.spec.ts`

```typescript
// tests/unit/layout-constants.spec.ts
// Task 1:布局常量（spec §4.1 决策 D1）——区宽/断点/保护阈值单一事实来源，锁定设计数值。
import { describe, expect, it } from 'vitest'
import {
  BREAKPOINTS, CHAT_MIN_WIDTH, CONVERSATION_WIDTH, LAYOUT_CONSTANTS,
  LIVE2D_DEFAULT_WIDTH, LIVE2D_MAX_WIDTH, LIVE2D_MIN_WIDTH,
  MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, NAV_WIDTH, TITLEBAR_HEIGHT
} from '../../src/renderer/src/layout/constants'

describe('layout/constants（D1 单一事实来源）', () => {
  it('区宽/保护阈值与 spec §4.1 锁定值一致', () => {
    expect(TITLEBAR_HEIGHT).toBe(36)
    expect(NAV_WIDTH).toBe(60)
    expect(CONVERSATION_WIDTH).toBe(260)
    expect(LIVE2D_DEFAULT_WIDTH).toBe(340)
    expect(LIVE2D_MIN_WIDTH).toBe(300)
    expect(LIVE2D_MAX_WIDTH).toBe(420)
    expect(CHAT_MIN_WIDTH).toBe(500)
    expect(MIN_WINDOW_WIDTH).toBe(1100)
    expect(MIN_WINDOW_HEIGHT).toBe(700)
  })
  it('断点四档锁定（spec §4.4）', () => {
    expect(BREAKPOINTS.wide).toBe(1200)
    expect(BREAKPOINTS.compact).toBe(736)
    expect(BREAKPOINTS.narrow).toBe(520)
    expect(BREAKPOINTS.extreme).toBe(320)
  })
  it('LAYOUT_CONSTANTS 与常量一致（computeEffectiveLayout 使用）', () => {
    expect(LAYOUT_CONSTANTS.NAV).toBe(60)
    expect(LAYOUT_CONSTANTS.CONV).toBe(260)
    expect(LAYOUT_CONSTANTS.CHAT_MIN).toBe(500)
    expect(LAYOUT_CONSTANTS.LIVE_MIN).toBe(300)
    expect(LAYOUT_CONSTANTS.LIVE_MAX).toBe(420)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/layout-constants.spec.ts`
Expected: FAIL，报模块 `../../src/renderer/src/layout/constants` 不存在。

- [ ] **Step 3: 最小实现** —— `apps/desktop/src/renderer/src/layout/constants.ts`

```typescript
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/layout-constants.spec.ts`
Expected: PASS（1 file / 3 tests）。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/layout/constants.ts apps/desktop/tests/unit/layout-constants.spec.ts
git commit -m "feat(G1 layout): 布局常量单一事实来源（D1）"
```

---

### Task 2: `effective-layout.ts` —— 有效布局推导：偏好 + 保护顺序（D2/D4/D5）

> 本任务实现 spec §4.2 算法「步骤 1-3」（目标布局 + 两步保护），override 直接当作有效标记使用（**兜底回退步骤 0 留 Task 3**），`dropped*` 先恒 false。测试只覆盖无 override 路径。

**Files:**
- Create: `apps/desktop/src/renderer/src/layout/effective-layout.ts`
- Test: `apps/desktop/tests/unit/effective-layout.spec.ts`

**Interfaces:**
- Consumes（Task 1）：`LayoutConstants` / `LAYOUT_CONSTANTS`
- Produces（Task 3-7 消费）：
  - `export interface LayoutPrefs { conversationCollapsed: boolean; live2dVisible: boolean; live2dWidth: number }`
  - `export interface LayoutOverrides { explicitOpenConversation: boolean; explicitOpenLive2d: boolean }`
  - `export interface EffectiveLayout { navWidth: number; conversationWidth: number; chatWidth: number; live2dWidth: number; conversationShown: boolean; live2dShown: boolean; autoCollapsedConversation: boolean; autoClosedLive2d: boolean; droppedConversationOverride: boolean; droppedLive2dOverride: boolean }`
  - `export function clampLive2dWidth(w: number, constants: LayoutConstants): number`
  - `export function computeEffectiveLayout(viewportWidth: number, prefs: LayoutPrefs, overrides: LayoutOverrides, constants: LayoutConstants): EffectiveLayout`

- [ ] **Step 1: 写失败测试** —— 追加到 `apps/desktop/tests/unit/effective-layout.spec.ts`（新文件，本任务先写「偏好与保护」describe）

```typescript
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/effective-layout.spec.ts`
Expected: FAIL，模块 `../../src/renderer/src/layout/effective-layout` 不存在。

- [ ] **Step 3: 最小实现** —— `apps/desktop/src/renderer/src/layout/effective-layout.ts`

```typescript
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

  // 步骤 0）override 生效性兜底（P1-1）——Task 3 在此插入；Task 2 直接采纳 override 标记
  const effConvOverride = overrides.explicitOpenConversation
  const effLiveOverride = overrides.explicitOpenLive2d
  const droppedConvOverride = false
  const droppedLiveOverride = false

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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/effective-layout.spec.ts`
Expected: PASS（8 tests）。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/layout/effective-layout.ts apps/desktop/tests/unit/effective-layout.spec.ts
git commit -m "feat(G1 layout): computeEffectiveLayout 偏好与保护推导（D2/D4/D5）"
```

---

### Task 3: `effective-layout.ts` —— 会话期 override 语义 + 双 override 兜底（D3/P1-1）

> 在 Task 2 实现前插入 spec §4.2「步骤 0」：override 只在当前宽度可容纳时生效，否则按优先序回退（先回退会话栏、保留 Live2D；连 Live2D 都装不下则全回退），回退经 `dropped*` 通知 store 清会话期标记。然后补 override 行为表测试与宽度扫描不变式（spec §4.11）。

**Files:**
- Modify: `apps/desktop/src/renderer/src/layout/effective-layout.ts`（步骤 0 插入）
- Test: `apps/desktop/tests/unit/effective-layout.spec.ts`（追加 describe）

**Interfaces:**
- Consumes（Task 2）：`computeEffectiveLayout`（当前无步骤 0 版本）
- Produces：`computeEffectiveLayout` 完整版（含步骤 0 + dropped* 正确赋值）

- [ ] **Step 1: 写失败测试（override 行为表 + 扫描不变式）** —— 追加到 `apps/desktop/tests/unit/effective-layout.spec.ts`

```typescript
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/effective-layout.spec.ts`
Expected: FAIL——override 行为表用例（Task 2 实现无步骤 0，`dropped*` 恒 false，`W=640 双 override` 等用例断言失败）。

- [ ] **Step 3: 实现步骤 0（override 生效性兜底）** —— 替换 `computeEffectiveLayout` 中的步骤 0 注释块

```typescript
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
```

> 并把下方「`const effConvOverride = ...`」两行与「`const droppedConvOverride = false` / `const droppedLiveOverride = false`」两行删除（已被步骤 0 取代），return 中 `droppedConversationOverride: droppedConvOverride, droppedLive2dOverride: droppedLiveOverride` 保持不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/effective-layout.spec.ts`
Expected: PASS（行为表 6 + 扫描 16 + 偏好 8 = 30 tests）。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/layout/effective-layout.ts apps/desktop/tests/unit/effective-layout.spec.ts
git commit -m "feat(G1 layout): 会话期 override 与双 override 兜底（D3/P1-1）+ 宽度扫描不变式"
```

---

### Task 4: `gridTemplateFor` —— grid-template-areas 按有效布局切换（D10）

**Files:**
- Modify: `apps/desktop/src/renderer/src/layout/effective-layout.ts`（追加 `GridTemplate` + `gridTemplateFor`）
- Test: `apps/desktop/tests/unit/effective-layout.spec.ts`（追加 describe）

**Interfaces:**
- Consumes（Task 2/3）：`EffectiveLayout`
- Produces（Task 7 App.vue 消费）：
  - `export interface GridTemplate { gridTemplateColumns: string; gridTemplateAreas: string }`
  - `export function gridTemplateFor(effective: EffectiveLayout): GridTemplate`
  - 四组合输出（spec §4.6 表，注意 `grid-template-areas` 真实 CSS 值**无 `/`**，行间用空格）：
    - 会话栏+Live2D：columns `60px 260px minmax(0, 1fr) 340px`；areas `"title title title title" "nav conv chat live"`
    - 仅会话栏：`60px 260px minmax(0, 1fr)`；`"title title title" "nav conv chat"`
    - 仅 Live2D：`60px minmax(0, 1fr) 340px`；`"title title title" "nav chat live"`
    - 均隐藏：`60px minmax(0, 1fr)`；`"title title" "nav chat"`

- [ ] **Step 1: 写失败测试** —— 追加到 `apps/desktop/tests/unit/effective-layout.spec.ts`

> 先把文件顶部 import 更新为 `import { computeEffectiveLayout, gridTemplateFor, type LayoutOverrides, type LayoutPrefs } from '../../src/renderer/src/layout/effective-layout'`（`gridTemplateFor` 在本任务实现，补进 import；Task 2/3 commit 时不含它，typecheck 不受影响）。

```typescript
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/effective-layout.spec.ts`
Expected: FAIL，`gridTemplateFor` 未定义。

- [ ] **Step 3: 最小实现** —— 追加到 `apps/desktop/src/renderer/src/layout/effective-layout.ts` 末尾

```typescript
export interface GridTemplate {
  gridTemplateColumns: string
  gridTemplateAreas: string
}

/** spec §4.6（决策 D10）：按有效布局生成 grid-template-*；隐藏区不生成对应列，
 *  组件用 v-show（display:none）配合，杜绝「隐藏列占位把聊天排进错误列」。 */
export function gridTemplateFor(effective: EffectiveLayout): GridTemplate {
  const conv = effective.conversationShown ? `${effective.conversationWidth}px` : null
  const live = effective.live2dShown ? `${effective.live2dWidth}px` : null
  const cols = [`${effective.navWidth}px`, ...(conv ? [conv] : []), 'minmax(0, 1fr)', ...(live ? [live] : [])]
  const rowTitle = Array(cols.length).fill('title').join(' ')
  const rowMain = ['nav', ...(conv ? ['conv'] : []), 'chat', ...(live ? ['live'] : [])].join(' ')
  return {
    gridTemplateColumns: cols.join(' '),
    gridTemplateAreas: `"${rowTitle}" "${rowMain}"`
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/effective-layout.spec.ts`
Expected: PASS（30 + 6 = 36 tests）。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/layout/effective-layout.ts apps/desktop/tests/unit/effective-layout.spec.ts
git commit -m "feat(G1 layout): gridTemplateFor 网格切换（D10）"
```

---

### Task 5: `layout-storage.ts` —— 布局记忆 localStorage 存储层（D6）

> key `cyrene.layout.v1`，值 `{version:1, conversationCollapsed, live2dVisible, live2dWidth}`；读 fail-safe（key 缺失/JSON 损坏/version≠1/形状非法 → 默认，宽度 clamp [300,420]）；写失败 `console.warn` 非致命；storage 可注入便于单测（沿用仓库 `setDesktopApi` 模块级 setter 模式）。**override 与 viewportWidth 不持久化。**

**Files:**
- Create: `apps/desktop/src/renderer/src/layout/layout-storage.ts`
- Test: `apps/desktop/tests/unit/layout-storage.spec.ts`

**Interfaces:**
- Consumes（Task 1/2）：`LayoutConstants`、`clampLive2dWidth`、`LayoutPrefs`
- Produces（Task 6 store 消费）：
  - `export const LAYOUT_STORAGE_KEY = 'cyrene.layout.v1'`
  - `export interface LayoutStorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }`
  - `export interface StoredLayoutV1 { version: 1; conversationCollapsed: boolean; live2dVisible: boolean; live2dWidth: number }`
  - `export function readLayout(constants: LayoutConstants): LayoutPrefs`
  - `export function writeLayout(prefs: LayoutPrefs, constants: LayoutConstants): void`
  - `export function setLayoutStorageForTest(storage: LayoutStorageLike | null): void`

- [ ] **Step 1: 写失败测试** —— `apps/desktop/tests/unit/layout-storage.spec.ts`

```typescript
// tests/unit/layout-storage.spec.ts
// Task 5:布局记忆存储层（spec §4.5，决策 D6）——key cyrene.layout.v1、fail-safe、宽度 clamp、可注入 storage。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LAYOUT_CONSTANTS } from '../../src/renderer/src/layout/constants'
import {
  LAYOUT_STORAGE_KEY, readLayout, setLayoutStorageForTest, writeLayout, type LayoutStorageLike
} from '../../src/renderer/src/layout/layout-storage'

const C = LAYOUT_CONSTANTS
interface MockStorage extends LayoutStorageLike { store: Map<string, string> }
let storage: MockStorage

beforeEach(() => {
  storage = {
    store: new Map(),
    getItem: vi.fn((k: string) => storage.store.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => { storage.store.set(k, v) })
  }
  setLayoutStorageForTest(storage)
})
afterEach(() => setLayoutStorageForTest(null))

describe('layout-storage（D6，key cyrene.layout.v1）', () => {
  it('round-trip：writeLayout 后 readLayout 恢复同一偏好（含宽度 clamp）', () => {
    writeLayout({ conversationCollapsed: true, live2dVisible: false, live2dWidth: 380 }, C)
    expect(readLayout(C)).toEqual({ conversationCollapsed: true, live2dVisible: false, live2dWidth: 380 })
  })
  it('写越界宽度落盘前 clamp [300,420]', () => {
    writeLayout({ conversationCollapsed: false, live2dVisible: true, live2dWidth: 999 }, C)
    expect(JSON.parse(storage.store.get(LAYOUT_STORAGE_KEY)!)).toEqual({
      version: 1, conversationCollapsed: false, live2dVisible: true, live2dWidth: 420
    })
  })
  it('key 缺失 → 默认偏好', () => {
    expect(readLayout(C)).toEqual({ conversationCollapsed: false, live2dVisible: true, live2dWidth: 340 })
  })
  it('JSON 损坏 → 默认偏好（不抛错）', () => {
    storage.store.set(LAYOUT_STORAGE_KEY, '{broken')
    expect(() => readLayout(C)).not.toThrow()
    expect(readLayout(C)).toEqual({ conversationCollapsed: false, live2dVisible: true, live2dWidth: 340 })
  })
  it('version ≠ 1 → 默认偏好', () => {
    storage.store.set(LAYOUT_STORAGE_KEY, JSON.stringify({ version: 2, conversationCollapsed: true, live2dVisible: true, live2dWidth: 340 }))
    expect(readLayout(C)).toEqual({ conversationCollapsed: false, live2dVisible: true, live2dWidth: 340 })
  })
  it('字段形状非法 → 默认偏好', () => {
    storage.store.set(LAYOUT_STORAGE_KEY, JSON.stringify({ version: 1, conversationCollapsed: 'yes', live2dVisible: true, live2dWidth: 340 }))
    expect(readLayout(C)).toEqual({ conversationCollapsed: false, live2dVisible: true, live2dWidth: 340 })
  })
  it('宽度越界读入 clamp [300,420]', () => {
    storage.store.set(LAYOUT_STORAGE_KEY, JSON.stringify({ version: 1, conversationCollapsed: false, live2dVisible: true, live2dWidth: 50 }))
    expect(readLayout(C).live2dWidth).toBe(300)
  })
  it('写失败（setItem 抛错）→ 不抛、console.warn 非致命', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    storage.setItem = vi.fn(() => { throw new Error('QuotaExceeded') })
    expect(() => writeLayout({ conversationCollapsed: false, live2dVisible: true, live2dWidth: 340 }, C)).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
  it('读 getItem 抛错 → 默认偏好（不级联）', () => {
    storage.getItem = vi.fn(() => { throw new Error('SecurityError') })
    expect(() => readLayout(C)).not.toThrow()
    expect(readLayout(C)).toEqual({ conversationCollapsed: false, live2dVisible: true, live2dWidth: 340 })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/layout-storage.spec.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 最小实现** —— `apps/desktop/src/renderer/src/layout/layout-storage.ts`

```typescript
// src/renderer/src/layout/layout-storage.ts
// 阶段 3 G1（spec §4.5，决策 D6）：布局记忆持久化 —— Renderer localStorage，key cyrene.layout.v1。
// fail-safe：读失败/版本不符/形状非法 → 默认；写失败 → console.warn 非致命（spec §4.9 场景1/2）。
// override（会话期）与 viewportWidth（运行时）不持久化。storage 可注入（单测，沿用 setDesktopApi 模式）。
import { LIVE2D_DEFAULT_WIDTH, type LayoutConstants } from './constants'
import { clampLive2dWidth, type LayoutPrefs } from './effective-layout'

export const LAYOUT_STORAGE_KEY = 'cyrene.layout.v1'

export interface LayoutStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface StoredLayoutV1 {
  version: 1
  conversationCollapsed: boolean
  live2dVisible: boolean
  live2dWidth: number
}

const DEFAULT_PREFS = (): LayoutPrefs => ({ conversationCollapsed: false, live2dVisible: true, live2dWidth: LIVE2D_DEFAULT_WIDTH })

function isBoolean(v: unknown): v is boolean { return typeof v === 'boolean' }

function parseStored(raw: string | null, constants: LayoutConstants): LayoutPrefs {
  if (raw === null) return DEFAULT_PREFS()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_PREFS()
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PREFS()
  const o = parsed as Record<string, unknown>
  if (o['version'] !== 1) return DEFAULT_PREFS()
  if (!isBoolean(o['conversationCollapsed']) || !isBoolean(o['live2dVisible']) ||
      typeof o['live2dWidth'] !== 'number' || !Number.isFinite(o['live2dWidth'])) {
    return DEFAULT_PREFS()
  }
  return {
    conversationCollapsed: o['conversationCollapsed'],
    live2dVisible: o['live2dVisible'],
    live2dWidth: clampLive2dWidth(o['live2dWidth'], constants)
  }
}

let injectedStorage: LayoutStorageLike | null = null
/** 单测注入（LayoutStorageLike 是完整 localStorage 子集）；传 null 恢复浏览器默认 */
export function setLayoutStorageForTest(storage: LayoutStorageLike | null): void { injectedStorage = storage }

function browserStorage(): LayoutStorageLike | null {
  if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
  return null
}

/** 读入布局偏好；任何失败回默认（fail-safe，不抛错、不级联） */
export function readLayout(constants: LayoutConstants): LayoutPrefs {
  const s = injectedStorage ?? browserStorage()
  if (!s) return DEFAULT_PREFS()
  let raw: string | null = null
  try {
    raw = s.getItem(LAYOUT_STORAGE_KEY)
  } catch {
    raw = null
  }
  return parseStored(raw, constants)
}

/** 落盘布局偏好；写入失败仅 console.warn，内存态继续可用 */
export function writeLayout(prefs: LayoutPrefs, constants: LayoutConstants): void {
  const s = injectedStorage ?? browserStorage()
  if (!s) return
  const payload: StoredLayoutV1 = {
    version: 1,
    conversationCollapsed: prefs.conversationCollapsed,
    live2dVisible: prefs.live2dVisible,
    live2dWidth: clampLive2dWidth(prefs.live2dWidth, constants)
  }
  try {
    s.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(payload))
  } catch (e) {
    console.warn('[layout] 布局偏好写 localStorage 失败（非致命）', e)
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/layout-storage.spec.ts`
Expected: PASS（9 tests）。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/layout/layout-storage.ts apps/desktop/tests/unit/layout-storage.spec.ts
git commit -m "feat(G1 layout): 布局记忆 localStorage 存储层（D6）"
```

---

### Task 6: `stores/layout.store.ts` —— Pinia 布局 store（P1-2 toggle 目标态 + 弹回 toast + P2-2 首帧播种）

> store 持有 `viewportWidth`（首帧 `window.innerWidth` 播种，P2-2）、`prefs`（持久化偏好）、`overrides`（会话期）、`notice`（窄窗弹回提示）、`effective`（computed 派生）。toggle 按「目标态」动作（P1-2）：折叠=写 prefs + 清 override；展开=写 prefs + **按 wouldBe 判据置 override**，置位后复核 `effective` 的 `dropped*` 决定是否清位 + toast。`prefs` 防抖 200ms 落盘（`flush:'sync'` 保证测试确定性）。`hydrate()` 在 main.ts（createPinia 后、mount 前）同步调用。

**Files:**
- Create: `apps/desktop/src/renderer/src/stores/layout.store.ts`
- Test: `apps/desktop/tests/unit/layout.store.spec.ts`

**Interfaces:**
- Consumes（Task 1-5）：`LAYOUT_CONSTANTS`、`LIVE2D_DEFAULT_WIDTH`、`clampLive2dWidth`、`computeEffectiveLayout`、`LayoutOverrides`、`LayoutPrefs`、`readLayout`、`writeLayout`、`setLayoutStorageForTest`
- Produces（Task 7-10 组件消费）：
  - `export const useLayoutStore = defineStore('layout', ...)`
  - State：`viewportWidth: Ref<number>`、`prefs: Ref<LayoutPrefs>`、`overrides: Ref<LayoutOverrides>`、`notice: Ref<string | null>`、`effective: ComputedRef<EffectiveLayout>`
  - Actions：`toggleConversation(): void`、`toggleLive2d(): void`、`setLive2dWidth(w: number): void`、`handleViewportChange(w: number): void`、`hydrate(): void`、`clearNotice(): void`

- [ ] **Step 1: 写失败测试** —— `apps/desktop/tests/unit/layout.store.spec.ts`

```typescript
// tests/unit/layout.store.spec.ts
// Task 6:layoutStore（spec §4.5）——toggle 目标态（P1-2）、弹回 toast（dropped* 复核）、
// handleViewportChange 清 override、首帧 viewportWidth 播种（P2-2）、hydrate、防抖落盘。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { LAYOUT_CONSTANTS } from '../../src/renderer/src/layout/constants'
import { computeEffectiveLayout, gridTemplateFor } from '../../src/renderer/src/layout/effective-layout'
import { LAYOUT_STORAGE_KEY, setLayoutStorageForTest, type LayoutStorageLike } from '../../src/renderer/src/layout/layout-storage'
import { useLayoutStore } from '../../src/renderer/src/stores/layout.store'

interface MockStorage extends LayoutStorageLike { store: Map<string, string> }
let storage: MockStorage

beforeEach(() => {
  setActivePinia(createPinia())
  storage = {
    store: new Map(),
    getItem: vi.fn((k: string) => storage.store.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => { storage.store.set(k, v) })
  }
  setLayoutStorageForTest(storage)
  vi.useFakeTimers()
})
afterEach(() => {
  setLayoutStorageForTest(null)
  vi.useRealTimers()
})

describe('layoutStore', () => {
  it('首帧 viewportWidth 播种 = window.innerWidth（P2-2）；node 无 window 回退 0', () => {
    const original = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: unknown }).window = { innerWidth: 1180 }
    try {
      setActivePinia(createPinia())
      const store = useLayoutStore()
      expect(store.viewportWidth).toBe(1180)
    } finally {
      if (original === undefined) delete (globalThis as { window?: unknown }).window
      else (globalThis as { window?: unknown }).window = original
    }
    setActivePinia(createPinia())
    const store2 = useLayoutStore()
    expect(store2.viewportWidth).toBe(0)
  })

  it('默认偏好：live2dVisible=true（D5）、conversationCollapsed=false、宽度 340', () => {
    const store = useLayoutStore()
    expect(store.prefs).toEqual({ conversationCollapsed: false, live2dVisible: true, live2dWidth: 340 })
    expect(store.overrides).toEqual({ explicitOpenConversation: false, explicitOpenLive2d: false })
  })

  it('hydrate 从 storage 载入（含宽度 clamp）；无存储 → 默认', () => {
    const store = useLayoutStore()
    storage.store.set(LAYOUT_STORAGE_KEY, JSON.stringify({ version: 1, conversationCollapsed: true, live2dVisible: false, live2dWidth: 999 }))
    store.hydrate()
    expect(store.prefs).toEqual({ conversationCollapsed: true, live2dVisible: false, live2dWidth: 420 })
    storage.store.clear()
    store.hydrate()
    expect(store.prefs).toEqual({ conversationCollapsed: false, live2dVisible: true, live2dWidth: 340 })
  })

  it('toggleConversation 折叠目标态（W=1200 宽窗）：写回持久偏好 + 清 override + 防抖落盘', () => {
    const store = useLayoutStore()
    store.handleViewportChange(1200)
    expect(store.effective.conversationShown).toBe(true)
    store.toggleConversation()
    expect(store.prefs.conversationCollapsed).toBe(true)
    expect(store.overrides.explicitOpenConversation).toBe(false)
    expect(store.effective.conversationShown).toBe(false)
    vi.advanceTimersByTime(200)
    expect(JSON.parse(storage.store.get(LAYOUT_STORAGE_KEY)!)).toEqual({
      version: 1, conversationCollapsed: true, live2dVisible: true, live2dWidth: 340
    })
  })

  it('toggleConversation 展开目标态（W=1100 被保护折叠）：置 override（wouldBe 判据）→ 真实有效', () => {
    const store = useLayoutStore()
    store.handleViewportChange(1100)
    expect(store.effective.conversationShown).toBe(false)
    store.toggleConversation()
    expect(store.overrides.explicitOpenConversation).toBe(true)
    expect(store.effective.conversationShown).toBe(true)
    expect(store.effective.live2dShown).toBe(false) // 保护第2步自动关 Live2D
    expect(store.effective.chatWidth).toBe(780)
  })

  it('手动折叠→重开 序列在 1100 下重开真实有效（P1-2，不再翻转矛盾）', () => {
    const store = useLayoutStore()
    store.handleViewportChange(1100)
    store.toggleConversation()            // 显式打开（置 override）
    expect(store.effective.conversationShown).toBe(true)
    store.toggleConversation()            // 手动折叠（写 prefs + 清 override）
    expect(store.effective.conversationShown).toBe(false)
    expect(store.prefs.conversationCollapsed).toBe(true)
    expect(store.overrides.explicitOpenConversation).toBe(false)
    store.toggleConversation()            // 重开（目标态展开 + wouldBe 置 override）
    expect(store.effective.conversationShown).toBe(true)
    expect(store.overrides.explicitOpenConversation).toBe(true)
    expect(store.effective.chatWidth).toBe(780)
  })

  it('窄窗弹回 toast：空间不足展开会话栏（已有 Live2D override、W<NAV+CONV+liveDesired）→ 置位后被兜底回退 + notice', () => {
    const store = useLayoutStore()
    store.handleViewportChange(640)
    store.overrides.explicitOpenLive2d = true
    store.toggleConversation()
    expect(store.overrides.explicitOpenConversation).toBe(false) // 置位后 dropped 复核 → 清掉
    expect(store.notice).toBe('当前窗口过窄，无法同时显示会话列表与角色栏')
    expect(store.effective.conversationShown).toBe(false)
    expect(store.effective.live2dShown).toBe(true)  // Live2D 保留
  })

  it('toggleLive2d 展开时先置的会话栏 override 被双 override 兜底回退 → 同步清位 + notice（评审第二轮重验修复）', () => {
    const store = useLayoutStore()
    store.handleViewportChange(640)
    store.overrides.explicitOpenConversation = true
    store.toggleLive2d()
    expect(store.overrides.explicitOpenConversation).toBe(false)  // 残留 override 不得复活
    expect(store.overrides.explicitOpenLive2d).toBe(true)
    expect(store.notice).toBe('窗口过窄，会话栏暂不可同时显示')
    expect(store.effective.live2dShown).toBe(true)
  })

  it('toggleLive2d 折叠目标态：写回偏好 + 清 override', () => {
    const store = useLayoutStore()
    store.handleViewportChange(1200)
    store.toggleLive2d()
    expect(store.prefs.live2dVisible).toBe(false)
    expect(store.overrides.explicitOpenLive2d).toBe(false)
    expect(store.effective.live2dShown).toBe(false)
  })

  it('handleViewportChange 宽度恢复足够（≥1160）→ 清两个 override（D3 判据）', () => {
    const store = useLayoutStore()
    store.handleViewportChange(1100)
    store.toggleConversation()
    expect(store.overrides.explicitOpenConversation).toBe(true)
    store.handleViewportChange(1200)
    expect(store.overrides.explicitOpenConversation).toBe(false)
    expect(store.overrides.explicitOpenLive2d).toBe(false)
  })

  it('handleViewportChange 同步清位被兜底回退的 override（W=640→350 时 Live2D override 回退）', () => {
    const store = useLayoutStore()
    store.handleViewportChange(640)
    store.overrides.explicitOpenLive2d = true
    expect(store.overrides.explicitOpenLive2d).toBe(true)  // W=640 ≥ NAV+340=400，override 有效
    store.handleViewportChange(350)
    expect(store.overrides.explicitOpenLive2d).toBe(false) // W=350 < 400 → dropped 同步清位
  })

  it('setLive2dWidth clamp [300,420] + 防抖落盘', () => {
    const store = useLayoutStore()
    store.setLive2dWidth(500)
    expect(store.prefs.live2dWidth).toBe(420)
    store.setLive2dWidth(100)
    expect(store.prefs.live2dWidth).toBe(300)
    vi.advanceTimersByTime(200)
    expect(JSON.parse(storage.store.get(LAYOUT_STORAGE_KEY)!)).toEqual({
      version: 1, conversationCollapsed: false, live2dVisible: true, live2dWidth: 300
    })
  })

  it('effective 与 gridTemplateFor 一致（4 组合 columns/areas）', () => {
    const store = useLayoutStore()
    store.handleViewportChange(1200) // 全四区
    expect(gridTemplateFor(store.effective).gridTemplateAreas).toBe('"title title title title" "nav conv chat live"')
    store.handleViewportChange(1100) // 仅 Live2D（会话栏自动折叠）
    expect(gridTemplateFor(store.effective).gridTemplateAreas).toBe('"title title title" "nav chat live"')
    store.prefs.live2dVisible = false // 仅会话栏
    store.handleViewportChange(1200)
    expect(gridTemplateFor(store.effective).gridTemplateAreas).toBe('"title title title" "nav conv chat"')
    store.prefs.conversationCollapsed = true // 均隐藏
    store.handleViewportChange(1200)
    expect(gridTemplateFor(store.effective).gridTemplateAreas).toBe('"title title" "nav chat"')
    // store.effective 与同一输入纯函数推导一致
    expect(store.effective).toEqual(computeEffectiveLayout(1200, store.prefs, store.overrides, LAYOUT_CONSTANTS))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/layout.store.spec.ts`
Expected: FAIL，模块 `../../src/renderer/src/stores/layout.store` 不存在。

- [ ] **Step 3: 最小实现** —— `apps/desktop/src/renderer/src/stores/layout.store.ts`

```typescript
// src/renderer/src/stores/layout.store.ts
// 阶段 3 G1（spec §4.5，决策 D6）：布局——Renderer 本地 UI 状态，localStorage key cyrene.layout.v1，不入 Main 配置。
// effective 由 computeEffectiveLayout 纯函数推导（D2，保护不写回持久偏好）；会话期 override（D3，不持久化）。
// toggle = 「目标态」动作（P1-2）：折叠=写 prefs+清 override；展开=写 prefs+按 wouldBe 判据置 override，
// 置位后复核 effective 的 dropped*（双 override 兜底 P1-1）→ 清位 + notice（窄窗弹回 toast），不静默。
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { LAYOUT_CONSTANTS, LIVE2D_DEFAULT_WIDTH } from '../layout/constants'
import {
  clampLive2dWidth, computeEffectiveLayout, type LayoutOverrides, type LayoutPrefs
} from '../layout/effective-layout'
import { readLayout, writeLayout } from '../layout/layout-storage'

const PERSIST_DEBOUNCE_MS = 200

export const useLayoutStore = defineStore('layout', () => {
  // P2-2：首帧用 window.innerWidth 播种，避免首个 ResizeObserver 回调前只渲染 nav+chat 的瞬时布局
  const viewportWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 0)
  const prefs = ref<LayoutPrefs>({ conversationCollapsed: false, live2dVisible: true, live2dWidth: LIVE2D_DEFAULT_WIDTH })
  const overrides = ref<LayoutOverrides>({ explicitOpenConversation: false, explicitOpenLive2d: false })
  const notice = ref<string | null>(null)
  const effective = computed(() => computeEffectiveLayout(viewportWidth.value, prefs.value, overrides.value, LAYOUT_CONSTANTS))

  // 持久化：prefs 防抖落盘（override 与 notice 不持久化）。flush:'sync' 保证写时序可测。
  let persistTimer: ReturnType<typeof setTimeout> | undefined
  watch(prefs, () => {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => writeLayout(prefs.value, LAYOUT_CONSTANTS), PERSIST_DEBOUNCE_MS)
  }, { deep: true, flush: 'sync' })

  function clearNotice(): void { notice.value = null }

  function toggleConversation(): void {
    if (effective.value.conversationShown) {
      // 目标：折叠 —— 写回持久偏好 + 清会话期 override
      prefs.value.conversationCollapsed = true
      overrides.value.explicitOpenConversation = false
      return
    }
    // 目标：展开 —— 写回持久偏好；若「偏好展开 + 无 override」会被保护抢回则置 override
    prefs.value.conversationCollapsed = false
    const wouldBe = computeEffectiveLayout(viewportWidth.value,
      { ...prefs.value, conversationCollapsed: false },
      { ...overrides.value, explicitOpenConversation: false },
      LAYOUT_CONSTANTS)
    if (wouldBe.autoCollapsedConversation) overrides.value.explicitOpenConversation = true
    // 置位后复核 effective（P1-2）：若该 override 立即被双 override 兜底回退 → 清位 + toast
    if (effective.value.droppedConversationOverride) {
      overrides.value.explicitOpenConversation = false
      notice.value = '当前窗口过窄，无法同时显示会话列表与角色栏'
    }
  }

  function toggleLive2d(): void {
    if (effective.value.live2dShown) {
      prefs.value.live2dVisible = false
      overrides.value.explicitOpenLive2d = false
      return
    }
    prefs.value.live2dVisible = true
    const wouldBe = computeEffectiveLayout(viewportWidth.value,
      { ...prefs.value, live2dVisible: true },
      { ...overrides.value, explicitOpenLive2d: false },
      LAYOUT_CONSTANTS)
    if (wouldBe.autoClosedLive2d) overrides.value.explicitOpenLive2d = true
    if (effective.value.droppedLive2dOverride) {
      overrides.value.explicitOpenLive2d = false
      notice.value = '当前窗口过窄，角色栏无法显示'
    }
    // 评审第二轮重验修复：先置的会话栏 override 可能被双 override 兜底回退（droppedConversationOverride），
    // 必须同步清位——否则残留 override 在宽度回升 [660,1160) 时「复活」，会话栏意外展开、聊天被压到 40px。
    if (effective.value.droppedConversationOverride) {
      overrides.value.explicitOpenConversation = false
      notice.value = '窗口过窄，会话栏暂不可同时显示'
    }
  }

  function setLive2dWidth(w: number): void {
    prefs.value.live2dWidth = clampLive2dWidth(w, LAYOUT_CONSTANTS)
  }

  function handleViewportChange(w: number): void {
    viewportWidth.value = w
    // 宽度恢复足够 → 清 override（D3 判据）；dropped* 同步清位也在此覆盖
    if (w >= LAYOUT_CONSTANTS.NAV + LAYOUT_CONSTANTS.CONV + prefs.value.live2dWidth + LAYOUT_CONSTANTS.CHAT_MIN) {
      overrides.value.explicitOpenConversation = false
      overrides.value.explicitOpenLive2d = false
    }
    if (effective.value.droppedConversationOverride) overrides.value.explicitOpenConversation = false
    if (effective.value.droppedLive2dOverride) overrides.value.explicitOpenLive2d = false
  }

  function hydrate(): void {
    prefs.value = readLayout(LAYOUT_CONSTANTS)
  }

  return {
    viewportWidth, prefs, overrides, notice, effective,
    toggleConversation, toggleLive2d, setLive2dWidth, handleViewportChange, hydrate, clearNotice
  }
})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/layout.store.spec.ts`
Expected: PASS（13 tests）。

- [ ] **Step 5: 跑相关单测 + typecheck**

Run: `pnpm -F @cyrene/desktop test tests/unit/layout.store.spec.ts tests/unit/effective-layout.spec.ts tests/unit/layout-storage.spec.ts tests/unit/layout-constants.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: 全 PASS + typecheck 绿。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/stores/layout.store.ts apps/desktop/tests/unit/layout.store.spec.ts
git commit -m "feat(G1 layout): layoutStore（P1-2 toggle 目标态 + 弹回 toast + P2-2 首帧播种）"
```

---

### Task 7: `App.vue` 布局宿主 + `main.ts` hydrate + 各组件 grid-area 接线（D10/D6）

> App.vue 消费 layoutStore：`gridTemplateFor(effective)` 绑定 `grid-template-columns/areas`；隐藏区用 `v-show`（display:none）配合网格列不生成；挂 ResizeObserver（.cy-app 根，rAF 节流，不可用回退 window.resize）喂 `handleViewportChange`；`notice` 渲染为轻量 toast（数秒自动清除）。给 5 个组件根元素接 `grid-area`（title/nav/conv/chat/live），其中 chat 在 App.vue `.cy-main`。`main.ts` 在 createPinia 后、mount 前同步 `hydrate()`（P2-2 时序）。**本任务开始涉及组件：仓库无组件单测基线（无 @vue/test-utils），验证以 `typecheck` + `build` 为准（spec §6 已知限制）。**

**Files:**
- Modify: `apps/desktop/src/renderer/src/App.vue`（整体替换）
- Modify: `apps/desktop/src/renderer/src/main.ts`（加 hydrate）
- Modify: `apps/desktop/src/renderer/src/components/CyTitleBar.vue`（`.cy-titlebar` 加 `grid-area: title`，替换 `grid-column: 1 / -1`）
- Modify: `apps/desktop/src/renderer/src/components/CyNavRail.vue`（`.cy-nav` 加 `grid-area: nav`）
- Modify: `apps/desktop/src/renderer/src/components/CyConversationList.vue`（`.cy-conversations` 加 `grid-area: conv`）
- Modify: `apps/desktop/src/renderer/src/components/CyLive2DPanel.vue`（`.cy-live` 加 `grid-area: live`）

**Interfaces:**
- Consumes（Task 4/6）：`gridTemplateFor(effective)`、`useLayoutStore()` 的 `effective/notice/handleViewportChange/clearNotice`
- Produces（Task 8-10 继续改组件）：App.vue 布局宿主就位，四个组件已是显式 grid 子项

- [ ] **Step 1: 改 `App.vue`（布局宿主）**

`apps/desktop/src/renderer/src/App.vue` 整体替换为：

```vue
<script setup lang="ts">
// 阶段 3 G1（spec §4.6，决策 D10）：布局宿主——消费 layoutStore，绑定 grid-template-columns/areas，
// 挂 ResizeObserver 喂 viewportWidth（P2-2 首帧已由 store 播种）；隐藏区 v-show + 网格列不生成。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import CyTitleBar from './components/CyTitleBar.vue'
import CyNavRail from './components/CyNavRail.vue'
import CyConversationList from './components/CyConversationList.vue'
import CyChatView from './components/CyChatView.vue'
import CyLive2DPanel from './components/CyLive2DPanel.vue'
import { useLayoutStore } from './stores/layout.store'
import { gridTemplateFor } from './layout/effective-layout'

const layout = useLayoutStore()
const rootRef = ref<HTMLElement>()
const gridStyle = computed(() => gridTemplateFor(layout.effective))

let ro: ResizeObserver | undefined
let rafPending = false
function onResize(width: number): void {
  if (rafPending) return
  rafPending = true
  requestAnimationFrame(() => { rafPending = false; layout.handleViewportChange(width) })
}
function onWindowResize(): void { onResize(window.innerWidth) }

onMounted(() => {
  const el = rootRef.value
  if (!el) return
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver((entries) => { for (const en of entries) onResize(en.contentRect.width) })
    ro.observe(el)
  } else {
    window.addEventListener('resize', onWindowResize)
  }
})
onBeforeUnmount(() => {
  ro?.disconnect()
  window.removeEventListener('resize', onWindowResize)
})

// 轻量布局提示 toast（spec §4.5 窄窗弹回）：数秒后自动清除
let noticeTimer: ReturnType<typeof setTimeout> | undefined
watch(() => layout.notice, (n) => {
  if (noticeTimer) clearTimeout(noticeTimer)
  if (n) noticeTimer = setTimeout(() => layout.clearNotice(), 3000)
})
</script>

<template>
  <!-- 四区布局:导航 / 会话列表 / 聊天 / Live2D 右栏（角色栏是布局列，不覆盖聊天）。grid-template-* 由有效布局驱动（D10） -->
  <div ref="rootRef" class="cy-app" :style="gridStyle">
    <CyTitleBar />
    <CyNavRail />
    <CyConversationList v-show="layout.effective.conversationShown" />
    <main class="cy-main">
      <CyChatView />
    </main>
    <CyLive2DPanel v-show="layout.effective.live2dShown" />
    <div v-if="layout.notice" class="cy-layout-toast" role="status">{{ layout.notice }}</div>
  </div>
</template>

<style scoped>
.cy-app {
  display: grid;
  /* 行高 36px = layout/constants.ts TITLEBAR_HEIGHT（D1 单一事实来源） */
  grid-template-rows: 36px 1fr;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--cy-window);
}

.cy-main {
  grid-area: chat;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--cy-surface);
}

/* 轻量 toast：非 Live2D 覆盖物，仅瞬时提示，不遮挡交互区 */
.cy-layout-toast {
  position: fixed;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  z-index: 40;
  max-width: 70vw;
  padding: 9px 14px;
  color: var(--cy-accent-text);
  background: var(--cy-accent);
  border: 1px solid var(--cy-border);
  border-radius: 12px;
  font-size: 12px;
  box-shadow: var(--cy-shadow);
}
</style>
```

- [ ] **Step 2: 改 `main.ts`（hydrate 时序，spec §4.5）**

`apps/desktop/src/renderer/src/main.ts` 修改：在 import 区加 `import { useLayoutStore } from './stores/layout.store'`；在 `app.use(createPinia())` 之后、`if (window.desktopApi)` 之前插入：

```typescript
// G1（spec §4.5/P2-2）：createPinia 之后、mount 之前同步 hydrate 布局偏好，避免首帧闪默认布局
useLayoutStore().hydrate()
```

- [ ] **Step 3: 组件 grid-area 接线（4 处一行 CSS）**

- `CyTitleBar.vue`：`.cy-titlebar` 的 `grid-column: 1 / -1;` 改为 `grid-area: title;`
- `CyNavRail.vue`：`.cy-nav` 块内加 `grid-area: nav;`
- `CyConversationList.vue`：`.cy-conversations` 块内加 `grid-area: conv;`
- `CyLive2DPanel.vue`：`.cy-live` 块内加 `grid-area: live;`

- [ ] **Step 4: typecheck + build 验证**

Run: `pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop build`
Expected: 全绿。`pnpm -F @cyrene/desktop test tests/unit/layout.store.spec.ts` 仍 PASS（store 未改动）。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/App.vue apps/desktop/src/renderer/src/main.ts \
  apps/desktop/src/renderer/src/components/CyTitleBar.vue apps/desktop/src/renderer/src/components/CyNavRail.vue \
  apps/desktop/src/renderer/src/components/CyConversationList.vue apps/desktop/src/renderer/src/components/CyLive2DPanel.vue
git commit -m "feat(G1 layout): App.vue 布局宿主 + hydrate + 组件 grid-area 接线（D10/D6）"
```

---

### Task 8: `CyNavRail` —— 会话栏折叠/展开开关（D7/D11）

> NavRail 在 spacer 之后加真实 `<button>`（常显、键盘可达）：图标 + tooltip + `aria-label`「折叠会话列表/展开会话列表」+ `aria-pressed`=有效 `conversationShown`；点击调 `toggleConversation()`。仅使用现有 token 与 `.cy-nav-button` 样式。

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/CyNavRail.vue`

**Interfaces:**
- Consumes（Task 6）：`useLayoutStore()` 的 `effective.conversationShown`、`toggleConversation()`

- [ ] **Step 1: 改 script + template + style**

`CyNavRail.vue` 修改：
1. script：把 `import { ref } from 'vue'` 改为 `import { computed, ref } from 'vue'`；新增 `import { useLayoutStore } from '../stores/layout.store'`；新增 `const layout = useLayoutStore()` 与 `const collapseLabel = computed(() => layout.effective.conversationShown ? '折叠会话列表' : '展开会话列表')`。
2. template：在 `<span class="cy-nav-spacer" />` 之后追加按钮（`aria-pressed` 反映有效态，spec §4.8）：

```html
    <button
      class="cy-nav-button cy-nav-collapse"
      :aria-pressed="layout.effective.conversationShown"
      :aria-label="collapseLabel"
      :title="collapseLabel"
      @click="layout.toggleConversation()"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 5h7v14H4zM15 9l3 3-3 3" />
      </svg>
    </button>
```

3. style：`.cy-nav-collapse` 复用 `.cy-nav-button`（无新 token），可选微调：

```css
.cy-nav-collapse[aria-pressed='true'] {
  color: var(--cy-accent-text);
  background: var(--cy-accent);
}
```

- [ ] **Step 2: typecheck + build 验证**

Run: `pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop build`
Expected: 全绿。

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/CyNavRail.vue
git commit -m "feat(G1 layout): NavRail 会话栏折叠开关（D7/D11）"
```

---

### Task 9: `CyChatView` 角色开关 + 头部窄宽防御 + `CyConnectionPanel` 容器查询（D7/D10）

> CyChatView `.cy-header-actions` 新增「角色」开关（`aria-pressed`=有效 `live2dShown`，tooltip「显示/隐藏角色」，调 `toggleLive2d()`）；自动关闭时按钮保持可见 = 显式重开入口。头部窄宽防御（spec §4.7）：`.cy-chat-header` 设 `container-type: inline-size` + `min-width: 0`；标题 h2 省略号截断；`.cy-header-actions` 不收缩。CyConnectionPanel 自身 `<style>` 加容器查询降级：容器 <520px 隐藏 Endpoint/Token 输入行（表单行加 `cy-row-form` 类）且 `min-width` 降 auto；<320px 仅留连接/断开按钮。容器 = `.cy-chat-header`（同一 DOM 祖先），规则只改自身呈现，不改布局状态机（spec §4.7）。

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/CyChatView.vue`
- Modify: `apps/desktop/src/renderer/src/components/CyConnectionPanel.vue`

**Interfaces:**
- Consumes（Task 6）：`useLayoutStore()` 的 `effective.live2dShown`、`toggleLive2d()`

- [ ] **Step 1: 改 `CyChatView.vue`**

1. script：加 `import { useLayoutStore } from '../stores/layout.store'`；新增 `const layout = useLayoutStore()`。
2. template：`.cy-header-actions` 内、「新建」按钮后追加：

```html
        <button
          class="cy-action-button"
          :aria-pressed="layout.effective.live2dShown"
          title="显示/隐藏角色"
          aria-label="显示/隐藏角色"
          @click="layout.toggleLive2d()"
        >角色</button>
```

3. style：头部窄宽防御（spec §4.7）：

```css
.cy-chat-header {
  container-type: inline-size; /* G1：连接面板据此容器查询降级 */
  min-width: 0;
}
.cy-chat-heading,
.cy-chat-title-line {
  min-width: 0;
}
.cy-chat-heading h2 {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cy-header-actions {
  flex: 0 0 auto; /* 极端窄聊天下不收缩，给标题省略留空间 */
}
```

（在现有 `.cy-chat-header`、`.cy-chat-title-line`、`.cy-chat-heading h2`、`.cy-header-actions` 规则上增补以上属性。）

- [ ] **Step 2: 改 `CyConnectionPanel.vue`**

1. template：两处表单行（Endpoint 行、Token 行）`class="cy-row"` 改为 `class="cy-row cy-row-form"`（连接/断开行保持 `.cy-row`）。
2. style：`.cy-connection-panel` 现有 `min-width: 260px;` 保留；追加容器查询降级规则：

```css
/* G1（spec §4.7）：作用于最近容器 .cy-chat-header（container-type: inline-size）。
   仅「极端窄聊天」才压缩连接面板：默认四区态聊天内容盒 = 540−28 边距 = 512px（窗口 1200），
   会话栏折叠后 672px（窗口 1100），均 ≥ 420 —— 输入行始终可见；
   chat 内容盒 < 420px（约 chat<448px，仅极窄视口 520/375 或嵌入场景可达）才隐藏 Endpoint/Token 行。 */
@container (max-width: 419px) {
  .cy-connection-panel {
    min-width: auto;
  }
  .cy-row-form {
    display: none;
  }
}
@container (max-width: 319px) {
  .cy-mode-badge {
    display: none;
  }
}
```

- [ ] **Step 3: typecheck + build 验证**

Run: `pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop build`
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/CyChatView.vue apps/desktop/src/renderer/src/components/CyConnectionPanel.vue
git commit -m "feat(G1 layout): 聊天顶栏角色开关 + 头部窄宽防御 + 连接面板容器查询（D7/D10）"
```

---

### Task 10: `CyLive2DPanel` —— 折叠接线 + 拖拽手柄（D8）

> 「折叠角色栏」按钮接线 `toggleLive2d()`（`aria-pressed`=有效态）；新增左缘拖拽手柄（`role="separator"` + `aria-orientation="vertical"` + `aria-valuenow/min/max`）：pointerdown + setPointerCapture → pointermove 把指针 x（`新宽 = layout.viewportWidth - e.clientX`，即面板左缘跟随指针）映射为 pref 宽度，`setLive2dWidth` 内部 clamp [300,420] → pointerup/cancel 释放。拖拽只写 pref，不直接改列宽；实时重算由 store.computed 完成（保护可能自动折叠会话栏腾空间，spec §4.7）。

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/CyLive2DPanel.vue`

**Interfaces:**
- Consumes（Task 6）：`useLayoutStore()` 的 `effective.live2dShown`、`effective.live2dWidth`、`viewportWidth`、`toggleLive2d()`、`setLive2dWidth(w)`
- Consumes（Task 1）：`LIVE2D_MIN_WIDTH`、`LIVE2D_MAX_WIDTH`

- [ ] **Step 1: 改 script + template + style**

`CyLive2DPanel.vue` 修改：
1. script：

```typescript
import { ref } from 'vue'
import { useLayoutStore } from '../stores/layout.store'
import { LIVE2D_MAX_WIDTH, LIVE2D_MIN_WIDTH } from '../layout/constants'

const layout = useLayoutStore()
const dragging = ref(false)

function onResizeStart(e: PointerEvent): void {
  if (e.button !== 0) return
  dragging.value = true
  const el = e.currentTarget as HTMLElement
  if (el.setPointerCapture) el.setPointerCapture(e.pointerId)
  e.preventDefault()
}
function onResizeMove(e: PointerEvent): void {
  if (!dragging.value) return
  // 新宽 = 视口宽 − 指针 x（面板左缘跟随指针）；setLive2dWidth 内部 clamp [300,420]
  layout.setLive2dWidth(layout.viewportWidth - e.clientX)
}
function onResizeEnd(e: PointerEvent): void {
  dragging.value = false
  const el = e.currentTarget as HTMLElement
  if (el.hasPointerCapture && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
}
```

2. template：`<aside class="cy-live">` 内部、`<div class="cy-live-head">` 之前插入手柄；折叠按钮接线：

```html
    <div
      class="cy-live-resizer"
      role="separator"
      aria-orientation="vertical"
      :aria-valuenow="layout.effective.live2dWidth"
      :aria-valuemin="LIVE2D_MIN_WIDTH"
      :aria-valuemax="LIVE2D_MAX_WIDTH"
      tabindex="-1"
      @pointerdown="onResizeStart"
      @pointermove="onResizeMove"
      @pointerup="onResizeEnd"
      @pointercancel="onResizeEnd"
    />
```

把现有折叠按钮改为：

```html
      <button class="cy-live-min" :aria-pressed="layout.effective.live2dShown" title="折叠角色栏" aria-label="折叠角色栏" @click="layout.toggleLive2d()">›</button>
```

3. style：`.cy-live` 已有 `position: relative`（保留）；追加：

```css
.cy-live-resizer {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 5px;
  cursor: col-resize;
  touch-action: none;
}
.cy-live-resizer:hover {
  background: var(--cy-accent-strong);
  opacity: 0.35;
}
.cy-live-min[aria-pressed='true'] {
  color: var(--cy-accent-text);
  background: var(--cy-accent);
}
```

- [ ] **Step 2: typecheck + build 验证**

Run: `pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop build`
Expected: 全绿。

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/CyLive2DPanel.vue
git commit -m "feat(G1 layout): Live2D 栏折叠接线 + 拖拽手柄（D8）"
```

---

### Task 11: `main-window.ts` —— 窗口最小尺寸 1100×700（D9）

> Main BrowserWindow `minWidth: 736, minHeight: 560` → `1100 / 700`（两行）。与 renderer `layout/constants.ts` 的 `MIN_WINDOW_WIDTH/MIN_WINDOW_HEIGHT` 保持一致（Main 不 import renderer 模块，避免跨进程边界；数值以注释登记同一事实来源）。**注意：改动波及打包路径，最终必须 `package` + `verify:artifact --smoke` 复跑（见 Task 12 门禁）。**

**Files:**
- Modify: `apps/desktop/src/main/windows/main-window.ts:28-29`

- [ ] **Step 1: 修改两行**

`apps/desktop/src/main/windows/main-window.ts`：

```typescript
    minWidth: 1100, // 阶段 3 G1（决策 D9）：与 renderer layout/constants.ts MIN_WINDOW_WIDTH 一致
    minHeight: 700, // 阶段 3 G1（决策 D9）：与 renderer layout/constants.ts MIN_WINDOW_HEIGHT 一致
```

- [ ] **Step 2: typecheck 验证**

Run: `pnpm -F @cyrene/desktop typecheck`
Expected: 绿。

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/windows/main-window.ts
git commit -m "feat(G1 layout): 窗口最小尺寸 1100×700（D9）"
```

---

### Task 12: 门禁全量复跑 + 视觉验收（Playwright 视口 + vision-MCP）

> 本组全部落地后：先跑全部门禁，再按 docs/17 用 Playwright MCP 视口（1100×700 / 900×700 / 640×700 / 375×700）断言「无 Live2D 覆盖聊天」（元素边界不相交）并截图，mimo-vision `analyze_image` 检查四档断点无溢出/遮挡（spec §4.11/§5），记录到 `docs/review/`。`pnpm test:e2e` 仍是占位（非零退出防假绿）——视觉验收走 Playwright MCP 手工记录，不纳入脚本门禁。

**Files:**
- Create: `docs/review/2026-08-14-G1-layout-responsive-visual.md`（视觉验收记录）

- [ ] **Step 1: 门禁全量**

Run:
```bash
pnpm -F @cyrene/desktop typecheck
pnpm -F @cyrene/desktop lint
pnpm -F @cyrene/desktop test
xvfb-run -a pnpm -F @cyrene/desktop test:integration
pnpm -F @cyrene/desktop build
pnpm -F @cyrene/desktop check:contract
pnpm -F @cyrene/desktop package
pnpm -F @cyrene/desktop verify:artifact --smoke
```
Expected: 全绿。记录单测新数字（527 现有 + 新增：layout-constants 3 + effective-layout 36 + layout-storage 9 + layout.store 13 = **+61 断言 / 4 新文件**，最终以实际为准）。`test:integration` 仍 23（G1 不动 IPC 面，预期不回退）；`check:contract` 13/13 不变。

- [ ] **Step 2: 启动应用并跑 Playwright 视口断言**

启动：`xvfb-run -a pnpm -F @cyrene/desktop dev`（或打包产物），用 Playwright MCP `browser_navigate` 打开应用。对每个视口（`browser_resize`：1100×700、900×700、640×700、375×700）执行：

```js
() => {
  const rect = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, w: b.width, h: b.height }
  }
  const chat = rect('.cy-main')
  const live = rect('.cy-live')
  if (!chat) return { ok: false, reason: 'no .cy-main' }
  if (!live || live.w === 0) return { ok: true, liveVisible: false, chatW: chat.w, viewportW: window.innerWidth }
  const disjoint = live.left >= chat.right - 1 || chat.left >= live.right - 1 // Live2D 是右列，不与聊天相交
  const chatInView = chat.right <= window.innerWidth + 1 && chat.left >= 0
  return { ok: disjoint && chatInView, liveVisible: true, liveLeft: live.left, chatRight: chat.right, chatW: chat.w, viewportW: window.innerWidth }
}
```
Expected：每视口 `ok: true`（Live2D 打开时 `liveLeft ≥ chatRight`，即右列布局；聊天不出视口、无横向溢出）。`browser_take_screenshot` 四张，存 `.playwright-mcp/`。

- [ ] **Step 3: vision-MCP 截图检查 + 验收记录**

对四张截图跑 `analyze_image`，检查：四区无重叠/遮挡、聊天头部标题省略号、连接面板在窄聊天宽度压缩态、无横向滚动条（spec §5 验收 1-2）。结果与 Playwright 断言一并写入 `docs/review/2026-08-14-G1-layout-responsive-visual.md`（中文，含视口表 + 截图路径 + vision-MCP 结论 + 人工实机窗口最小尺寸记录，spec §6「BrowserWindow min-size 无法脱离 Electron 单测」）。

- [ ] **Step 4: Commit**

```bash
git add docs/review/2026-08-14-G1-layout-responsive-visual.md
git commit -m "test(G1 layout): 门禁全量 + Playwright 视口视觉验收记录"
```

---

### Task 13: 文档同步（spec §7，P1-3 实质修订 docs/06）

> 按 spec §7 逐条执行。**docs/06 §8.1 是实质修订（非仅注记）**：把 `layout` 字段从 `PersistedSettingsV2` 移除/重分类为「UI 状态·选择性持久化」（D6，不留双事实来源）。docs/13 item 11 从「仍需外部确认」移除并登记。docs/16 勾选阶段 3 相关项 + 更新测试数字 + 变更记录行。README/CLAUDE.md 更新三态状态源（G1 标「已验证」）。

**Files:**
- Modify: `docs/06-Cyrene-前端状态管理与本地存储设计-v0.2.md`
- Modify: `docs/16-Cyrene-前端实施任务清单与进度跟踪.md`
- Modify: `docs/03-Cyrene-前端UI与交互设计-v0.2.md`
- Modify: `docs/13-Cyrene-前端文档交叉Review与修订记录-v0.1.md`
- Modify: `README.md`、`CLAUDE.md`

- [ ] **Step 1: 修订 `docs/06`（P1-3 定案动作）**

1. **§2 状态分类表**：
   - 「UI 状态」行示例改为：`当前页面、折叠栏、Live2D 栏布局（可见/折叠/宽度）、滚动位置`，持久化列注明 `选择性持久化（布局记忆走 Renderer localStorage，key cyrene.layout.v1）`；
   - 「用户设置」行示例改为：`发送键、Live2D（模型/表情/发音等设置，非栏布局）、主题`，并加注「Live2D **栏布局**（可见/折叠/宽度）归 UI 状态，与 Live2D 用户设置（模型/表情/发音，阶段 5）区分」。
2. **§8.1 `PersistedSettingsV2`**：删除 `layout: { conversationPaneCollapsed, live2dPaneVisible, live2dPaneWidth }` 字段，在接口处加迁移注记：

```typescript
// 迁移注记（阶段 3 G1，决策 D6）：layout 字段已从 Main 配置移除，重分类为「UI 状态·选择性持久化」，
// 走 Renderer localStorage（key `cyrene.layout.v1`，见 §8.5）；旧配置中的 layout 字段若存在则忽略。
```

3. **§3 store 清单**：新增小节（在 §3.12 之后）——

```markdown
### 3.13 `layoutStore`

- 会话栏折叠、Live2D 开关与栏宽（Renderer 本地 UI 状态，决策 D6）；
- 布局记忆走 localStorage（key `cyrene.layout.v1`），不入 Main 配置；
- 有效布局由纯函数 `computeEffectiveLayout` 推导，保护不写回持久偏好。
```

4. **§8 新增分节**（§8.3 之后）：

```markdown
### 8.5 UI 状态·选择性持久化（布局记忆）

布局折叠/开关/栏宽属 UI 状态（Renderer、选择性持久化），经 `layoutStore` 读写 localStorage（key `cyrene.layout.v1`，schema 版本化 `{version:1, conversationCollapsed, live2dVisible, live2dWidth}`）。读入 fail-safe（损坏/版本不符 → 默认），写入失败非致命；`override`（会话期）与运行时 `viewportWidth` 不持久化。
```

- [ ] **Step 2: 更新 `docs/16`**

1. §6 任务清单勾选：`- [ ] 四区主布局、会话栏折叠与 Live2D 右栏预留` → `- [x] ...`；`- [ ] 落地 1200 / 736 / 520 / 320 响应式规则` → `- [x] ...`；验收门槛勾选 `- [ ] 1100×700 可用，窄窗口无 Live2D 覆盖聊天`。
2. 头部「文档状态」段追加 G1 落地数字（527 + 新增单测数、23 集成、typecheck/lint/build/check:contract 13/13/package/verify:artifact 全绿，标「已验证」）。
3. 变更记录表追加一行（日期 2026-08-14，内容「阶段 3 G1 布局与响应式落地」）。

- [ ] **Step 3: 更新 `docs/03`**

§3.1 布局数值段落加注「G1 已落地：会话栏 260 可折叠、Live2D 340（[300,420]）可调、聊天最小 500、窗口最小 1100×700，数值实机微调时同步 `layout/constants.ts`」；§3.2 布局记忆范围加注「G1 仅覆盖会话栏/Live2D 开关与宽度；窗口 bounds 归 Main 窗口生命周期组（后续组）」。

- [ ] **Step 4: 更新 `docs/13` item 11**

item 11「Live2D 默认展开状态、宽度、聊天最小宽度、极窄阈值」从「仍需外部确认」移除并登记定案：Live2D 默认显示、340 可调（[300,420]）、最小窗口 1100×700、窄窗先折叠会话栏再自动关闭 Live2D（spec 2026-08-14-phase3-layout-responsive-design v2.1，决策 D4/D5/D9）。

- [ ] **Step 5: 更新 `README.md` / `CLAUDE.md`**

README「真实模式联调」小节三态状态源：阶段 3 G1 布局与响应式标「**已验证**」（纯前端布局、无联调对象；本地门禁全绿 + Playwright 视口 + vision-MCP 视觉记录，2026-08-14）。CLAUDE.md「Current status」段补一句 G1 落地状态。

- [ ] **Step 6: 全量门禁复跑（确认文档改动未破坏代码）**

Run: `pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop lint && pnpm -F @cyrene/desktop test`
Expected: 全绿。

- [ ] **Step 7: Commit**

```bash
git add docs/06-Cyrene-前端状态管理与本地存储设计-v0.2.md docs/16-Cyrene-前端实施任务清单与进度跟踪.md \
  docs/03-Cyrene-前端UI与交互设计-v0.2.md docs/13-Cyrene-前端文档交叉Review与修订记录-v0.1.md \
  README.md CLAUDE.md
git commit -m "docs(G1 layout): 文档同步——docs/06 §8.1 实质修订 + 16/03/13/README 三态更新"
```

---

## 门禁汇总与三态状态源

- **门禁**（Task 12 已列）：`typecheck` / `lint` / `test`（527 + ~61 新增，4 新 spec 文件）/ `test:integration`（23 不回退）/ `build` / `check:contract`（13/13）/ `package` + `verify:artifact --smoke`（Main 最小尺寸改动波及打包路径，复跑）。
- **三态状态源**：G1 为纯前端布局、无真实后端联调对象 → 门禁全绿 + Playwright 视口 + vision-MCP 视觉记录后标「**已验证**」；窗口最小尺寸属本地行为，以人工实机记录（spec §4.11/§6）。
- **开放项（spec §6，不在本组）**：窗口 bounds 持久化（Main 窗口组）；消息级窄屏表现（聊天/媒体组）；ESC 关面板 / 全局快捷键 / 拖拽键盘 resize（P1）。

---

## Spec 覆盖对照表（自审 1）

| Spec 条目 | 任务 |
|---|---|
| §4.1 布局常量（D1） | Task 1 |
| §4.2 有效布局推导（D2）+ 正确性论证/不变式 | Task 2-4（Task 4 扫描不变式） |
| §4.3 会话期 override（D3）行为表 9 行 | Task 3（算法）+ Task 6（store 清位/置位）+ Task 6 行为表单测 |
| §4.4 断点语义（D4，P2-1 动态阈值） | Task 2/3 测试（W=1160/1200+420）+ Task 7/9 布局与 CSS |
| §4.5 布局记忆 layoutStore + localStorage（D6/P1-3）+ 边界说明 | Task 5-7（storage/store/hydrate）+ Task 13（docs/06 实质修订） |
| §4.6 网格实现 grid-template-areas（D10）+ ResizeObserver + P2-2 | Task 4（gridTemplateFor）+ Task 7（App.vue/RO/播种/hydrate） |
| §4.7 组件改造表 7 组件 + 界面风格 | Task 7（grid-area/App.vue）、Task 8（NavRail）、Task 9（ChatView/ConnectionPanel）、Task 10（Live2DPanel）、Task 11（main-window） |
| §4.8 键盘与可访问性（D11） | Task 8（aria-pressed/label）、Task 9（角色按钮）、Task 10（role=separator + aria-valuenow） |
| §4.9 错误处理与边界 6 场景 | Task 5（localStorage 失败 fail-safe）、Task 7（RO 回退）、Task 10（pointer capture 释放）、Task 2-4（chat≥0/无覆盖） |
| §4.10 数据流 | Task 6（store）+ Task 7（App.vue RO → handleViewportChange → effective → grid） |
| §4.11 测试（D12）+ 门禁 | Task 1-6（单测）+ Task 12（全量门禁 + Playwright 视口 + vision-MCP） |
| §5 验收 5 项 | Task 2-4（chat≥0/不溢出单测）、Task 9（头部窄宽防御）、Task 5-7（布局记忆）、Task 8-10（键盘）、Task 12（视觉验收） |
| §6 已知限制（记录） | 开放项清单见上（不实现，文档记录） |
| §7 文档同步 5 项 | Task 13 |
