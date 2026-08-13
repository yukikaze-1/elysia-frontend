# Cyrene 阶段 3 G1：四区布局与响应式设计（布局记忆 + 窄窗保护）

**日期：** 2026-08-14
**依据：** `docs/03`（§3 主窗口布局 / §6 聊天顶部栏 / §11 Live2D 区域 / §14 键盘与可访问性 / §15 UI 验收）、PRD `docs/Cyrene-Desktop-Demo-产品需求文档-v0.2.md`（§6.1 主窗口结构）、`docs/10`（§6 阶段 3 任务）、`docs/12`（§9.4 阶段 3）、`docs/16`（§6 阶段 3 清单+验收门槛）、`docs/06`（§3.7 settingsStore / §8 本地持久化分层）、`docs/13`（R-21 四区布局口径）、阶段 3 组范围（G1 布局与响应式）
**范围：** 阶段 3 G1——四区主布局、会话栏折叠、Live2D 右栏布局预留与响应式、布局记忆、窄窗保护、窗口最小尺寸
**目的：** 把当前硬编码四区网格（App.vue）升级为可折叠、可调整、响应式、有布局记忆的主布局；落实 1200/736/520/320 四档断点、会话栏 260 可折叠、Live2D 340 可调整、最小窗口 1100×700；保证任何宽度下 Live2D 作为右侧布局列参与排版、永不覆盖聊天；Live2D 默认显示；界面贴合现有 tokens.css 的现代 QQ/微信风格。本组只做 Live2D 右栏的**布局预留与响应式行为**，不接入 Live2D SDK（阶段 5）。
**决策：** 本组决策由我按推荐定案（用户已授权自主定案，记录进本 spec，最终报告统一汇报）——D1（区宽常量落 JS 单一事实来源）、D2（有效布局=纯函数推导，保护永不写回持久偏好）、D3（会话期显式覆盖 override，显式重开入口真实有效）、D4（断点语义：1200 主断点 + 736/520/320 防御性）、D5（Live2D 默认显示，auto-close 为派生态）、D6（布局记忆走 Renderer localStorage，不入 Main 配置；理由：布局折叠/开关/栏宽为纯 UI 状态、非敏感设置，避免为 trivial 偏好扩 IPC 面；与 docs/06 §8.1 现存 `layout` 字段冲突，实施时按 §7 实质修订 docs/06 §8.1 解决）、D7（会话栏折叠开关放 NavRail、Live2D 开关放聊天顶栏）、D8（Live2D 栏宽拖拽手柄，范围 [300,420]）、D9（窗口最小尺寸 1100×700，Main BrowserWindow 修改）、D10（网格用 grid-template-areas 按有效布局切换，避免 display:none + auto-placement 错位）、D11（键盘可达：开关为真实 button + aria，不做全局快捷键）、D12（测试策略：纯函数+store 单测为主，视觉用 Playwright 视口 + vision-MCP 验收）
**文档状态：** v2.1（评审修订，2026-08-14）。独立评审后修订：**修复 P1-1**（双 override 并存且宽度不足时 chatWidth 为负 → 按优先序回退的兜底算法 + 不变式/行为表/测试同步，保证任何 W 下 chat≥0 且网格不溢出）、**修复 P1-2**（toggle 改为「按目标态设置 + 置/清 override」，补「折叠→重开」序列与窄窗弹回 toast，不再盲目翻转 prefs）、**修复 P1-3**（布局记忆持久化与 docs/06 §8.1 `layout` 字段冲突 → 定案 Renderer localStorage（D6），§7 改为对 docs/06 §8.1 的实质修订动作并补强理由）；**处理 P2-1**（断点表「≥1200=全四区」口径过宽 → 区存在性由算法按 live2dWidth 动态决定，1200 仅为 CSS 视觉断点）、**处理 P2-2**（首帧 viewportWidth=0 瞬时布局 → store 用 `window.innerWidth` 播种）。**重验（第二轮）后追加：** 修复 `toggleLive2d` 漏同步「已置的会话栏 override 被双 override 兜底回退」的清位（残留 override 会在宽度回升 [660,1160) 时复活，聊天被压到 40px）；§7 补 docs/13 同步（item 11 Live2D 默认/宽度/最小聊天/极窄阈值已由本组锁定决策定案）。其余内容不变。待实施；实施后按三态状态源标记。

---

## 1. 背景与目标

阶段 2 主链已真实联调通过（B-01 封口，2026-08-14），阶段 3 升为主线。阶段 3 第一个可独立验证的子项是 G1「布局与响应式」：当前 `App.vue` 是硬编码的静态四区网格，无法折叠会话栏、无法隐藏/调整 Live2D 栏、没有布局记忆、也没有任何窄窗保护逻辑；Live2D 面板是纯占位（CyLive2DPanel），宽度 208px 与设计 340px 不符。

本组目标：

1. **四区主布局**按设计宽固化：导航 60 / 会话列表 260（可折叠）/ 聊天自适应（最小 500）/ Live2D 340（可调整，默认显示）；
2. **落地 1200/736/520/320 四档断点**：全四区阈值随 `live2dWidth` 动态（默认 340 时需 W≥1160，live2dWidth=420 时需 W≥1240，见 §4.4；1200 仅为 CSS 视觉断点，**不保证「1200 必全四区」**）；窄窗先自动折叠会话列表保护聊天区，仍不够则自动关闭 Live2D 并保留显式重开入口；
3. **Live2D 打开时始终作为右侧布局列参与排版**（聊天区随之收窄），**禁止任何覆盖层**遮住消息/滚动条/输入区；
4. **布局记忆**：会话栏折叠状态、Live2D 开关与栏宽持久化（Renderer 本地，doc 06 UI 状态分层）；
5. **最小窗口 1100×700**（Main BrowserWindow）；
6. **键盘可完成本组布局层面的主要操作**（折叠/展开开关 Tab + Enter/Space 可达）；
7. Live2D 右栏**本组只做布局预留**，SDK/渲染属阶段 5；界面风格贴合 tokens.css（现代 QQ/微信：圆角、留白、扁平化），不新增颜色 token。

**完成标准**（对照 docs/16 §6 阶段 3 验收门槛中本组相关项）：
- 1100×700 下四个主要区域正常显示、无溢出/遮挡；
- 窄窗口（四档断点及防御性更窄宽度）下 Live2D 永不覆盖聊天，聊天区随 Live2D 关闭而回宽；聊天头部在极窄聊天宽度下自身无横向溢出（标题截断 + 连接面板压缩）；
- 会话栏折叠/Live2D 开关与栏宽有布局记忆（刷新/重启后恢复）；
- 布局相关主要操作可键盘完成；
- 会话栏折叠与 Live2D 开关/自动关闭行为有可自动执行单测（纯函数 + store），视觉经 Playwright 视口 + vision-MCP 验收记录。

