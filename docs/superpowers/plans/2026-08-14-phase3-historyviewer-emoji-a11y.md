# 阶段 3 G4：统一聊天历史查看器 + Emoji/表情包 + 无障碍 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地阶段 3 G4「历史查看器 + 表情 + 无障碍」——QQ 式全窗覆盖历史查看器（关键词/本地自然日/分类组合查询、不透明游标分页、来源跳转与高亮）、Emoji 光标插入与最近优先（localStorage 非敏感例外）、表情包内置 `st_` 清单 + PendingSticker 待发送 + wire `stickerId` + 查看器表情分类集中查看 + 气泡内 sticker 分段渲染、模态/键盘/焦点/IME 无障碍（`isCompositionEnter` 守卫硬化）、贴图复用 G3 通用媒体代理 `cyrene://renderer/__cyrene-media/sticker/{stickerId}`、「绘画资源」文档概念清理。

**Architecture:** 按信任边界分层——Renderer 只经 historyViewerStore 消费查询/分页/跳转编排，所有查询/跳转只走 Preload 窄接口（`queryChatHistory`/`getMessageContext`/`listStickers` 3 新通道）；Main 消化协议差异（`localDate+timeZone` → 后端 `date_from/date_to` 半开区间由 shared/domain 纯函数换算、category 枚举映射、search/context/stickers 响应 Schema 校验 + RestMapper 归一化为 `ChatHistoryItem`）。**（P0-1）**search item 按 `frontend_contract/rest.py` 为 camelCase 纯文本命中（无 kind/url），RestMapper 只映射文本字段、不产 resource；查看器「图片/视频/表情」分类缩略图设计缺口见 Task 6 后「P0-1 设计缺口」（spec 开放项）。查看器为纯 DOM 覆盖层不阻塞聊天流（D10）；跳转复用 `activate(id, anchor?)` epoch 守卫 + `getMessageContext` 上下文窗口 + 高亮状态；贴图继承 G3 通用媒体代理（stickerId/MIME/fetch host 白名单 + 1MB 上限 + 导航 deny + `Sec-Fetch-Dest: document` 拒绝），CSP 仅 dev 两处 `img-src` 追加 `cyrene:`（prod 同源 `'self'` 即放行；spec §5 D9「dev 三处」为残留不一致，以 §4.6 两处为准，P2-3）。

**Tech Stack:** Electron + Vue 3 + TypeScript（strict）+ Pinia（setup store）+ Vitest（node 环境）+ zod（仅 IPC 边界）+ `Intl`（日期时区换算，**不新增运行时依赖**，无日期库/无新 scheme 注册）。

**Spec:** `docs/superpowers/specs/2026-08-14-phase3-historyviewer-emoji-a11y-design.md`（v1 定稿 + 两轮修订，已闭环：D1-D15、P1-1、P2-1~2-4、P3-1~3-4）。实施者以 spec 为准；本计划每任务引用对应 spec 章节（§2 范围 / §3.1 缺口表 / §3.2 技术约束 / §4.2-4.9 设计 / §4.10 文档清理 / §5 决策 D1-D15 / §6 验收 / §7 开放项）。

**评审修订轮次（2026-08-14 独立评审，修订 commit 83b9c08 之后）：** 修复 **2 P0 + 3 P1 + 5 P2**，全部对照 `frontend_contract/rest.py`（contract.raw.ts）验证：
- **P0-1**：search wire 形状与后端契约不符——`RestSearchMessageItem` 改为 camelCase `{conversationId, messageId, responseId?, segmentId?, role, timestamp, snippet}`（**无 kind/url/sticker_id**，删除发明出的 snake_case 字段）；`toChatHistoryItem` 改为仅文本映射（snippet→文案，无 resource 缩略图）；Task 6/7 fixture 同步改 camelCase。查看器「图片/视频/表情」分类缩略图依赖 search item 不携带 kind/url，已标注为 **spec 开放项设计缺口**（见 Task 6 后「P0-1 设计缺口」）。
- **P0-2**：`/api/stickers` 响应与契约不符——对齐 `StickerEntry{stickerId, src}` / `StickerListResponse{stickers:[...]}`，领域 `StickerManifest{stickers}`（原 `{items:{id,name,url,version}}` 为发明形状）；Task 4/5/6/7/8/10/11/18 同步。
- **P1-1**：Task 13 `loadContextWindow` 测试断言 `toBe(2)` 与实现（窗口+首页两页去重合并共 3 条）矛盾 → 改 `toBe(3)`。
- **P1-2**：Task 15 `history-viewer.store.spec.ts` beforeEach 补 `setActivePinia(createPinia())`（node 环境无全局 pinia，否则每用例崩溃）。
- **P1-3**：CyEmojiPicker 网格容器 `@keydown` 取 `currentTarget.dataset.emoji` 恒 undefined（Enter/Space 插空串）→ 改逐按钮 `@keydown`（对齐 CyStickerPanel）。
- **P2-1**：删「check:contract 门禁对齐 REST 形状」错误说法（check:contract 不覆盖 REST schema，改「按 `frontend_contract/rest.py` 人工核对」）；`'image,video'` 组合串在契约无出处，按资源端点单值枚举 `image|link|video|audio|file|sticker` 处理。
- **P2-2**：Task 12 依赖 G3 内部成员（`svc.stream`/`mkService`/`STICKER_MIME`）加全局约束与 G3 落地前替代。
- **P2-3**：spec §5 D9 决策表「dev 三处」为残留不一致，**以 spec §4.6「dev 两处」为准**（本计划已按两处），最终报告汇报并修 spec。
- **P2-4**：Task 9/10/13/14 测试脚手架占位补真实 import/断言（Task 10 对齐 `desktop-api-chat.spec.ts` 的 `importDesktopApi`+`mockIpc` 注入式）。
- **P2-5**：Task 15 补「打开查看器不阻塞聊天流（store 事件继续应用）」测试（spec §4.9）。

---

## Global Constraints（subagent 必须遵守，逐条绑定）

1. **TypeScript 严格**：新增/修改文件必须过 `pnpm -F @cyrene/desktop typecheck`（typecheck:node 覆盖 main/preload/shared，typecheck:web 覆盖 renderer）。
2. **zod 只在 IPC 边界**：request/response schema 只出现在 `main/ipc/channels.ts`、`shared/schemas/ipc-response.ts`、`preload/desktop-api.ts` 的防御性解析；Main 传输层用 REST 响应 schema（`rest-schemas.ts`，遵循既有 parseRest* 模式）；Renderer 纯逻辑层一律不用 zod（类型守卫 + 手检）。
3. **不新增运行时依赖**：日期换算只用 `Intl`；无 dayjs/luxon/emoji-picker 库；无新 `cyrene` scheme 注册（沿用既有 `cyrene` scheme + `renderer` host）。
4. **Renderer 不可信、不直连后端**：查看器查询/跳转只经 Preload 窄接口；贴图/媒体 URL 不得以后端任意源直连渲染（CSP 保持收紧）；`cyrene://renderer/__cyrene-media/sticker/{stickerId}` 是 Renderer 贴图唯一来源。
5. **协议差异收敛在 Main**：`ChatHistoryQuery` 的 `localDate+timeZone`→`date_from/date_to`、`category` 枚举映射、search item→`ChatHistoryItem` 归一化全部在 RealBackend/RestMapper 内；wire 字段不泄漏进 Vue。
6. **不透明游标**：分页用 `nextCursor`（后端 base64 串，前端不解析内容）；Mock 游标用 `mock:{offset}` 透明值仅限 Mock（前端同样不解析）。
7. **单写者口径（FE-INT-RISK-01）**：查看器为只读消费；跳转复用既有激活路径，不新增写入。
8. **响应 Schema 严格镜像契约（C1）**：字段可丢即契约形状漂移，禁止为「宽松」而放宽必填项；Main 侧协议错误显式报错（`SCHEMA_VALIDATION_FAILED` 等）。
9. **TDD 红-绿-提交**：每任务先写失败测试→跑（FAIL）→最小实现→跑（PASS）→commit；commit 消息 `feat/fix/test/docs(...)`，中文说明（如 `feat(G4 history): ...`）。组件任务无单测基线（spec §6 已知限制），以 `typecheck` + `build` 为准 + 验收点清单。
10. **文档编辑保持中文**（docs 集约定）。
11. **G3 依赖（锁定）**：本计划消费 G3 交付的 `cyrene://renderer/__cyrene-media/sticker/{stickerId}` 通用媒体代理（`parseMediaPath`/`isDocumentRequest`/`MediaService.stream`/handler 媒体分支/导航 `__cyrene-media` deny，见 `docs/superpowers/plans/2026-08-14-phase3-attachments-media.md` Task 8/9）与 `shared/contracts/attachments.ts` 的 `PendingSticker` 类型（G3 Task 2 产出）。**执行顺序须在 G3 落地之后**；本计划 Task 12 只做 G4 特有硬化（1MB 上限 + MIME 剥参 trim + dev CSP `img-src cyrene:`），不重复实现通用代理。**（P2-2）**Task 12 的测试脚手架引用了 G3 尚未交付的内部成员（`mkService`/`STICKER_MIME`/`svc.stream` 等方法级形状）——执行时须：① G3 落地后，Task 12 先与 G3 `media-service.ts` 实际实现对齐，若 G3 内部形状与 Task 12 代码不一致则以 G3 为准**重写 Task 12 代码/测试**；② G3 未落地前，不得把 `mkService` 等当已存在成员使用——改为按 spec §4.6 定义的 `MediaService` 接口写**契约测试**（只测 G4 硬化语义：1MB 上限、MIME 剥参、dev CSP），并在测试文件头标注「待 G3 落地后接入真实 `MediaService`」。
12. **门禁**（Task 21 全量复跑）：`typecheck` / `lint` / `test`（527 现有 + 本组新增）/ `xvfb-run -a pnpm test:integration` / `build` / `pnpm -F @cyrene/desktop check:contract`（13/13，schema 结构不动——`content` 保持 `unknown`）/ `package` + `verify:artifact --smoke`。**（P2-1）**`check:contract` 只覆盖 IPC/WS wire 契约（`frontend_contract` 的 schema/ws 指纹），**不覆盖本组 REST schema**——REST 形状（search/context/stickers）按 `frontend_contract/rest.py` **人工核对**，不依赖 check:contract 门禁。
13. **三态状态源**：本组依赖真实后端 search/context/stickers 端点，本地门禁全绿后标「**已开发、未联调**」，不得标「已完成」（spec §6 验收最后一项）；真实联调复验后升「已真实联调」。
14. **文档清理范围**：docs/10 §6.1、docs/03 §7.7/§15、docs/16 §6 四处必改（用户锁定）+ docs/00/01/08/13 同概念顺带清扫（spec §4.10）。

---

## 文件结构（新建 / 修改）

**新建（shared / main / renderer）：**
- `apps/desktop/src/shared/domain/history-date.ts` —— 日期时区纯函数（D3）
- `apps/desktop/src/shared/domain/sticker-url.ts` —— `stickerIdFromResourceUrl`/`stickerRenderUrl`（P3-3）
- `apps/desktop/src/shared/domain/ime-guard.ts` —— `isCompositionEnter`（D14）
- `apps/desktop/src/shared/contracts/sticker.ts` —— `StickerItem`/`StickerManifest`（D8）
- `apps/desktop/src/renderer/src/utils/recent-emoji.ts` —— 最近 Emoji localStorage 纯函数（D7）
- `apps/desktop/src/renderer/src/stores/historyViewer.store.ts` —— 独立 Pinia store（D4）
- `apps/desktop/src/renderer/src/components/CyHistoryViewer.vue`、`CyHistoryResultItem.vue`、`CyEmojiPicker.vue`、`CyStickerPanel.vue`（D1/D7/D8/D14）

**新建（测试）：**
- `apps/desktop/tests/unit/history-date.spec.ts`、`sticker-url.spec.ts`、`ime-guard.spec.ts`、`history-contracts.spec.ts`、`rest-search-mapper.spec.ts`、`real-backend-search.spec.ts`、`mock-backend-search.spec.ts`、`chat-history-query.spec.ts`、`history-viewer.store.spec.ts`、`recent-emoji.spec.ts`
- `apps/desktop/tests/integration/history-viewer-ipc.spec.ts`

**修改：**
- `apps/desktop/src/shared/domain/index.ts`（export 三个新模块）
- `apps/desktop/src/shared/contracts/backend.ts`（ChatHistoryQuery/ChatHistoryItem/ChatHistoryPage/ConversationResource/HistoryCategory/ChatHistoryScope）
- `apps/desktop/src/shared/contracts/message.ts`（AssistantSegment.stickerId?、Message.stickerId?、SendMessageInput.stickerId?）
- `apps/desktop/src/shared/contracts/ipc.ts`（3 通道常量）、`index.ts`（export sticker）
- `apps/desktop/src/shared/schemas/ipc-response.ts`（ConversationResourceSchema/ChatHistoryItemSchema/ChatHistoryPageSchema/StickerManifestSchema + AssistantSegment/Message stickerId）
- `apps/desktop/src/main/ipc/channels.ts`（chatQueryHistorySchema/chatGetMessageContextSchema/chatListStickersSchema + chatSendSchema.stickerId）
- `apps/desktop/src/main/chat/chat-handlers.ts`（3 通道注册）、`chat-service.ts`（3 方法透传）
- `apps/desktop/src/main/transport/backend-adapter.ts`（listStickers 接口）
- `apps/desktop/src/main/transport/real-backend.ts`（queryChatHistory/getMessageContext/listStickers + sendMessage wire stickerId）
- `apps/desktop/src/main/transport/mock-backend.ts`（三方法 + 消息记录）
- `apps/desktop/src/main/transport/protocol-v2/rest-types.ts`、`rest-schemas.ts`、`rest-mapper.ts`（search/context/stickers 响应类型、schema、映射）
- `apps/desktop/src/main/attachments/media-service.ts`（streamSticker 1MB 上限 + MIME 剥参 trim，G4 硬化）
- `apps/desktop/src/main/config/dev-csp.ts`、`apps/desktop/src/renderer/index.html`（dev `img-src` 加 `cyrene:`，幂等加固）
- `apps/desktop/src/preload/desktop-api.ts`（3 方法）
- `apps/desktop/src/renderer/src/stores/desktop-api.types.ts`（DesktopApiLike +3）
- `apps/desktop/src/renderer/src/stores/message.store.ts`（高亮/nextCursor/loadEarlier/loadContextWindow/send stickerId）
- `apps/desktop/src/renderer/src/stores/conversation.store.ts`（activate(id, anchor?) + jumpToMessage）
- `apps/desktop/src/renderer/src/components/CyChatInput.vue`、`CyChatView.vue`、`CyMessageBubble.vue`、`App.vue`

**文档（Task 20/21）：** spec §4.10 的「绘画资源」替换（docs/10 §6.1、docs/03 §7.7/§15、docs/16 §6 必改 + docs/00/01/08/13 顺带）；docs/16 状态行 + README/CLAUDE.md 三态标记。

**范围外（不做）：** 附件上传/下载/媒体渲染管线（G3）；表情包收藏/同步（D13）；会话标题/摘要搜索；消息虚拟滚动；`/api/sessions/{id}/resources` 独立资源窗口（D15，资源经查看器分类查询统一呈现）；历史离线缓存；Live2D 表情联动；G2 草稿。

---

### Task 1: 日期时区纯函数 `history-date.ts`（D3）

> `localDate(YYYY-MM-DD) + IANA timeZone → 半开区间 [本地日起始, 次日本地日起始) 的 UTC ISO 串`；`ISO 时间 → 用户本地自然日标签`。用 `Intl.DateTimeFormat` 时间组件换算，禁止 naive `new Date(y,m,d-1)`/手动 `+8h`（docs/02 §11 避免 UTC 跨日错误）。双端复用（Main 换算 date_from/date_to，Renderer 结果日期分组）。

**Files:**
- Create: `apps/desktop/src/shared/domain/history-date.ts`
- Modify: `apps/desktop/src/shared/domain/index.ts`
- Test: `apps/desktop/tests/unit/history-date.spec.ts`

**Interfaces:**
- Produces（Task 7 RealBackend、Task 8 MockBackend、Task 15 buildQuery/结果分组 消费）：
  - `export function localDateToHalfOpenRange(localDate: string, timeZone: string): { from: string; to: string }`
  - `export function isoToLocalDate(iso: string, timeZone: string): string`

- [ ] **Step 1: 写失败测试** —— `apps/desktop/tests/unit/history-date.spec.ts`

```typescript
// tests/unit/history-date.spec.ts
// Task 1:日期时区纯函数（spec §4.4，D3）——localDateToHalfOpenRange / isoToLocalDate，Intl 实现。
// env=node：Intl 全 ICU 可用，无需 Electron。
import { describe, expect, it } from 'vitest'
import { isoToLocalDate, localDateToHalfOpenRange } from '../../src/shared/domain/history-date'

describe('localDateToHalfOpenRange（本地自然日 → UTC 半开区间）', () => {
  it('Asia/Shanghai（UTC+8，无 DST）：本地日映射前一日 16:00Z 起', () => {
    expect(localDateToHalfOpenRange('2026-08-14', 'Asia/Shanghai')).toEqual({ from: '2026-08-13T16:00:00.000Z', to: '2026-08-14T16:00:00.000Z' })
  })
  it('America/New_York 冬季 EST（UTC-5）', () => {
    expect(localDateToHalfOpenRange('2026-01-15', 'America/New_York')).toEqual({ from: '2026-01-15T05:00:00.000Z', to: '2026-01-16T05:00:00.000Z' })
  })
  it('America/New_York 夏季 EDT（UTC-4，夏令时跨日正确）', () => {
    expect(localDateToHalfOpenRange('2026-07-15', 'America/New_York')).toEqual({ from: '2026-07-15T04:00:00.000Z', to: '2026-07-16T04:00:00.000Z' })
  })
  it('相邻两日区间无缝衔接（半开区间不重不漏）', () => {
    const a = localDateToHalfOpenRange('2026-08-14', 'Asia/Shanghai')
    const b = localDateToHalfOpenRange('2026-08-15', 'Asia/Shanghai')
    expect(a.to).toBe(b.from)
  })
})

describe('isoToLocalDate（UTC 时间 → 用户本地自然日标签）', () => {
  it('UTC 前一日深夜 → 上海本地次日（跨 UTC 日）', () => {
    expect(isoToLocalDate('2026-08-13T17:00:00.000Z', 'Asia/Shanghai')).toBe('2026-08-14')
  })
  it('本地日边界内不跨日', () => {
    expect(isoToLocalDate('2026-08-14T15:59:00.000Z', 'Asia/Shanghai')).toBe('2026-08-14')
  })
  it('纽约冬季 UTC-5：本地日与 UTC 日一致/边界 04:59Z 仍属前一日', () => {
    expect(isoToLocalDate('2026-01-15T10:00:00.000Z', 'America/New_York')).toBe('2026-01-15')
    expect(isoToLocalDate('2026-01-15T04:59:00.000Z', 'America/New_York')).toBe('2026-01-14')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/history-date.spec.ts`
Expected: FAIL——模块 `history-date` 不存在。

- [ ] **Step 3: 最小实现** —— `apps/desktop/src/shared/domain/history-date.ts`

```typescript
// src/shared/domain/history-date.ts
// 阶段 3 G4（spec §4.4，D3）：日期时区纯函数（Intl 实现，双端复用）。
// 禁止 naive 本地日期假设（docs/02 §11「避免 UTC 跨日错误」）；无 Electron/无状态依赖。

function getTimezoneOffsetMs(timeZone: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'
  })
  const parts = dtf.formatToParts(new Date(utcMs))
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0)
  const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return wallAsUtc - utcMs   // 该 UTC 瞬间下目标时区的偏移（ms）
}

/** 目标时区「本地墙钟时间」→ UTC 毫秒（两遍法：先按墙钟当 UTC 算偏移再修正，正确处理 DST 常规场景） */
function zonedTimeToUtc(y: number, m: number, d: number, h: number, min: number, s: number, timeZone: string): number {
  const asUtc = Date.UTC(y, m - 1, d, h, min, s)
  return asUtc - getTimezoneOffsetMs(timeZone, asUtc)
}

/** localDate(YYYY-MM-DD) + IANA timeZone → 半开区间 [本地日起始, 次日本地日起始) 的 UTC ISO 串 */
export function localDateToHalfOpenRange(localDate: string, timeZone: string): { from: string; to: string } {
  const [y, m, d] = localDate.split('-').map(Number)
  const from = new Date(zonedTimeToUtc(y, m, d, 0, 0, 0, timeZone)).toISOString()
  const to = new Date(zonedTimeToUtc(y, m, d + 1, 0, 0, 0, timeZone)).toISOString()   // Date.UTC 自动处理月/日进位
  return { from, to }
}

/** ISO 时间 → 用户本地自然日标签(YYYY-MM-DD)，供结果日期分组 */
export function isoToLocalDate(iso: string, timeZone: string): string {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const parts = dtf.formatToParts(new Date(iso))
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}
```

`apps/desktop/src/shared/domain/index.ts` 追加 `export * from './history-date'`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/history-date.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: PASS（9 tests）+ typecheck 绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/domain/history-date.ts apps/desktop/src/shared/domain/index.ts apps/desktop/tests/unit/history-date.spec.ts
git commit -m "feat(G4 history): 日期时区纯函数 localDateToHalfOpenRange/isoToLocalDate（D3）"
```

---

### Task 2: `sticker-url.ts` —— `stickerIdFromResourceUrl` + `stickerRenderUrl`（P3-3）

> 历史项 `resource.url`（后端路径如 `/static/stickers/st_xxx.png`）→ stickerId（pathname 末段去 `.png` 后缀 + 白名单 `^st_[A-Za-z0-9-]+$` 校验）→ 构造 `cyrene://renderer/__cyrene-media/sticker/{stickerId}` 渲染 URL；校验失败返回 undefined（该历史项按「无贴图」占位，不注入任意 URL）。**（P0-1）**P3-3 映射原消费方是 Task 6 search item 的 resource.url；search item 现无 kind/url，该函数当前无 search 路径消费——保留为**资源端点补充路径（开放项）与 `stickerRenderUrl` 派生的纯函数**（`stickerRenderUrl` 由 CyStickerPanel/CyMessageBubble 经 manifest stickerId 消费），`stickerIdFromResourceUrl` 仍随本任务交付供未来 resource 富化复用。

**Files:**
- Create: `apps/desktop/src/shared/domain/sticker-url.ts`
- Modify: `apps/desktop/src/shared/domain/index.ts`
- Test: `apps/desktop/tests/unit/sticker-url.spec.ts`

**Interfaces:**
- Consumes: 无
- Produces（`stickerRenderUrl` 由 Task 18 CyStickerPanel / Task 19 CyMessageBubble 消费；`stickerIdFromResourceUrl` 为资源端点补充路径（P0-1 开放项）保留）：
  - `export function stickerIdFromResourceUrl(url: string): string | undefined`
  - `export function stickerRenderUrl(stickerId: string): string`

- [ ] **Step 1: 写失败测试** —— `apps/desktop/tests/unit/sticker-url.spec.ts`