## 2. 范围（本组做 vs 不做）

**本组做：**

- 四区主布局重构（App.vue 网格从硬编码列改由布局 store 驱动）；
- 会话栏折叠/展开（NavRail 开关）+ 窄窗自动折叠；
- Live2D 右栏布局预留：显示/隐藏开关（聊天顶栏）、栏宽拖拽调整、窄窗自动关闭、显式重开入口；
- 1200/736/520/320 断点落地（结构性折叠由算法驱动，CSS media query 做区内视觉微调）；
- 布局记忆：`layoutStore`（Renderer localStorage，schema 版本化）；
- 窗口最小尺寸 1100×700（Main `main-window.ts` 两行修改）；
- 本组布局层面的键盘可达与可访问性（aria、焦点）；
- 纯函数 + store 单元测试。

**本组不做：**

- **Live2D SDK/渲染/状态映射**（阶段 5；CyLive2DPanel 保持占位）；
- **窗口位置/大小持久化**（doc 03 §3.2 布局记忆含窗口 bounds，但 G1 范围明确只含「会话栏/Live2D 开关与宽度」；窗口 bounds 属 Main 窗口生命周期组，本组记录为后续开放项）；
- **最后访问页面持久化**（doc 03 §3.2 列项，非 G1）；
- **设置中心集成**（模型/主题/Live2D 设置、外观、字体缩放等属阶段 4/11；G1 仅做轻量 layoutStore，不触碰 Main 配置持久化）；
- **会话列表产品功能**（置顶/归档/分组为 P1，非 G1）；
- **消息级窄屏表现**（长代码块/表格横向滚动、图片缩放、Markdown 窄屏优化等属聊天/媒体组；G1 只保证容器层不溢出、不遮挡）；
- 自定义标题栏拖拽区域（`-webkit-app-region`，窗口外壳层，非 G1）；
- 全局键盘快捷键（P1，本组只保证开关可 Tab + 激活）。

## 3. 现状与技术约束

### 3.1 现状（问题点证据）

| 位置 | 现状 | 问题 |
|---|---|---|
| `App.vue` | `grid-template-columns: 58px 174px minmax(292px, 1fr) 208px` 硬编码 | 列宽与设计不符（导航 58≠60、会话栏 174≠260、聊天最小 292≠500、Live2D 208≠340）；无可折叠/隐藏/调整；无响应式 |
| `CyLive2DPanel.vue` | 纯占位；「折叠角色栏」按钮无逻辑；宽 208 | 无显示开关接线、无宽度调整、无窄窗自动关闭 |
| `CyNavRail.vue` | 仅 brand + 聊天/任务/设置三按钮 | 无会话栏折叠开关（折叠后无处重开） |
| `CyChatView.vue` | 顶栏有「新建」+ 连接面板 | 无 Live2D 显示切换（doc 03 §6 要求） |
| `main-window.ts` | `minWidth: 736, minHeight: 560` | 与「最小窗口 1100×700」不符 |
| Renderer | 无 layoutStore、无 localStorage 使用 | 无布局记忆 |
| Store 清单（doc 06 §3） | 列 app/connection/conversation/message/tool/live2d/settings/modelService/voice/search/resource/sticker | 无 layoutStore（需 doc 06 增补） |

### 3.2 技术约束

- **不新增 IPC/Preload 面**：布局记忆属 doc 06「UI 状态（折叠栏）· Renderer · 选择性持久化」，走 Renderer localStorage，不碰 Main 配置/IPC；G1 唯一的 Main 改动是窗口最小尺寸（`main-window.ts` 两行）。**与 docs/06 §8.1 `PersistedSettingsV2.layout` 字段冲突**（doc 06 早版把 `conversationPaneCollapsed/live2dPaneVisible/live2dPaneWidth` 列进 Main 配置）：本 spec 以「UI 状态·选择性持久化」定案（决策 D6，理由见 §4.5 边界说明），实施时按 §7 对 docs/06 §8.1 做实质修订，不留双事实来源。
- **Live2D 必须是布局列，不是覆盖层**：doc 03 §3.1/§11 + doc 13 R-21 + PRD §6.1——角色栏作为聊天区右侧新增布局列参与排版，禁止覆盖消息/滚动条/输入区。结构上用 grid 列天然满足，且不能引入任何 `position: fixed/absolute` 的全局覆盖物。
- **窄窗保护顺序固定**：doc 03 §3.1「先折叠会话列表保护聊天区；若仍无法同时容纳聊天与角色栏，则自动关闭 Live2D，并保留显式重新打开入口」。
- **断点数值已锁定**：1200/736/520/320（doc 12/16），「实机后再微调数值」。
- **网格不能依赖 display:none + auto-placement**：grid 项 `display:none` 后 auto-placement 会把后续项错位排进被隐藏列的槽位（如会话栏隐藏后聊天会被排进 260px 列），必须用 grid-template-areas 显式命名（D10）。
- **CSS media query 读不到用户偏好**：会话栏/Live2D 折叠是「宽度 × 偏好」共同决定的动态结果，必须由 JS 纯函数推导出有效布局后绑定网格；media query 只做区内视觉微调，避免双事实来源（D2/D4）。
- **保护不得写回持久偏好**：自动折叠/自动关闭是派生态；若写回 localStorage，用户恢复宽窗后会永久失去默认布局（D2）。
- **「显式重开入口」必须真实有效**：窄窗下若用户点开被自动关闭的栏，立即又被保护抢回，入口形同虚设；需要会话期 override（D3）。
- **Live2D 默认显示已锁定**（用户拍板）；PRD §6.1「按需展开」被用户最新决策覆盖（doc 00 §5 优先级 1）。
- **仓库无 Vue 组件级单测基线**（无 @vue/test-utils 使用）；G1 自动测试落在纯函数 + store（可注入 storage），视觉/响应式以 Playwright 视口 + vision-MCP 验收（docs/17 有用法与坑）。
- **窗口最小 1100 与断点 736/520/320 的关系**：最小窗口 1100 使这三档在正常 Electron 窗口下不可达；它们作为防御层（字体缩放、窗口管理器忽略最小尺寸、DevTools/浏览器预览、Playwright 视口测试）必须实现且正确。

## 4. 设计

### 4.1 布局常量与区宽（决策 D1）

新增 `src/renderer/src/layout/constants.ts`，作为区宽/断点/保护阈值的**单一事实来源**（JS 常量）：

```ts
// src/renderer/src/layout/constants.ts
export const TITLEBAR_HEIGHT = 36
export const NAV_WIDTH = 60
export const CONVERSATION_WIDTH = 260
export const LIVE2D_DEFAULT_WIDTH = 340
export const LIVE2D_MIN_WIDTH = 300      // PRD §6.1「300～420 px」
export const LIVE2D_MAX_WIDTH = 420
export const CHAT_MIN_WIDTH = 500        // doc 03 §3.1 聊天区最小 500
export const MIN_WINDOW_WIDTH = 1100
export const MIN_WINDOW_HEIGHT = 700
export const BREAKPOINTS = { wide: 1200, compact: 736, narrow: 520, extreme: 320 } as const
```

- App.vue 不再硬编码列宽；网格列由 layout store 生成（D10）。
- CSS 内如需引用区宽，经 `:style` 内联或 CSS 变量注入，不复制数值。
- 会话栏 260、Live2D 默认 340 已锁定；Live2D 可调整范围取 PRD [300, 420]（「实机后再微调」）。

### 4.2 有效布局推导：纯函数（决策 D2）

新增 `src/renderer/src/layout/effective-layout.ts`，**纯函数、无 DOM/无副作用、可单测**：

```ts
// src/renderer/src/layout/effective-layout.ts
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
  chatWidth: number               // 剩余宽度，永远 ≥ 0，且满足「可满足且无有效 override 时 ≥ CHAT_MIN_WIDTH」
  live2dWidth: number             // 有效栏宽，关闭时为 0
  conversationShown: boolean
  live2dShown: boolean
  autoCollapsedConversation: boolean // 本次因保护自动折叠
  autoClosedLive2d: boolean          // 本次因保护自动关闭
  droppedConversationOverride: boolean // 双 override 兜底回退会话栏 override（P1-1）；store 据此清除会话期标记
  droppedLive2dOverride: boolean       // 双 override 兜底回退 Live2D override；store 据此清除会话期标记
}

export function computeEffectiveLayout(
  viewportWidth: number,
  prefs: LayoutPrefs,
  overrides: LayoutOverrides,
  constants: LayoutConstants
): EffectiveLayout
```

**算法（确定性，按 doc 03 §3.1 顺序；P1-1 修复——任何 W 下 chat ≥ 0 且网格不溢出）：**

```ts
const { NAV, CONV, CHAT_MIN, LIVE_MIN, LIVE_MAX } = constants
const liveDesired = prefs.live2dVisible ? clamp(prefs.live2dWidth, LIVE_MIN, LIVE_MAX) : 0
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
return { navWidth: nav, conversationWidth: conv, live2dWidth: live, chatWidth: chat,
         conversationShown: conv > 0, live2dShown: live > 0,
         autoCollapsedConversation: autoCollapsed, autoClosedLive2d: autoClosed,
         droppedConversationOverride: droppedConvOverride, droppedLive2dOverride: droppedLiveOverride }
```

**正确性论证（chat ≥ 0 恒成立，W ≥ 320）：**

- **无有效 override**：保护按 doc 03 顺序收栏，最终 `chat = W − NAV − 0 − 0 ≥ 260`；
- **单会话栏 override**：仅当 `W ≥ NAV + CONV`（步骤 0 保证）才生效，此时第 2 步可能被跳过，但第 3 步仍可关 Live2D，`chat ≥ W − NAV − CONV ≥ 0`；
- **单 Live2D override**：仅当 `W ≥ NAV + liveDesired` 才生效，第 2 步折叠会话栏后 `chat ≥ W − NAV − liveDesired ≥ 0`；不满足则回退，由保护收栏回到 ≥ 260；
- **双 override**：仅当 `W ≥ NAV + CONV + liveDesired` 才并存，`chat = W − NAV − CONV − liveDesired ≥ 0`；否则按优先序回退到上面两种单 override 情形之一。**任一情形 chat 不为负、网格不溢出。**

**不变式（单测保证，精确表述；「有效 override」= 经步骤 0 兜底回退后仍生效的 override，回退者本轮视为未置位）：**

- `navWidth + conversationWidth + live2dWidth + chatWidth === viewportWidth`（网格恒占满）；
- 四个宽度均 ≥ 0，**chat ≥ 0 恒成立（对 W ≥ 320）**：无有效 override 时保护收栏后 `chat ≥ W − NAV ≥ 260`；有有效 override 时其生效前提是「当前宽度可同时容纳对应栏」（见算法步骤 0），故 `chat ≥ 0`，绝不为负、网格绝不溢出；
- **「可满足」定义**：存在 (conv ∈ {0,260}, live ∈ {0,liveDesired}) 使 `viewportWidth − NAV − conv − live ≥ CHAT_MIN`，即 `viewportWidth ≥ NAV + CHAT_MIN = 560`。当可满足且**无有效 override 阻碍保护**时，保护保证 `chatWidth ≥ CHAT_MIN`；有有效 override 时用户显式接受 `chat < CHAT_MIN`（下界 0 仍由步骤 0 兜底保证）；当不可满足（W < 560）时聊天区接受 < 500（无其他选择），但**永不重叠、不为负**；
- **保护不多触发**：当 `viewportWidth − NAV − convDesired − liveDesired ≥ CHAT_MIN`（不折叠不关闭即满足）时，`autoCollapsedConversation` 与 `autoClosedLive2d` 必须为 false；
- **autoCollapsedConversation === true ⟺ `prefs.conversationCollapsed === false` 且 `!有效 explicitOpenConversation` 且 `viewportWidth − NAV − CONV − liveDesired < CHAT_MIN`**（保护前会话栏开着、聊天不足、无显式覆盖时才自动折叠）；回退会话栏 override 时同样成立（store 清位后与「无 override」等价）；
- **autoClosedLive2d === true ⟺ `prefs.live2dVisible === true` 且 `!有效 explicitOpenLive2d` 且第 1 步后 `chat < CHAT_MIN`**（第 1 步折叠后仍不足、且 Live2D 无显式覆盖时才自动关闭）；回退 Live2D override（W < NAV + liveDesired）时成立；
- 窄窗无覆盖：四区是 grid 列，天然无重叠；不产生任何覆盖层（见 §4.6）。

**保护/偏好分离语义：**