```typescript
// tests/unit/sticker-url.spec.ts
// Task 2:历史资源 URL → stickerId 解析 + 渲染 URL 构造（spec §4.6 P3-3）。
// env=node：纯函数，无 Electron。
import { describe, expect, it } from 'vitest'
import { stickerIdFromResourceUrl, stickerRenderUrl } from '../../src/shared/domain/sticker-url'

describe('stickerIdFromResourceUrl', () => {
  it('绝对路径末段提取 st_ ID（.png 后缀）', () => {
    expect(stickerIdFromResourceUrl('http://127.0.0.1:9000/static/stickers/st_abc.png')).toBe('st_abc')
  })
  it('相对路径末段提取（与配置后端 origin 拼接等价）', () => {
    expect(stickerIdFromResourceUrl('/static/stickers/st_abc.png')).toBe('st_abc')
  })
  it('带 query 参数容忍', () => {
    expect(stickerIdFromResourceUrl('/static/stickers/st_abc.png?v=2')).toBe('st_abc')
  })
  it('无 .png 后缀也可', () => {
    expect(stickerIdFromResourceUrl('/static/stickers/st_abc')).toBe('st_abc')
  })
  it('非 st_ 前缀拒', () => {
    expect(stickerIdFromResourceUrl('/static/stickers/foo.png')).toBeUndefined()
  })
  it('畸形 id（大小写/非法字符/路径穿越）拒——不注入任意 URL', () => {
    expect(stickerIdFromResourceUrl('/static/stickers/ST_ABC.png')).toBeUndefined()      // 白名单 ^st_[A-Za-z0-9-]+$（小写 st_）
    expect(stickerIdFromResourceUrl('/static/stickers/st_.._x.png')).toBeUndefined()
    expect(stickerIdFromResourceUrl('/static/stickers/../secret.png')).toBeUndefined()   // URL 归一化后末段 secret.png
    expect(stickerIdFromResourceUrl('/static/stickers/st_1/x.png')).toBeUndefined()      // 末段 x.png
  })
  it('空/畸形 URL → undefined', () => {
    expect(stickerIdFromResourceUrl('')).toBeUndefined()
    expect(stickerIdFromResourceUrl('::::')).toBeUndefined()
  })
})

describe('stickerRenderUrl', () => {
  it('构造通用媒体代理 URL（G3 协议，D9）', () => {
    expect(stickerRenderUrl('st_abc')).toBe('cyrene://renderer/__cyrene-media/sticker/st_abc')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/sticker-url.spec.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 最小实现** —— `apps/desktop/src/shared/domain/sticker-url.ts`

```typescript
// src/shared/domain/sticker-url.ts
// 阶段 3 G4（spec §4.6 P3-3）：历史资源 URL → stickerId 解析 + 渲染 URL 构造。
// stickerId 白名单 ^st_[A-Za-z0-9-]+$（D-07 st_ 前缀 + 安全字符）；校验失败回 undefined，绝不注入任意 URL。
export const STICKER_ID_PATTERN = /^st_[A-Za-z0-9-]+$/

/** 历史项 resource.url（后端路径，如 /static/stickers/st_xxx.png）→ stickerId；非法回 undefined。
 *  相对路径以固定占位 origin 解析取 pathname 末段（等价 new URL(url, 配置后端 origin).pathname 的末段，URL 归一化已处理 `..`）。 */
export function stickerIdFromResourceUrl(url: string): string | undefined {
  if (!url) return undefined
  let pathname: string
  try {
    pathname = new URL(url, 'http://cyrene.invalid').pathname
  } catch {
    return undefined
  }
  const tail = pathname.split('/').filter(Boolean).pop() ?? ''
  const id = tail.replace(/\.png$/i, '')
  return STICKER_ID_PATTERN.test(id) ? id : undefined
}

/** 渲染 URL 构造（复用 G3 通用媒体代理，无新 scheme） */
export function stickerRenderUrl(stickerId: string): string {
  return `cyrene://renderer/__cyrene-media/sticker/${encodeURIComponent(stickerId)}`
}
```

`apps/desktop/src/shared/domain/index.ts` 追加 `export * from './sticker-url'`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/sticker-url.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: PASS（9 tests）+ typecheck 绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/domain/sticker-url.ts apps/desktop/src/shared/domain/index.ts apps/desktop/tests/unit/sticker-url.spec.ts
git commit -m "feat(G4 history): stickerIdFromResourceUrl/stickerRenderUrl 纯函数（P3-3）"
```

---

### Task 3: `ime-guard.ts` —— `isCompositionEnter`（D14）

> IME 合成守卫抽纯函数，`CyChatInput.onEnter` 与查看器搜索框共用并单测：`e.isComposing || e.keyCode === 229`（组词确认 Enter 不发送/不搜索）。

**Files:**
- Create: `apps/desktop/src/shared/domain/ime-guard.ts`
- Modify: `apps/desktop/src/shared/domain/index.ts`
- Test: `apps/desktop/tests/unit/ime-guard.spec.ts`

**Interfaces:**
- Produces（Task 19 CyChatInput/查看器搜索框 消费）：
  - `export function isCompositionEnter(e: { isComposing?: boolean; keyCode?: number }): boolean`

- [ ] **Step 1: 写失败测试** —— `apps/desktop/tests/unit/ime-guard.spec.ts`

```typescript
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/ime-guard.spec.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 最小实现** —— `apps/desktop/src/shared/domain/ime-guard.ts`

```typescript
// src/shared/domain/ime-guard.ts
// 阶段 3 G4（spec §4.7，D14 硬化②）：IME 合成期间 Enter 是候选确认，不得触发发送/搜索。
export function isCompositionEnter(e: { isComposing?: boolean; keyCode?: number }): boolean {
  return e.isComposing === true || e.keyCode === 229
}
```

`apps/desktop/src/shared/domain/index.ts` 追加 `export * from './ime-guard'`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/ime-guard.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: PASS（3 tests）+ typecheck 绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/domain/ime-guard.ts apps/desktop/src/shared/domain/index.ts apps/desktop/tests/unit/ime-guard.spec.ts
git commit -m "feat(G4 a11y): isCompositionEnter IME 组合守卫纯函数（D14）"
```

---

### Task 4: 共享契约收敛（D2/D7/D8）+ 贴图消息字段（开放项落地）

> `ChatHistoryQuery` 收敛到 docs/02 §19 形状（scope/query/localDate/timeZone/category/cursor/limit，`items` 改 `ChatHistoryItem[]`，废弃占位 keyword/fromDate/toDate）；`ChatHistoryItem`/`ConversationResource`/`HistoryCategory`/`ChatHistoryScope`；`StickerItem`/`StickerManifest`（新建 sticker.ts，**P0-2 对齐契约 `StickerEntry{stickerId, src}`/`StickerListResponse{stickers}`**）；`SendMessageInput.stickerId?`；`AssistantSegment.stickerId?` + `Message.stickerId?`（§7 开放项「用户贴图消息 wire 表示待确认」本组按可选字段落地，联调对齐）。**（P0-1）**`ConversationResource` 保留为领域契约（spec §4.3 定义，资源端点字段补全参考），但 search item 不携带 kind/url——真实后端 search 路径不产 `resource`，详情见 Task 6。

**Files:**
- Modify: `apps/desktop/src/shared/contracts/backend.ts`
- Modify: `apps/desktop/src/shared/contracts/message.ts`
- Create: `apps/desktop/src/shared/contracts/sticker.ts`
- Modify: `apps/desktop/src/shared/contracts/ipc.ts`、`apps/desktop/src/shared/contracts/index.ts`
- Test: `apps/desktop/tests/unit/history-contracts.spec.ts`

**Interfaces:**
- Consumes: 无（独立契约层）
- Produces（Task 5-21 全链消费）：
  - `export type HistoryCategory = 'all' | 'image_video' | 'sticker' | 'file' | 'audio' | 'link'`
  - `export type ChatHistoryScope = { type: 'conversation'; conversationId: string } | { type: 'all_conversations' }`
  - `export interface ChatHistoryQuery extends PageQuery { scope: ChatHistoryScope; query?: string; localDate?: string; timeZone: string; category: HistoryCategory; cursor?: string; limit: number }`
  - `export interface ChatHistoryItem { hitId: string; conversationId: string; messageId: string; responseId?: string; segmentId?: string; senderLabel: string; snippet?: string; resource?: ConversationResource; createdAt: string; sortKey: string }`
  - `export interface ChatHistoryPage { items: ChatHistoryItem[]; nextCursor?: string; hasMore: boolean; snapshotId?: string }`
  - `export interface ConversationResource { messageId: string; timestamp: string; kind: 'image' | 'link' | 'video' | 'audio' | 'file' | 'sticker'; url: string; stickerId?: string }`
  - `export interface StickerItem { stickerId: string; src: string }`；`export interface StickerManifest { stickers: StickerItem[] }`（P0-2：对齐 `frontend_contract/rest.py` `StickerEntry{stickerId, src}` / `StickerListResponse{stickers}`；无 name/url/version）
  - `SendMessageInput` 增 `stickerId?: string`；`AssistantSegment` 增 `stickerId?: string`；`Message` 增 `stickerId?: string`
  - `IpcChannels` 增 `chatQueryHistory: 'chat:query-history'`、`chatGetMessageContext: 'chat:get-message-context'`、`chatListStickers: 'chat:list-stickers'`

- [ ] **Step 1: 写失败测试** —— `apps/desktop/tests/unit/history-contracts.spec.ts`

```typescript
// tests/unit/history-contracts.spec.ts
// Task 4:历史查看器/表情契约形状（spec §4.3，D2/D8）——类型导出 + 对象字面量符合形状（编译期 + 运行时）。
// env=node：纯类型/常量断言。
import { describe, expect, it } from 'vitest'
import { IpcChannels } from '../../src/shared/contracts'
import type { ChatHistoryItem, ChatHistoryPage, ChatHistoryQuery, ChatHistoryScope, ConversationResource, HistoryCategory } from '../../src/shared/contracts/backend'
import type { StickerItem, StickerManifest } from '../../src/shared/contracts/sticker'
import type { SendMessageInput } from '../../src/shared/contracts/message'

describe('历史查看器契约（spec §4.3）', () => {
  it('ChatHistoryQuery 收敛形状：scope/query/localDate/timeZone/category/limit', () => {
    const scope: ChatHistoryScope = { type: 'conversation', conversationId: 'c1' }
    const q: ChatHistoryQuery = { scope, query: '关键词', localDate: '2026-08-14', timeZone: 'Asia/Shanghai', category: 'sticker', limit: 50 }
    expect(q.scope).toBe(scope)
    expect(q.category).toBe('sticker')
    expect(q.limit).toBe(50)
    // 废弃占位字段不再存在（编译期：此处若引用 keyword/fromDate 会 TS 报错，故以运行时不出现为断言）
    expect('keyword' in q).toBe(false)
    expect('fromDate' in q).toBe(false)
  })
  it('ChatHistoryItem 形状：hitId 稳定键 + 可跳转 messageId + 稳定排序键', () => {
    const item: ChatHistoryItem = {
      hitId: 'c1:m1:seg1', conversationId: 'c1', messageId: 'm1', segmentId: 'seg1',
      senderLabel: 'user', snippet: '命中片段', createdAt: '2026-08-14T02:00:00.000Z', sortKey: '2026-08-14T02:00:00.000Z|m1'
    }
    expect(item.hitId).toBe('c1:m1:seg1')
  })
  it('ConversationResource 六分类 + 可选 stickerId（P3-3）', () => {
    const r: ConversationResource = { messageId: 'm3', timestamp: 't', kind: 'sticker', url: '/static/stickers/st_1.png', stickerId: 'st_1' }
    expect(r.kind).toBe('sticker')
    expect(r.stickerId).toBe('st_1')
  })
  it('HistoryCategory 六值', () => {
    const categories: HistoryCategory[] = ['all', 'image_video', 'sticker', 'file', 'audio', 'link']
    expect(categories).toHaveLength(6)
  })
  it('ChatHistoryPage 保留游标分页字段 + snapshotId 可选', () => {
    const page: ChatHistoryPage = { items: [], hasMore: false }
    expect(page.hasMore).toBe(false)
  })
})

describe('表情契约（spec §4.3，D8）', () => {
  it('StickerManifest{stickers} 形状（P0-2：对齐契约 StickerEntry{stickerId, src}）', () => {
    const item: StickerItem = { stickerId: 'st_1', src: '/static/stickers/st_1.png' }
    const manifest: StickerManifest = { stickers: [item] }
    expect(manifest.stickers[0].stickerId).toBe('st_1')
  })
  it('SendMessageInput 增 stickerId 可选（wire 发送）', () => {
    const input: SendMessageInput = { conversationId: 'c1', text: '', clientRequestId: 'cr1', stickerId: 'st_1' }
    expect(input.stickerId).toBe('st_1')
    const plain: SendMessageInput = { conversationId: 'c1', text: 'hi', clientRequestId: 'cr2' }
    expect(plain.stickerId).toBeUndefined()
  })
})

describe('IPC 三新通道（spec §4.3）', () => {
  it('通道常量存在', () => {
    expect(IpcChannels.chatQueryHistory).toBe('chat:query-history')
    expect(IpcChannels.chatGetMessageContext).toBe('chat:get-message-context')
    expect(IpcChannels.chatListStickers).toBe('chat:list-stickers')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/history-contracts.spec.ts`
Expected: FAIL——`chatQueryHistory` undefined / `sticker` 模块不存在 / ChatHistoryQuery 仍带占位字段。

- [ ] **Step 3: 最小实现** —— 四个文件

`apps/desktop/src/shared/contracts/backend.ts`：`ChatHistoryQuery`/`ChatHistoryPage` 替换为：

```typescript
/** 历史分类（D2 对齐 docs/02 §19 后端六分类；image_video 为查看器「图片/视频」tab） */
export type HistoryCategory = 'all' | 'image_video' | 'sticker' | 'file' | 'audio' | 'link'

/** 查询范围（scope=当前会话传 conversationId；全部会话不传） */
export type ChatHistoryScope =
  | { type: 'conversation'; conversationId: string }
  | { type: 'all_conversations' }

/** 统一聊天历史查看器查询（D2：收敛到 docs/02 §19 形状，废弃占位 keyword/fromDate/toDate） */
export interface ChatHistoryQuery extends PageQuery {
  scope: ChatHistoryScope
  query?: string              // 关键词（空串不传）
  localDate?: string          // YYYY-MM-DD（用户本地自然日）；同时必须传 timeZone
  timeZone: string            // IANA 时区名
  category: HistoryCategory
  cursor?: string             // 不透明游标
  limit: number               // 必填（后端上限 100；默认 50）
}

/** 历史命中项（Adapter 归一化；hitId/sortKey 由 Adapter 派生稳定键） */
export interface ChatHistoryItem {
  hitId: string               // `${conversationId}:${messageId}:${segmentId ?? ''}`
  conversationId: string
  messageId: string           // 必可跳转（D-06）
  responseId?: string         // 仅供展示兼容；跳转回复组根用 messageId
  segmentId?: string          // 分段命中尽量返回
  senderLabel: string         // user/assistant/系统/工具
  snippet?: string            // 命中片段
  resource?: ConversationResource
  createdAt: string
  sortKey: string             // `${createdAt}|${messageId}` 稳定排序键
}

/** 后端资源分类（六分类，docs/02 §19） */
export interface ConversationResource {
  messageId: string
  timestamp: string
  kind: 'image' | 'link' | 'video' | 'audio' | 'file' | 'sticker'
  url: string                 // 后端资源项 URL（贴图渲染经受信协议，D9）
  stickerId?: string          // P3-3：sticker 项渲染专用（后端可直接返回则跳过解析；缺省由 resource.url 末段提取）
}

export interface ChatHistoryPage {
  items: ChatHistoryItem[]
  nextCursor?: string
  hasMore: boolean
  snapshotId?: string         // 可选：避免查询期间新消息致分页重复/漏项
}
```

`apps/desktop/src/shared/contracts/message.ts`：`SendMessageInput` 增 `stickerId?: string`；`AssistantSegment` 增 `stickerId?: string`（sticker 分段身份）；`Message` 增 `stickerId?: string`（§7 开放项：用户贴图消息 wire 表示待确认，本组按可选字段落地）。

`apps/desktop/src/shared/contracts/sticker.ts`（新建）：

```typescript
/** 表情包内置清单项（P0-2：对齐 frontend_contract/rest.py StickerEntry{stickerId, src}，D-07 稳定 st_ ID） */
export interface StickerItem {
  stickerId: string       // ^st_[A-Za-z0-9-]+$
  src: string             // 静态资源路径（/static/stickers/{id}.png）；渲染统一经 cyrene://renderer/__cyrene-media/sticker/{stickerId}（D9）
}
export interface StickerManifest { stickers: StickerItem[] }   // 对齐 StickerListResponse{stickers:[...]}
```

`apps/desktop/src/shared/contracts/ipc.ts`：`IpcChannels` 追加 `chatQueryHistory: 'chat:query-history', chatGetMessageContext: 'chat:get-message-context', chatListStickers: 'chat:list-stickers'`。

`apps/desktop/src/shared/contracts/index.ts`：追加 `export * from './sticker'`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/history-contracts.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: PASS（9 tests）+ typecheck 绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/contracts/backend.ts apps/desktop/src/shared/contracts/message.ts apps/desktop/src/shared/contracts/sticker.ts apps/desktop/src/shared/contracts/ipc.ts apps/desktop/src/shared/contracts/index.ts apps/desktop/tests/unit/history-contracts.spec.ts
git commit -m "feat(G4 history): 历史查看器/表情契约收敛（D2/D8）+ 贴图消息可选字段"
```

---

### Task 5: IPC request/response zod schema（channels.ts + ipc-response.ts 镜像，C1）

> 3 新通道 request schema（全字段 zod）+ 3 响应 Schema（`ChatHistoryItemSchema`/`ChatHistoryPageSchema`/`StickerManifestSchema`，`getMessageContext` 复用 `MessagePageSchema`）；响应 Schema 严格镜像契约（禁止为宽松放宽必填）。

**Files:**
- Modify: `apps/desktop/src/main/ipc/channels.ts`
- Modify: `apps/desktop/src/shared/schemas/ipc-response.ts`
- Test: `apps/desktop/tests/unit/history-contracts.spec.ts`（追加 describe）

**Interfaces:**
- Consumes（Task 4）：契约类型
- Produces（Task 10 Preload、Task 11 handler 消费）：
  - `export const chatQueryHistorySchema`（scope/query/localDate(YYYY-MM-DD)/timeZone/category/cursor/limit≤100）
  - `export const chatGetMessageContextSchema`（conversationId/messageId/before?/after?，对齐 MessageContextQuery）
  - `export const chatListStickersSchema = z.undefined()`
  - `export const ConversationResourceSchema`、`ChatHistoryItemSchema`、`ChatHistoryPageSchema: z.ZodType<ChatHistoryPage>`、`StickerItemSchema`、`StickerManifestSchema`
  - `chatSendSchema` 增 `stickerId: z.string().optional()`
  - `AssistantSegmentSchema`/`MessageSchema` 增 `stickerId: z.string().optional()`

- [ ] **Step 1: 写失败测试** —— 追加到 `apps/desktop/tests/unit/history-contracts.spec.ts`

```typescript
import { chatGetMessageContextSchema, chatListStickersSchema, chatQueryHistorySchema, chatSendSchema } from '../../src/main/ipc/channels'
import { ChatHistoryPageSchema, MessagePageSchema, StickerManifestSchema } from '../../src/shared/schemas'

describe('IPC request schema（spec §4.3）', () => {
  it('chatQueryHistorySchema 全字段校验（scope 判别 + 必填 timeZone/category/limit）', () => {
    const ok = chatQueryHistorySchema.safeParse({ scope: { type: 'conversation', conversationId: 'c1' }, query: 'k', localDate: '2026-08-14', timeZone: 'Asia/Shanghai', category: 'sticker', limit: 50 })
    expect(ok.success).toBe(true)
    expect(chatQueryHistorySchema.safeParse({ scope: { type: 'all_conversations' }, timeZone: 'UTC', category: 'all', limit: 50 }).success).toBe(true)
    expect(chatQueryHistorySchema.safeParse({ scope: { type: 'bogus' }, timeZone: 'UTC', category: 'all', limit: 50 }).success).toBe(false)
    expect(chatQueryHistorySchema.safeParse({ scope: { type: 'conversation', conversationId: 'c1' }, timeZone: 'UTC', category: 'all', limit: 200 }).success).toBe(false)  // limit 上限 100
    expect(chatQueryHistorySchema.safeParse({ scope: { type: 'conversation', conversationId: 'c1' }, timeZone: 'UTC', category: 'all' }).success).toBe(false)  // limit 必填
  })
  it('chatQueryHistorySchema localDate 必须 YYYY-MM-DD', () => {
    expect(chatQueryHistorySchema.safeParse({ scope: { type: 'all_conversations' }, localDate: '2026/08/14', timeZone: 'UTC', category: 'all', limit: 50 }).success).toBe(false)
  })
  it('chatGetMessageContextSchema 对齐 MessageContextQuery；chatListStickersSchema 无参', () => {
    expect(chatGetMessageContextSchema.safeParse({ conversationId: 'c1', messageId: 'm1', before: 5, after: 5 }).success).toBe(true)
    expect(chatGetMessageContextSchema.safeParse({ conversationId: 'c1' }).success).toBe(false)
    expect(chatListStickersSchema.safeParse(undefined).success).toBe(true)
  })
  it('chatSendSchema 接受可选 stickerId（st_ 前缀）', () => {
    const r = chatSendSchema.safeParse({ conversationId: 'c1', text: '', clientRequestId: 'cr1', stickerId: 'st_1' })
    expect(r.success).toBe(true)
  })
})