- `computeEffectiveLayout` **不写回 prefs**；自动折叠/自动关闭只出现在返回值标记位（`autoCollapsedConversation`/`autoClosedLive2d`），由 UI 用于提示（如开关按钮反映有效态）。
- 唯一例外（P1-1）：`droppedConversationOverride`/`droppedLive2dOverride` 是返回值的一部分，由 **store** 依它同步清除对应的会话期 override 标记（不落盘、不碰 prefs）；这是「会话期状态一致性」，不违反「保护不写回持久偏好」原则。
- 用户偏好是「宽窗时的目标布局」；有效布局是「当前宽度下的实际布局」；宽窗恢复后自动回到偏好。

### 4.3 会话期显式覆盖（决策 D3）

避免「窄窗下用户显式打开某栏，立即被保护抢回」。`layout.store` 持有**会话期**（不持久化）`LayoutOverrides`：

- **置位（P1-2 补强——不只「当前被保护」，「展开后会被保护抢回」也置）**：用户在以下情形显式打开某栏时置对应 `explicitOpen* = true`：
  1. 该栏当前被保护关闭/折叠（`autoCollapsed`/`autoClosed` 为真）——显式重开被保护抢回的情形；
  2. 该栏当前因**偏好**隐藏，且按偏好展开后的推导会被保护立即抢回（即「折叠 → 重开」序列：`wouldBe.autoCollapsed*` 为真，如宽 1100 下先手动折叠会话栏再点展开）——此时若不置 override，展开后 `chat < CHAT_MIN` 又被保护折叠回 0，重开点击无效果；
  3. **置位后立即被双 override 兜底回退**（置 override 后 `effective.dropped*` 为真，如已有另一栏 override 且 `W < NAV+CONV+liveDesired`）——此时 store **清掉该 override** 并触发窄窗提示（见 §4.5 说明），避免静默无效果。
- **清位**：
  - 用户主动关闭该栏 → 清该栏 override；
  - 视口宽度增大到「全偏好布局可容纳」→ 清两个 override。判据：`viewportWidth >= NAV_WIDTH + CONVERSATION_WIDTH + live2dWidth(偏好) + CHAT_MIN_WIDTH`（此时聊天在不折叠不关闭下即 ≥ 500，保护不再需要）；
  - 双 override 兜底回退掉该栏 override（`droppedConversationOverride`/`droppedLive2dOverride` 为真）→ store 同步清除对应会话期标记（与算法步骤 0 一致，避免残留 override 在宽度回升后「不请自来」）。

**行为示例（最小窗口 1100，Live2D 默认显示）：**

| 场景 | 结果 |
|---|---|
| 宽 1100、偏好全开 | 保护第 1 步自动折叠会话栏 → 聊天 700、Live2D 显示（默认角色可见） |
| 宽 1100、用户显式打开会话栏 | 置 override（wouldBe 判据）→ 跳过第 1 步 → 第 2 步自动关闭 Live2D → 聊天 780、会话栏可见 |
| 宽 1100、用户再显式打开 Live2D | 两个 override 都置位（W≥660 可并存）→ 聊天 440（用户显式选择，接受 < 500，无遮挡、不为负） |
| 宽 1100、用户**手动折叠会话栏后重开** | 目标态展开 + 置 override（P1-2 判据 2）→ 同「显式打开会话栏」效果（聊天 780、会话栏可见），展开点击真实有效 |
| 宽 640、两个 override 都置位 | 双 override 兜底（W=640 < 660）：回退会话栏 override（保留 Live2D）→ 会话栏自动折叠、Live2D 显示、聊天 240；不溢出、不为负；store 清除会话栏 override |
| 宽 350、Live2D override 置位 | 单 override 兜底（W=350 < NAV+liveDesired=400）：回退 Live2D override → Live2D 自动关闭 + toast「角色栏无法显示」，聊天 ≥ 260；不溢出 |
| 宽度增到 ≥ 1160（默认 340 时） | override 清空，恢复偏好全开、聊天 ≥ 500；live2dWidth=420 时该阈值升到 1240（全四区阈值随 live2dWidth 动态，见 §4.4） |
| 宽 1200、默认(340) | 全四区显示，聊天 540 ≥ 500，保护不触发 |
| 宽 1200、live2dWidth=420 | 全四区需 1240 > 1200 → 自动折叠会话栏（聊天 = 1200−60−420 = 720 ≥ 500、Live2D 显示） |

### 4.4 断点语义与 CSS（决策 D4）

四档断点映射（`BREAKPOINTS` 常量 + CSS media query 双份，语义一致）：

| 断点 | 名称 | 结构性行为（算法驱动） | CSS 视觉微调（media query 驱动） |
|---|---|---|---|
| ≥ 1200 | wide | **区存在性由算法决定，不保证「1200 必全四区」**：全四区条件为 `W ≥ NAV + CONV + live2dWidth + CHAT_MIN`（默认 340 时 ≥ 1160；live2dWidth=420 时 ≥ 1240），满足才全四区；不满足仍走保护（例：W=1200、live2dWidth=420 → 自动折叠会话栏）；1200 仅作为 CSS 视觉断点 | 默认留白/字号 |
| [736, 1200) | compact | 保护激活（先自动折叠会话栏，仍不够自动关闭 Live2D） | 收紧区内间距、预览行可截断 |
| [520, 736) | narrow | Live2D 大概率自动关闭；会话栏自动折叠 | 消息列表/输入区更紧凑，标题省略号 |
| [320, 520) | extreme | 仅导航 + 聊天；两栏均不可同时显示 | 最小留白；一切内容可滚动/换行，无横向溢出 |

说明：

- **结构性折叠由算法驱动**（media query 无法读用户偏好），CSS media query 只做区内视觉微调（间距、截断、面板压缩），两者不冲突、不重复定义区宽；**区存在性/区宽只由有效布局决定**，media/container query 不得改变四区的显示/隐藏或列宽；
- **「1200 = 全四区」是过宽口径（P2-1 已处理）**：全四区需 `W − NAV − CONV − live2dWidth ≥ CHAT_MIN`，阈值随 live2dWidth 动态（默认 340 时 ≥ 1160；live2dWidth=420 时 ≥ 1240）。1200 仅是 CSS 视觉断点（wide 区内的默认留白/字号切换）；区存在性一律以算法为准。验收与测试不再断言「1200 必全四区」，改为断言动态阈值（例：W=1200、live2dWidth=420 → 自动折叠会话栏）；
- **聊天区内头部溢出防御**（见 §4.7）：`.cy-chat-header` 用 CSS 容器查询（`container-type: inline-size`）驱动连接面板在窄聊天宽度下压缩，标题省略号截断——保证四档断点（含 320 防御档）下聊天头部自身不横向溢出；
- 最小窗口 1100 使 compact/narrow/extreme 在正常 Electron 窗口下**不可达**（防御层），但算法与 media/container query 都必须正确——覆盖字体缩放、WM 忽略最小尺寸、DevTools/浏览器预览与 Playwright 视口测试；这是「实机后再微调」的既定取舍（见 §6 已知限制）。

### 4.5 布局记忆：layoutStore + localStorage（决策 D6）

新增 `src/renderer/src/stores/layout.store.ts`（Pinia，Renderer 本地 UI 状态）：

```ts
export const useLayoutStore = defineStore('layout', () => {
  // P2-2：首帧用 window.innerWidth 播种，避免首个 ResizeObserver 回调前只渲染 nav+chat 的瞬时布局
  const viewportWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 0)
  const prefs = ref<LayoutPrefs>({ conversationCollapsed: false, live2dVisible: true, live2dWidth: 340 })
  const overrides = ref<LayoutOverrides>({ explicitOpenConversation: false, explicitOpenLive2d: false })
  const notice = ref<string | null>(null)   // 窄窗弹回提示（App.vue 渲染为轻量 toast；见下）
  const effective = computed(() => computeEffectiveLayout(viewportWidth.value, prefs.value, overrides.value, LAYOUT_CONSTANTS))

  // 动作（P1-2：toggle 按「目标态」设置，不盲目翻转 prefs）
  toggleConversation(): void {
    if (effective.value.conversationShown) {
      // 目标：折叠 —— 写回持久偏好 + 清会话期 override
      prefs.value.conversationCollapsed = true
      overrides.value.explicitOpenConversation = false
    } else {
      // 目标：展开 —— 写回持久偏好；若「偏好展开 + 无 override」会被保护抢回则置 override
      prefs.value.conversationCollapsed = false
      const wouldBe = computeEffectiveLayout(viewportWidth.value,
        { ...prefs.value, conversationCollapsed: false },
        { ...overrides.value, explicitOpenConversation: false },
        LAYOUT_CONSTANTS)
      if (wouldBe.autoCollapsedConversation) {
        overrides.value.explicitOpenConversation = true
      }
      // 置位后复核 effective（P1-2）：若该 override 立即被双 override 兜底回退
      // （如已有 Live2D override、W < NAV+CONV+liveDesired）→ 清位 + toast，不静默
      if (effective.value.droppedConversationOverride) {
        overrides.value.explicitOpenConversation = false
        notice.value = '当前窗口过窄，无法同时显示会话列表与角色栏'
      }
    }
  }
  toggleLive2d(): void {
    if (effective.value.live2dShown) {
      prefs.value.live2dVisible = false
      overrides.value.explicitOpenLive2d = false
    } else {
      prefs.value.live2dVisible = true
      const wouldBe = computeEffectiveLayout(viewportWidth.value,
        { ...prefs.value, live2dVisible: true },
        { ...overrides.value, explicitOpenLive2d: false },
        LAYOUT_CONSTANTS)
      if (wouldBe.autoClosedLive2d) {
        overrides.value.explicitOpenLive2d = true
      }
      if (effective.value.droppedLive2dOverride) {
        overrides.value.explicitOpenLive2d = false
        notice.value = '当前窗口过窄，角色栏无法显示'
      }
      // 重验修复（评审第二轮）：先置的会话栏 override 可能被双 override 兜底回退（droppedConversationOverride），
      // 必须同步清位——否则残留 override 在宽度回升到 [660,1160) 时「复活」，会话栏意外展开、聊天被压到 40px。
      if (effective.value.droppedConversationOverride) {
        overrides.value.explicitOpenConversation = false
        notice.value = '窗口过窄，会话栏暂不可同时显示'
      }
    }
  }
  setLive2dWidth(w: number): void // clamp [300,420] 到 prefs，防抖持久化
  handleViewportChange(w: number): void {
    viewportWidth.value = w
    // 宽度恢复足够 → 清 override（D3 判据）；双 override 兜底回退的 override 也在此同步清位
    if (w >= LAYOUT_CONSTANTS.NAV + LAYOUT_CONSTANTS.CONV + prefs.value.live2dWidth + LAYOUT_CONSTANTS.CHAT_MIN) {
      overrides.value.explicitOpenConversation = false
      overrides.value.explicitOpenLive2d = false
    }
    if (effective.value.droppedConversationOverride) overrides.value.explicitOpenConversation = false
    if (effective.value.droppedLive2dOverride) overrides.value.explicitOpenLive2d = false
  }
  hydrate(): void               // 启动时从 storage 读入（解析失败回默认，clamp 宽度）
  // ...
})
```

说明（toggle 语义）：

- **toggle = 「目标态」动作，不是「翻转」**：按钮反映**有效**态（`aria-pressed` = `effective.conversationShown`/`live2dShown`），动作把系统带到目标态——折叠 = 置 `prefs.*=true` + 清 override；展开 = 置 `prefs.*=false` + **按 wouldBe 判据置 override**。修复了原「翻转 prefs」的两个缺陷：(a) 手动折叠后重开——wouldBe 判据使重开真实有效；(b) 与行为表②矛盾——不再把 `prefs.collapsed` false→true 当成「展开」。
- **wouldBe 判据覆盖两类置位场景**：当前被保护折叠（`autoCollapsed*` 为真，等价于 wouldBe 同判）+ 当前因偏好隐藏但展开后会被抢回（手动折叠 → 重开）。两者统一为「无 override 展开会立即被保护抢回」，即 `wouldBe.autoCollapsed* === true`。
- **窄窗弹回策略**：展开动作置 override 后立即复核 `effective`——若该 override 被双 override 兜底回退（`dropped*` 为真，如已有另一栏 override 且 `W < NAV+CONV+liveDesired`）则**清掉该 override 并弹出轻量提示**（`notice` ref，App.vue 渲染为 toast，数秒后清除；若后续已有全局 toast 机制则复用），而非静默无效果。检测点用「置位后的 effective」，不用 wouldBe（wouldBe 暂清了本栏 override，检测不到「置后被回退」）。
- 持久化由 `prefs` watcher 防抖落盘（override 与 `notice` 不持久化）。

持久化辅助 `src/renderer/src/layout/layout-storage.ts`（可注入 storage 以便单测）：