describe('IPC 响应 schema 严格镜像（C1）', () => {
  it('ChatHistoryPageSchema 接受完整命中项（含 resource）', () => {
    const r = ChatHistoryPageSchema.safeParse({
      items: [{ hitId: 'c1:m1:', conversationId: 'c1', messageId: 'm1', senderLabel: 'user', createdAt: 't', sortKey: 't|m1', resource: { messageId: 'm1', timestamp: 't', kind: 'sticker', url: '/static/stickers/st_1.png', stickerId: 'st_1' } }],
      hasMore: false
    })
    expect(r.success).toBe(true)
  })
  it('ChatHistoryPageSchema 拒缺必填（hitId/messageId/senderLabel/sortKey）', () => {
    expect(ChatHistoryPageSchema.safeParse({ items: [{ conversationId: 'c1', createdAt: 't' }], hasMore: false }).success).toBe(false)
  })
  it('StickerManifestSchema 接受 {stickers}（P0-2）；getMessageContext 复用 MessagePageSchema', () => {
    expect(StickerManifestSchema.safeParse({ stickers: [{ stickerId: 'st_1', src: '/static/stickers/st_1.png' }] }).success).toBe(true)
    expect(StickerManifestSchema.safeParse({ stickers: [{ stickerId: '' }] }).success).toBe(false)
    expect(MessagePageSchema).toBeDefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/history-contracts.spec.ts`
Expected: FAIL——`chatQueryHistorySchema` 等未导出；`ChatHistoryPageSchema` 未导出。

- [ ] **Step 3: 最小实现** —— 两文件

`apps/desktop/src/main/ipc/channels.ts` 追加：

```typescript
// —— chat 历史查看器/表情 request schema（spec §4.3；响应 schema 在 shared/schemas/ipc-response）——
export const chatQueryHistorySchema = z.object({
  scope: z.union([
    z.object({ type: z.literal('conversation'), conversationId: z.string().min(1) }),
    z.object({ type: z.literal('all_conversations') })
  ]),
  query: z.string().optional(),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  timeZone: z.string().min(1),
  category: z.enum(['all', 'image_video', 'sticker', 'file', 'audio', 'link']),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(100)
})
export const chatGetMessageContextSchema = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
  before: z.number().int().positive().optional(),
  after: z.number().int().positive().optional()
})
export const chatListStickersSchema = z.undefined()
```

`chatSendSchema` 改为：

```typescript
export const chatSendSchema = z.object({
  conversationId: z.string().min(1),
  text: z.string(),
  clientRequestId: z.string().min(1),
  stickerId: z.string().optional()
})
```

`apps/desktop/src/shared/schemas/ipc-response.ts` 追加（并给 `AssistantSegmentSchema`/`MessageSchema` 补 `stickerId: z.string().optional()`）：

```typescript
export const ConversationResourceSchema = z.object({
  messageId: z.string().min(1),
  timestamp: z.string(),
  kind: z.enum(['image', 'link', 'video', 'audio', 'file', 'sticker']),
  url: z.string().min(1),
  stickerId: z.string().optional()
})

export const ChatHistoryItemSchema: z.ZodType<import('@shared/contracts').ChatHistoryItem> = z.object({
  hitId: z.string().min(1),
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
  responseId: z.string().optional(),
  segmentId: z.string().optional(),
  senderLabel: z.string().min(1),
  snippet: z.string().optional(),
  resource: ConversationResourceSchema.optional(),
  createdAt: z.string(),
  sortKey: z.string().min(1)
})

export const ChatHistoryPageSchema: z.ZodType<import('@shared/contracts').ChatHistoryPage> =
  PageSchema(ChatHistoryItemSchema).extend({ snapshotId: z.string().optional() })

export const StickerItemSchema = z.object({
  stickerId: z.string().min(1),          // P0-2：对齐契约 StickerEntry{stickerId, src}
  src: z.string().min(1)
})
export const StickerManifestSchema = z.object({ stickers: z.array(StickerItemSchema) })   // 对齐 StickerListResponse{stickers}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/history-contracts.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: PASS（Task 4 9 + Task 5 8 = 17 tests）+ typecheck 绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/ipc/channels.ts apps/desktop/src/shared/schemas/ipc-response.ts apps/desktop/tests/unit/history-contracts.spec.ts
git commit -m "feat(G4 history): 3 通道 request schema + 响应 schema 镜像（C1）"
```

---

### Task 6: rest-types/rest-schemas/rest-mapper —— search/context/stickers 响应与映射（D2 归一化）

> **（P0-1/P0-2 修订）** search item 具体字段形状已由独立评审对照 `frontend_contract/rest.py` 定案（**非开放项**）：`SearchMessageItem` 为 **camelCase** `{conversationId, messageId, responseId?, segmentId?, role, timestamp, snippet}`（**无 kind/url/sticker_id**）；`SearchMessagesResponse{items, has_more, cursor}`；`/api/stickers` → `StickerListResponse{stickers:[{stickerId, src}]}`（**无 name/url/version**）。本任务按契约定义 wire 类型与 zod schema，映射为 `ChatHistoryItem`（hitId/sortKey 派生、**仅文本映射**——snippet→snippet、senderLabel 由 role 映射，**不产 resource**；缺字段显式 SCHEMA_VALIDATION_FAILED）；`getMessageContext` 响应 → `MessagePage`；`/api/stickers` → `StickerManifest{stickers}`。

> **P0-1 设计缺口（spec 开放项，最终报告汇报）：** 契约 `SearchMessageItem` 不携带 kind/url/stickerId，因此查看器「图片/视频/表情/文件/音频/链接」分类**无法从 search 结果展示资源缩略图/贴图**，也无法按命中项校验具体 kind。本计划按 spec D15「资源端点不做独立 UI」处理：search 结果仅文本展示（命中片段 + 分类 chip 由当前查询 category 派生），跳转仍可用。两种补齐路径均超出当前 spec，标注为开放项待后端确认：① 后端在 `SearchMessageItem` 增可选 `kind/url/stickerId` 字段（契约变更）→ 本组 `ConversationResource`/`toChatHistoryItem` resource 映射可直接恢复；② 前端新增 `queryResources` 通道查 `GET /api/sessions/{id}/resources?category=<单值枚举 image|link|video|audio|file|sticker>`（docs/02 §19，`ResourceItem{messageId,timestamp,kind,url}`）补充分类数据——但该端点按会话查询（无全会话），且图片/视频/音频/文件的 `url` 为稳定路径需 G3 签名端点解析渲染，属 G3 范围；贴图分类可由 `stickerIdFromResourceUrl`（P3-3）渲染。G4 不实施路径②（避免超范围），保留 `ConversationResource` 领域类型作字段补全参考（spec §4.3）。

**Files:**
- Modify: `apps/desktop/src/main/transport/protocol-v2/rest-types.ts`
- Modify: `apps/desktop/src/main/transport/protocol-v2/rest-schemas.ts`
- Modify: `apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts`
- Test: `apps/desktop/tests/unit/rest-search-mapper.spec.ts`

**Interfaces:**
- Consumes（Task 2）：`stickerIdFromResourceUrl`；Task 4 契约
- Produces（Task 7 RealBackend 消费）：
  - `export interface RestSearchMessageItem { conversationId: string; messageId: string; timestamp: string; role?: 'user' | 'assistant' | 'tool' | 'system'; snippet?: string; responseId?: string; segmentId?: string }`（P0-1：camelCase、无 kind/url/sticker_id）
  - `export interface RestSearchMessagesResponse { items: RestSearchMessageItem[]; has_more: boolean; cursor?: string }`
  - `export interface RestMessageContextResponse { anchor: RestMessage; before: RestMessage[]; after: RestMessage[]; conversationId: string }`
  - `export interface RestStickerItem { stickerId: string; src: string }`；`export interface RestStickerListResponse { stickers: RestStickerItem[] }`（P0-2：对齐契约）
  - `export function parseRestSearchMessages(input: unknown): { success: true; data: RestSearchMessagesResponse } | { success: false; error: z.ZodError }`（+ `parseRestMessageContext`/`parseRestStickerList`）
  - `RestMapper.toChatHistoryItem(raw: RestSearchMessageItem): ChatHistoryItem`（仅文本映射，无 resource）、`toChatHistoryPage(raw: RestSearchMessagesResponse): ChatHistoryPage`、`toMessagePageFromContext(res: RestMessageContextResponse): MessagePage`、`toStickerManifest(raw: RestStickerListResponse): StickerManifest`

- [ ] **Step 1: 写失败测试** —— `apps/desktop/tests/unit/rest-search-mapper.spec.ts`

```typescript
// tests/unit/rest-search-mapper.spec.ts
// Task 6:search/context/stickers 响应归一化（spec §4.3/§4.6，D2）——RestMapper 派生 hitId/sortKey、仅文本映射（P0-1：
// search item 无 kind/url）、缺字段显式错误。
// env=node：RestMapper 纯逻辑，无 Electron。
import { describe, expect, it } from 'vitest'
import { RestMapper } from '../../src/main/transport/protocol-v2/rest-mapper'
import { parseRestMessageContext, parseRestSearchMessages, parseRestStickerList } from '../../src/main/transport/protocol-v2/rest-schemas'
import type { RestSearchMessageItem } from '../../src/main/transport/protocol-v2/rest-types'

const mapper = new RestMapper()

describe('parseRest* 响应 schema（C1 严格）', () => {
  it('search 响应合法通过；缺 messageId 拒（P0-1 camelCase）', () => {
    const ok = parseRestSearchMessages({ items: [{ conversationId: 'c1', messageId: 'm1', role: 'user', timestamp: 't', snippet: '命中' }], has_more: false })
    expect(ok.success).toBe(true)
    expect(parseRestSearchMessages({ items: [{ conversationId: 'c1', timestamp: 't' }], has_more: false }).success).toBe(false)
    // .strict()：多余字段拒（真实后端不回 kind/url）
    expect(parseRestSearchMessages({ items: [{ conversationId: 'c1', messageId: 'm1', role: 'user', timestamp: 't', kind: 'sticker' }], has_more: false }).success).toBe(false)
  })
  it('context 响应 anchor/before/after/conversationId 合法通过', () => {
    const r = parseRestMessageContext({ anchor: { role: 'user', message_id: 'm1', timestamp: 't' }, before: [], after: [], conversationId: 'c1' })
    expect(r.success).toBe(true)
  })
  it('stickers 响应 {stickers:[{stickerId, src}]} 通过；空 stickerId 拒（P0-2）', () => {
    expect(parseRestStickerList({ stickers: [{ stickerId: 'st_1', src: '/static/stickers/st_1.png' }] }).success).toBe(true)
    expect(parseRestStickerList({ stickers: [{ stickerId: '' }] }).success).toBe(false)
  })
})

describe('RestMapper.toChatHistoryItem（D2 归一化，P0-1 仅文本映射）', () => {
  it('文本命中项：hitId/sortKey 派生 + senderLabel 映射', () => {
    const raw: RestSearchMessageItem = { conversationId: 'c1', messageId: 'm1', timestamp: '2026-08-14T02:00:00.000Z', role: 'user', snippet: '命中' }
    const item = mapper.toChatHistoryItem(raw)
    expect(item).toMatchObject({ hitId: 'c1:m1:', conversationId: 'c1', messageId: 'm1', senderLabel: 'user', snippet: '命中', sortKey: '2026-08-14T02:00:00.000Z|m1' })
    expect(item.resource).toBeUndefined()
  })
  it('带 segmentId → hitId 含分段；system/tool → 中文 senderLabel', () => {
    expect(mapper.toChatHistoryItem({ conversationId: 'c1', messageId: 'm2', timestamp: 't', segmentId: 'seg1' }).hitId).toBe('c1:m2:seg1')
    expect(mapper.toChatHistoryItem({ conversationId: 'c1', messageId: 'm3', timestamp: 't', role: 'system' }).senderLabel).toBe('系统')
    expect(mapper.toChatHistoryItem({ conversationId: 'c1', messageId: 'm4', timestamp: 't', role: 'tool' }).senderLabel).toBe('工具')
  })
  it('responseId/segmentId 透传；无 snippet 时缺省（不产 resource——search item 无 kind/url，P0-1）', () => {
    const item = mapper.toChatHistoryItem({ conversationId: 'c1', messageId: 'm5', timestamp: 't', responseId: 'g1', segmentId: 'seg2' })
    expect(item).toMatchObject({ responseId: 'g1', segmentId: 'seg2' })
    expect(item.snippet).toBeUndefined()
    expect(item.resource).toBeUndefined()
  })
})

describe('RestMapper.toChatHistoryPage / toMessagePageFromContext / toStickerManifest', () => {
  it('toChatHistoryPage：映射 + 稳定排序 + 游标透传', () => {
    const page = mapper.toChatHistoryPage({
      items: [
        { conversationId: 'c1', messageId: 'm2', role: 'user', timestamp: '2026-08-14T02:00:01.000Z' },
        { conversationId: 'c1', messageId: 'm1', role: 'user', timestamp: '2026-08-14T02:00:00.000Z' }
      ],
      has_more: true, cursor: 'abc'
    })
    expect(page.items.map((i) => i.messageId)).toEqual(['m1', 'm2'])
    expect(page).toMatchObject({ hasMore: true, nextCursor: 'abc' })
  })
  it('toMessagePageFromContext：before+anchor+after 合并 + 稳定排序 + hasMore:false', () => {
    const page = mapper.toMessagePageFromContext({
      anchor: { role: 'user', message_id: 'm5', timestamp: '2026-08-14T02:00:02.000Z' },
      before: [{ role: 'user', message_id: 'm4', timestamp: '2026-08-14T02:00:01.000Z' }],
      after: [{ role: 'assistant', message_id: 'm6', timestamp: '2026-08-14T02:00:03.000Z' }],
      conversationId: 'c1'
    })
    expect(page.items.map((i) => i.messageId)).toEqual(['m4', 'm5', 'm6'])
    expect(page.hasMore).toBe(false)
  })
  it('toStickerManifest：stickerId/src 必填透传（P0-2 对齐契约）', () => {
    const manifest = mapper.toStickerManifest({ stickers: [{ stickerId: 'st_1', src: '/static/stickers/st_1.png' }] })
    expect(manifest.stickers[0]).toEqual({ stickerId: 'st_1', src: '/static/stickers/st_1.png' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/rest-search-mapper.spec.ts`
Expected: FAIL——类型/方法/parse 助手不存在。

- [ ] **Step 3: 最小实现** —— 三文件

`apps/desktop/src/main/transport/protocol-v2/rest-types.ts` 追加：

```typescript
/** 历史搜索 item（P0-1：对齐 frontend_contract/rest.py SearchMessageItem——camelCase，无 kind/url/sticker_id） */
export interface RestSearchMessageItem {
  conversationId: string
  messageId: string
  timestamp: string
  role?: 'user' | 'assistant' | 'tool' | 'system'
  snippet?: string
  responseId?: string
  segmentId?: string
}
export interface RestSearchMessagesResponse { items: RestSearchMessageItem[]; has_more: boolean; cursor?: string }
export interface RestMessageContextResponse { anchor: RestMessage; before: RestMessage[]; after: RestMessage[]; conversationId: string }
/** P0-2：对齐契约 StickerEntry{stickerId, src} / StickerListResponse{stickers} */
export interface RestStickerItem { stickerId: string; src: string }
export interface RestStickerListResponse { stickers: RestStickerItem[] }
```

`apps/desktop/src/main/transport/protocol-v2/rest-schemas.ts` 追加：

```typescript
export const RestSearchMessageItemSchema = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
  timestamp: z.string().min(1),
  role: z.enum(['user', 'assistant', 'tool', 'system']).optional(),
  snippet: z.string().optional(),
  responseId: z.string().optional(),
  segmentId: z.string().optional()
}).strict()
export const RestSearchMessagesResponseSchema = z.object({
  items: z.array(RestSearchMessageItemSchema),
  has_more: z.boolean(),
  cursor: z.string().optional()
}).strict()
export const RestMessageContextResponseSchema = z.object({
  anchor: RestMessageSchema,
  before: z.array(RestMessageSchema),
  after: z.array(RestMessageSchema),
  conversationId: z.string().min(1)
}).strict()
export const RestStickerItemSchema = z.object({
  stickerId: z.string().min(1),
  src: z.string().min(1)
}).strict()
export const RestStickerListResponseSchema = z.object({ stickers: z.array(RestStickerItemSchema) }).strict()

export function parseRestSearchMessages(input: unknown): { success: true; data: RestSearchMessagesResponse } | { success: false; error: z.ZodError } {
  return RestSearchMessagesResponseSchema.safeParse(input)
}
export function parseRestMessageContext(input: unknown): { success: true; data: RestMessageContextResponse } | { success: false; error: z.ZodError } {
  return RestMessageContextResponseSchema.safeParse(input)
}
export function parseRestStickerList(input: unknown): { success: true; data: RestStickerListResponse } | { success: false; error: z.ZodError } {
  return RestStickerListResponseSchema.safeParse(input)
}
```

`apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts` 追加 import（`ChatHistoryItem`/`ChatHistoryPage`/`StickerManifest` 类型）与方法：

```typescript
toChatHistoryItem(raw: RestSearchMessageItem): ChatHistoryItem {
  const base: ChatHistoryItem = {
    hitId: `${raw.conversationId}:${raw.messageId}:${raw.segmentId ?? ''}`,
    conversationId: raw.conversationId,
    messageId: raw.messageId,
    senderLabel: senderLabelOf(raw.role),
    createdAt: raw.timestamp,
    sortKey: `${raw.timestamp}|${raw.messageId}`
  }
  if (raw.responseId) base.responseId = raw.responseId
  if (raw.segmentId) base.segmentId = raw.segmentId
  if (raw.snippet) base.snippet = raw.snippet
  // P0-1：search item 无 kind/url，不产 resource（查看器分类缩略图缺口见「P0-1 设计缺口」）
  return base
}

toChatHistoryPage(raw: RestSearchMessagesResponse): ChatHistoryPage {
  const items = raw.items.map((i) => this.toChatHistoryItem(i)).sort((a, b) =>
    a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0)
  return { items, nextCursor: raw.cursor, hasMore: raw.has_more }
}

toMessagePageFromContext(res: RestMessageContextResponse): MessagePage {
  const items = [res.anchor, ...res.before, ...res.after]
    .map((m) => this.toDomainMessage(m, res.conversationId))
    .sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.messageId < b.messageId ? -1 : 1)
  return { items, hasMore: false }
}

toStickerManifest(raw: RestStickerListResponse): StickerManifest {
  return { stickers: raw.stickers.map((s) => ({ stickerId: s.stickerId, src: s.src })) }
}
```

`rest-mapper.ts` 模块级加 `senderLabelOf` 助手：

```typescript
function senderLabelOf(role?: 'user' | 'assistant' | 'tool' | 'system'): string {
  switch (role) {
    case 'user': return 'user'
    case 'assistant': return 'assistant'
    case 'system': return '系统'
    case 'tool': return '工具'
    default: return 'user'
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/rest-search-mapper.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: PASS（9 tests）+ typecheck 绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/transport/protocol-v2/rest-types.ts apps/desktop/src/main/transport/protocol-v2/rest-schemas.ts apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts apps/desktop/tests/unit/rest-search-mapper.spec.ts
git commit -m "feat(G4 history): search/context/stickers 响应 schema + RestMapper 归一化（D2）"
```

---

### Task 7: RealBackend —— queryChatHistory / getMessageContext / listStickers + wire stickerId（D2/D8）

> 三方法落地：`/api/search/messages`（query/conversationId/date_from/date_to 由 `localDateToHalfOpenRange` 换算/timezone/category 映射/cursor/limit）；`/api/messages/{mid}/context?conversationId&before&after` → `MessagePage`；`/api/stickers` → `StickerManifest`。响应 Schema 校验失败 → `SCHEMA_VALIDATION_FAILED`。`sendMessage` wire payload 追加 `stickerId`。

**Files:**
- Modify: `apps/desktop/src/main/transport/real-backend.ts`
- Test: `apps/desktop/tests/unit/real-backend-search.spec.ts`

**Interfaces:**
- Consumes（Task 1/6）：`localDateToHalfOpenRange`、`parseRestSearchMessages`/`parseRestMessageContext`/`parseRestStickerList`、`RestMapper` 新方法
- Produces（Task 9/11 消费）：`RealBackend.queryChatHistory(input: ChatHistoryQuery): Promise<ChatHistoryPage>`、`getMessageContext(input: MessageContextQuery): Promise<MessagePage>`、`listStickers(): Promise<StickerManifest>`；`sendMessage` wire 带 `stickerId`

- [ ] **Step 1: 写失败测试** —— `apps/desktop/tests/unit/real-backend-search.spec.ts`

```typescript
// tests/unit/real-backend-search.spec.ts
// Task 7:RealBackend 历史/上下文/表情 REST 映射（spec §4.3/§4.4，D2/D8）+ sendMessage wire stickerId。
// env=node：同一 http server 挂真实 WebSocketServer({path:'/ws'}) 握手 stub（既有惯例，避免 60s 挂起）。
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'net'
import { RealBackend } from '../../src/main/transport/real-backend'

/** 断言 search/context/stickers 请求参数后返回对应响应 */
function apiServer(opts: { onSearch?: (url: string) => void; onContext?: (url: string) => void; onStickers?: () => void }): Promise<{ port: number; close(): void }> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      const send = (body: unknown): void => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
      if (req.url?.startsWith('/api/search/messages')) {
        opts.onSearch?.(req.url)
        send({ items: [{ conversationId: 'c1', messageId: 'm1', timestamp: '2026-08-14T02:00:00.000Z', role: 'user', snippet: '命中' }], has_more: false })
      } else if (req.url?.startsWith('/api/messages/m1/context')) {
        opts.onContext?.(req.url)
        send({ anchor: { role: 'user', message_id: 'm1', timestamp: '2026-08-14T02:00:02.000Z' }, before: [{ role: 'user', message_id: 'm0', timestamp: '2026-08-14T02:00:01.000Z' }], after: [], conversationId: 'c1' })
      } else if (req.url === '/api/stickers') {
        opts.onStickers?.()
        send({ stickers: [{ stickerId: 'st_1', src: '/static/stickers/st_1.png' }] })
      } else { res.writeHead(404); res.end() }
    })
    const wss = new WebSocketServer({ server: s, path: '/ws' })
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 0, byModel: {} } }))
      ws.send(JSON.stringify({ type: 'server_info', protocol_version: '2.0', server_version: '0.4.0', features: {}, services: {}, connectionId: 'conn-1' }))
      ws.send(JSON.stringify({ type: 'expression', expression: 'idle' }))
    })
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as AddressInfo).port, close: () => { wss.close(); s.close() } }))
  })
}

describe('RealBackend.queryChatHistory（spec §4.3/§4.4）', () => {
  it('URL 参数：query/conversationId/date_from 半开区间/timezone/category/cursor/limit', async () => {
    const seen: string[] = []
    const { port, close } = await apiServer({ onSearch: (u) => seen.push(u) })
    try {
      const backend = new RealBackend({ now: () => Date.now() })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      const page = await backend.queryChatHistory({
        scope: { type: 'conversation', conversationId: 'c1' },
        query: '关键词', localDate: '2026-08-14', timeZone: 'Asia/Shanghai', category: 'sticker', limit: 50
      })
      expect(seen[0]).toContain('query=%E5%85%B3%E9%94%AE%E8%AF%8D')
      expect(seen[0]).toContain('conversationId=c1')
      expect(seen[0]).toContain('date_from=2026-08-13T16%3A00%3A00.000Z')   // 上海 UTC+8 本地日 → 前一日 16:00Z
      expect(seen[0]).toContain('date_to=2026-08-14T16%3A00%3A00.000Z')
      expect(seen[0]).toContain('timezone=Asia%2FShanghai')
      expect(seen[0]).toContain('category=sticker')
      expect(seen[0]).toContain('limit=50')
      expect(page.items[0]).toMatchObject({ messageId: 'm1', snippet: '命中' })   // P0-1：search item 仅文本，无 resource
      expect(page.items[0].resource).toBeUndefined()
      await backend.disconnect()
    } finally { close() }
  })
  it('scope=all 不传 conversationId；无 localDate 不传 date_from/date_to', async () => {
    const seen: string[] = []
    const { port, close } = await apiServer({ onSearch: (u) => seen.push(u) })
    try {
      const backend = new RealBackend({ now: () => Date.now() })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      await backend.queryChatHistory({ scope: { type: 'all_conversations' }, timeZone: 'UTC', category: 'all', limit: 50 })
      expect(seen[0]).not.toContain('conversationId=')
      expect(seen[0]).not.toContain('date_from=')
      await backend.disconnect()
    } finally { close() }
  })
})

describe('RealBackend.getMessageContext（spec §4.5）', () => {
  it('URL 参数 + MessagePage 归一化（before+anchor+after 合并稳定排序）', async () => {
    const seen: string[] = []
    const { port, close } = await apiServer({ onContext: (u) => seen.push(u) })
    try {
      const backend = new RealBackend({ now: () => Date.now() })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      const page = await backend.getMessageContext({ conversationId: 'c1', messageId: 'm1', before: 5, after: 5 })
      expect(seen[0]).toContain('conversationId=c1')
      expect(seen[0]).toContain('before=5')
      expect(seen[0]).toContain('after=5')
      expect(page.items.map((m) => m.messageId)).toEqual(['m0', 'm1'])
      expect(page.hasMore).toBe(false)
      await backend.disconnect()
    } finally { close() }
  })
})

describe('RealBackend.listStickers（D8）', () => {
  it('GET /api/stickers → StickerManifest', async () => {
    const { port, close } = await apiServer({})
    try {
      const backend = new RealBackend({ now: () => Date.now() })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      const manifest = await backend.listStickers()
      expect(manifest.stickers[0]).toEqual({ stickerId: 'st_1', src: '/static/stickers/st_1.png' })   // P0-2
      await backend.disconnect()
    } finally { close() }
  })
})