- key：`cyrene.layout.v1`（命名空间 + schema 版本）；值：`{ version: 1, conversationCollapsed, live2dVisible, live2dWidth }`；
- **读**：key 缺失 / JSON 解析失败 / `version !== 1` / 字段形状非法 → 回默认值（fail-safe，不级联、不抛错）；
- **写**：动作防抖（如 200ms）落盘；`localStorage` 写入失败（配额/禁用）→ `console.warn` 非致命，内存态继续可用；
- 宽度读入即 `clamp(300, 420)`；
- 不持久化 override（会话期）与 viewportWidth（运行时）；
- **hydrate() 时序**：在 `main.ts`（`createPinia()` 之后、`app.mount()` 之前）同步调用，避免首帧闪默认布局；App.vue 只负责挂 ResizeObserver 喂宽度（§4.6）。

**边界说明（与 doc 06 对齐，P1-3 已定案）**：layout 属「UI 状态（折叠栏）· Renderer · 选择性持久化」；**不是**「用户设置 · Main 配置」（主题/模型/凭据类走 Main，属阶段 4/11）。因此 G1 不新增 IPC。

**与 docs/06 §8.1 的冲突与解决**：docs/06 §8.1 `PersistedSettingsV2` 现存 `layout: { conversationPaneCollapsed, live2dPaneVisible, live2dPaneWidth }`（Main 配置）；本 spec 定案走 Renderer localStorage（决策 D6）。理由：

- 布局折叠/开关/栏宽是**纯 UI 状态**：无敏感数据、无跨进程共享需求、无安全边界参与，Renderer 读写即可闭环；
- Main 配置面向需安全边界/多进程一致访问的设置（凭据、模型服务、外观、Live2D **模型/表情等**用户设置）；为 trivial 布局偏好扩 IPC/Preload 面与 schema 迁移负担不划算；
- **Live2D 栏布局（可见/折叠/宽度）与「Live2D 用户设置」（模型/表情/发音，阶段 5）是两回事**：前者是 UI 状态，后者才是 Main 配置的用户设置，二者不冲突；
- 代价（localStorage 仅 Renderer 可用、可能被清）对本组可接受：布局偏好非关键数据，丢失后 fail-safe 回默认布局。

因此 G1 不新增 IPC；**实施时必须实质修订 docs/06 §8.1**——把 `layout` 字段从 `PersistedSettingsV2` 移除/重分类为「UI 状态·选择性持久化」，并同步更新 docs/06 §2 状态分类表（Live2D 栏布局归 UI 状态，与「Live2D 用户设置」区分）与 §3 store 清单（增补 `layoutStore`）。具体修订动作见 §7。

### 4.6 网格实现：grid-template-areas 按有效布局切换（决策 D10）

App.vue 重构为布局宿主：

- `effective-layout.ts` 额外导出纯函数 `gridTemplateFor(effective)`，返回 `{ gridTemplateColumns, gridTemplateAreas }`：

| 有效布局 | columns | areas |
|---|---|---|
| 会话栏 + Live2D 均显 | `60px 260px minmax(0,1fr) {live}px` | `"title title title title" / "nav conv chat live"` |
| 仅会话栏 | `60px 260px minmax(0,1fr)` | `"title title title" / "nav conv chat"` |
| 仅 Live2D | `60px minmax(0,1fr) {live}px` | `"title title title" / "nav chat live"` |
| 均隐藏 | `60px minmax(0,1fr)` | `"title title" / "nav chat"` |

- 行：`36px 1fr`（TITLEBAR_HEIGHT）。
- 各组件显式 `grid-area: nav / conv / chat / live / title`：
  - `CyTitleBar.vue` → `grid-area: title`（保留 `1 / -1` 语义）；
  - `CyNavRail.vue` → `nav`；`CyConversationList.vue` → `conv`；`.cy-main` → `chat`；`CyLive2DPanel.vue` → `live`。
- 隐藏区用 `v-show`（`display:none`）+ 网格列不生成（areas 对应组合），杜绝「隐藏列占位把聊天排进错误列」。
- `chat` 列用 `minmax(0, 1fr)`（允许收缩），`.cy-main` 已有 `min-width: 0`（保留）——聊天区内元素窄屏时文本换行、长内容由其自身滚动（消息级优化属聊天/媒体组）。
- App.vue 挂 `ResizeObserver` 于 `.cy-app` 根元素（更稳，覆盖 DevTools/缩放），rAF 节流 → `layoutStore.handleViewportChange`；`ResizeObserver` 不可用时回退 `window.resize`。**首帧时序（P2-2）**：store 的 `viewportWidth` 初始已用 `window.innerWidth` 播种（见 §4.5），首个 RO 回调必然立即以当前尺寸触发并校正为容器实际宽度——首帧按播种宽度渲染（全四区/折叠正确），不出现「只渲染 nav+chat」的瞬时布局；`hydrate()`（main.ts 同步，mount 前）保证首帧即用持久化偏好，无默认布局闪烁。
- **禁止**：为 Live2D 引入任何 `position: fixed/absolute` 覆盖层；面板内外只允许列内绝对定位装饰（如现有 `.cy-live-glow`）。

### 4.7 组件改造

| 组件 | 变更 |
|---|---|
| `CyNavRail.vue` | 新增「会话列表折叠/展开」按钮（图标 + tooltip + `aria-pressed`=有效 `conversationShown`；`aria-label`「折叠会话列表/展开会话列表」）；放 spacer 之后（常显、键盘可达）；点击调 `toggleConversation()` |
| `CyChatView.vue` | 顶栏 `.cy-header-actions` 新增「角色」开关按钮（doc 03 §6「Live2D 显示切换」）：`aria-pressed`=有效 `live2dShown`，tooltip「显示/隐藏角色」，点击调 `toggleLive2d()`；自动关闭时按钮保持可见即「显式重开入口」。**头部窄宽防御**：`.cy-chat-header` 设 `container-type: inline-size` + `min-width: 0`；会话标题 `h2` 加 `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`（过长截断、悬停显示完整）；连接面板（`min-width: 260px`，REAL 模式下含 Endpoint/Token 输入）经容器查询在头部容器 < 520px 时压缩为「模式徽标 + 连接按钮」单行紧凑态（隐藏输入行），防止 320 防御档/双 override 极端窄聊天下头部横向溢出 |
| `CyConnectionPanel.vue` | 自身 `<style>` 内加容器查询降级规则（作用于最近容器 `.cy-chat-header`）：容器 < 520px 时隐藏 Endpoint/Token 输入行（`.cy-row` 含输入框）并把面板 `min-width` 由 260 降为 auto（只留模式徽标 + 连接/断开按钮）；容器 < 320px 时仅保留连接/断开按钮。规则只改自身呈现，不改布局状态机 |
| `CyLive2DPanel.vue` | 保留占位内容；「折叠角色栏」按钮接线 `toggleLive2d()`；新增左缘拖拽手柄（`cursor: col-resize`，`role="separator"` + `aria-orientation="vertical"`）：pointerdown + pointer capture → pointermove 把指针 x（相对面板左缘 = NAV + 有效会话栏宽）映射为 **pref 宽度**，`clamp` 到 [300, 420] → `setLive2dWidth`；pointerup 释放；期间实时重算有效布局（保护可能自动折叠会话栏腾出空间）；拖拽只写 pref，不直接改列宽 |
| `CyConversationList.vue` | 结构不变（宽 260 已由网格提供）；内部 `min-width: 0` 保留；无新增开关（开关在 NavRail） |
| `CyTitleBar.vue` | `grid-area: title`；无其他改动（拖拽区域非 G1） |
| `App.vue` | 布局宿主：消费 layoutStore，绑定 `grid-template-columns/areas`、挂 ResizeObserver、喂 viewportWidth |
| `main-window.ts` | `minWidth: 1100, minHeight: 700`（从 736×560 改，D9） |

**界面风格**：沿用现有 tokens.css（圆角 10–13px、1px `--cy-border`、`--cy-pane/--cy-surface/--cy-surface-hover`、`--cy-muted/--cy-accent`），不新增颜色；折叠/拖拽等新控件只使用既有 token。

### 4.8 键盘与可访问性（决策 D11）

本组布局层面：

- 两个开关（会话栏折叠、Live2D 显示）均为真实 `<button>`，Tab 可达、Enter/Space 可激活，`aria-pressed`/`aria-expanded` 反映**有效**状态；
- 状态不只靠颜色：有效态由 `aria-pressed` + 图标/文案共同表达；
- 图标按钮提供可读 `aria-label`/`title`；
- 拖拽手柄 `role="separator"`（键盘 resize 为 P1，不做）；
- `ESC` 关闭 Live2D 面板：仅当焦点在面板内（P1 可选，不阻塞本组门禁）；
- **不做全局快捷键**（Ctrl+B/Ctrl+\ 等留 P1，避免与未来输入法/编辑器快捷键冲突）。

### 4.9 错误处理与边界

| 场景 | 处理 |
|---|---|
| localStorage 读入损坏/版本不符/字段非法 | 回默认布局，`console.warn`，不抛错、不级联 |
| localStorage 写入失败（配额/禁用） | 内存态继续，`console.warn`，布局功能不受影响 |
| ResizeObserver 不可用 | 回退 `window.resize` 监听 |
| 拖拽中途 pointer 离开窗口 / 右键 / ESC | 释放 pointer capture，保留最后一次有效宽度 |
| 极端窄宽（< NAV+CHAT_MIN，如 320） | 聊天接受 < 500，但四区 grid 列恒占满且无重叠（结构保证） |
| 无覆盖保证 | Live2D 打开 = 右侧布局列（聊天收窄），结构上不存在覆盖消息/滚动条/输入区的可能；回归检查禁止引入覆盖物 |

### 4.10 数据流

```text
App.vue(ResizeObserver) ──viewportWidth──▶ layoutStore.handleViewportChange
layoutStore ──prefs+overrides+width──▶ computeEffectiveLayout(纯函数) ──▶ effective
effective ──▶ gridTemplateFor ──▶ App.vue :style(grid-template-*) ──▶ 四区网格渲染
用户点 NavRail 折叠 / 聊天顶栏角色 ──▶ layoutStore.toggleConversation/toggleLive2d ──▶ prefs/overrides 更新 ──▶ 重新推导 ──▶ 防抖写 localStorage
拖拽手柄 ──▶ setLive2dWidth ──▶ prefs.live2dWidth ──▶ 实时重算
```

### 4.11 测试（决策 D12）

新增单测（纯函数 + store，符合仓库无组件测试基线）：

| 文件 | 覆盖 |
|---|---|
| `tests/unit/effective-layout.spec.ts` | 动态全四区阈值：W=1160/默认340 全四区不触发保护、W=1200/live2dWidth=420 → 自动折叠会话栏（P2-1，不再断言「1200 必全四区」）；1100+默认触发自动折叠（聊天 700）；显式打开会话栏 → 自动关闭 Live2D；显式打开 Live2D（双 override、W≥660 可并存）→ 聊天接受 440；**双 override 兜底（P1-1）**：W=640 双 override → 回退会话栏 override、聊天 240、`droppedConversationOverride=true`、网格不溢出；W=350 Live2D override → 回退、`droppedLive2dOverride=true`；override 清位（宽到 1160+、主动关闭、兜底回退同步）；clamp [300,420]；**宽度扫描不变式**（W=320..1600 步进 10 × 偏好 × override 全组合（无/会话栏/Live2D/双）：四宽和恒等于 W、**chat ≥ 0 恒成立**、可满足且无有效 override 时 chat ≥ 500、autoCollapsed 仅当 conv>0 且 chat<min 且无有效 override、autoClosed 同理、双 override 并存 ⟺ W ≥ NAV+CONV+liveDesired） |
| `tests/unit/layout-storage.spec.ts` | 读写 round-trip；JSON 损坏/版本不符/形状非法 → 默认；宽度越界读入 clamp；写失败注入 → 不抛、回默认 |
| `tests/unit/layout.store.spec.ts` | hydrate 从 storage 载入；**toggle 目标态（P1-2）**：折叠写 prefs+清 override、展开置 override（wouldBe 判据）、「手动折叠→重开」序列在 1100 下展开真实有效（不再翻转矛盾）；**窄窗弹回 toast**：空间不足展开（含已有另一栏 override、`W<NAV+CONV+liveDesired`）→ 置位后 `effective.dropped*` 复核 → 清掉刚置的 override + `notice` 置位；handleViewportChange 清 override（含 dropped* 同步）；首帧 `viewportWidth` 播种 = window.innerWidth（P2-2）；effective 与 gridTemplateFor 一致性（4 种组合的 columns/areas 字符串断言） |
| `tests/unit/grid-template.spec.ts` | 并入 effective-layout.spec 或独立：4 组合的 columns/areas 精确字符串；列数=areas 列数一致 |