describe('RealBackend.sendMessage wire stickerId（D8）', () => {
  it('payload 带 stickerId（content 可空）', async () => {
    const payloads: Array<Record<string, unknown>> = []
    const s = createServer(() => {})
    const wss = new WebSocketServer({ server: s, path: '/ws' })
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 0, byModel: {} } }))
      ws.send(JSON.stringify({ type: 'server_info', protocol_version: '2.0', server_version: '0.4.0', features: {}, services: {}, connectionId: 'conn-1' }))
      ws.send(JSON.stringify({ type: 'expression', expression: 'idle' }))
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString())
        if (parsed.type === 'text') {
          payloads.push(parsed)
          ws.send(JSON.stringify({ type: 'user_message.ack', clientRequestId: parsed.clientRequestId, messageId: 'm9' }))
        }
      })
    })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    const port = (s.address() as AddressInfo).port
    try {
      const backend = new RealBackend({ now: () => Date.now(), ackTimeoutMs: 5000 })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      await backend.sendMessage({ conversationId: 'c1', text: '', clientRequestId: 'cr1', stickerId: 'st_1' })
      expect(payloads[0]).toMatchObject({ type: 'text', conversationId: 'c1', clientRequestId: 'cr1', stickerId: 'st_1' })
      await backend.disconnect()
    } finally { wss.close(); s.close() }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/real-backend-search.spec.ts`
Expected: FAIL——`queryChatHistory`/`getMessageContext`/`listStickers` 抛 NOT_IMPLEMENTED。

- [ ] **Step 3: 最小实现** —— `apps/desktop/src/main/transport/real-backend.ts`

import 追加：`localDateToHalfOpenRange`（`@shared/domain`）、`parseRestMessageContext`/`parseRestSearchMessages`/`parseRestStickerList`、`StickerManifest`/`HistoryCategory` 类型。

替换 `queryChatHistory`/`getMessageContext` 占位并新增 `listStickers`：

```typescript
/** category → search 端点 category 参数（P2-1：不做 'image,video' 组合串假设——契约无出处；按 docs/02 §19 资源端点
 *  单值枚举 image|link|video|audio|file|sticker 处理。image_video（图片/视频 tab）拆两次单值查询合并；其余单值透传；
 *  search 端点 category 最终取值以真实后端联调确认为准（开放项 §7）。check:contract 不覆盖 REST schema，按 frontend_contract/rest.py 人工核对。 */
const HISTORY_CATEGORY_WIRE: Record<HistoryCategory, string[] | undefined> = {
  all: undefined,
  image_video: ['image', 'video'],
  sticker: ['sticker'],
  file: ['file'],
  audio: ['audio'],
  link: ['link']
}

async queryChatHistory(input: ChatHistoryQuery): Promise<ChatHistoryPage> {
  const wireCats = HISTORY_CATEGORY_WIRE[input.category] ?? [undefined]
  const pages = await Promise.all(wireCats.map(async (cat) => {
    const params: Record<string, string> = {}
    if (input.query) params['query'] = input.query
    if (input.scope.type === 'conversation') params['conversationId'] = input.scope.conversationId
    if (input.localDate) {
      const range = localDateToHalfOpenRange(input.localDate, input.timeZone)
      params['date_from'] = range.from
      params['date_to'] = range.to
    }
    params['timezone'] = input.timeZone
    if (cat) params['category'] = cat
    if (input.cursor) params['cursor'] = input.cursor
    params['limit'] = String(input.limit)
    const q = new URLSearchParams(params).toString()
    const res = await this.restFetch(`/api/search/messages${q ? `?${q}` : ''}`)
    const parsed = parseRestSearchMessages(await res.json())
    if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, '历史搜索响应校验失败')
    return parsed.data
  }))
  const byHit = new Map(pages.flatMap((p) => p.items).map((i) => [i.hitId, i]))
  const items = [...byHit.values()].sort((a, b) =>
    a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0)
  // image_video 合并分页：以任一行有余量的子查询游标续页（两个子查询各自 cursor 续页细节以联调确认，开放项 §7）
  return { items, hasMore: pages.some((p) => p.has_more), nextCursor: pages.find((p) => p.has_more)?.cursor }
}

async getMessageContext(input: MessageContextQuery): Promise<MessagePage> {
  const params: Record<string, string> = { conversationId: input.conversationId }
  if (input.before !== undefined) params['before'] = String(input.before)
  if (input.after !== undefined) params['after'] = String(input.after)
  const q = new URLSearchParams(params).toString()
  const res = await this.restFetch(`/api/messages/${encodeURIComponent(input.messageId)}/context?${q}`)
  const parsed = parseRestMessageContext(await res.json())
  if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, '消息上下文响应校验失败')
  return this.restMapper.toMessagePageFromContext(parsed.data)
}

async listStickers(): Promise<StickerManifest> {
  const res = await this.restFetch('/api/stickers')
  const parsed = parseRestStickerList(await res.json())
  if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, '表情清单响应校验失败')
  return this.restMapper.toStickerManifest(parsed.data)
}
```

`sendMessage` payload 追加：`const payload = { type: 'text', content: input.text, clientRequestId: input.clientRequestId, conversationId: input.conversationId, ...(input.stickerId ? { stickerId: input.stickerId } : {}) }`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/real-backend-search.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: PASS（5 tests）+ typecheck 绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/transport/real-backend.ts apps/desktop/tests/unit/real-backend-search.spec.ts
git commit -m "feat(G4 history): RealBackend 历史搜索/上下文/表情清单 + wire stickerId（D2/D8）"
```

---

### Task 8: MockBackend —— queryChatHistory / getMessageContext / listStickers + 消息记录（Mock 全链路可测）

> Mock 维护 `messageRecords`（预置样例 + sendMessage 追加），`queryChatHistory` 按 scope/关键词/分类/本地日期过滤 + `mock:{offset}` 游标分页 + 稳定排序；`getMessageContext` 窗口切片；`listStickers` 返回内置 st_ 清单。使查看器在 Mock 模式全链路可演示、可自动化测试。

**Files:**
- Modify: `apps/desktop/src/main/transport/mock-backend.ts`
- Test: `apps/desktop/tests/unit/mock-backend-search.spec.ts`

**Interfaces:**
- Consumes（Task 1/4）：`isoToLocalDate`、契约类型、`ChatHistoryItem`
- Produces（Task 11 集成测试 消费）：`MockBackend.queryChatHistory/getMessageContext/listStickers` 确定性实现

- [ ] **Step 1: 写失败测试** —— `apps/desktop/tests/unit/mock-backend-search.spec.ts`

```typescript
// tests/unit/mock-backend-search.spec.ts
// Task 8:MockBackend 历史/上下文/表情确定性（spec §2.7/§4.3）——过滤/分页/窗口切片/listStickers。
// env=node：注入时钟/ID 工厂。
import { describe, expect, it } from 'vitest'
import { MockBackend } from '../../src/main/transport/mock-backend'

const NOW = new Date('2026-08-14T04:00:00.000Z')
let idCounter = 0
function mkBackend(): MockBackend {
  idCounter = 0
  return new MockBackend({ now: () => NOW, idFactory: () => `id${++idCounter}` })
}

describe('MockBackend.queryChatHistory（spec §2.7）', () => {
  it('scope=conversation 过滤当前会话；结果按时间稳定排序', async () => {
    const mb = mkBackend()
    const page = await mb.queryChatHistory({ scope: { type: 'conversation', conversationId: 'conv-1001' }, timeZone: 'Asia/Shanghai', category: 'all', limit: 50 })
    expect(page.items.every((i) => i.conversationId === 'conv-1001')).toBe(true)
    const keys = page.items.map((i) => i.sortKey)
    expect([...keys].sort()).toEqual(keys)
  })
  it('关键词过滤（大小写不敏感，命中 content 片段）', async () => {
    const mb = mkBackend()
    const page = await mb.queryChatHistory({ scope: { type: 'all_conversations' }, query: '表情', timeZone: 'UTC', category: 'all', limit: 50 })
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items[0].snippet).toContain('表情')
  })
  it('分类过滤：category=sticker 只回贴图项（resource.kind=sticker）', async () => {
    const mb = mkBackend()
    const page = await mb.queryChatHistory({ scope: { type: 'all_conversations' }, timeZone: 'UTC', category: 'sticker', limit: 50 })
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.every((i) => i.resource?.kind === 'sticker')).toBe(true)
  })
  it('本地自然日过滤（isoToLocalDate 换算）', async () => {
    const mb = mkBackend()
    const page = await mb.queryChatHistory({ scope: { type: 'all_conversations' }, localDate: '2026-08-14', timeZone: 'Asia/Shanghai', category: 'all', limit: 50 })
    // 上海 2026-08-14 = UTC [2026-08-13T16:00Z, 2026-08-14T16:00Z)
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.every((i) => i.createdAt >= '2026-08-13T16:00:00.000Z' && i.createdAt < '2026-08-14T16:00:00.000Z')).toBe(true)
  })
  it('游标分页：limit 切片 + mock:{offset} 游标 + hasMore', async () => {
    const mb = mkBackend()
    const first = await mb.queryChatHistory({ scope: { type: 'all_conversations' }, timeZone: 'UTC', category: 'all', limit: 2 })
    expect(first.items.length).toBe(2)
    expect(first.hasMore).toBe(true)
    expect(first.nextCursor).toMatch(/^mock:\d+$/)
    const second = await mb.queryChatHistory({ scope: { type: 'all_conversations' }, timeZone: 'UTC', category: 'all', limit: 2, cursor: first.nextCursor })
    expect(second.items.length).toBeGreaterThan(0)
    const allIds = [...first.items, ...second.items].map((i) => i.messageId)
    expect(new Set(allIds).size).toBe(allIds.length)   // 不重复
  })
})

describe('MockBackend.getMessageContext（spec §4.5）', () => {
  it('窗口切片：before/after 围绕锚点，含锚点消息', async () => {
    const mb = mkBackend()
    const page = await mb.getMessageContext({ conversationId: 'conv-1001', messageId: 'msg-1002', before: 1, after: 1 })
    expect(page.items.some((m) => m.messageId === 'msg-1002')).toBe(true)
    expect(page.items.length).toBeLessThanOrEqual(3)
    expect(page.hasMore).toBe(false)
  })
  it('锚点不存在 → NOT_FOUND', async () => {
    const mb = mkBackend()
    await expect(mb.getMessageContext({ conversationId: 'conv-1001', messageId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('MockBackend.listStickers + sendMessage 记录（D8）', () => {
  it('listStickers 返回内置 st_ 清单（P0-2：StickerManifest{stickers}）', async () => {
    const mb = mkBackend()
    const manifest = await mb.listStickers()
    expect(manifest.stickers.length).toBeGreaterThan(0)
    expect(manifest.stickers.every((s) => /^st_/.test(s.stickerId))).toBe(true)
  })
  it('sendMessage 带 stickerId → 记录为 sticker 消息，可被 category=sticker 查到', async () => {
    const mb = mkBackend()
    await mb.connect({ serverUrl: 'mock://local' })
    await mb.sendMessage({ conversationId: 'conv-1001', text: '', clientRequestId: 'cr1', stickerId: 'st_1' })
    const page = await mb.queryChatHistory({ scope: { type: 'conversation', conversationId: 'conv-1001' }, timeZone: 'UTC', category: 'sticker', limit: 50 })
    expect(page.items.some((i) => i.resource?.stickerId === 'st_1')).toBe(true)   // Mock 领域富化（见下注）
  })
})
```

> **Mock/Real 差异注（P0-1）**：Mock `queryChatHistory` 直接产出领域 `ChatHistoryItem`（非 REST wire 形状），为演示「表情」分类缩略图保留 `resource` 富化（`toHistoryItem` 由本地 `Message.stickerId` 派生）；真实后端 search item 无 kind/url，联调后查看器分类缩略图需资源端点补充或契约变更（见 Task 6「P0-1 设计缺口」）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/mock-backend-search.spec.ts`
Expected: FAIL——`queryChatHistory` 空实现/`listStickers` 不存在/`getMessageContext` 空实现。

- [ ] **Step 3: 最小实现** —— `apps/desktop/src/main/transport/mock-backend.ts`

import 追加：`isoToLocalDate`、`ChatHistoryItem`/`ChatHistoryPage`/`StickerManifest` 类型。类字段：

```typescript
private messageRecords: Message[] = this.seedMessages()

private seedMessages(): Message[] {
  const mk = (messageId: string, conversationId: string, role: 'user' | 'assistant', createdAt: string, content?: string, stickerId?: string): Message =>
    ({ messageId, conversationId, role, createdAt, status: 'completed', ...(content !== undefined ? { content } : {}), ...(stickerId ? { stickerId } : {}) })
  return [
    mk('msg-1001', 'conv-1001', 'user', '2026-08-14T02:00:00.000Z', '你好，帮我总结一下'),
    mk('msg-1002', 'conv-1001', 'assistant', '2026-08-14T02:00:10.000Z', '好的，正在总结……'),
    mk('msg-1003', 'conv-1001', 'user', '2026-08-13T09:00:00.000Z', '发个表情', 'st_1'),
    mk('msg-1004', 'conv-1002', 'user', '2026-08-07T01:30:00.000Z', '历史会话的问题'),
    mk('msg-1005', 'conv-1002', 'assistant', '2026-08-07T01:31:00.000Z', '这是历史会话的回复')
  ]
}
```

替换 `getMessageContext`/`queryChatHistory`，新增 `listStickers`，改 `sendMessage`：

```typescript
async getMessageContext(input: MessageContextQuery): Promise<MessagePage> {
  const records = this.messageRecords.filter((m) => m.conversationId === input.conversationId)
    .sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)
  const idx = records.findIndex((m) => m.messageId === input.messageId)
  if (idx < 0) throw new CyreneError(CyreneErrorCode.NOT_FOUND, `消息不存在: ${input.messageId}`)
  const before = Math.min(input.before ?? 5, idx)
  const after = Math.min(input.after ?? 5, records.length - idx - 1)
  return { items: records.slice(idx - before, idx + after + 1), hasMore: false }
}

async queryChatHistory(input: ChatHistoryQuery): Promise<ChatHistoryPage> {
  const filtered = this.messageRecords
    .filter((m) => input.scope.type === 'all_conversations' || m.conversationId === input.scope.conversationId)
    .filter((m) => !input.query || (m.content ?? '').toLowerCase().includes(input.query.toLowerCase()))
    .filter((m) => !input.localDate || isoToLocalDate(m.createdAt, input.timeZone) === input.localDate)
    .filter((m) => categoryMatches(m, input.category))
    .map((m) => this.toHistoryItem(m))
    .sort((a, b) => a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0)
  let offset = 0
  if (input.cursor?.startsWith('mock:')) offset = Number(input.cursor.slice(5)) || 0
  const items = filtered.slice(offset, offset + input.limit)
  const nextOffset = offset + input.limit
  return { items, hasMore: nextOffset < filtered.length, nextCursor: nextOffset < filtered.length ? `mock:${nextOffset}` : undefined }
}

async listStickers(): Promise<StickerManifest> {
  return { stickers: [
    { stickerId: 'st_1', src: '/static/stickers/st_1.png' },
    { stickerId: 'st_2', src: '/static/stickers/st_2.png' },
    { stickerId: 'st_3', src: '/static/stickers/st_3.png' }
  ] }
}
```

`sendMessage` 追加消息记录（`scheduleReplay` 之前）：

```typescript
const recordedId = `msg-${this.idFactory().replace(/[^A-Za-z0-9_-]/g, '')}`
this.messageRecords.push({
  messageId: recordedId, conversationId: input.conversationId, role: 'user',
  createdAt: this.now().toISOString(), status: 'completed',
  ...(input.text ? { content: input.text } : {}),
  ...(input.stickerId ? { stickerId: input.stickerId } : {})
})
```

模块级助手：

```typescript
function categoryMatches(m: Message, category: HistoryCategory): boolean {
  if (category === 'all') return true
  if (category === 'sticker') return !!m.stickerId
  return false   // 其余分类 Mock 无样例（可扩展）
}