集成/E2E（阶段 3 占位 + 视觉验收）：Playwright 设视口 1100×700 / 900 / 640 / 375 断言「无 Live2D 覆盖聊天」（元素边界不相交）+ vision-MCP 截图检查四档断点无溢出/遮挡；窗口最小尺寸 1100×700 以 `verify:artifact --smoke` + 人工实机确认（BrowserWindow min-size 无法脱离 Electron 单测）。

**门禁**：`pnpm typecheck`、`pnpm lint`、`pnpm test`（527 + 本组新增，预计 +35~45 断言 / 3~4 个新单测文件，grid-template 视合并情况并入 effective-layout）、`xvfb-run -a pnpm test:integration`（23，本组不动 IPC 面，预期不回退）、`pnpm build`、`pnpm -F @cyrene/desktop check:contract`（13/13 不变，纯前端布局无 wire 契约变化）、`pnpm package` + `verify:artifact --smoke`（Main 最小尺寸改动波及打包路径，须复跑）。

**三态状态源**：G1 为纯前端布局，无真实后端联调对象；本地门禁全绿 + Playwright/vision-MCP 视觉记录后标「已验证」（不适用「已开发、未联调」——无联调对象；窗口最小尺寸属本地行为，实机记录即可）。

## 5. 验收与门禁（对照 docs/16 §6 阶段 3 本组相关项）

- [ ] **1100×700 可用，窄窗口无 Live2D 覆盖聊天**：最小窗口 1100×700（Main）；有效布局推导 + 网格结构保证；Playwright 视口 1100/900/640/375 元素边界不相交；
- [ ] **四区布局在四档断点下无溢出/遮挡**：width 扫描单测不变式（含 override 全组合：任何 W 下 chat ≥ 0、网格不溢出）+ media query/容器查询视觉微调 + vision-MCP 截图；聊天头部在 320 防御档/双 override 极端窄聊天下无横向溢出（标题省略 + 连接面板压缩）；全四区阈值按 `NAV+CONV+live2dWidth+CHAT_MIN` 动态验收（不要求「1200 必全四区」，P2-1）；
- [ ] **会话栏折叠/Live2D 开关与宽度有布局记忆**：layout-storage 单测 + 重启恢复人工记录（Renderer localStorage，P1-3 定案；docs/06 §8.1 按 §7 实质修订）；
- [ ] **主要操作可键盘完成（本组布局层面）**：两个开关 Tab + Enter/Space；`aria-pressed` 有效态；
- [ ] **Live2D 默认显示**：prefs 默认 `live2dVisible: true`；宽窗不操作即显示；
- [ ] **显式重开入口真实有效**：聊天顶栏「角色」按钮在自动关闭后仍可见、可点、可恢复（override 语义）；「手动折叠 → 重开」序列在窄窗下重开真实有效（P1-2 wouldBe 判据）；空间不足以同时容纳时给 toast 提示而非静默无效果（P1-1 兜底）；
- [ ] 门禁全绿 + 打包冒烟不回归 + 文档同步（§7）。

## 6. 已知限制（记录，待实机/后续组）

- **断点 736/520/320 在最小窗口 1100 下常态不可达**：为防御层 + 可测性（字体缩放/WM 忽略最小尺寸/DevTools/浏览器预览/Playwright 视口）；算法与 media query 均已正确实现；「实机后再微调数值」是既定口径。
- **窗口位置/大小持久化不在 G1**：doc 03 §3.2 布局记忆含窗口 bounds，但 G1 范围明确仅「会话栏/Live2D 开关与宽度」；窗口 bounds 归 Main 窗口生命周期组（开放项）。
- **最后访问页面持久化不在 G1**（doc 03 §3.2 列项）。
- **消息级窄屏表现**（长代码/表格横向滚动、图片缩放、Markdown 窄屏）属聊天/媒体组；G1 只保证容器层不溢出、不遮挡。
- **无组件级单测**（仓库无 @vue/test-utils 基线）：App.vue 网格绑定经 Playwright 视口 + vision-MCP 验收，不以组件单测为门禁。
- **ESC 关 Live2D 与全局快捷键**为 P1 可选，不阻塞本组。
- **Live2D 拖拽手柄键盘 resize**（P1）不做；仅鼠标/指针。
- **BrowserWindow min-size 无法脱离 Electron 单测**：以 `verify:artifact --smoke` + 人工实机确认。

## 7. 文档同步（实施后）

- 本 spec 落 `docs/superpowers/specs/2026-08-14-phase3-layout-responsive-design.md`；
- `docs/16`：阶段 3「四区主布局/会话栏折叠/Live2D 右栏预留」「落地 1200/736/520/320 响应式规则」勾选 + 测试数字 + 变更记录行；
- `docs/06`：**实质修订（P1-3 定案动作，非仅注记）**：
  1. §8.1 把 `layout: { conversationPaneCollapsed, live2dPaneVisible, live2dPaneWidth }` 从 `PersistedSettingsV2` **移除/重分类**为「UI 状态·选择性持久化」（Renderer localStorage，key `cyrene.layout.v1`），并加迁移注记（旧配置若存在则忽略）；
  2. §2 状态分类表：新增/归类「UI 状态——折叠栏、Live2D 栏布局（可见/折叠/宽度）」一行，并在「用户设置」行注明该行 Live2D 仅指 Live2D **模型/表情/发音等设置**，与栏布局 UI 状态区分；
  3. §3 store 清单增补 `layoutStore`；§8 增补「UI 状态·选择性持久化」分节并给 layoutStore 作为实例。
  理由（决策 D6）：布局折叠/开关/栏宽为纯 UI 状态、非敏感、无跨进程共享需求，Main 配置只保留需安全边界/多进程一致访问的设置；为 trivial 偏好扩 IPC/Preload 面与 schema 迁移负担不划算；localStorage 丢失后 fail-safe 回默认布局，代价可接受。修订后 docs/06 不再与 G1 实现自相矛盾。
- `docs/03`：§3.1 数值微调时同步（「实机后再微调」）；§3.2 布局记忆范围标注（窗口 bounds 归后续组）；
- `docs/13`：item 11「Live2D 默认展开状态、宽度、聊天最小宽度、极窄阈值」已由本组锁定决策定案（Live2D 默认显示、340 可调、最小窗口 1100×700、窄窗自动折叠/关闭规则），实施时从「仍需外部确认」清单移除并登记；
- README / CLAUDE.md：阶段 3 G1 落地状态 + 三态状态源更新；
- 若断点/区宽数值实机微调，同步更新 `layout/constants.ts`、docs/03、docs/16 与 README。