function senderLabelOf(role: Message['role']): string {
  switch (role) { case 'assistant': return 'assistant'; case 'system': return '系统'; case 'tool': return '工具'; default: return 'user' }
}
```

类内 `toHistoryItem`：

```typescript
private toHistoryItem(m: Message): ChatHistoryItem {
  const base: ChatHistoryItem = {
    hitId: `${m.conversationId}:${m.messageId}:`,
    conversationId: m.conversationId, messageId: m.messageId,
    senderLabel: senderLabelOf(m.role), createdAt: m.createdAt,
    sortKey: `${m.createdAt}|${m.messageId}`
  }
  if (m.content) base.snippet = m.content
  if (m.stickerId) {
    base.resource = { messageId: m.messageId, timestamp: m.createdAt, kind: 'sticker', url: `/static/stickers/${m.stickerId}.png`, stickerId: m.stickerId }
    base.snippet = '表情'
  }
  return base
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/mock-backend-search.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: PASS（9 tests）+ typecheck 绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/transport/mock-backend.ts apps/desktop/tests/unit/mock-backend-search.spec.ts
git commit -m "feat(G4 history): MockBackend 历史查询/上下文/表情清单确定性实现"
```

---

### Task 9: BackendAdapter 接口 + ChatService 透传（3 方法）

> `BackendAdapter` 增 `listStickers()`（queryChatHistory/getMessageContext 已有签名，类型随 Task 4 自动收紧）；`ChatService` 增 3 方法透传（handler 消费）。

**Files:**
- Modify: `apps/desktop/src/main/transport/backend-adapter.ts`
- Modify: `apps/desktop/src/main/chat/chat-service.ts`
- Test: `apps/desktop/tests/unit/chat-service.spec.ts`（追加 describe）

**Interfaces:**
- Consumes（Task 4）：`StickerManifest`
- Produces（Task 11 handler 消费）：`ChatService.queryChatHistory/getMessageContext/listStickers` 透传

- [ ] **Step 1: 写失败测试** —— 追加到 `apps/desktop/tests/unit/chat-service.spec.ts`

```typescript
import type { StickerManifest } from '../../src/shared/contracts/sticker'

describe('ChatService 历史/上下文/表情透传（G4）', () => {
  it('queryChatHistory/getMessageContext/listStickers 透传到 adapter', async () => {
    const adapter = {
      queryChatHistory: vi.fn(async () => ({ items: [], hasMore: false })),
      getMessageContext: vi.fn(async () => ({ items: [], hasMore: false })),
      listStickers: vi.fn(async (): Promise<StickerManifest> => ({ stickers: [{ stickerId: 'st_1', src: '/static/stickers/st_1.png' }] })),   // P0-2
      subscribe: vi.fn(() => () => {})
    }
    const svc = createChatService({ adapter, send: vi.fn(), getToken: async () => 'tok', connectionConfig: undefined as never, requireToken: false } as never)
    await svc.queryChatHistory({ scope: { type: 'all_conversations' }, timeZone: 'UTC', category: 'all', limit: 50 })
    await svc.getMessageContext({ conversationId: 'c1', messageId: 'm1' })
    await svc.listStickers()
    expect(adapter.queryChatHistory).toHaveBeenCalledTimes(1)
    expect(adapter.getMessageContext).toHaveBeenCalledTimes(1)
    expect(adapter.listStickers).toHaveBeenCalledTimes(1)
  })
})
```

（P2-4：`chat-service.spec.ts` 既有头部已 `import { describe, expect, it, vi } from 'vitest'` + `import { createChatService } from '../../src/main/chat/chat-service'`；本 describe 追加到该文件即可直接使用，无需新增 import。若需适配 `makeDeps` 注入式（`const { deps } = makeDeps()` + `createChatService(deps)`）亦可用，断言不变。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/chat-service.spec.ts`
Expected: FAIL——`svc.queryChatHistory`/`listStickers` 不存在。

- [ ] **Step 3: 最小实现**

`apps/desktop/src/main/transport/backend-adapter.ts` 接口追加：

```typescript
listStickers(): Promise<StickerManifest>
```

（`import type { StickerManifest } from '@shared/contracts/sticker'`；`queryChatHistory`/`getMessageContext` 已有。）

`apps/desktop/src/main/chat/chat-service.ts` 追加透传（import `ChatHistoryQuery`/`MessageContextQuery`/`StickerManifest` 类型）：

```typescript
queryChatHistory: (input: ChatHistoryQuery) => adapter.queryChatHistory(input),
getMessageContext: (input: MessageContextQuery) => adapter.getMessageContext(input),
listStickers: () => adapter.listStickers(),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/chat-service.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: PASS + typecheck 绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/transport/backend-adapter.ts apps/desktop/src/main/chat/chat-service.ts apps/desktop/tests/unit/chat-service.spec.ts
git commit -m "feat(G4 history): BackendAdapter.listStickers + ChatService 三方法透传"
```

---

### Task 10: Preload 3 方法 + DesktopApiLike（Renderer 窄接口）

> `desktop-api.ts` 新增 `queryChatHistory`/`getMessageContext`/`listStickers`（`unwrap` + 对应响应 Schema 防御）；`desktop-api.types.ts` DesktopApiLike 同步 +3。

**Files:**
- Modify: `apps/desktop/src/preload/desktop-api.ts`
- Modify: `apps/desktop/src/renderer/src/stores/desktop-api.types.ts`
- Test: `apps/desktop/tests/unit/desktop-api-chat.spec.ts`（追加 describe）

**Interfaces:**
- Consumes（Task 5）：`ChatHistoryPageSchema`/`StickerManifestSchema`
- Produces（Task 15/17-19 消费）：
  - `desktopApi.queryChatHistory(input: ChatHistoryQuery): Promise<ChatHistoryPage>`
  - `desktopApi.getMessageContext(input: MessageContextQuery): Promise<MessagePage>`
  - `desktopApi.listStickers(): Promise<StickerManifest>`

- [ ] **Step 1: 写失败测试** —— 追加到 `apps/desktop/tests/unit/desktop-api-chat.spec.ts`

```typescript
// P2-4：沿用本文件既有 importDesktopApi + mockIpc.invoke 注入式（文件头 vi.mock('electron') 已 mock ipcRenderer；
// beforeEach 已 reset mockIpc.invoke）。追加 describe 直接可用 importDesktopApi()/mockIpc，无需新 import。
describe('desktopApi 历史/上下文/表情方法（G4）', () => {
  it('queryChatHistory 解包 ChatHistoryPage（响应校验失败抛 SCHEMA_VALIDATION_FAILED）', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValueOnce({ items: [{ hitId: 'c1:m1:', conversationId: 'c1', messageId: 'm1', senderLabel: 'user', createdAt: 't', sortKey: 't|m1' }], hasMore: false })
    const page = await desktopApi.queryChatHistory({ scope: { type: 'all_conversations' }, timeZone: 'UTC', category: 'all', limit: 50 })
    expect(Array.isArray(page.items)).toBe(true)
    expect(typeof page.hasMore).toBe('boolean')
    mockIpc.invoke.mockResolvedValueOnce({ items: 'bad', hasMore: false })
    await expect(desktopApi.queryChatHistory({ scope: { type: 'all_conversations' }, timeZone: 'UTC', category: 'all', limit: 50 })).rejects.toMatchObject({ code: 'SCHEMA_VALIDATION_FAILED' })
  })
  it('listStickers 解包 StickerManifest{stickers}（P0-2）', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValueOnce({ stickers: [{ stickerId: 'st_1', src: '/static/stickers/st_1.png' }] })
    const manifest = await desktopApi.listStickers()
    expect(Array.isArray(manifest.stickers)).toBe(true)
    expect(manifest.stickers[0].stickerId).toBe('st_1')
  })
  it('getMessageContext 解包 MessagePage', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValueOnce({ items: [{ messageId: 'm1', conversationId: 'c1', role: 'user', status: 'completed', createdAt: 't', content: 'x' }], hasMore: false })
    const page = await desktopApi.getMessageContext({ conversationId: 'c1', messageId: 'm1' })
    expect(Array.isArray(page.items)).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/desktop-api-chat.spec.ts`
Expected: FAIL——`queryChatHistory`/`listStickers` 不存在。

- [ ] **Step 3: 最小实现**

`apps/desktop/src/preload/desktop-api.ts`：import `ChatHistoryQuery`/`StickerManifest` 类型与 `ChatHistoryPageSchema`/`StickerManifestSchema`，追加：

```typescript
async function queryChatHistory(input: ChatHistoryQuery): Promise<ChatHistoryPage> {
  return unwrap(await invokeWithArgs<ChatHistoryPage>(IpcChannels.chatQueryHistory, input), ChatHistoryPageSchema)
}
async function getMessageContext(input: MessageContextQuery): Promise<MessagePage> {
  return unwrap(await invokeWithArgs<MessagePage>(IpcChannels.chatGetMessageContext, input), MessagePageSchema)
}
async function listStickers(): Promise<StickerManifest> {
  return unwrap(await invoke<StickerManifest>(IpcChannels.chatListStickers), StickerManifestSchema)
}
```

`desktopApi` 对象追加三项；`desktop-api.types.ts` `DesktopApiLike` 追加：

```typescript
queryChatHistory(input: ChatHistoryQuery): Promise<ChatHistoryPage>
getMessageContext(input: MessageContextQuery): Promise<MessagePage>
listStickers(): Promise<StickerManifest>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/desktop-api-chat.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: PASS + typecheck 绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/preload/desktop-api.ts apps/desktop/src/renderer/src/stores/desktop-api.types.ts apps/desktop/tests/unit/desktop-api-chat.spec.ts
git commit -m "feat(G4 history): Preload 历史/上下文/表情三方法 + DesktopApiLike"
```

---

### Task 11: chat-handlers 3 通道注册 + 集成测试（history-viewer-ipc.spec.ts）

> `chat-handlers.ts` 注册 3 通道（request schema + 响应 Schema）；集成测试沿用 launchApp（mock）模式：`window.desktopApi.queryChatHistory/getMessageContext/listStickers` 经 IPC 往返返回预期结果；既有通道不回归。

**Files:**
- Modify: `apps/desktop/src/main/chat/chat-handlers.ts`
- Modify: `apps/desktop/tests/unit/chat-handlers.spec.ts`（追加：3 通道注册 + responseSchema 组合）
- Create: `apps/desktop/tests/integration/history-viewer-ipc.spec.ts`

**Interfaces:**
- Consumes（Task 5/7/8/9/10）
- Produces: 3 通道端到端可用（Task 15/17-19 经 desktopApi 调用）

- [ ] **Step 1: 写失败测试（单元层）** —— 追加到 `apps/desktop/tests/unit/chat-handlers.spec.ts`

```typescript
describe('G4 历史/上下文/表情通道（registerChatHandlers 真实接线）', () => {
  it('chatQueryHistory 响应 ChatHistoryPageSchema 拒绝畸形页', async () => {
    const h = createIpcHandler(chatQueryHistorySchema, ChatHistoryPageSchema, () => ({ items: [{ conversationId: 'c1' }], hasMore: false }), { sanitize, channel: IpcChannels.chatQueryHistory })
    const res = await h({ scope: { type: 'all_conversations' }, timeZone: 'UTC', category: 'all', limit: 50 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('SCHEMA_VALIDATION_FAILED')
  })
  it('chatListStickers 响应 StickerManifestSchema 拒绝畸形（P0-2：stickers 形状）', async () => {
    const h = createIpcHandler(chatListStickersSchema, StickerManifestSchema, () => ({ stickers: [{ stickerId: '' }] }), { sanitize, channel: IpcChannels.chatListStickers })
    expect((await h(undefined)).ok).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/chat-handlers.spec.ts`
Expected: FAIL——`ChatHistoryPageSchema`/`chatQueryHistorySchema` import 可过但 handler 未注册（若测试只断言 schema 则须确认 FAIL 来自未导出——按上文已导出）。

- [ ] **Step 3: 最小实现** —— `apps/desktop/src/main/chat/chat-handlers.ts`

import `chatQueryHistorySchema`/`chatGetMessageContextSchema`/`chatListStickersSchema` 与 `ChatHistoryPageSchema`/`StickerManifestSchema`，注册：

```typescript
registerHandler(IpcChannels.chatQueryHistory, handle(chatQueryHistorySchema, ChatHistoryPageSchema, (req) => svc.queryChatHistory(req), IpcChannels.chatQueryHistory), 1)
registerHandler(IpcChannels.chatGetMessageContext, handle(chatGetMessageContextSchema, MessagePageSchema, (req) => svc.getMessageContext(req), IpcChannels.chatGetMessageContext), 1)
registerHandler(IpcChannels.chatListStickers, handle(chatListStickersSchema, StickerManifestSchema, () => svc.listStickers(), IpcChannels.chatListStickers), 0)
```

- [ ] **Step 4: 写集成测试** —— `apps/desktop/tests/integration/history-viewer-ipc.spec.ts`

```typescript
// tests/integration/history-viewer-ipc.spec.ts
// Task 11:3 新通道经 IPC 往返（launchApp 恒 mock；MockBackend queryChatHistory 无需连接即可返回预置样例）。
import { describe, expect, it } from 'vitest'
import { closeApp, launchApp } from './helpers/app'

describe('历史查看器/表情 IPC 往返（G4）', () => {
  it('queryChatHistory 经 IPC 返回 ChatHistoryPage（过滤当前会话）', async () => {
    const launched = await launchApp()
    try {
      const page = await launched.page.evaluate(async () => {
        const r = await window.desktopApi.queryChatHistory({ scope: { type: 'conversation', conversationId: 'conv-1001' }, timeZone: 'UTC', category: 'all', limit: 50 })
        return { hasMore: r.hasMore, first: r.items[0] }
      })
      expect(typeof page.hasMore).toBe('boolean')
      expect(page.first?.conversationId ?? 'conv-1001').toBe('conv-1001')
    } finally { await closeApp(launched) }
  })
  it('listStickers 经 IPC 返回内置 st_ 清单（P0-2：StickerManifest{stickers}）', async () => {
    const launched = await launchApp()
    try {
      const manifest = await launched.page.evaluate(() => window.desktopApi.listStickers())
      expect(manifest.stickers.length).toBeGreaterThan(0)
      expect(manifest.stickers[0].stickerId).toMatch(/^st_/)
    } finally { await closeApp(launched) }
  })
  it('getMessageContext 经 IPC 返回 MessagePage 窗口', async () => {
    const launched = await launchApp()
    try {
      const page = await launched.page.evaluate(() => window.desktopApi.getMessageContext({ conversationId: 'conv-1001', messageId: 'msg-1002', before: 1, after: 1 }))
      expect(page.items.some((m) => m.messageId === 'msg-1002')).toBe(true)
    } finally { await closeApp(launched) }
  })
})
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/chat-handlers.spec.ts && xvfb-run -a pnpm -F @cyrene/desktop test:integration tests/integration/history-viewer-ipc.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/chat/chat-handlers.ts apps/desktop/tests/unit/chat-handlers.spec.ts apps/desktop/tests/integration/history-viewer-ipc.spec.ts
git commit -m "feat(G4 history): 3 通道 handler 注册 + 集成往返测试"
```

---

### Task 12: 贴图媒体代理 G4 硬化 + dev CSP（P3-2/P3-4/D9）

> 复用 G3 通用媒体代理（`parseMediaPath`/`isDocumentRequest`/`MediaService.stream('sticker',...)`/handler 媒体分支/导航 deny 已由 G3 交付）；G4 做特有硬化：① `MediaService.streamSticker` 加 **1MB 响应体上限**（P3-2，docs/07 行 101 协议/域名/大小/MIME 四项，贴图公开静态免鉴权）；② MIME 剥参 `split(';')[0].trim()` 匹配（P3-4，容忍 `; charset=` 参数）。③ dev 两处 `img-src` 追加 `cyrene:`（D9：prod 同源 `img-src 'self'` 即放行不改 `protocol/csp.ts`；dev 需 `dev-csp.ts` + `index.html` meta 两处，缺一即被 AND 交集剔除失效）。stickerId 白名单/fetch host 钉定/MIME 白名单/导航 deny/`Sec-Fetch-Dest` 拒绝已含于 G3（本任务验证承接）。**（P2-2）**本任务测试脚手架引用了 G3 尚未交付的内部成员（`mkService`/`STICKER_MIME`/`svc.stream` 等方法级形状，未在 spec 定义）：执行时先按全局约束 11 处理——G3 落地后与 G3 `media-service.ts` 实际实现对齐，形状不符则**以 G3 为准重写本任务代码/测试**；G3 未落地前按 spec §4.6 的 `MediaService` 接口写契约测试（只测 G4 硬化语义），文件头标注「待 G3 落地后接入」。

**Files:**
- Modify: `apps/desktop/src/main/attachments/media-service.ts`（streamSticker 硬化）
- Modify: `apps/desktop/src/main/config/dev-csp.ts`
- Modify: `apps/desktop/src/renderer/index.html`
- Test: `apps/desktop/tests/unit/media-service.spec.ts`（追加）、`apps/desktop/tests/unit/dev-csp.spec.ts`（追加）

**Interfaces:**
- Consumes（G3）：`MediaService`、`parseMediaPath`、`isDocumentRequest`、`registerCyreneProtocolHandler({rendererRoot, resolveMedia})`、导航 `__cyrene-media` deny
- Produces（Task 18/19 渲染消费）：`cyrene://renderer/__cyrene-media/sticker/{stickerId}` 经硬化后可用；dev CSP `img-src 'self' data: blob: cyrene:`

- [ ] **Step 1: 写失败测试** —— 追加到 `apps/desktop/tests/unit/media-service.spec.ts`

```typescript
describe('MediaService.streamSticker G4 硬化（spec §4.6 P3-2/P3-4）', () => {
  it('MIME 带参数容忍：image/png; charset=utf-8 通过（剥参 trim 匹配）', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([0x89, 0x50]), { status: 200, headers: { 'content-type': 'image/png; charset=utf-8' } }))
    const svc = mkService({ fetchImpl })
    const res = await svc.stream('sticker', 'st_1', new Request('cyrene://renderer/__cyrene-media/sticker/st_1', { headers: { 'sec-fetch-dest': 'img' } }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
  })
  it('响应体超 1MB → 404 占位（中止注入，P3-2）', async () => {
    const big = new Uint8Array(1024 * 1024 + 1)
    const fetchImpl = vi.fn(async () => new Response(big, { status: 200, headers: { 'content-type': 'image/png' } }))
    const svc = mkService({ fetchImpl })
    const res = await svc.stream('sticker', 'st_1', new Request('cyrene://renderer/__cyrene-media/sticker/st_1', { headers: { 'sec-fetch-dest': 'img' } }))
    expect(res.status).toBe(404)
  })
  it('恰好 1MB 通过；MIME 不匹配 → 415', async () => {
    const exact = new Uint8Array(1024 * 1024)
    const svcExact = mkService({ fetchImpl: async () => new Response(exact, { status: 200, headers: { 'content-type': 'image/png' } }) })
    expect((await svcExact.stream('sticker', 'st_1', new Request('cyrene://renderer/__cyrene-media/sticker/st_1', { headers: { 'sec-fetch-dest': 'img' } }))).status).toBe(200)
    const svcBad = mkService({ fetchImpl: async () => new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'text/html' } }) })
    expect((await svcBad.stream('sticker', 'st_1', new Request('cyrene://renderer/__cyrene-media/sticker/st_1', { headers: { 'sec-fetch-dest': 'img' } }))).status).toBe(415)
  })
})
```

追加到 `apps/desktop/tests/unit/dev-csp.spec.ts`：

```typescript
it('dev img-src 追加 cyrene:（贴图经 cyrene:// 媒体代理；prod 同源不改，D9）', () => {
  const csp = buildDevCsp(resolveTrustedDevOrigins({}))
  expect(csp).toContain("img-src 'self' data: blob: cyrene:")
  const connect = csp.split('; ').find((d) => d.startsWith('connect-src'))!
  expect(connect).not.toContain('cyrene:')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/media-service.spec.ts tests/unit/dev-csp.spec.ts`
Expected: FAIL——无 1MB 上限（大响应返回 200）/MIME 参数误拒（无 trim）/dev `img-src` 无 `cyrene:`。

- [ ] **Step 3: 最小实现**

`apps/desktop/src/main/attachments/media-service.ts`：`streamSticker` 替换为（缓冲 + 1MB 上限 + 剥参 trim）：

```typescript
const STICKER_MAX_BYTES = 1024 * 1024   // P3-2：docs/07 行 101 大小上限；公开静态贴图免鉴权

/** 读响应体并计数；超上限返回 null（中止，回 404 占位） */
private async readBodyCapped(res: Response): Promise<Uint8Array | null> {
  const reader = res.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > STICKER_MAX_BYTES) { await reader.cancel(); return null }
      chunks.push(value)
    }
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength }
  return out
}

private async streamSticker(stickerId: string): Promise<Response> {
  if (!STICKER_ID_PATTERN.test(stickerId)) return new Response('Forbidden', { status: 403 })
  const base = this.baseUrl()
  if (!base) return new Response('Not Found', { status: 404 })
  const url = `${base.replace(/\/$/, '')}/static/stickers/${encodeURIComponent(stickerId)}.png`
  try {
    const res = await this.fetchImpl(url)
    // P3-4：MIME 剥参匹配（容忍 ; charset= 等参数，严格相等会误拒）
    const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim()
    if (res.status !== 200 || mime !== STICKER_MIME) return new Response('Unsupported Media Type', { status: 415 })
    const body = await this.readBodyCapped(res)
    if (body === null) return new Response('Not Found', { status: 404 })   // 超 1MB → 占位（P3-2）
    return new Response(body, { status: 200, headers: { 'Content-Type': STICKER_MIME, 'Cache-Control': 'public, max-age=86400' } })
  } catch {
    return new Response('Not Found', { status: 404 })
  }
}
```

`apps/desktop/src/main/config/dev-csp.ts`：`"img-src 'self' data: blob: cyrene:"`（幂等；若 G3 已加则无改动）。

`apps/desktop/src/renderer/index.html` meta CSP：`img-src` 段改为 `img-src 'self' data: blob: cyrene:`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/media-service.spec.ts tests/unit/dev-csp.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: 全绿。

- [ ] **Step 5: 验证承接（G3 防线）** —— 追加到 `apps/desktop/tests/unit/navigation.spec.ts`

```typescript
it('cyrene://renderer/__cyrene-media/sticker/* 前缀 deny（贴图字节不得作顶层文档，P3-1 双保险）', () => {
  expect(classifyNavigation('cyrene://renderer/__cyrene-media/sticker/st_1', undefined, false)).toBe('deny')
  expect(classifyNavigation('cyrene://renderer/index.html', undefined, false)).toBe('app')
})
```

Run: `pnpm -F @cyrene/desktop test tests/unit/navigation.spec.ts && pnpm -F @cyrene/desktop build`
Expected: 全绿（导航 deny 若已由 G3 交付则测试直接通过）。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/attachments/media-service.ts apps/desktop/src/main/config/dev-csp.ts apps/desktop/src/renderer/index.html apps/desktop/tests/unit/media-service.spec.ts apps/desktop/tests/unit/dev-csp.spec.ts apps/desktop/tests/unit/navigation.spec.ts
git commit -m "feat(G4 sticker): 贴图媒体代理 1MB 上限+MIME 剥参硬化 + dev CSP img-src cyrene:"
```

---

### Task 13: message.store —— 高亮 + nextCursor/loadEarlier/loadContextWindow + send(stickerId)

> 新增 `highlightMessageId/highlightSegmentId/setHighlight/clearHighlight`（D6）；`nextCursor` + `loadEarlier`（跳转后分页续接，P2-3，镜像 conversationStore.getMore 的 `!nextCursor` 早退）；`loadContextWindow(messageId, before?, after?)`（getMessageContext 窗口 + loadPage 去重合并 + 首页 getMessages 游标初始化）；`resetConversation` 清高亮/游标；`send(text, stickerId?)` 透传 stickerId 并落乐观消息（D8）。

**Files:**
- Modify: `apps/desktop/src/renderer/src/stores/message.store.ts`
- Test: `apps/desktop/tests/unit/message.store.spec.ts`（追加 describe）

**Interfaces:**
- Consumes（Task 10）：`api.getMessageContext`/`api.getMessages`
- Produces（Task 14/15/19 消费）：
  - `highlightMessageId: Ref<string | undefined>`、`highlightSegmentId: Ref<string | undefined>`
  - `setHighlight(messageId: string, segmentId?: string): void`、`clearHighlight(): void`
  - `nextCursor: Ref<string | undefined>`、`loadingEarlier: Ref<boolean>`、`loadEarlier(): Promise<void>`
  - `loadContextWindow(messageId: string, before?: number, after?: number): Promise<boolean>`
  - `send(text: string, stickerId?: string): Promise<void>`（既有调用兼容）

- [ ] **Step 1: 写失败测试** —— 追加到 `apps/desktop/tests/unit/message.store.spec.ts`

```typescript
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { useMessageStore } from '../../src/renderer/src/stores/message.store'

describe('message.store 高亮与上下文窗口（spec §4.5，D5/D6/P2-3）', () => {
  it('setHighlight/clearHighlight 维护高亮状态（含分段）', () => {
    const store = useMessageStore()
    store.setHighlight('m1', 'seg1')
    expect(store.highlightMessageId).toBe('m1')
    expect(store.highlightSegmentId).toBe('seg1')
    store.clearHighlight()
    expect(store.highlightMessageId).toBeUndefined()
  })
  it('loadContextWindow：getMessageContext 窗口 + 首页游标初始化 + 去重合并', async () => {
    setDesktopApi({
      getMessageContext: async () => ({ items: [
        { messageId: 'm1', conversationId: 'c1', role: 'user', status: 'completed', createdAt: '2026-08-14T02:00:00.000Z', content: '命中' },
        { messageId: 'm2', conversationId: 'c1', role: 'assistant', status: 'completed', createdAt: '2026-08-14T02:00:10.000Z' }
      ], hasMore: false }),
      getMessages: async () => ({ items: [
        { messageId: 'm1', conversationId: 'c1', role: 'user', status: 'completed', createdAt: '2026-08-14T02:00:00.000Z', content: '命中' },
        { messageId: 'm0', conversationId: 'c1', role: 'user', status: 'completed', createdAt: '2026-08-14T01:00:00.000Z', content: '更早' }
      ], hasMore: true, nextCursor: 'cur-1' }),
      getMessageContextCalled: 0
    } as never)
    const conversationStore = useConversationStore()
    conversationStore.$patch({ currentId: 'c1' })
    const store = useMessageStore()
    store.resetConversation('c1')
    const ok = await store.loadContextWindow('m1')
    expect(ok).toBe(true)
    expect(store.nextCursor).toBe('cur-1')
    // P1-1：getMessageContext 返回 [m1,m2] + 首页 getMessages 返回 [m1,m0]，loadPage 按 messageId 去重合并 → m0/m1/m2 共 3 条
    expect(store.order.length).toBe(3)
    expect(store.byId.m1).toBeDefined()
  })
  it('loadEarlier：!nextCursor 早退（镜像 getMore）；成功后更新游标', async () => {
    let called = 0
    setDesktopApi({ getMessages: async () => { called++; return { items: [], hasMore: false, nextCursor: undefined } } } as never)
    const conversationStore = useConversationStore()
    conversationStore.$patch({ currentId: 'c1' })
    const store = useMessageStore()
    store.resetConversation('c1')
    await store.loadEarlier()          // 无 nextCursor → 早退
    expect(called).toBe(0)
    store.$patch({ nextCursor: 'cur-1' })
    await store.loadEarlier()
    expect(called).toBe(1)
  })
  it('send 携带 stickerId 透传 + 乐观消息标记', async () => {
    const sent: unknown[] = []
    setDesktopApi({ send: async (input: unknown) => { sent.push(input); return { clientRequestId: 'cr1', serverMessageId: 'sm1' } } } as never)
    const conversationStore = useConversationStore()
    conversationStore.$patch({ currentId: 'c1' })
    const store = useMessageStore()
    store.resetConversation('c1')
    await store.send('', 'st_1')
    expect(sent[0]).toMatchObject({ conversationId: 'c1', text: '', stickerId: 'st_1' })
  })
})
```

（P2-4：`message.store.spec.ts` 既有头部已 `import { createPinia, setActivePinia } from 'pinia'` + 全局 `beforeEach(() => { setActivePinia(createPinia()); setDesktopApi(mockApi); setCurrent('conv-1') })`；追加的 describe 直接沿用（`useConversationStore`/`useMessageStore`/`setDesktopApi` 均在既有 import 内）。若隔离需要，可在本 describe 内再 `beforeEach(() => setActivePinia(createPinia()))` 重置 pinia 状态。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/message.store.spec.ts`
Expected: FAIL——`setHighlight`/`loadContextWindow`/`loadEarlier` 不存在；`send` 不接受 stickerId。

- [ ] **Step 3: 最小实现** —— `apps/desktop/src/renderer/src/stores/message.store.ts`

状态追加：

```typescript
const highlightMessageId = ref<string>()
const highlightSegmentId = ref<string>()
const nextCursor = ref<string>()
const loadingEarlier = ref(false)
```

动作追加：

```typescript
function setHighlight(messageId: string, segmentId?: string): void {
  highlightMessageId.value = messageId
  highlightSegmentId.value = segmentId
}
function clearHighlight(): void {
  highlightMessageId.value = undefined
  highlightSegmentId.value = undefined
}

/** 跳转后分页续接（P2-3）：getMessageContext 窗口落地后，再补一次首页 getMessages 做游标初始化；
 *  首页 items 与窗口经 loadPage 去重合并（upsert 按 messageId，按 createdAt 稳定排序）。 */
async function loadContextWindow(messageId: string, before = 5, after = 5): Promise<boolean> {
  const conversationId = useConversationStore().currentId
  if (!conversationId) return false
  try {
    const page = await api.getMessageContext({ conversationId, messageId, before, after })
    loadPage(page)
    reorder()
    const first = await api.getMessages({ conversationId, limit: 20 })
    nextCursor.value = first.nextCursor
    loadPage(first)
    reorder()
    return true
  } catch {
    return false
  }
}

/** 加载更早消息：!nextCursor 早退（镜像 conversationStore.getMore）；成功更新游标；失败保留旧结果可重试 */
async function loadEarlier(): Promise<void> {
  const conversationId = useConversationStore().currentId
  if (!conversationId || !nextCursor.value || loadingEarlier.value) return
  loadingEarlier.value = true
  try {
    const page = await api.getMessages({ conversationId, before: nextCursor.value })
    loadPage(page)
    reorder()
    nextCursor.value = page.nextCursor
  } catch {
    // 保留旧结果，可重试
  } finally {
    loadingEarlier.value = false
  }
}

/** 按 (createdAt, messageId) 稳定重排 order（批量加载后保序；流式单条 upsert 不受影响） */
function reorder(): void {
  const cmp = (a: Message, b: Message): number =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.messageId < b.messageId ? -1 : 1
  order.value.sort((x, y) => cmp(byId.value[x], byId.value[y]))
}
```

`resetConversation` 追加 `nextCursor.value = undefined; loadingEarlier.value = false; highlightMessageId.value = undefined; highlightSegmentId.value = undefined`。

`send` 改为 `async function send(text: string, stickerId?: string)`：乐观消息 content 条件化 + stickerId；`api.send({ conversationId, text, clientRequestId, ...(stickerId ? { stickerId } : {}) })`。

return 增补 `highlightMessageId, highlightSegmentId, setHighlight, clearHighlight, nextCursor, loadingEarlier, loadContextWindow, loadEarlier`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/message.store.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: PASS（既有 + 4）+ typecheck 绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/stores/message.store.ts apps/desktop/tests/unit/message.store.spec.ts
git commit -m "feat(G4 history): message.store 高亮/上下文窗口/分页续接 + send stickerId（D5/D6/P2-3）"
```

---

### Task 14: conversation.store —— activate(id, anchor?) 最小扩展 + jumpToMessage（D5）

> `activate(id, anchor?)`：anchor 缺省行为完全不变（回归零风险）；anchor 存在时（复用 epoch 守卫 + currentId 立即切换 + resetConversation + applyPendingReplay 后）改拉 `loadContextWindow` 上下文窗口替代首页 + setHighlight。`jumpToMessage(conversationId, messageId, segmentId?)`：当前会话直接 loadContextWindow + setHighlight；跨会话走 activate(anchor)。失败写 `conversationStore.error`（聊天区错误横幅，两分支统一：查看器已关闭后失败 → 横幅；不清空聊天内容）。

**Files:**
- Modify: `apps/desktop/src/renderer/src/stores/conversation.store.ts`
- Test: `apps/desktop/tests/unit/conversation.store.spec.ts`（追加 describe）

**Interfaces:**
- Consumes（Task 13）：`messageStore.loadContextWindow/setHighlight`
- Produces（Task 15/17 消费）：
  - `activate(id: string, anchor?: { messageId: string; segmentId?: string }): Promise<void>`
  - `jumpToMessage(conversationId: string, messageId: string, segmentId?: string): Promise<boolean>`

- [ ] **Step 1: 写失败测试** —— 追加到 `apps/desktop/tests/unit/conversation.store.spec.ts`

```typescript
describe('conversation.store activate(id, anchor?) 与 jumpToMessage（spec §4.5，D5）', () => {
  it('activate 无 anchor 行为不变（回归：首屏 getMessages 拉取）', async () => {
    const getMessages = vi.fn(async () => ({ items: [], hasMore: false }))
    setDesktopApi({ activate: async () => ({ conversationId: 'c2' }), getMessages, getMessageContext: vi.fn() } as never)
    const cs = useConversationStore()
    await cs.activate('c2')
    expect(getMessages).toHaveBeenCalledTimes(1)
  })
  it('activate 带 anchor → loadContextWindow 替代首页 + setHighlight', async () => {
    const ms = useMessageStore()
    const loadContextWindow = vi.fn(async () => true)
    const setHighlight = vi.fn()
    ms.loadContextWindow = loadContextWindow as never
    ms.setHighlight = setHighlight as never
    setDesktopApi({ activate: async () => ({ conversationId: 'c3' }) } as never)
    const cs = useConversationStore()
    await cs.activate('c3', { messageId: 'm9', segmentId: 'seg1' })
    expect(loadContextWindow).toHaveBeenCalledWith('m9')
    expect(setHighlight).toHaveBeenCalledWith('m9', 'seg1')
  })
  it('jumpToMessage 当前会话：直接 loadContextWindow + setHighlight；失败写 error', async () => {
    const ms = useMessageStore()
    ms.loadContextWindow = vi.fn(async () => false) as never
    ms.setHighlight = vi.fn() as never
    setDesktopApi({} as never)
    const cs = useConversationStore()
    cs.$patch({ currentId: 'c1' })
    const ok = await cs.jumpToMessage('c1', 'm1')
    expect(ok).toBe(false)
    expect(cs.error?.message).toContain('无法定位消息')
  })
  it('jumpToMessage 跨会话：走 activate(anchor)', async () => {
    const activate = vi.fn(async () => {})
    const cs = useConversationStore()
    cs.activate = activate as never
    cs.$patch({ currentId: 'c1' })
    await cs.jumpToMessage('c9', 'm1', 'seg1')
    expect(activate).toHaveBeenCalledWith('c9', { messageId: 'm1', segmentId: 'seg1' })
  })
})
```

（P2-4：`conversation.store.spec.ts` 既有全局 `beforeEach(() => { setActivePinia(createPinia()); setDesktopApi(mockApi); vi.resetAllMocks() })` 已注入 pinia + mock api；追加的 describe 直接沿用。`mockApi` 已含 `activate`/`getMessages`（`getMessageContext` 缺失不影响——本 describe 各用例用 `setDesktopApi(...)` 局部覆盖其要 mock 的方法）。注意本 describe 内 `ms.loadContextWindow = ...` 赋值覆盖需在 pinia store 实例上操作，`useMessageStore()` 每次返回同一实例。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/conversation.store.spec.ts`
Expected: FAIL——`activate` 不接受 anchor；`jumpToMessage` 不存在。

- [ ] **Step 3: 最小实现** —— `apps/desktop/src/renderer/src/stores/conversation.store.ts`

`activate` 签名与分支：

```typescript
async function activate(id: string, anchor?: { messageId: string; segmentId?: string }): Promise<void> {
  const myEpoch = ++epoch
  busy.value = true
  currentId.value = id
  const messageStore = useMessageStore()
  messageStore.resetConversation(id)
  messageStore.applyPendingReplay(id)
  try {
    await api.activate(id)
    if (myEpoch !== epoch) return
    if (anchor) {
      const ok = await messageStore.loadContextWindow(anchor.messageId)
      if (myEpoch !== epoch) return
      if (ok) messageStore.setHighlight(anchor.messageId, anchor.segmentId)
      error.value = ok ? undefined : parsePublicError('无法定位消息')
    } else {
      const p = await api.getMessages({ conversationId: id })
      if (myEpoch !== epoch) return
      messageStore.loadPage(p)
      error.value = undefined
    }
  } catch (e) {
    if (myEpoch !== epoch) return
    error.value = parsePublicError(messageOf(e))
  } finally {
    if (myEpoch === epoch) busy.value = false
  }
}
```

新增：

```typescript
/** 来源跳转（D5）：当前会话直接上下文窗口；跨会话走 activate(anchor)。失败经 error（聊天区横幅，两分支统一；不清空聊天内容）。 */
async function jumpToMessage(conversationId: string, messageId: string, segmentId?: string): Promise<boolean> {
  if (currentId.value === conversationId) {
    const ok = await useMessageStore().loadContextWindow(messageId)
    if (ok) useMessageStore().setHighlight(messageId, segmentId)
    else error.value = parsePublicError('无法定位消息')
    return ok
  }
  await activate(conversationId, { messageId, segmentId })
  return true   // 失败已由 activate 写 error（横幅）
}
```

return 增补 `jumpToMessage`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/conversation.store.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: PASS（既有 + 4）+ typecheck 绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/stores/conversation.store.ts apps/desktop/tests/unit/conversation.store.spec.ts
git commit -m "feat(G4 history): conversation.store activate(id,anchor?) + jumpToMessage（D5）"
```

---

### Task 15: historyViewerStore —— 独立 Pinia store（D4/D5/D10/D11/D12/D15）+ buildQuery 纯函数

> 查询/分页/跳转编排单测可测、与组件解耦。`buildQuery` 纯函数（D15 统一路径：关键词/日期/分类全部经 queryChatHistory）；`submitQuery` 显式提交（busy 防重入、失败保留旧结果）；`loadMore` 不透明游标 + 去重合并 + 稳定排序 + busy 防重入（D12）；`jumpTo` 关闭查看器并返回跳转目标（D5）；打开不阻塞聊天流（store 级无阻塞点，D10）。

**Files:**
- Create: `apps/desktop/src/renderer/src/stores/historyViewer.store.ts`
- Test: `apps/desktop/tests/unit/chat-history-query.spec.ts`（buildQuery）+ `apps/desktop/tests/unit/history-viewer.store.spec.ts`

**Interfaces:**
- Consumes（Task 10/14）：`api.queryChatHistory`、`useConversationStore`
- Produces（Task 17 组件 消费）：
  - `export interface BuildQueryInput { keyword: string; localDate: string; scope: 'conversation' | 'all'; category: HistoryCategory; conversationId?: string; cursor?: string; limit?: number }`
  - `export function buildQuery(input: BuildQueryInput): ChatHistoryQuery`
  - `useHistoryViewerStore()` 暴露：`open: Ref<boolean>`、`keyword/localDate/scope/category` refs、`items: Ref<ChatHistoryItem[]>`、`loading/loadingMore/hasMore/nextCursor/hasSearched/error/busy` refs、`openViewer(initialCategory?: HistoryCategory): void`、`closeViewer(): void`、`submitQuery(): Promise<void>`、`loadMore(): Promise<void>`、`jumpTo(hit: ChatHistoryItem): { conversationId: string; messageId: string; segmentId?: string }`

- [ ] **Step 1: 写失败测试（buildQuery）** —— `apps/desktop/tests/unit/chat-history-query.spec.ts`

```typescript
// tests/unit/chat-history-query.spec.ts
// Task 15:buildQuery 纯函数（spec §4.4，D15）——UI 状态 → ChatHistoryQuery 映射。
// env=node：Intl 取本机时区，测试断言结构不依赖具体时区值。
import { describe, expect, it } from 'vitest'
import { buildQuery } from '../../src/renderer/src/stores/historyViewer.store'

describe('buildQuery（UI 状态 → ChatHistoryQuery）', () => {
  it('scope=conversation 传 conversationId；scope=all 不传', () => {
    const q1 = buildQuery({ keyword: '', localDate: '', scope: 'conversation', category: 'all', conversationId: 'c1' })
    expect(q1.scope).toEqual({ type: 'conversation', conversationId: 'c1' })
    const q2 = buildQuery({ keyword: '', localDate: '', scope: 'all', category: 'all' })
    expect(q2.scope).toEqual({ type: 'all_conversations' })
  })
  it('关键词空串不传 query（空白 trim）', () => {
    const q = buildQuery({ keyword: '   ', localDate: '', scope: 'all', category: 'sticker' })
    expect(q.query).toBeUndefined()
  })
  it('关键词非空 → query；localDate → 传 localDate 并必带 timeZone', () => {
    const q = buildQuery({ keyword: '你好', localDate: '2026-08-14', scope: 'all', category: 'all' })
    expect(q.query).toBe('你好')
    expect(q.localDate).toBe('2026-08-14')
    expect(q.timeZone).toBeTruthy()
  })
  it('无日期无关键词：不传 localDate，timeZone 仍必带', () => {
    const q = buildQuery({ keyword: '', localDate: '', scope: 'all', category: 'all' })
    expect(q.localDate).toBeUndefined()
    expect(q.timeZone).toBeTruthy()
  })
  it('limit 默认 50；cursor 透传', () => {
    const q = buildQuery({ keyword: '', localDate: '', scope: 'all', category: 'all', cursor: 'abc' })
    expect(q.limit).toBe(50)
    expect(q.cursor).toBe('abc')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/chat-history-query.spec.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 最小实现** —— `apps/desktop/src/renderer/src/stores/historyViewer.store.ts`（buildQuery 部分）

```typescript
// src/renderer/src/stores/historyViewer.store.ts
// 阶段 3 G4（spec §4.1-4.5，D4/D5/D10/D11/D12/D15）：历史查看器独立 Pinia store。
// 查询/分页/跳转编排在此（可单测）；组件只消费状态与动作。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ChatHistoryItem, ChatHistoryPage, ChatHistoryQuery, HistoryCategory } from '@shared/contracts'
import { api } from './desktop-api'
import { useConversationStore } from './conversation.store'
import { parsePublicError, type PublicError } from '../utils/public-error'

export interface BuildQueryInput {
  keyword: string
  localDate: string
  scope: 'conversation' | 'all'
  category: HistoryCategory
  conversationId?: string
  cursor?: string
  limit?: number
}

/** D15 统一路径：关键词/日期/分类/scope/分页全部映射到 queryChatHistory 单一路径 */
export function buildQuery(input: BuildQueryInput): ChatHistoryQuery {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const keyword = input.keyword.trim()
  return {
    scope: input.scope === 'all'
      ? { type: 'all_conversations' }
      : { type: 'conversation', conversationId: input.conversationId ?? '' },
    ...(keyword ? { query: keyword } : {}),
    ...(input.localDate ? { localDate: input.localDate } : {}),
    timeZone,
    category: input.category,
    ...(input.cursor ? { cursor: input.cursor } : {}),
    limit: input.limit ?? 50
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/chat-history-query.spec.ts`
Expected: PASS（5 tests）。

- [ ] **Step 5: 写失败测试（store）** —— `apps/desktop/tests/unit/history-viewer.store.spec.ts`

```typescript
// tests/unit/history-viewer.store.spec.ts
// Task 15:historyViewerStore（spec §4.1/§4.5/§4.8，D4/D10/D11/D12）——open 预置、submitQuery 成功/失败保留旧结果、
// loadMore 游标 + busy 防重入、无结果空态、jumpTo 编排、不阻塞聊天（P2-5：打开查看器期间 messageStore 事件继续应用，D10）。
// env=node：setDesktopApi 注入 mock；pinia 用 createPinia + setActivePinia（P1-2：node 无全局 pinia，缺则每用例抛「No active Pinia」）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { useHistoryViewerStore } from '../../src/renderer/src/stores/historyViewer.store'
import { useMessageStore } from '../../src/renderer/src/stores/message.store'

function item(messageId: string, createdAt: string): import('@shared/contracts').ChatHistoryItem {
  return { hitId: `c1:${messageId}:`, conversationId: 'c1', messageId, senderLabel: 'user', createdAt, sortKey: `${createdAt}|${messageId}` }
}

beforeEach(() => {
  setActivePinia(createPinia())
  setDesktopApi({ queryChatHistory: vi.fn() } as never)
})

describe('historyViewerStore', () => {
  it('open(initialCategory?) 预置分类（资源入口 → image_video）', () => {
    const s = useHistoryViewerStore()
    s.openViewer('image_video')
    expect(s.open).toBe(true)
    expect(s.category).toBe('image_video')
    s.openViewer()
    expect(s.category).toBe('all')
  })
  it('submitQuery 成功：写 items/hasMore/nextCursor/hasSearched', async () => {
    setDesktopApi({ queryChatHistory: async () => ({ items: [item('m1', 't1')], hasMore: false, nextCursor: undefined }) } as never)
    const s = useHistoryViewerStore()
    s.openViewer()
    await s.submitQuery()
    expect(s.items).toHaveLength(1)
    expect(s.hasSearched).toBe(true)
    expect(s.error).toBeUndefined()
  })
  it('submitQuery 失败：保留旧结果 + 写 error（不清空聊天内容）', async () => {
    setDesktopApi({ queryChatHistory: vi.fn(async () => { throw new Error('[HTTP_500] 服务端错误') }) } as never)
    const s = useHistoryViewerStore()
    s.openViewer()
    s.$patch({ items: [item('mOld', 'tOld')] })
    await s.submitQuery()
    expect(s.items).toHaveLength(1)          // 旧结果保留
    expect(s.error?.message).toContain('服务端错误')
  })
  it('loadMore：带 cursor 去重合并 + busy 防重入', async () => {
    const calls: Array<Record<string, unknown>> = []
    setDesktopApi({
      queryChatHistory: async (input: Record<string, unknown>) => {
        calls.push(input)
        return { items: [item('m2', 't2')], hasMore: false, nextCursor: undefined }
      }
    } as never)
    const s = useHistoryViewerStore()
    s.openViewer()
    s.$patch({ items: [item('m1', 't1')], hasMore: true, nextCursor: 'cur-1' })
    const p1 = s.loadMore()
    const p2 = s.loadMore()       // busy 防重入：第二次直接返回
    await Promise.all([p1, p2])
    expect(calls).toHaveLength(1)
    expect(calls[0].cursor).toBe('cur-1')
    expect(s.items.map((i) => i.messageId)).toEqual(['m1', 'm2'])
  })
  it('无结果空态：hasSearched=true 且 items 空', async () => {
    setDesktopApi({ queryChatHistory: async () => ({ items: [], hasMore: false }) } as never)
    const s = useHistoryViewerStore()
    s.openViewer()
    await s.submitQuery()
    expect(s.hasSearched).toBe(true)
    expect(s.items).toHaveLength(0)
  })
  it('jumpTo：关闭查看器并返回跳转目标（含 segmentId）', () => {
    const s = useHistoryViewerStore()
    s.openViewer()
    const hit = { ...item('m5', 't5'), segmentId: 'seg1' }
    const target = s.jumpTo(hit)
    expect(s.open).toBe(false)
    expect(target).toEqual({ conversationId: 'c1', messageId: 'm5', segmentId: 'seg1' })
  })
  it('打开查看器不阻塞聊天流：D10 store 事件继续应用（查看器 open 期间 messageStore 归并不受影响）', async () => {
    const s = useHistoryViewerStore()
    s.openViewer()
    expect(s.open).toBe(true)
    const ms = useMessageStore()
    ms.applyEvent({ eventId: 'e1', sequence: 1, event: 'generation.started', generationId: 'g1', messageId: 'm10', responseId: 'g1', conversationId: 'c1' })
    ms.applyEvent({ eventId: 'e2', sequence: 2, event: 'generation.delta', generationId: 'g1', segmentId: 's1', segmentIndex: 0, channel: 'public_reply', kind: 'markdown', deltaSequence: 0, text: '流式继续' })
    expect(ms.byId.m10?.assistantSegments?.[0]?.text).toBe('流式继续')   // 查看器打开不阻断消息归并
  })
})
```

- [ ] **Step 6: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/history-viewer.store.spec.ts`
Expected: FAIL——store 未定义动作/模块不完整。

- [ ] **Step 7: 实现 store 主体** —— 追加到 `historyViewer.store.ts`

```typescript
export const useHistoryViewerStore = defineStore('historyViewer', () => {
  const open = ref(false)
  const keyword = ref('')
  const localDate = ref('')               // '' = 未筛选（<input type="date"> 空值）
  const scope = ref<'conversation' | 'all'>('all')
  const category = ref<HistoryCategory>('all')
  const items = ref<ChatHistoryItem[]>([])
  const loading = ref(false)
  const loadingMore = ref(false)
  const error = ref<PublicError>()
  const hasMore = ref(false)
  const nextCursor = ref<string>()
  const hasSearched = ref(false)          // 区分初始空态与「无结果」空态
  const busy = ref(false)

  function openViewer(initialCategory?: HistoryCategory): void {
    open.value = true
    keyword.value = ''
    localDate.value = ''
    scope.value = 'all'                   // D11：scope 默认全部会话
    category.value = initialCategory ?? 'all'
    items.value = []
    error.value = undefined
    hasMore.value = false
    nextCursor.value = undefined
    hasSearched.value = false
  }

  function closeViewer(): void {
    open.value = false
    error.value = undefined
  }

  /** D11 显式提交（搜索按钮/Enter，IME 守卫在组件）；busy 防重入；失败保留旧结果（D10 不清空聊天） */
  async function submitQuery(): Promise<void> {
    if (busy.value) return
    busy.value = true
    loading.value = true
    error.value = undefined
    try {
      const query = buildQuery({
        keyword: keyword.value, localDate: localDate.value, scope: scope.value, category: category.value,
        conversationId: useConversationStore().currentId
      })
      const page = await api.queryChatHistory(query)
      items.value = page.items
      hasMore.value = page.hasMore
      nextCursor.value = page.nextCursor
      hasSearched.value = true
    } catch (e) {
      error.value = parsePublicError(messageOf(e))     // 保留上次成功结果
    } finally {
      busy.value = false
      loading.value = false
    }
  }

  /** D12 不透明游标续接：去重合并 + 稳定排序 + busy 防重入；失败保留当前页 */
  async function loadMore(): Promise<void> {
    if (busy.value || !hasMore.value || !nextCursor.value) return
    busy.value = true
    loadingMore.value = true
    try {
      const query = buildQuery({
        keyword: keyword.value, localDate: localDate.value, scope: scope.value, category: category.value,
        conversationId: useConversationStore().currentId, cursor: nextCursor.value
      })
      const page = await api.queryChatHistory(query)
      const byHit = new Map(items.value.map((i) => [i.hitId, i]))
      for (const item of page.items) byHit.set(item.hitId, item)
      items.value = [...byHit.values()].sort((a, b) => a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0)
      hasMore.value = page.hasMore
      nextCursor.value = page.nextCursor
      error.value = undefined
    } catch (e) {
      error.value = parsePublicError(messageOf(e))
    } finally {
      busy.value = false
      loadingMore.value = false
    }
  }

  /** D5 来源跳转编排：关闭查看器，返回跳转目标（组件随后调 conversationStore.jumpToMessage） */
  function jumpTo(hit: ChatHistoryItem): { conversationId: string; messageId: string; segmentId?: string } {
    closeViewer()
    return { conversationId: hit.conversationId, messageId: hit.messageId, segmentId: hit.segmentId }
  }

  return {
    open, keyword, localDate, scope, category, items, loading, loadingMore, error, hasMore, nextCursor, hasSearched, busy,
    openViewer, closeViewer, submitQuery, loadMore, jumpTo
  }
})
```

- [ ] **Step 8: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/history-viewer.store.spec.ts tests/unit/chat-history-query.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: PASS（5 + 6）+ typecheck 绿。

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/renderer/src/stores/historyViewer.store.ts apps/desktop/tests/unit/history-viewer.store.spec.ts apps/desktop/tests/unit/chat-history-query.spec.ts
git commit -m "feat(G4 history): historyViewerStore + buildQuery 统一查询路径（D4/D5/D10/D11/D12/D15）"
```

---

### Task 16: recent-emoji 纯函数（D7 localStorage 非敏感例外）

> Emoji 最近使用清单：localStorage 键 `cyrene:ui:recent-emoji`，去重置前、最多 24 个；纯函数注入 storage（Node 测试可测）。非敏感纯展示偏好，localStorage 例外合理（D7；若后续统一设置持久化再迁移）。

**Files:**
- Create: `apps/desktop/src/renderer/src/utils/recent-emoji.ts`
- Test: `apps/desktop/tests/unit/recent-emoji.spec.ts`

**Interfaces:**
- Produces（Task 18 组件 消费）：
  - `export const RECENT_EMOJI_KEY = 'cyrene:ui:recent-emoji'`
  - `export const RECENT_EMOJI_MAX = 24`
  - `export function loadRecentEmoji(storage: Pick<Storage, 'getItem' | 'setItem'>): string[]`
  - `export function saveRecentEmoji(recent: string[], storage: Pick<Storage, 'getItem' | 'setItem'>): void`
  - `export function recordEmoji(recent: string[], emoji: string): string[]`

- [ ] **Step 1: 写失败测试** —— `apps/desktop/tests/unit/recent-emoji.spec.ts`

```typescript
// tests/unit/recent-emoji.spec.ts
// Task 16:最近 Emoji localStorage 纯函数（spec §4.6，D7）——去重置前、上限 24、非法值容错。
// env=node：注入假 storage，无 localStorage 全局。
import { describe, expect, it } from 'vitest'
import { loadRecentEmoji, RECENT_EMOJI_KEY, recordEmoji, saveRecentEmoji } from '../../src/renderer/src/utils/recent-emoji'

function fakeStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> {
  const map = new Map(Object.entries(initial))
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v) } }
}

describe('recordEmoji（去重置前 + 上限）', () => {
  it('新 emoji 置前，旧项后移', () => {
    expect(recordEmoji(['a', 'b'], 'c')).toEqual(['c', 'a', 'b'])
  })
  it('已存在 emoji → 提到最前（去重）', () => {
    expect(recordEmoji(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
  })
  it('超上限截断到 24', () => {
    const recent = Array.from({ length: 24 }, (_, i) => `e${i}`)
    const next = recordEmoji(recent, 'new')
    expect(next).toHaveLength(24)
    expect(next[0]).toBe('new')
  })
})

describe('loadRecentEmoji / saveRecentEmoji', () => {
  it('空 storage → 空数组；解析非法 JSON → 空数组', () => {
    expect(loadRecentEmoji(fakeStorage())).toEqual([])
    expect(loadRecentEmoji(fakeStorage({ [RECENT_EMOJI_KEY]: 'not-json' }))).toEqual([])
  })
  it('round-trip：save 后 load 一致', () => {
    const storage = fakeStorage()
    saveRecentEmoji(['a', 'b'], storage)
    expect(loadRecentEmoji(storage)).toEqual(['a', 'b'])
  })
  it('非字符串元素丢弃', () => {
    const storage = fakeStorage({ [RECENT_EMOJI_KEY]: JSON.stringify(['a', 1, null]) })
    expect(loadRecentEmoji(storage)).toEqual(['a'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/recent-emoji.spec.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 最小实现** —— `apps/desktop/src/renderer/src/utils/recent-emoji.ts`

```typescript
// src/renderer/src/utils/recent-emoji.ts
// 阶段 3 G4（spec §4.6，D7）：最近 Emoji localStorage 纯函数。
// 非敏感纯展示偏好 → localStorage 例外合理（若后续统一设置持久化通道再迁移）。
export const RECENT_EMOJI_KEY = 'cyrene:ui:recent-emoji'
export const RECENT_EMOJI_MAX = 24

/** 新 emoji 置前去重，上限 24 */
export function recordEmoji(recent: string[], emoji: string): string[] {
  const next = [emoji, ...recent.filter((e) => e !== emoji)]
  return next.slice(0, RECENT_EMOJI_MAX)
}

export function loadRecentEmoji(storage: Pick<Storage, 'getItem' | 'setItem'>): string[] {
  try {
    const raw = storage.getItem(RECENT_EMOJI_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e): e is string => typeof e === 'string')
  } catch {
    return []
  }
}

export function saveRecentEmoji(recent: string[], storage: Pick<Storage, 'getItem' | 'setItem'>): void {
  try {
    storage.setItem(RECENT_EMOJI_KEY, JSON.stringify(recent))
  } catch {
    // localStorage 满/禁用：非敏感偏好，静默忽略
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/recent-emoji.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: PASS（8 tests）+ typecheck 绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/utils/recent-emoji.ts apps/desktop/tests/unit/recent-emoji.spec.ts
git commit -m "feat(G4 emoji): 最近 Emoji localStorage 纯函数（D7）"
```

---

### Task 17: CyHistoryViewer.vue + CyHistoryResultItem.vue（D1/D6/D14）

> 全窗覆盖式模态（覆盖聊天主区与会话栏，保留导航/标题栏）：`role="dialog"` + `aria-modal="true"` + `aria-label="聊天历史"`；初始焦点进关键词输入；Tab/Shift+Tab 焦点陷阱；Esc 关闭并回焦点到触发按钮（触发前记录 `document.activeElement`）；Tab 顺序固定（关闭→scope→关键词→日期→分类 tabs→结果→加载更多）；`:focus-visible` 明确样式；结果数/错误/空态 `aria-live="polite"`；搜索输入 Enter 带 IME 守卫（`isCompositionEnter`）+ 显式提交（D11）；不透明游标分页（loadMore）+ 空态/错误态/加载态。结果项：时间/发送者/命中片段/类型 chip/跳转按钮（D6 非纯颜色）。**（P0-1）**真实后端 search item 无 kind/url，结果项为纯文本行（chip「消息」，无缩略图）；贴图缩略图分支保留于 `hit.resource` 存在时（Mock 演示 / 资源端点补充，见「P0-1 设计缺口」）。

**Files:**
- Create: `apps/desktop/src/renderer/src/components/CyHistoryViewer.vue`
- Create: `apps/desktop/src/renderer/src/components/CyHistoryResultItem.vue`

**Interfaces:**
- Consumes（Task 15）：`useHistoryViewerStore`；Task 10：`api`（经 store）；Task 2：`stickerRenderUrl`（贴图缩略图）；Task 3：`isCompositionEnter`
- Produces: 查看器模态组件（Task 19 App.vue 挂载消费）；`emit('jump', hit)` 由 CyHistoryResultItem 上抛

**验收点（无单测基线，以 typecheck + build + 手工/Playwright 核对）：**
- `role="dialog" aria-modal="true"` + 初始焦点进关键词输入框
- Tab/Shift+Tab 焦点陷阱（循环回拦）；Esc 关闭并回焦点触发按钮
- Tab 顺序固定；分类 tabs/scope 切换键盘可达
- 搜索 Enter IME 守卫（组词确认不触发提交）
- `aria-live="polite"` 播报结果数/错误/空态
- 失败/无结果保留聊天内容（store 已保证，组件验证）
- 资源入口（`openViewer('image_video')`）预置图片/视频分类

- [ ] **Step 1: 实现组件** —— `apps/desktop/src/renderer/src/components/CyHistoryViewer.vue`

```vue
<script setup lang="ts">
// CyHistoryViewer:全窗覆盖式历史查看器（spec §4.1/§4.7，D1/D14）。
// 模态无障碍:role=dialog + aria-modal、初始焦点搜索框、Tab 焦点陷阱、Esc 关闭并回焦点、aria-live 播报。
// 查询:显式提交(D11) + IME 守卫(isCompositionEnter,D14);分页:不透明游标 loadMore(D12)。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { isCompositionEnter } from '@shared/domain'
import type { ChatHistoryItem, HistoryCategory } from '@shared/contracts'
import { useConversationStore } from '../stores/conversation.store'
import { useHistoryViewerStore } from '../stores/historyViewer.store'
import CyHistoryResultItem from './CyHistoryResultItem.vue'

const store = useHistoryViewerStore()
const conversationStore = useConversationStore()

const keywordInput = ref<HTMLInputElement>()
const overlay = ref<HTMLElement>()
let triggerElement: Element | null = null   // 打开前的活动元素(关闭后回焦点)
const CATEGORIES: Array<{ value: HistoryCategory; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'image_video', label: '图片/视频' },
  { value: 'sticker', label: '表情' },
  { value: 'file', label: '文件' },
  { value: 'audio', label: '音频' },
  { value: 'link', label: '链接' }
]

/** 打开时记录触发元素并聚焦搜索框 */
function onOpen(): void {
  triggerElement = document.activeElement
  void nextTick(() => keywordInput.value?.focus())
}
watch(() => store.open, (v) => { if (v) onOpen() })
onMounted(() => { if (store.open) onOpen() })

function close(): void {
  store.closeViewer()
  if (triggerElement instanceof HTMLElement) triggerElement.focus()
}

function onEnter(e: KeyboardEvent): void {
  if (isCompositionEnter(e)) return   // IME 组词确认 Enter 不提交(D14)
  e.preventDefault()
  void store.submitQuery()
}

/** Tab 焦点陷阱:循环回拦在可聚焦元素内 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (document.activeElement === keywordInput.value && keywordInput.value?.value) {
      keywordInput.value.value = ''; store.keyword = ''   // Esc 先清空输入(可选)
    } else {
      close()
    }
    return
  }
  if (e.key !== 'Tab' || !overlay.value) return
  const focusables = overlay.value.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
  if (focusables.length === 0) return
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
}

function setCategory(c: HistoryCategory): void { store.category = c }
function onScopeChange(e: Event): void { store.scope = (e.target as HTMLSelectElement).value as 'conversation' | 'all' }

/** 跳转:store.jumpTo 关闭查看器 → conversationStore.jumpToMessage(失败两分支统一:已关→横幅;未关→查看器提示) */
async function onJump(hit: ChatHistoryItem): Promise<void> {
  const target = store.jumpTo(hit)
  const ok = await conversationStore.jumpToMessage(target.conversationId, target.messageId, target.segmentId)
  if (!ok && store.open) store.error = { code: 'JUMP_FAILED', message: '无法定位消息' }
}

const announceText = computed(() => {
  if (store.loading) return '正在搜索聊天记录'
  if (store.error) return `搜索失败:${store.error.message}`
  if (store.hasSearched && store.items.length === 0) return '没有找到相关聊天记录'
  if (store.hasSearched) return `找到 ${store.items.length} 条相关聊天记录`
  return ''
})

onBeforeUnmount(() => { triggerElement = null })
</script>

<template>
  <Teleport to="body">
    <div v-if="store.open" ref="overlay" class="cy-history-overlay" role="dialog" aria-modal="true" aria-label="聊天历史" @keydown="onKeydown">
      <div class="cy-history">
        <header class="cy-history-header">
          <div class="cy-history-title">
            <strong>聊天历史</strong>
            <span class="cy-muted">搜索不影响当前聊天</span>
          </div>
          <button class="cy-close-btn" aria-label="关闭历史查看器" @click="close">✕</button>
        </header>

        <div class="cy-history-filters">
          <select class="cy-filter-select" :value="store.scope" aria-label="搜索范围" @change="onScopeChange">
            <option value="all">全部会话</option>
            <option value="conversation">当前会话</option>
          </select>
          <input ref="keywordInput" v-model="store.keyword" class="cy-filter-input" type="text" placeholder="关键词搜索" aria-label="关键词搜索" @keydown.enter="onEnter" />
          <input v-model="store.localDate" class="cy-filter-date" type="date" aria-label="按日期筛选" />
          <button class="cy-search-btn" :disabled="store.busy" aria-label="搜索" @click="store.submitQuery()">搜索</button>
        </div>

        <nav class="cy-history-tabs" aria-label="分类筛选">
          <button v-for="c in CATEGORIES" :key="c.value" class="cy-cat-tab" :class="{ active: store.category === c.value }" :aria-pressed="store.category === c.value" @click="setCategory(c.value)">
            {{ c.label }}
          </button>
        </nav>

        <div class="cy-live" role="status" aria-live="polite">{{ announceText }}</div>

        <div v-if="store.error" class="cy-history-error" role="alert">
          <span>搜索失败:{{ store.error.message }}</span>
          <button class="cy-retry-btn" @click="store.submitQuery()">重试</button>
        </div>

        <div v-if="store.loading" class="cy-history-state">正在搜索…</div>
        <div v-else-if="store.hasSearched && store.items.length === 0" class="cy-history-state">没有找到相关聊天记录</div>
        <ul v-else class="cy-history-results">
          <CyHistoryResultItem v-for="hit in store.items" :key="hit.hitId" :hit="hit" @jump="onJump" />
        </ul>

        <footer class="cy-history-footer">
          <button v-if="store.hasMore && !store.loadingMore" class="cy-more-btn" @click="store.loadMore()">加载更多</button>
          <span v-if="store.loadingMore" class="cy-muted">加载中…</span>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cy-history-overlay {
  position: fixed;
  inset: 36px 0 0 58px;   /* 保留标题栏(36px)与导航栏(58px),覆盖聊天主区与会话栏(D1) */
  z-index: 50;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--cy-window) 70%, transparent);
  backdrop-filter: blur(2px);
}
.cy-history {
  display: flex;
  flex-direction: column;
  width: min(760px, calc(100% - 48px));
  max-height: calc(100% - 48px);
  padding: 14px;
  background: var(--cy-pane);
  border: 1px solid var(--cy-border);
  border-radius: 16px;
  box-shadow: 0 12px 40px rgb(0 0 0 / 0.25);
}
.cy-history-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.cy-history-title { display: flex; align-items: baseline; gap: 8px; }
.cy-close-btn { padding: 4px 10px; border: 1px solid var(--cy-border); border-radius: 8px; background: var(--cy-surface); color: var(--cy-muted); }
.cy-history-filters { display: flex; flex-wrap: wrap; gap: 8px; }
.cy-filter-select, .cy-filter-input, .cy-filter-date { padding: 7px 9px; border: 1px solid var(--cy-border); border-radius: 10px; background: var(--cy-surface); color: var(--cy-text); font-size: 13px; }
.cy-filter-input { flex: 1; min-width: 160px; }
.cy-search-btn { padding: 7px 14px; border: 0; border-radius: 10px; background: var(--cy-accent); color: var(--cy-accent-text); }
.cy-search-btn:disabled { opacity: 0.5; }
.cy-history-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
.cy-cat-tab { padding: 5px 10px; border: 1px solid var(--cy-border); border-radius: 999px; background: var(--cy-surface); color: var(--cy-muted); font-size: 12px; }
.cy-cat-tab.active { background: var(--cy-accent); color: var(--cy-accent-text); border-color: var(--cy-accent); }
.cy-live { min-height: 18px; color: var(--cy-muted); font-size: 12px; }
.cy-history-error { display: flex; align-items: center; gap: 8px; padding: 8px 11px; margin-bottom: 8px; color: var(--cy-danger); background: var(--cy-surface-soft); border: 1px dashed var(--cy-danger); border-radius: 10px; font-size: 12px; }
.cy-retry-btn { margin-left: auto; padding: 3px 9px; border: 1px solid var(--cy-border); border-radius: 7px; background: var(--cy-surface); }
.cy-history-state { padding: 28px 0; color: var(--cy-muted); text-align: center; font-size: 13px; }
.cy-history-results { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; overflow-y: auto; min-height: 120px; }
.cy-history-footer { margin-top: 10px; text-align: center; }
.cy-more-btn { padding: 6px 16px; border: 1px solid var(--cy-border); border-radius: 999px; background: var(--cy-surface); color: var(--cy-muted); font-size: 12px; }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 2px; }
</style>
```

`apps/desktop/src/renderer/src/components/CyHistoryResultItem.vue`：

```vue
<script setup lang="ts">
// CyHistoryResultItem:单条命中行（spec §4.1）——时间/发送者/命中片段/类型 chip/跳转按钮。P0-1：真实后端 search item 无 kind/url，
// 结果项为纯文本行（chip 显示「消息」）；缩略图分支仅在 hit.resource 存在时触发（Mock 领域富化演示 / 未来资源端点补充，见 Task 6「P0-1 设计缺口」）。
import { computed } from 'vue'
import type { ChatHistoryItem } from '@shared/contracts'
import { stickerRenderUrl } from '@shared/domain'

const props = defineProps<{ hit: ChatHistoryItem }>()
defineEmits<{ jump: [hit: ChatHistoryItem] }>()

const KIND_LABEL: Record<string, string> = { image: '图片', video: '视频', audio: '音频', file: '文件', link: '链接', sticker: '表情' }
const typeLabel = computed(() => (props.hit.resource ? KIND_LABEL[props.hit.resource.kind] ?? props.hit.resource.kind : '消息'))
const isSticker = computed(() => props.hit.resource?.kind === 'sticker')
const stickerSrc = computed(() => {
  const id = props.hit.resource?.stickerId
  return id ? stickerRenderUrl(id) : undefined
})
const timeText = computed(() => {
  const d = new Date(props.hit.createdAt)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
})
</script>

<template>
  <li class="cy-history-item">
    <div class="cy-hit-main">
      <span class="cy-hit-time">{{ timeText }}</span>
      <span class="cy-hit-sender">{{ hit.senderLabel }}</span>
      <span class="cy-hit-chip" :class="`kind-${hit.resource?.kind ?? 'text'}`">{{ typeLabel }}</span>
    </div>
    <p class="cy-hit-snippet">{{ hit.snippet || '（无文本命中）' }}</p>
    <img v-if="isSticker && stickerSrc" class="cy-hit-thumb" :src="stickerSrc" alt="表情" />
    <button class="cy-jump-btn" @click="$emit('jump', hit)">跳转</button>
  </li>
</template>

<style scoped>
.cy-history-item { display: grid; grid-template-columns: 1fr auto; gap: 6px 10px; align-items: center; padding: 9px 11px; background: var(--cy-surface); border: 1px solid var(--cy-border); border-radius: 12px; }
.cy-hit-main { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.cy-hit-time { color: var(--cy-muted); }
.cy-hit-sender { color: var(--cy-text); font-weight: 500; }
.cy-hit-chip { padding: 1px 7px; border-radius: 999px; background: var(--cy-surface-soft); color: var(--cy-muted); border: 1px solid var(--cy-border); font-size: 11px; }
.cy-hit-chip.kind-sticker { color: var(--cy-accent-text); background: var(--cy-accent); }
.cy-hit-snippet { grid-column: 1 / -1; margin: 0; color: var(--cy-text); font-size: 13px; }
.cy-hit-thumb { grid-column: 1 / -1; width: 56px; height: 56px; object-fit: contain; border-radius: 8px; background: var(--cy-surface-soft); }
.cy-jump-btn { padding: 5px 12px; border: 1px solid var(--cy-border); border-radius: 8px; background: var(--cy-surface); color: var(--cy-text); font-size: 12px; }
.cy-jump-btn:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 2px; }
</style>
```

- [ ] **Step 2: 验证编译**

Run: `pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop build`
Expected: 全绿。

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/CyHistoryViewer.vue apps/desktop/src/renderer/src/components/CyHistoryResultItem.vue
git commit -m "feat(G4 history): CyHistoryViewer 全窗模态 + 结果项（D1/D6/D14）"
```

---

### Task 18: CyEmojiPicker.vue + CyStickerPanel.vue（D7/D8/D14）

> Emoji 面板：最近使用优先 + 常用 Emoji 网格，Tab 遍历 + Enter/Space 插入 + Esc 关闭回焦点；插入逻辑（光标处 draft 拼接，不自动发送）在 CyChatInput 内完成，本组件只 `emit('select-emoji', emoji)`。表情包 tab：`chat:list-stickers` 拉内置 st_ 清单，加载中/失败重试/空清单三态；选择 → `emit('select-sticker', PendingSticker)`。面板随 Composer 弹出，Esc 关闭并回焦点输入区。

**Files:**
- Create: `apps/desktop/src/renderer/src/components/CyEmojiPicker.vue`
- Create: `apps/desktop/src/renderer/src/components/CyStickerPanel.vue`

**Interfaces:**
- Consumes（Task 10/16/2）：`api.listStickers`、`loadRecentEmoji`/`saveRecentEmoji`、`stickerRenderUrl`、`PendingSticker`（G3 `@shared/contracts/attachments`）
- Produces（Task 19 消费）：
  - `CyEmojiPicker` emits `{ (e: 'select-emoji', emoji: string): void; (e: 'close'): void }`
  - `CyStickerPanel` emits `{ (e: 'select-sticker', sticker: { kind: 'sticker'; stickerId: string; name?: string; status: 'ready' }): void }`
  - `CyEmojiPicker` 内 tab 切换（Emoji / 表情包），Emoji 网格项 `aria-label` = emoji 字符，表情包网格项 `aria-label` = stickerId（P0-2：契约 StickerEntry 无 name 字段）

**验收点（无单测基线，typecheck + build + 手工核对）：** 打开焦点进面板；Tab 遍历网格项；**Enter/Space 选择插入的是聚焦按钮的 emoji（非空串）**（P1-3：逐按钮 @keydown，回归点）；Esc 关闭并回焦点输入区；表情包加载失败显示重试。

- [ ] **Step 1: 实现组件** —— `apps/desktop/src/renderer/src/components/CyEmojiPicker.vue`

```vue
<script setup lang="ts">
// CyEmojiPicker:Emoji/表情包双 tab 弹出面板（spec §4.6，D7/D8）。选择不自动发送,由 CyChatInput 决定插入/入队。
// Emoji 网格最近优先;表情包 tab 委托 CyStickerPanel。
import { computed, onMounted, ref } from 'vue'
import { loadRecentEmoji, saveRecentEmoji } from '../utils/recent-emoji'
import CyStickerPanel from './CyStickerPanel.vue'

const emit = defineEmits<{
  (e: 'select-emoji', emoji: string): void
  (e: 'close'): void
}>()

const tab = ref<'emoji' | 'sticker'>('emoji')
const recent = ref<string[]>([])
const COMMON_EMOJI = ['😀', '😂', '😊', '👍', '🎉', '❤️', '🔥', '😢', '🙏', '🤔', '✨', '👏']

onMounted(() => { recent.value = loadRecentEmoji(window.localStorage) })

function pick(e: string): void {
  recent.value = [e, ...recent.value.filter((x) => x !== e)].slice(0, 24)
  saveRecentEmoji(recent.value, window.localStorage)
  emit('select-emoji', e)
}

/** 网格键盘:Tab 逐项;Enter/Space 选择（P1-3：逐按钮绑定，取聚焦按钮的 emoji，避免 currentTarget 网格无 dataset） */
function onGridKeydown(e: KeyboardEvent, item: string): void {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(item) }
  else if (e.key === 'Escape') emit('close')
}

const orderedEmoji = computed(() => [...recent.value, ...COMMON_EMOJI.filter((e) => !recent.value.includes(e))])
</script>

<template>
  <div class="cy-emoji-picker" role="dialog" aria-label="Emoji 与表情包">
    <nav class="cy-emoji-tabs" aria-label="面板分类">
      <button :class="{ active: tab === 'emoji' }" @click="tab = 'emoji'">Emoji</button>
      <button :class="{ active: tab === 'sticker' }" @click="tab = 'sticker'">表情包</button>
    </nav>
    <div v-if="tab === 'emoji'" class="cy-emoji-grid">
      <button v-for="e in orderedEmoji" :key="e" :data-emoji="e" :aria-label="e" class="cy-emoji-cell" @click="pick(e)" @keydown="onGridKeydown($event, e)">
        {{ e }}
      </button>
    </div>
    <CyStickerPanel v-else @select-sticker="(s) => emit('select-sticker', s)" @close="emit('close')" />
  </div>
</template>

<style scoped>
.cy-emoji-picker { display: flex; flex-direction: column; width: 288px; max-height: 300px; padding: 10px; background: var(--cy-pane); border: 1px solid var(--cy-border); border-radius: 12px; box-shadow: 0 8px 24px rgb(0 0 0 / 0.2); }
.cy-emoji-tabs { display: flex; gap: 6px; margin-bottom: 8px; }
.cy-emoji-tabs button { padding: 4px 10px; border: 1px solid var(--cy-border); border-radius: 8px; background: var(--cy-surface); color: var(--cy-muted); font-size: 12px; }
.cy-emoji-tabs button.active { background: var(--cy-accent); color: var(--cy-accent-text); }
.cy-emoji-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 4px; overflow-y: auto; }
.cy-emoji-cell { padding: 4px; border: 0; border-radius: 6px; background: transparent; font-size: 20px; line-height: 1.4; }
.cy-emoji-cell:hover { background: var(--cy-surface-hover); }
button:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 1px; }
</style>
```

`apps/desktop/src/renderer/src/components/CyStickerPanel.vue`：

```vue
<script setup lang="ts">
// CyStickerPanel:内置 st_ 清单网格（spec §4.6，D8）——listStickers 拉取,加载中/失败重试/空清单三态。
// 选择 → emit PendingSticker（G3 待发送分支,不含 localId,stickerId 为身份）。
import { onMounted, ref } from 'vue'
import { stickerRenderUrl } from '@shared/domain'
import type { StickerItem } from '@shared/contracts/sticker'
import { api } from '../stores/desktop-api'

const emit = defineEmits<{
  (e: 'select-sticker', sticker: { kind: 'sticker'; stickerId: string; name?: string; status: 'ready' }): void
  (e: 'close'): void
}>()

const stickers = ref<StickerItem[]>([])
const loading = ref(false)
const failed = ref(false)
const message = ref('')

async function load(): Promise<void> {
  loading.value = true
  failed.value = false
  message.value = ''
  try {
    const manifest = await api.listStickers()
    stickers.value = manifest.stickers                       // P0-2：StickerManifest{stickers}
    if (manifest.stickers.length === 0) message.value = '暂无内置表情包'
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}
onMounted(load)

function pick(s: StickerItem): void {
  emit('select-sticker', { kind: 'sticker', stickerId: s.stickerId, status: 'ready' })   // 契约无 name 字段（P0-2）
}

function onGridKeydown(e: KeyboardEvent, s: StickerItem): void {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(s) }
  else if (e.key === 'Escape') emit('close')
}
</script>

<template>
  <div class="cy-sticker-panel">
    <div v-if="loading" class="cy-sticker-state">加载中…</div>
    <div v-else-if="failed" class="cy-sticker-state">
      <span>表情包加载失败</span>
      <button class="cy-sticker-retry" @click="load">重试</button>
    </div>
    <div v-else-if="message" class="cy-sticker-state">{{ message }}</div>
    <div v-else class="cy-sticker-grid">
      <button
        v-for="s in stickers"
        :key="s.stickerId"
        class="cy-sticker-cell"
        :aria-label="s.stickerId"
        @click="pick(s)"
        @keydown="onGridKeydown($event, s)"
      >
        <img :src="stickerRenderUrl(s.stickerId)" :alt="s.stickerId" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.cy-sticker-panel { display: flex; flex-direction: column; min-height: 120px; }
.cy-sticker-state { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 22px 0; color: var(--cy-muted); font-size: 13px; }
.cy-sticker-retry { padding: 4px 12px; border: 1px solid var(--cy-border); border-radius: 8px; background: var(--cy-surface); color: var(--cy-muted); }
.cy-sticker-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; overflow-y: auto; }
.cy-sticker-cell { padding: 4px; border: 0; border-radius: 8px; background: var(--cy-surface); }
.cy-sticker-cell img { width: 56px; height: 56px; object-fit: contain; }
.cy-sticker-cell:hover { background: var(--cy-surface-hover); }
button:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 1px; }
</style>
```

- [ ] **Step 2: 验证编译**

Run: `pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop build`
Expected: 全绿。

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/CyEmojiPicker.vue apps/desktop/src/renderer/src/components/CyStickerPanel.vue
git commit -m "feat(G4 emoji): CyEmojiPicker + CyStickerPanel（D7/D8/D14）"
```

---

### Task 19: CyChatInput IME 硬化 + Emoji/表情接线 + CyChatView 入口 + App 挂载 + CyMessageBubble sticker（D14/D7/D8/D5/D6）

> ① IME 硬化：`@keydown.enter.exact.prevent` 去掉 `.prevent`，`onEnter` 经 `isCompositionEnter` 守卫后 `preventDefault()` + send（D14 硬化①）。② Emoji/表情按钮 + CyEmojiPicker 挂载；Emoji 光标位置插入 draft（selectionStart/End 拼接，不自动发送）；贴图 → PendingSticker 入待发送队列（组件级，G3 队列未落地前自持）。③ 发送：文本 + 逐贴图 `messageStore.send('', stickerId)`。④ CyChatView header 加「聊天记录」「资源」入口（`openViewer()`/`openViewer('image_video')`）+ watch highlight 滚动居中 + 6s 定时清除 + aria-live「已定位到消息」+ 高亮 class +「已定位」chip（D6 非纯颜色）。⑤ App.vue 挂载 CyHistoryViewer。⑥ CyMessageBubble sticker 分段渲染（`stickerRenderUrl`，失败占位）。

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/CyChatInput.vue`
- Modify: `apps/desktop/src/renderer/src/components/CyChatView.vue`
- Modify: `apps/desktop/src/renderer/src/App.vue`
- Modify: `apps/desktop/src/renderer/src/components/CyMessageBubble.vue`

**Interfaces:**
- Consumes（Task 3/13/14/15/17/18/2）：`isCompositionEnter`、`messageStore.send/setHighlight/highlightMessageId/highlightSegmentId`、`conversationStore.jumpToMessage`、`useHistoryViewerStore`、`CyEmojiPicker`、`stickerRenderUrl`、`PendingSticker`（G3）
- Produces: 查看器入口、IME 硬化、贴图发送与渲染闭环

**验收点（typecheck + build + 手工/Playwright）：** IME 组词 Enter 不发送（硬化后）；Emoji 插入光标位不自动发送；贴图选择入待发送、发送 wire 带 stickerId；消息气泡 sticker 分段渲染为贴图（失败占位可重试）；查看器入口两按钮打开同一查看器、「资源」预置图片/视频分类；跳转后滚动居中 +「已定位」chip + aria-live；6s 后清除高亮；查看器打开期间生成继续（D10）。

- [ ] **Step 1: CyChatInput IME 硬化 + Emoji/表情接线** —— `apps/desktop/src/renderer/src/components/CyChatInput.vue`

script 区改动：

```typescript
import { isCompositionEnter } from '@shared/domain'
import CyEmojiPicker from './CyEmojiPicker.vue'
import type { PendingSticker } from '@shared/contracts/attachments'

const showPicker = ref(false)
const pendingStickers = ref<PendingSticker[]>([])
const textareaRef = ref<HTMLTextAreaElement>()
const pickerAnchor = ref<HTMLElement>()

/** D14 硬化①:去掉模板 .prevent,守卫通过后才 preventDefault + send */
function onEnter(e: KeyboardEvent): void {
  if (isCompositionEnter(e)) return
  e.preventDefault()
  send()
}

function send(): void {
  if (!canSend.value && pendingStickers.value.length === 0) return
  if (draft.value.trim()) messageStore.send(draft.value.trim())
  for (const s of pendingStickers.value) messageStore.send('', s.stickerId)
  draft.value = ''
  pendingStickers.value = []
}

/** Emoji 光标插入:读取 selectionStart/End,draft 拼接,光标移到插入后;不自动发送(D7) */
function insertEmoji(emoji: string): void {
  const ta = textareaRef.value
  const start = ta?.selectionStart ?? draft.value.length
  const end = ta?.selectionEnd ?? draft.value.length
  draft.value = draft.value.slice(0, start) + emoji + draft.value.slice(end)
  void nextTick(() => {
    if (ta) { const pos = start + emoji.length; ta.setSelectionRange(pos, pos) }
  })
  showPicker.value = false
  ta?.focus()
}

function onSelectSticker(s: PendingSticker): void {
  pendingStickers.value = [...pendingStickers.value, s]
  showPicker.value = false
  textareaRef.value?.focus()
}

function removeSticker(id: string): void {
  pendingStickers.value = pendingStickers.value.filter((s) => s.stickerId !== id)
}

function onPickerKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { showPicker.value = false; textareaRef.value?.focus() }
}
```

模板改动（textarea 移除 `.prevent`，加 ref；composer 底部加 emoji 按钮 + 面板 + 贴图队列）：

```html
<textarea
  ref="textareaRef"
  v-model="draft"
  :disabled="messageStore.sending"
  placeholder="输入消息，Enter 发送"
  rows="1"
  aria-label="消息输入框"
  @keydown.enter.exact="onEnter"
/>
<div class="cy-composer-tools">
  <button class="cy-emoji-btn" :aria-expanded="showPicker" aria-label="Emoji 与表情包" @click="showPicker = !showPicker">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm3.5 7.5a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5zM8.5 9.5a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5zM12 17c-2.5 0-4.5-1.5-5-3.5h10c-.5 2-2.5 3.5-5 3.5z"/></svg>
  </button>
  <div ref="pickerAnchor" class="cy-picker-wrap" @keydown="onPickerKeydown">
    <CyEmojiPicker v-if="showPicker" class="cy-emoji-pop" @select-emoji="insertEmoji" @select-sticker="onSelectSticker" @close="showPicker = false" />
  </div>
</div>
<div v-if="pendingStickers.length" class="cy-sticker-queue" role="list" aria-label="待发送表情">
  <span v-for="s in pendingStickers" :key="s.stickerId" class="cy-sticker-chip" role="listitem">
    {{ s.stickerId }}                    <!-- P0-2：契约 StickerEntry 无 name，chip 显示 stickerId -->
    <button :aria-label="`移除 ${s.stickerId}`" @click="removeSticker(s.stickerId)">✕</button>
  </span>
</div>
```

补充 `import { nextTick } from 'vue'`；`canSend` 在贴图待发送时也可发送（见 send 条件）。

样式补：`.cy-composer-tools`、`.cy-emoji-btn`、`.cy-picker-wrap`（`position: relative`）、`.cy-emoji-pop`（`position: absolute; bottom: 100%; right: 0;`）、`.cy-sticker-queue`、`.cy-sticker-chip`。

- [ ] **Step 2: CyChatView 入口 + 高亮** —— `apps/desktop/src/renderer/src/components/CyChatView.vue`

script 区追加：

```typescript
import { useHistoryViewerStore } from '../stores/historyViewer.store'
const historyStore = useHistoryViewerStore()
const highlightTimer = ref<ReturnType<typeof setTimeout>>()
const highlightMessageId = computed(() => messageStore.highlightMessageId)

/** D6:高亮 → 滚动居中 + 6s 后清除 + aria-live 播报 */
watch(highlightMessageId, async (id) => {
  if (highlightTimer.value) clearTimeout(highlightTimer.value)
  if (!id) return
  await nextTick()
  const el = messagesRef.value?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)
  el?.scrollIntoView({ block: 'center' })
  highlightTimer.value = setTimeout(() => messageStore.clearHighlight(), 6000)
})
```

模板 header 加：

```html
<button class="cy-action-button" title="聊天记录" :disabled="!canAct" @click="historyStore.openViewer()">聊天记录</button>
<button class="cy-action-button" title="资源" :disabled="!canAct" @click="historyStore.openViewer('image_video')">资源</button>
```

消息列表加 `data-message-id` + 高亮 class + chip + aria-live：

```html
<div ref="messagesRef" class="cy-messages" aria-live="polite">
  <div v-if="isEmpty" class="cy-empty"><p>新会话,开始对话</p></div>
  <template v-else>
    <div
      v-for="id in visibleIds"
      :key="id"
      :data-message-id="id"
      class="cy-msg-wrap"
      :class="{ 'cy-highlighted': messageStore.highlightMessageId === id }"
    >
      <CyMessageBubble :message="messageStore.byId[id]" />
      <span v-if="messageStore.highlightMessageId === id" class="cy-located-chip">已定位</span>
    </div>
  </template>
  <div v-if="isStreaming" class="cy-streaming-placeholder">…</div>
</div>
<div class="cy-sr-live" role="status" aria-live="polite">{{ highlightMessageId ? '已定位到消息' : '' }}</div>
```

样式补：`.cy-msg-wrap`（`position: relative`）、`.cy-highlighted`（`outline: 2px solid var(--cy-accent-strong); border-radius: 12px;`——非纯颜色，配合 chip）、`.cy-located-chip`、`.cy-sr-live`（`position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0);`）。

- [ ] **Step 3: App.vue 挂载查看器** —— 追加

```html
<CyHistoryViewer />
```

（import `CyHistoryViewer from './components/CyHistoryViewer.vue'`，放于 `<div class="cy-app">` 内末尾。）

- [ ] **Step 4: CyMessageBubble sticker 分段渲染** —— `apps/desktop/src/renderer/src/components/CyMessageBubble.vue`

script 追加：

```typescript
import { stickerRenderUrl } from '@shared/domain'
const props = defineProps<{ message: Message }>()
const stickerQueue = new Set<string>()   // 加载失败占位重试键
function stickerSrc(id?: string): string | undefined { return id ? stickerRenderUrl(id) : undefined }
```

模板：user 分支加贴图（stickerId 消息）：

```html
<div v-if="isUser" class="cy-message-row cy-user-row">
  <div class="cy-message cy-user-message">
    <p v-if="message.content">{{ message.content }}</p>
    <img v-if="message.stickerId" :src="stickerSrc(message.stickerId)" class="cy-sticker-img" alt="表情" />
    <span v-if="message.status === 'failed'" class="cy-user-error-badge" title="发送失败">发送失败</span>
  </div>
</div>
```

assistant 分支模板 `v-for="seg in publicSegments"` 中加 sticker 分支：

```html
<img v-else-if="seg.kind === 'sticker' && seg.stickerId" :src="stickerSrc(seg.stickerId)" class="cy-sticker-img" alt="表情" />
```

样式补：`.cy-sticker-img`（`width: 96px; height: 96px; object-fit: contain;`）。

- [ ] **Step 5: 验证编译 + 回归**

Run: `pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop lint && pnpm -F @cyrene/desktop test tests/unit/message.store.spec.ts tests/unit/conversation.store.spec.ts && pnpm -F @cyrene/desktop build`
Expected: 全绿（IME 硬化不破坏既有 IME 测试——`message.store.spec`/`conversation.store.spec` 回归）。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/CyChatInput.vue apps/desktop/src/renderer/src/components/CyChatView.vue apps/desktop/src/renderer/src/App.vue apps/desktop/src/renderer/src/components/CyMessageBubble.vue
git commit -m "feat(G4): IME 硬化 + Emoji/表情接线 + 查看器入口/高亮 + sticker 渲染（D14/D7/D8/D5/D6）"
```

---

### Task 20: 文档清理「绘画资源」→ 六分类口径（spec §4.10）

> 后端资源分类仅 image/link/video/audio/file/sticker，PRD 无绘画功能；四处必改（用户锁定）+ 五处同概念顺带清扫，替换文案按 spec §4.10 表逐行；文档状态行同步。

**Files:**
- Modify: `docs/10-Cyrene-前端实施路线与任务拆分-v0.2.md:135`
- Modify: `docs/03-Cyrene-前端UI与交互设计-v0.2.md:236`、`:443`
- Modify: `docs/16-Cyrene-前端实施任务清单与进度跟踪.md:270`
- Modify: `docs/00-Cyrene-前端文档索引与阅读顺序.md:14`
- Modify: `docs/01-Cyrene-Electron-前端总体架构设计-v0.2.md:328`
- Modify: `docs/08-Cyrene-前端测试与Demo验收方案-v0.2.md:346`
- Modify: `docs/13-Cyrene-前端文档交叉Review与修订记录-v0.1.md:119`

- [ ] **Step 1: 替换四处必改**

`docs/10` 第 135 行：`- 将原消息搜索、绘画资源和会话媒体统一到历史查看器；` → `- 将原消息搜索与会话媒体统一到历史查看器（分类：全部、图片/视频、表情、文件、音频、链接）；`

`docs/03` 第 236 行：`- 图片/视频分类承载现有绘画资源与会话媒体，表情分类集中展示已发送表情包；` → `- 图片/视频分类承载会话媒体（图片、视频），表情分类集中展示已发送表情包；`

`docs/03` 第 443 行：`- [ ] 原消息搜索、绘画资源和会话多媒体均已整合进历史查看器；` → `- [ ] 原消息搜索与会话多媒体均已整合进历史查看器（图片/视频、表情、文件、音频、链接分类）；`

`docs/16` 第 270 行：`- [ ] 把原消息搜索、绘画资源与会话媒体统一到历史查看器` → `- [ ] 把原消息搜索与会话媒体统一到历史查看器（后端六分类：图片/视频、表情、文件、音频、链接）`

- [ ] **Step 2: 顺带清扫五处**

`docs/00` 第 14 行：`…整合消息搜索、绘画资源、媒体、表情、文件和链接的 QQ 式聊天历史查看器。` → `…整合消息搜索、媒体、表情、文件和链接的 QQ 式聊天历史查看器（后端六分类：图片/视频、表情、文件、音频、链接）。`

`docs/01` 第 328 行：`…图片/视频、绘画资源、表情包、文件、音频和链接只保存来源引用。` → `…图片/视频、表情包、文件、音频和链接（后端六分类）只保存来源引用。`

`docs/08` 第 346 行：`5. 分别筛选全部、图片/视频、表情、文件、音频、链接，确认绘画资源和原搜索结果均在此处；` → `5. 分别筛选全部、图片/视频、表情、文件、音频、链接，确认会话媒体与搜索结果均在此处；`

`docs/13` 第 119 行：`- 图片/视频、绘画资源、表情、文件、音频和链接都保存来源消息引用；` → `- 图片/视频、表情、文件、音频和链接（后端六分类）都保存来源消息引用；`

- [ ] **Step 3: 验证（grep 无残留「绘画资源」在以上文件）**

Run: `grep -rn "绘画资源" docs/10-Cyrene-前端实施路线与任务拆分-v0.2.md docs/03-Cyrene-前端UI与交互设计-v0.2.md docs/16-Cyrene-前端实施任务清单与进度跟踪.md docs/00-Cyrene-前端文档索引与阅读顺序.md docs/01-Cyrene-Electron-前端总体架构设计-v0.2.md docs/08-Cyrene-前端测试与Demo验收方案-v0.2.md docs/13-Cyrene-前端文档交叉Review与修订记录-v0.1.md || echo "clean"`
Expected: `clean`（无残留）。

- [ ] **Step 4: Commit**

```bash
git add docs/10-Cyrene-前端实施路线与任务拆分-v0.2.md docs/03-Cyrene-前端UI与交互设计-v0.2.md docs/16-Cyrene-前端实施任务清单与进度跟踪.md docs/00-Cyrene-前端文档索引与阅读顺序.md docs/01-Cyrene-Electron-前端总体架构设计-v0.2.md docs/08-Cyrene-前端测试与Demo验收方案-v0.2.md docs/13-Cyrene-前端文档交叉Review与修订记录-v0.1.md
git commit -m "docs(G4): 清理「绘画资源」提法为后端六分类口径（spec §4.10）"
```

---

### Task 21: 门禁全量复跑 + 三态标记 + 状态同步

> 全量门禁（spec §6 验收）+ 三态标记（本组标「已开发、未联调」）+ docs/16 状态行 + README/CLAUDE.md 阶段 3 状态同步。

**Files:**
- Modify: `docs/16-Cyrene-前端实施任务清单与进度跟踪.md`（阶段 3 G4 勾选 + 测试数字 + 三态）
- Modify: `README.md`、`CLAUDE.md`（阶段 3 状态同步，按项目既有三态口径）
- Modify: `docs/02-Cyrene-前后端通信协议与前端数据结构-v0.2.md`（§19 search/context/stickers 行补实际确认字段形状——若实施确认，开放项收口）

- [ ] **Step 1: 全量门禁**

Run（repo 根，依次）：
```
pnpm typecheck
pnpm lint
pnpm test
xvfb-run -a pnpm test:integration
pnpm build
pnpm -F @cyrene/desktop check:contract
pnpm package
pnpm -F @cyrene/desktop verify:artifact --smoke
```
Expected: 全绿（527 现有单测 + 本组新增；23 现有集成 + 本组 1；check:contract 13/13——schema 结构不动故指纹不变）。

- [ ] **Step 2: 三态标记 + 状态同步（docs/16 + README + CLAUDE.md）**

- docs/16 阶段 3 状态行：勾选 G4 历史查看器/表情/无障碍各项，注明「**已开发、未联调**」（依赖真实后端 search/context/stickers 端点，B-01 后真实联调复验升「已真实联调」）；测试数字更新（单测/集成新增计数）。
- README「真实模式联调」小节 + CLAUDE.md 当前状态段：按项目三态口径同步 G4 状态。

- [ ] **Step 3: Commit**

```bash
git add docs/16-Cyrene-前端实施任务清单与进度跟踪.md README.md CLAUDE.md docs/02-Cyrene-前后端通信协议与前端数据结构-v0.2.md
git commit -m "docs(G4): 门禁全量绿 + 三态标记（已开发、未联调）+ 状态同步"
```

---

## 自审记录（writing-plans 技能自审清单）

**1. Spec coverage（spec 每节/每条验收 → 任务，无 gap）：**
- §2 范围 1-7 → Task 17/15（查看器）、Task 7/8/11（数据通道）、Task 16/18/19（Emoji）、Task 18/19（表情包）、Task 12/19（无障碍）、Task 20（文档清理）、Task 8/11（Mock 全链路）
- §4.1-4.2 数据流 → Task 15/14/13（查询/跳转编排）
- §4.3 契约与 IPC → Task 4/5/9/10/11
- §4.4 组合查询映射与日期时区（D3）→ Task 1/15（buildQuery）
- §4.5 来源跳转链路（D5/P2-3）→ Task 13/14/17
- §4.6 Emoji 与表情包（D7/D8/D9/P1-1/P3-1~3-4）→ Task 2/12/16/18/19
- §4.7 无障碍与 IME（D14）→ Task 3/17/18/19
- §4.8 错误处理 → Task 15/17（两分支统一、保留旧结果）
- §4.9 测试计划 → Task 1/2/3/6/7/8/11/13/14/15/16（对应 history-date/sticker-url/ime-guard/rest-search-mapper/real-backend-search/mock-backend-search/chat-history-query/history-viewer.store/history-viewer-ipc/recent-emoji；sticker.spec 覆盖并入 mock/real-backend-search）
- §4.10 文档清理 → Task 20
- §5 决策 D1-D15 → 各 Task（D1:17；D2:4/6；D3:1；D4:15；D5:13/14/15；D6:13/17/19；D7:16/18/19；D8:4/7/8/18/19；D9:12；D10:15/17；D11:15/17；D12:15；D13:范围外；D14:3/17/18/19；D15:15）
- §6 验收 → Task 21（门禁）+ 各组件验收点
- §7 开放项 → Task 7（category 取值）、Task 4/6（Message.stickerId 可选字段落地）、Task 21（docs/02 补字段）；**P0-1 设计缺口**（分类缩略图需资源端点补充/契约变更）→ 最终报告

**2. Placeholder scan：** 计划内无 TBD/TODO/「类似 Task N」；每代码步骤含完整代码块与可运行测试；组件任务以 typecheck+build+验收点清单为门禁（spec 已知限制）。**（P2-4 已修订）**Task 9/10/13/14 测试脚手架占位已补齐真实 import/断言（Task 10 对齐 `importDesktopApi`+`mockIpc.invoke` 注入式；Task 9/13/14 沿用既有文件头部 setup 并给出实际导入与隔离约定）。

**3. Type consistency：**
- `localDateToHalfOpenRange(localDate, timeZone): {from,to}` / `isoToLocalDate(iso, timeZone): string`（Task 1）→ Task 7/8/15 消费同签名 ✓
- `stickerIdFromResourceUrl(url): string|undefined` / `stickerRenderUrl(stickerId): string`（Task 2）→ `stickerRenderUrl` 由 Task 18/19 消费；`stickerIdFromResourceUrl` 供 P0-1 资源补充路径保留 ✓
- `isCompositionEnter(e): boolean`（Task 3）→ Task 17/19 消费 ✓
- `ChatHistoryQuery/ChatHistoryItem/ChatHistoryPage/ConversationResource/HistoryCategory/ChatHistoryScope`（Task 4）→ 全链一致（Task 5-21）✓
- `StickerItem{stickerId, src}` / `StickerManifest{stickers}`（Task 4，P0-2）→ Task 5/6/7/8/10/11/18 一致 ✓
- `buildQuery(BuildQueryInput): ChatHistoryQuery`（Task 15）→ 测试/组件消费一致 ✓
- `activate(id, anchor?)` / `jumpToMessage(conversationId, messageId, segmentId?)`（Task 14）→ Task 17 消费一致 ✓
- `loadContextWindow(messageId, before?, after?): Promise<boolean>` / `send(text, stickerId?)` / `setHighlight/clearHighlight`（Task 13）→ Task 14/19 消费一致 ✓
- `openViewer(initialCategory?)/submitQuery()/loadMore()/jumpTo(hit)`（Task 15）→ Task 17 消费一致 ✓
- `PendingSticker { kind:'sticker'; stickerId; name?; status:'ready' }`（G3）→ Task 18/19 消费一致 ✓

**遗留开放项（记录到最终报告）：**
1. **P0-1 设计缺口**：search item 无 kind/url，查看器「图片/视频/表情」分类缩略图不可从 search 数据呈现——方案①后端 `SearchMessageItem` 增可选 kind/url/stickerId（契约变更）；方案②新增 `queryResources` 通道查 `/api/sessions/{id}/resources?category=<单值枚举>`（docs/02 §19），其中图片/视频/音频/文件渲染依赖 G3 签名端点。G4 按 D15 文本展示，不实施 ①②（超范围）。**（P2-1）**REST 形状（search/context/stickers）按 `frontend_contract/rest.py` 人工核对，`check:contract` 不覆盖。
2. 用户贴图消息 wire 表示（spec §7）——本计划按 `Message.stickerId` 可选字段落地，联调对齐后端。
3. Inner Voice 命中回复组默认折叠 + 视觉标记（spec §4.5）——跳转定位逻辑已含 setHighlight(segmentId)，回复组展开按当前折叠设置（无持久化，默认保持折叠）；组件层细节留 Task 19 验收点。
4. 最近 Emoji localStorage 例外（D7）——若后续统一设置持久化通道再迁移。
5. 本组状态标记为「已开发、未联调」——真实后端 search/context/stickers 端点联调复验后升「已真实联调」。
6. **（P2-3）spec §5 D9 决策表「dev 三处」为残留不一致，以 spec §4.6「dev 两处」为准；最终报告汇报并修 spec。**
