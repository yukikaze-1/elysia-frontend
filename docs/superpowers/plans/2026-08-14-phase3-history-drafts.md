# 阶段 3 G2：历史与聊天体验（历史懒加载 / 每会话草稿 / 离线缓存 / 代码块复制 / Markdown 增强）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把阶段 2「最新一页 + 无条件回底」升级为阶段 3 G2「可向上翻完整历史不跳动、切换会话不丢草稿与合理滚动位置、离线可读最近会话、代码块可复制」，并保持信任边界（持久化归 Main、Renderer 只持内存态）与最小依赖（不引入三方虚拟列表/高亮库）。

**Architecture:** 按信任边界分层——Renderer 新增 `draftStore`（草稿+滚动锚点内存态/防抖持久化）与 `cacheStore`（离线水合 + 已确认消息快照推送），经新 IPC（`chat:hydrate-persistence` / `chat:persist-session` / `chat:cache-messages` / `app:open-external`）与 Main 交互；Main 新增 `SessionStore`（`drafts-v1.json` + `message-cache-v1.json`，版本化 + 逐条校验 + 损坏隔离 + 配额 + 50 会话淘汰告知 + `MAX_IPC_MESSAGE_BYTES=4MiB` 字节预算）；`message.store` 的 `upsertMessage` 改为 (createdAt, messageId) 升序二分有序插入（P0-1），新增 `loadOlder`（before 游标）/`loadSnapshot`（离线水合）；自研轻量虚拟列表 `CyMessageList`（估高 + ResizeObserver 实测 + 前缀和二分窗口 + 锚点捕获/恢复/高度补偿）；`CyMarkdown` 增加代码块语言标签+复制按钮+外部链接经 Main 白名单打开+80ms 尾沿防抖。游标分页契约（docs/02 §19 `before/_id` 倒序 keyset）已真实联调，本批新用户流标「已开发、未联调」。

**Tech Stack:** Electron main（Node）+ renderer（Vue 3 + Pinia）+ TypeScript strict + zod v4（仅 IPC 边界）+ Vitest（node 环境）+ `fs/promises`（Main 直读盘，复用 `atomicWriteFile`/`safe-open` 地基）。**不新增运行时依赖**（无 vue-virtual-scroller / highlight.js；虚拟窗口数学做成纯函数单测，组件薄）。

**Spec:** `docs/superpowers/specs/2026-08-14-phase3-history-drafts-design.md`（v2 已闭环：有序二分插入替代 append、离线切换 activateLocal、IPC 4MiB 上限、淘汰提示口径、connected/disconnected 缓存口径统一、草稿 50×100KB、缓存 20 会话、代码块仅复制+基础样式）。实施者以 spec 为准；本计划每任务引用对应 spec 章节（§4.2 IPC 面 / §4.3 历史懒加载+虚拟列表+锚点 D3/D5/D6 / §4.4 草稿 D1/D4 / §4.5 离线缓存 D2 / §4.6 Markdown D7 / §5 验收 / §7 已知限制）。

**基线 HEAD：** `main@a576404`。

---

## 评审修订轮次（2026-08-14，独立评审 2 P0 + 2 P1 + 4 P2，评审已验证）

| # | 问题 | 级别 | 处理 |
|---|---|---|---|
| 1 | Task 6 loadOlder 测试断言从未插入的消息——setPageMeta 只写 hasMoreBefore/beforeCursor、不载入 items（实现 1161-1165），order 实为 `[]`/`[m1]` | P0-1 | 测试改为「先 `loadPage(page)` 插入首页 items → `setPageMeta` 只初始化游标 → `loadOlder` 断言新页 items 有序前插」；setPageMeta 语义保持只写游标不变（与 Task 7 activate 流程 `loadPage(p)`+`setPageMeta(p)` 一致） |
| 2 | Task 3 compensateScroll 测试期望 -50 与实现 `Σ(new-old)`=-10 互斥 | P0-2 | 统一为实现语义：补偿 = Σ(新行高 − 旧行高)，期望改 **-10**（30+0−40；「新行更高则往下滚」的锚点补偿语义） |
| 3 | SessionStore.hydrate 降级链从不裁剪草稿，兜底返回全量 drafts；persistSession 允许 50×100KB=5MB，破 4MiB 不变量（GC7 + spec P1-2） | P1-1 | 降级链补草稿裁剪：快照降级仍超 → lastActive 优先、其余按 updatedAt 最近保留，逐条入内直至预算（`hydrate:drafts-degraded` 计数，被裁会话锚点一并清）；兜底仍超 → 空草稿+空快照拒绝路径；补单测断言出参 ≤4MiB |
| 4 | CyMessageList 未实现 loadOlder 前捕获锚点 + 前插后恢复；onRowResized 对前插行（prev undefined）不补偿 | P1-2 | onScroll 顶部哨兵 loadOlder 前 `captureAnchor` → 完成后 `restoreScrollTop` 恢复可视位置；onRowResized 前插行首测按「实测−估高」补偿；virtual-window.spec 增前插回环纯函数测试 |
| 5 | purgeConversation 不清理缓存会话列表（syncConversationList 是并集合并，删除后残留） | P2-1 | purge 时从 `cache.conversations` 移除被删会话；Task 8 补单测 + Task 16 集成测试补 conversations 断言 |
| 6 | Task 15 send() 在 send 返回前无条件清草稿（2844-2849），失败丢草稿 | P2-2 | `messageStore.send` 改返回 `Promise<boolean>`（true=已受理成功、false=失败）；CyChatInput 成功返回后清空、失败保留草稿（spec §4.4.1） |
| 7 | initializeConnected 离线恢复分支早退未置 ready=true/initializedFor=key（1318-1334），恢复后 UI 就绪门控不恢复 | P2-3 | 离线恢复分支补 `initializedFor=key; ready=true` 后再触发 activate |
| 8 | Task 8「整文件损坏」单测在 Linux 实际测权限路径——0644 写文件触发 SafeOpenError 先于 JSON.parse | P2-4 | writeFile 补 `mode: 0o600`，权限检查通过后走真实 JSON.parse 失败 → 隔离重建分支 |

---

## Global Constraints（subagent 必须遵守，逐条绑定）

1. **TypeScript 严格**：新增/修改文件必须过 `pnpm -F @cyrene/desktop typecheck`（typecheck:node 覆盖 main/preload/shared，typecheck:web 覆盖 renderer）。`DesktopApiLike` 是 Renderer store 消费的唯一窄接口——新方法必须同步 preload `desktop-api.ts`、`preload/index.d.ts`、`stores/desktop-api.types.ts` 三处。
2. **zod 只在 IPC 边界**：request/response schema 只出现在 `main/ipc/channels.ts`、`shared/schemas/ipc-response.ts`、`preload/desktop-api.ts` 的防御性解析（`unwrap(res, schema)` 信封解包）；Main `SessionStore` 与 Renderer 纯逻辑层一律不用 zod（形状手检 + 类型守卫）。新 IPC 通道必须走 handlers/executor 双层校验模式（`registerHandler` + `createIpcHandler`）。
3. **不新增运行时依赖**：只用现有 vue/pinia/marked + Node 内置（fs/promises、crypto、path）+ Electron 内置（`shell.openExternal`）。
4. **Main 是持久化边界（docs/06 §14 / docs/07 §1）**：草稿（敏感用户输入）与消息快照（敏感聊天内容，docs/06 §8.3）持久化必须归 Main userData（`app-cache` 0700 + safe-open + `atomicWriteFile` 0600 + POSIX dir fsync）；Renderer 只持内存态，`localStorage` 仅 UI 偏好；**新 IPC 不暴露任意路径**；缓存/草稿正文**永不写日志/诊断包**（只记计数/ID，诊断接口带 spy logger 断言）。
5. **后端是 source of truth（docs/06 §1）**：缓存/草稿只是本地便利副本；连接建立后由后端覆盖/调和；connected 时缓存消息快照**不进入** messageStore（P2-2），离线水合只发生在 disconnected snapshot 分支。
6. **失败语义 fail-open（C1 同款）**：持久化（草稿/缓存）失败不改变操作结果——草稿保内存态、缓存保内存态，下次触发重试；损坏恢复不阻塞启动。
7. **`MAX_IPC_MESSAGE_BYTES = 4 * 1024 * 1024`（4 MiB）**：定义于 `shared/contracts/ipc.ts`（注释引用 docs/07 §6.3「设置单条 IPC 消息大小上限」）；四个新通道入参/出参统一以它为准——Main 出参装箱预算降级（分页/截断/拒绝+告警）、入参预算校验（超限 `IPC_MESSAGE_TOO_LARGE`），降级只记诊断计数、不记正文。
8. **有序插入不变量（P0-1）**：同会话内 `messageStore.order` 恒为 `(createdAt, messageId)` 升序——`upsertMessage` 二分有序插入、`loadPage` 合并前防御性排序、`loadSnapshot` 载入前排序；锚点上方前缀和语义不变。
9. **常量定值**：草稿单条上限 `DRAFT_MAX_BYTES = 100 * 1024`（UTF-8 字节）；草稿防抖 `DRAFT_DEBOUNCE_MS = 800`；草稿条目上限 `DRAFT_MAX_ENTRIES = 50`；缓存会话上限 `CACHE_TOP_N = 20`；每会话快照上限 `CACHE_MESSAGES_PER_CONV = 300`；快照推送分片 `CACHE_PUSH_CHUNK = 200` 条/批 + 字节预算；Markdown 流式防抖 `MARKDOWN_DEBOUNCE_MS = 80`；虚拟列表 overscan `OVERSCAN_PX = 400`。
10. **TDD 红-绿-提交**：每任务先写失败测试→跑（FAIL）→最小实现→跑（PASS）→commit；commit 消息 `feat/fix/test/docs(...)` 中文说明（如 `feat(G2 virtual-window): 前缀和窗口数学纯函数`）。组件任务（CyMarkdown/CyMessageList/CyChatInput/CyChatView/CyConversationList）无单测基线，以 `typecheck:web` + `build` 为准（G3 plan 同款纪律，spec §5 组件层手动验证）。
11. **文档编辑保持中文**（docs 集约定）。
12. **门禁（Task 16 全量复跑）**：`typecheck` / `lint`（`--max-warnings=0`）/ `test`（527 现有 + 本组新增单测）/ `xvfb-run -a pnpm -F @cyrene/desktop test:integration`（23 现有 + 本组 1 新增，预期不回退）/ `build` / `check:contract`（13/13——本批不动 wire 契约/schema 指纹，实施时实测确认）/ `package` + `xvfb-run -a verify:artifact -- --smoke`（本批动 renderer UI + Main 持久化，打包路径受牵连，必须复跑）。
13. **三态状态源**：本批为阶段 3 新功能、Mock 驱动 → 本地门禁全绿后标「**已开发、未联调**」，不得标「已完成」（spec §5 状态标记）。
14. **范围边界（明确不做）**：G4 历史查看器/`getMessageContext` 深锚点（留阶段 7）；G3 附件（`ConversationDraft.attachmentLocalIds` 恒空数组）；窗口 bounds 持久化；语法高亮库（阶段 7 再评估）。

---

## 文件结构（新建 / 修改）

**新建（shared）：**
- `apps/desktop/src/shared/contracts/persistence.ts` —— `ScrollAnchor`/`PersistSessionInput`/`PersistSessionResult`/`CacheMessagesInput`/`OpenExternalInput`/`SessionPersistenceState`（spec §4.2）

**修改（shared）：**
- `apps/desktop/src/shared/contracts/ipc.ts` —— 新增 4 通道常量 + `MAX_IPC_MESSAGE_BYTES`
- `apps/desktop/src/shared/contracts/index.ts` —— export persistence
- `apps/desktop/src/shared/schemas/persistence.ts` —— 新建，镜像契约的 zod schema
- `apps/desktop/src/shared/schemas/index.ts` —— export persistence

**新建（main / renderer）：**
- `apps/desktop/src/main/persistence/session-store.ts` —— `SessionStore`（草稿+锚点+会话列表缓存+消息快照+配额+损坏隔离+字节预算+删除联动）
- `apps/desktop/src/main/persistence/persistence-handlers.ts` —— 四通道 IPC handler（含 `appOpenExternal` http/https 白名单）
- `apps/desktop/src/renderer/src/utils/message-order.ts` —— `cmpMsg` 比较器（(createdAt, messageId) 升序）
- `apps/desktop/src/renderer/src/utils/virtual-window.ts` —— 前缀和/二分窗口/锚点数学（纯函数，spec §4.3.1）
- `apps/desktop/src/renderer/src/utils/clipboard.ts` —— `copyText`（navigator.clipboard 优先 + execCommand 兜底，Web API 不经 IPC）
- `apps/desktop/src/renderer/src/utils/debounce-trailing.ts` —— 尾沿防抖（可注入定时器）
- `apps/desktop/src/renderer/src/stores/draft.store.ts` —— 草稿+滚动锚点内存态（spec §4.1/§4.4）
- `apps/desktop/src/renderer/src/stores/cache.store.ts` —— 离线水合+消息快照推送（spec §4.1/§4.5）
- `apps/desktop/src/renderer/src/components/CyMessageList.vue` —— 自研虚拟列表（spec §4.3.2）

**修改（main / preload / renderer）：**
- `apps/desktop/src/main/ipc/channels.ts` —— 4 个新通道 request schema
- `apps/desktop/src/main/ipc/handlers.ts` —— 注册 persistence handlers
- `apps/desktop/src/main/index.ts` —— 装配 SessionStore（`app-cache` 目录 + safeRoot + `getActiveConversationId`）+ 传入 registerHandlers
- `apps/desktop/src/main/chat/chat-service.ts` —— `listConversations` 写列表缓存 / `activate` 记 `lastActiveConversationId` / `deleteConversation` purge（fail-open）
- `apps/desktop/src/preload/desktop-api.ts` —— 4 个新方法（`unwrap(res, schema)`）
- `apps/desktop/src/preload/index.d.ts` —— window.desktopApi 类型同步
- `apps/desktop/src/renderer/src/stores/desktop-api.types.ts` —— `DesktopApiLike` 窄接口 +4
- `apps/desktop/src/renderer/src/stores/message.store.ts` —— 有序插入 `upsertMessage` + `setPageMeta`/`loadOlder`/`loadSnapshot` + `hasMoreBefore`/`beforeCursor`/`loadingOlder` + 快照推送钩子
- `apps/desktop/src/renderer/src/stores/conversation.store.ts` —— `activate` 初始化 hasMoreBefore + `offlineView`/`setOfflineCache`/`activateLocal` + 在线恢复 + list 同步 cacheStore
- `apps/desktop/src/renderer/src/bootstrap.ts` —— `hydratePersistence` + disconnected 离线水合（P1-1/P2-2）
- `apps/desktop/src/renderer/src/main.ts` —— 新 store 传入 bootstrap
- `apps/desktop/src/renderer/src/utils/markdown.ts` —— `wrapCodeBlocks`（sanitize 后字符串处理）
- `apps/desktop/src/renderer/src/components/CyMarkdown.vue` —— 代码块/复制/外部链接/防抖
- `apps/desktop/src/renderer/src/components/CyChatView.vue` —— 改用 CyMessageList
- `apps/desktop/src/renderer/src/components/CyChatInput.vue` —— draftStore 草稿源 + 超限横幅
- `apps/desktop/src/renderer/src/components/CyConversationList.vue` —— 离线点击走 `activateLocal`

**新建（测试）：**
- `apps/desktop/tests/unit/virtual-window.spec.ts`
- `apps/desktop/tests/unit/draft.store.spec.ts`
- `apps/desktop/tests/unit/cache.store.spec.ts`
- `apps/desktop/tests/unit/session-store.spec.ts`
- `apps/desktop/tests/unit/clipboard.spec.ts`
- `apps/desktop/tests/unit/debounce-trailing.spec.ts`
- `apps/desktop/tests/unit/persistence-handlers.spec.ts`
- `apps/desktop/tests/integration/persistence-lifecycle.spec.ts`

**修改（测试）：**
- `apps/desktop/tests/unit/ipc-response-schema.spec.ts`（新 schema 镜像）
- `apps/desktop/tests/unit/message.store.spec.ts`（loadOlder 有序合并 / loadSnapshot / setPageMeta + mockApi +4）
- `apps/desktop/tests/unit/conversation.store.spec.ts`（activateLocal / setOfflineCache + mockApi +4）
- `apps/desktop/tests/unit/connection.store.spec.ts`（mockApi +4）
- `apps/desktop/tests/unit/markdown-sanitize.spec.ts`（代码块包裹 / 复制文本提取）
- `apps/desktop/tests/unit/renderer-bootstrap.spec.ts`（离线水合 / connected 不覆盖；makeFake/makeStores 补 hydratePersistence + draft/cache）
- `apps/desktop/tests/unit/desktop-api-chat.spec.ts`（4 新方法信封解包）
- `apps/desktop/tests/integration/helpers/app.ts`（`launchApp` 增可选 `seedFiles` 预置损坏文件）

---

### Task 1: 共享契约 —— persistence.ts + IPC 通道 + MAX_IPC_MESSAGE_BYTES + DesktopApiLike

**Files:**
- Create: `apps/desktop/src/shared/contracts/persistence.ts`
- Modify: `apps/desktop/src/shared/contracts/ipc.ts`
- Modify: `apps/desktop/src/shared/contracts/index.ts`
- Modify: `apps/desktop/src/renderer/src/stores/desktop-api.types.ts`
- Modify: `apps/desktop/tests/unit/message.store.spec.ts`、`conversation.store.spec.ts`、`connection.store.spec.ts`（mockApi +4 方法，否则 `setDesktopApi(mockApi)` 类型报错）

**Interfaces:**
- Produces: `IpcChannels.chatHydratePersistence/chatPersistSession/chatCacheMessages/appOpenExternal`；`MAX_IPC_MESSAGE_BYTES = 4 * 1024 * 1024`；`ScrollAnchor { messageId: string; offset: number }`；`PersistSessionInput { conversationId: string; draft: { text: string; updatedAt: string }; scrollAnchor: ScrollAnchor | null }`；`PersistSessionResult { evictedConversationIds?: string[] }`；`CacheMessagesInput { conversationId: string; messages: Message[]; updatedAt: string }`；`OpenExternalInput { url: string }`；`SessionPersistenceState { drafts: ConversationDraft[]; scrollAnchors: Record<string, ScrollAnchor>; lastActiveConversationId?: string; conversations: Conversation[]; messageSnapshots: Record<string, Message[]> }`；`DesktopApiLike` +4：`hydratePersistence(): Promise<SessionPersistenceState>` / `persistSession(input: PersistSessionInput): Promise<PersistSessionResult>` / `cacheMessages(input: CacheMessagesInput): Promise<void>` / `openExternal(url: string): Promise<void>`
- Consumes: 既有 `ConversationDraft`/`Conversation`/`Message`（`@shared/contracts`）

- [ ] **Step 1: 写失败测试**——在 `tests/unit/ipc-response-schema.spec.ts` 无断言（Task 2 才有 schema），此处先用编译门禁：`pnpm -F @cyrene/desktop typecheck` 预期 FAIL——`desktop-api.types.ts` 尚无 `hydratePersistence` 等（本任务先建类型文件，断言走 Task 2）。

  `apps/desktop/src/shared/contracts/persistence.ts`（新建）：

```ts
// 阶段 3 G2 持久化契约（spec §4.2）：草稿+滚动锚点 / 会话列表缓存 / 消息快照缓存 / 外部链接。
// 信任边界：Main 是持久化边界，Renderer 只持内存态；这些类型经 IPC 流转，Render 端经 schema 校验。
import type { Conversation, ConversationDraft } from './conversation'
import type { Message } from './message'

/** 可视锚点：视口顶 → 锚点消息顶的偏移（D5） */
export interface ScrollAnchor {
  messageId: string
  offset: number
}

/** 草稿+滚动锚点 upsert（防抖/切会话 flush；draft.text 空串=清除） */
export interface PersistSessionInput {
  conversationId: string
  draft: { text: string; updatedAt: string }
  scrollAnchor: ScrollAnchor | null
}

/** persistSession 响应：本次写入触发 50 会话上限淘汰时，返回被淘汰条目的 conversationId（P2-1，淘汰不静默） */
export interface PersistSessionResult {
  evictedConversationIds?: string[]
}

/** 已确认消息快照增量推送（Renderer 装配后推送；Main 按 messageId 去重合并） */
export interface CacheMessagesInput {
  conversationId: string
  messages: Message[]
  updatedAt: string
}

/** Markdown 外部链接（http/https 白名单，Main shell.openExternal） */
export interface OpenExternalInput {
  url: string
}

/** 启动水合响应：草稿+锚点+上次活动会话+最近 20 会话列表+消息快照 */
export interface SessionPersistenceState {
  drafts: ConversationDraft[]
  scrollAnchors: Record<string, ScrollAnchor>
  lastActiveConversationId?: string
  conversations: Conversation[]
  messageSnapshots: Record<string, Message[]>
}
```

- [ ] **Step 2: 实现类型**——`ipc.ts` 追加通道与常量；`index.ts` export；`desktop-api.types.ts` +4 方法。

  `apps/desktop/src/shared/contracts/ipc.ts`（在 `IpcChannels` 对象内追加 4 键）：

```ts
  chatHydratePersistence: 'chat:hydrate-persistence',   // 启动水合：草稿+锚点+会话列表+消息快照
  chatPersistSession: 'chat:persist-session',           // 草稿+滚动锚点 upsert（防抖/切会话 flush）
  chatCacheMessages: 'chat:cache-messages',             // 已确认消息快照增量推送
  appOpenExternal: 'app:open-external'                  // Markdown 外部链接（http/https 白名单）
```

  文件底部追加（docs/07 §6.3「设置单条 IPC 消息大小上限」落地）：

```ts
/** 单条 IPC 消息大小上限（docs/07 §6.3）：新持久化/外部链接通道的出参装箱预算与入参校验统一以它为准 */
export const MAX_IPC_MESSAGE_BYTES = 4 * 1024 * 1024
```

  `apps/desktop/src/shared/contracts/index.ts` 追加 `export * from './persistence'`。

  `apps/desktop/src/renderer/src/stores/desktop-api.types.ts`：import 追加 `CacheMessagesInput, OpenExternalInput, PersistSessionInput, PersistSessionResult, SessionPersistenceState`，`DesktopApiLike` 内追加：

```ts
  hydratePersistence(): Promise<SessionPersistenceState>
  persistSession(input: PersistSessionInput): Promise<PersistSessionResult>
  cacheMessages(input: CacheMessagesInput): Promise<void>
  openExternal(url: string): Promise<void>
```

- [ ] **Step 3: 修测试 mockApi**——三个 spec 的 mockApi 各 +4 方法：

```ts
  hydratePersistence: vi.fn(), persistSession: vi.fn(), cacheMessages: vi.fn(), openExternal: vi.fn(),
```

  `tests/unit/message.store.spec.ts` / `conversation.store.spec.ts` / `connection.store.spec.ts` 的 `mockApi` 对象体各加一行。

- [ ] **Step 4: 验证**——`pnpm -F @cyrene/desktop typecheck` 预期 PASS；`pnpm -F @cyrene/desktop test -- tests/unit/message.store.spec.ts tests/unit/conversation.store.spec.ts tests/unit/connection.store.spec.ts` 预期 PASS（无行为变化）。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/shared/contracts/persistence.ts apps/desktop/src/shared/contracts/ipc.ts apps/desktop/src/shared/contracts/index.ts apps/desktop/src/renderer/src/stores/desktop-api.types.ts apps/desktop/tests/unit/message.store.spec.ts apps/desktop/tests/unit/conversation.store.spec.ts apps/desktop/tests/unit/connection.store.spec.ts
git commit -m "feat(G2 persistence): 持久化/外部链接共享契约 + IPC 通道 + MAX_IPC_MESSAGE_BYTES + DesktopApiLike"
```

---

### Task 2: 共享 zod schema（IPC 边界镜像）+ schema 测试

**Files:**
- Create: `apps/desktop/src/shared/schemas/persistence.ts`
- Modify: `apps/desktop/src/shared/schemas/index.ts`
- Modify: `tests/unit/ipc-response-schema.spec.ts`

**Interfaces:**
- Consumes: Task 1 的契约类型 + `MessageSchema`/`ConversationSchema`（既有）
- Produces: `ScrollAnchorSchema`、`PersistSessionInputSchema`、`PersistSessionResultSchema`、`CacheMessagesInputSchema`、`OpenExternalInputSchema`、`SessionPersistenceStateSchema`（Main responseSchema/requestSchema 与 Preload 防御性解析共用）

- [ ] **Step 1: 写失败测试**——`tests/unit/ipc-response-schema.spec.ts` 末尾追加 describe：

```ts
import {
  ScrollAnchorSchema, PersistSessionInputSchema, PersistSessionResultSchema,
  CacheMessagesInputSchema, OpenExternalInputSchema, SessionPersistenceStateSchema
} from '@shared/schemas'

describe('阶段 3 G2 持久化 Schema（镜像 shared/contracts/persistence.ts）', () => {
  it('ScrollAnchorSchema 通过 {messageId, offset}', () => {
    expect(ScrollAnchorSchema.safeParse({ messageId: 'm1', offset: 120 }).success).toBe(true)
  })
  it('ScrollAnchorSchema 拒绝缺 messageId / 负 offset', () => {
    expect(ScrollAnchorSchema.safeParse({ offset: 0 }).success).toBe(false)
    expect(ScrollAnchorSchema.safeParse({ messageId: 'm1', offset: -1 }).success).toBe(false)
  })
  it('PersistSessionInputSchema 通过完整载荷,scrollAnchor 可 null', () => {
    const ok = PersistSessionInputSchema.safeParse({
      conversationId: 'c1', draft: { text: '你好', updatedAt: 't' }, scrollAnchor: { messageId: 'm1', offset: 0 }
    })
    expect(ok.success).toBe(true)
    const okNull = PersistSessionInputSchema.safeParse({ conversationId: 'c1', draft: { text: '', updatedAt: 't' }, scrollAnchor: null })
    expect(okNull.success).toBe(true)
  })
  it('PersistSessionInputSchema 拒绝 draft.text 超 100_000 码点（Main 再按 UTF-8 字节权威校验）', () => {
    const r = PersistSessionInputSchema.safeParse({ conversationId: 'c1', draft: { text: 'x'.repeat(100_001), updatedAt: 't' }, scrollAnchor: null })
    expect(r.success).toBe(false)
  })
  it('CacheMessagesInputSchema 通过/拒绝（缺 messages 或 messageId 空拒绝）', () => {
    const ok = CacheMessagesInputSchema.safeParse({ conversationId: 'c1', messages: [{ messageId: 'm1', conversationId: 'c1', role: 'user', content: 'hi', status: 'completed', createdAt: 't' }], updatedAt: 't' })
    expect(ok.success).toBe(true)
    expect(CacheMessagesInputSchema.safeParse({ conversationId: 'c1', messages: [], updatedAt: 't' }).success).toBe(true)
    expect(CacheMessagesInputSchema.safeParse({ conversationId: 'c1', messages: [{ messageId: '', conversationId: 'c1', role: 'user', status: 'completed', createdAt: 't' }], updatedAt: 't' }).success).toBe(false)
  })
  it('OpenExternalInputSchema 拒绝非字符串 url', () => {
    expect(OpenExternalInputSchema.safeParse({ url: 'https://example.com' }).success).toBe(true)
    expect(OpenExternalInputSchema.safeParse({ url: 42 }).success).toBe(false)
  })
  it('SessionPersistenceStateSchema 通过完整水合载荷（snapshots 含合法消息）', () => {
    const state = {
      drafts: [{ conversationId: 'c1', text: '草稿', attachmentLocalIds: [], updatedAt: 't' }],
      scrollAnchors: { c1: { messageId: 'm1', offset: 5 } },
      lastActiveConversationId: 'c1',
      conversations: [{ id: 'c1', title: '会话', updatedAt: 't' }],
      messageSnapshots: { c1: [{ messageId: 'm1', conversationId: 'c1', role: 'assistant', status: 'completed', createdAt: 't', assistantSegments: [] }] }
    }
    expect(SessionPersistenceStateSchema.safeParse(state).success).toBe(true)
  })
})
```

  预期 FAIL：`@shared/schemas` 无这些导出。

- [ ] **Step 2: 实现 schema**——`apps/desktop/src/shared/schemas/persistence.ts`（新建）：

```ts
import { z } from 'zod'
import { ConversationSchema, MessageSchema } from './ipc-response'

/** 草稿文件条目（drafts-v1.json entries 值；attachmentLocalIds 契约保留为空，G3 接入） */
export const ConversationDraftSchema = z.object({
  conversationId: z.string().min(1),
  text: z.string(),
  attachmentLocalIds: z.array(z.string()),
  updatedAt: z.string()
})

export const ScrollAnchorSchema = z.object({
  messageId: z.string().min(1),
  offset: z.number().finite().nonnegative()
})

export const PersistSessionInputSchema = z.object({
  conversationId: z.string().min(1),
  draft: z.object({ text: z.string().max(100_000), updatedAt: z.string() }),
  scrollAnchor: ScrollAnchorSchema.nullable()
})

export const PersistSessionResultSchema = z.object({
  evictedConversationIds: z.array(z.string().min(1)).optional()
})

export const CacheMessagesInputSchema = z.object({
  conversationId: z.string().min(1),
  messages: z.array(MessageSchema),
  updatedAt: z.string()
})

export const OpenExternalInputSchema = z.object({ url: z.string() })

export const SessionPersistenceStateSchema = z.object({
  drafts: z.array(ConversationDraftSchema),
  scrollAnchors: z.record(z.string(), ScrollAnchorSchema),
  lastActiveConversationId: z.string().optional(),
  conversations: z.array(ConversationSchema),
  messageSnapshots: z.record(z.string(), z.array(MessageSchema))
})
```

  `apps/desktop/src/shared/schemas/index.ts` 追加 `export * from './persistence'`。

- [ ] **Step 3: 跑测试**——`pnpm -F @cyrene/desktop test -- tests/unit/ipc-response-schema.spec.ts` 预期 PASS。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/src/shared/schemas/persistence.ts apps/desktop/src/shared/schemas/index.ts apps/desktop/tests/unit/ipc-response-schema.spec.ts
git commit -m "feat(G2 persistence): 持久化/外部链接 zod schema 镜像契约（IPC 边界）"
```

---

### Task 3: 纯函数层 —— cmpMsg + virtual-window 前缀和/二分/锚点数学

**Files:**
- Create: `apps/desktop/src/renderer/src/utils/message-order.ts`
- Create: `apps/desktop/src/renderer/src/utils/virtual-window.ts`
- Test: `tests/unit/virtual-window.spec.ts`

**Interfaces:**
- Consumes: `Message`/`ScrollAnchor`（`@shared/contracts`）
- Produces（后续 Task 4/6/14 消费）:
  - `cmpMsg(a: Message, b: Message): number` —— `a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0`
  - `estimateHeight(m: Message): number`
  - `buildPrefix(items: Message[], heights: Record<string, number>): number[]`（`prefix[i]` = items[0..i-1] 高度累计，实测优先、缺失用估高）
  - `computeWindow(prefix: number[], scrollTop: number, viewportHeight: number, overscanPx: number): { startIndex: number; endIndex: number; paddingTop: number; paddingBottom: number }`
  - `captureAnchor(items: Message[], prefix: number[], scrollTop: number, viewportHeight: number): ScrollAnchor`
  - `restoreScrollTop(items: Message[], prefix: number[], anchor: ScrollAnchor): number`（锚点消息顶 + offset；不在列表返回 0）
  - `compensateScroll(deltas: Array<{ old: number; new: number }>): number`（累加 `new - old`，供锚点上方高度变化调 scrollTop）

- [ ] **Step 1: 写失败测试**——`tests/unit/virtual-window.spec.ts`（新建）：

```ts
// tests/unit/virtual-window.spec.ts —— spec §4.3.1 纯函数层：估高+实测混合前缀和/二分窗口/锚点数学。
import { describe, expect, it } from 'vitest'
import type { Message } from '@shared/contracts'
import { cmpMsg } from '../../src/renderer/src/utils/message-order'
import {
  estimateHeight, buildPrefix, computeWindow, captureAnchor, restoreScrollTop, compensateScroll
} from '../../src/renderer/src/utils/virtual-window'

function msg(id: string, createdAt: string): Message {
  return { messageId: id, conversationId: 'c1', role: 'user', content: 'hello', status: 'completed', createdAt }
}
function mh(items: Message[]): Record<string, number> {
  const h: Record<string, number> = {}
  for (const m of items) h[m.messageId] = 50
  return h
}

describe('cmpMsg（(createdAt, messageId) 升序）', () => {
  it('时间不同按 createdAt；时间相同按 messageId；全等为 0', () => {
    expect(cmpMsg(msg('a', '2026-01-01T00:00:00.000Z'), msg('b', '2026-01-02T00:00:00.000Z'))).toBeLessThan(0)
    expect(cmpMsg(msg('b', '2026-01-02T00:00:00.000Z'), msg('a', '2026-01-01T00:00:00.000Z'))).toBeGreaterThan(0)
    expect(cmpMsg(msg('a', '2026-01-01T00:00:00.000Z'), msg('b', '2026-01-01T00:00:00.000Z'))).toBeLessThan(0)
    expect(cmpMsg(msg('a', 't'), msg('a', 't'))).toBe(0)
  })
})

describe('estimateHeight 启发式', () => {
  it('user 短文本 >0；assistant 长 markdown（含代码围栏）高于短文本', () => {
    const short = msg('u', 't')
    const long: Message = { ...msg('a', 't'), role: 'assistant', assistantSegments: [{ segmentId: 's', segmentIndex: 0, channel: 'public_reply', kind: 'markdown', text: '```ts\ncode\n```\n\nlong text '.repeat(20), completed: true }] }
    expect(estimateHeight(short)).toBeGreaterThan(0)
    expect(estimateHeight(long)).toBeGreaterThan(estimateHeight(short))
  })
})

describe('buildPrefix / computeWindow（前缀和 + 二分窗口）', () => {
  const items = [msg('m1', 't1'), msg('m2', 't2'), msg('m3', 't3'), msg('m4', 't4'), msg('m5', 't5')]
  const prefix = buildPrefix(items, mh(items)) // 每条实测 50 → prefix = [0,50,100,150,200,250]
  it('buildPrefix 全实测：前缀和递增且末项=总高', () => {
    expect(prefix).toEqual([0, 50, 100, 150, 200, 250])
  })
  it('buildPrefix 缺失估高兜底：heights 缺 m2 → 用 estimateHeight', () => {
    const h = mh(items); delete h['m2']
    const p = buildPrefix(items, h)
    expect(p[1]).toBe(50)
    expect(p[2]).toBe(50 + estimateHeight(items[1]))
  })
  it('computeWindow 空列表 → 全 0', () => {
    expect(computeWindow([0], 0, 600, 400)).toEqual({ startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0 })
  })
  it('computeWindow 视口中部 → 含 overscan 的窗口 + paddingTop/Bottom', () => {
    const w = computeWindow(prefix, 120, 100, 40) // top=80,bottom=260
    expect(w.startIndex).toBeGreaterThanOrEqual(0)
    expect(w.endIndex).toBeGreaterThan(w.startIndex)
    expect(w.paddingTop + w.paddingBottom).toBeLessThan(prefix[prefix.length - 1])
    expect(w.paddingTop).toBe(prefix[w.startIndex])
    expect(w.paddingBottom).toBe(prefix[prefix.length - 1] - prefix[w.endIndex])
  })
  it('computeWindow 越界 clamp（scrollTop 超内容 → 末窗口、paddingBottom=0）', () => {
    const w = computeWindow(prefix, 9999, 100, 0)
    expect(w.endIndex).toBe(prefix.length - 1)
    expect(w.paddingBottom).toBe(0)
  })
})

describe('captureAnchor / restoreScrollTop / compensateScroll（prepend 不跳动，P0-1）', () => {
  const items = [msg('m1', 't1'), msg('m2', 't2'), msg('m3', 't3'), msg('m4', 't4')]
  const prefix = buildPrefix(items, mh(items)) // [0,50,100,150,200]
  it('captureAnchor 取首个可见消息 + 视口偏移', () => {
    const a = captureAnchor(items, prefix, 110, 100) // prefix[2]=100 <= 110 → 锚点 m3
    expect(a.messageId).toBe('m3')
    expect(a.offset).toBe(10)
  })
  it('restoreScrollTop 恢复 = 锚点消息顶 + offset（prepend 后前缀和增长，锚点位移不变）', () => {
    const before = restoreScrollTop(items, prefix, { messageId: 'm3', offset: 10 })
    expect(before).toBe(110)
    const prepended = [msg('p1', 't0.5'), ...items]
    const p2 = buildPrefix(prepended, mh(prepended)) // 每条 50 → p2=[0,50,100,150,200,250]
    const after = restoreScrollTop(prepended, p2, { messageId: 'm3', offset: 10 })
    expect(after).toBe(160) // m3 现在 index 3 → prefix[3]=150 + offset 10 = 160（锚点上方新增一行 → 位移 +50）
    expect(after - before).toBe(50)
  })
  it('restoreScrollTop 锚点不在列表 → 0', () => {
    expect(restoreScrollTop(items, prefix, { messageId: 'nope', offset: 0 })).toBe(0)
  })
  it('P1-2 loadOlder 前插锚点回环：captureAnchor→前插多页→restoreScrollTop 后锚点消息与视口偏移不变', () => {
    const anchor = captureAnchor(items, prefix, 110, 100) // prefix[2]=100 <= 110 → 锚点 m3，offset 10
    const prepended = [msg('p1', 't0.2'), msg('p2', 't0.1'), ...items] // 更早两页前插
    const p2 = buildPrefix(prepended, mh(prepended)) // 每条 50 → m3 现 index 4 → prefix[4]=200
    const restored = restoreScrollTop(prepended, p2, anchor)
    expect(restored).toBe(210) // 200 + offset 10：scrollTop 前移 100px 补偿前插高度（锚点视口位置不变）
    // 回环：恢复后的滚动位置再捕获，锚点消息与偏移与捕获时一致（用户感知「向上翻不跳动」，评审 P1-2）
    const recaptured = captureAnchor(prepended, p2, restored, 100)
    expect(recaptured.messageId).toBe(anchor.messageId)
    expect(recaptured.offset).toBe(anchor.offset)
  })
  it('compensateScroll 累计实测-估高 delta（D5 高度补偿）', () => {
    // Σ(new-old)=30+0-40=-10：新行更高 delta 正 → 往下滚；新行更矮 delta 负 → 往上滚（评审 P0-2 统一为实现语义）
    expect(compensateScroll([{ old: 50, new: 80 }, { old: 40, new: 40 }, { old: 100, new: 60 }])).toBe(-10)
  })
  it('P0-1 不变量：order 恒升序时前缀和=可视位移（锚点上方新增行只增加前缀和、offset 不变）', () => {
    const a = captureAnchor(items, prefix, 110, 100)
    const sorted = [...items, msg('m0', 't0')].sort(cmpMsg) // m0 最旧 → 前插
    expect(sorted[0].messageId).toBe('m0')
    const p = buildPrefix(sorted, mh(sorted))
    const after = restoreScrollTop(sorted, p, a)
    expect(after).toBeGreaterThan(110) // 锚点下方新增 → 前缀和增量
    expect(a.offset).toBe(10) // 锚点偏移不变
  })
})
```

  预期 FAIL：`@shared` utils 不存在。

- [ ] **Step 2: 实现**——`apps/desktop/src/renderer/src/utils/message-order.ts`（新建）：

```ts
// 消息排序比较器（spec §4.3.3 P0-1）：(createdAt, messageId) 升序。
// message.store 有序插入 / loadPage 防御性排序 / loadSnapshot 排序 / 虚拟列表锚点前缀和共用。
import type { Message } from '@shared/contracts'

export function cmpMsg(a: Message, b: Message): number {
  if (a.createdAt < b.createdAt) return -1
  if (a.createdAt > b.createdAt) return 1
  if (a.messageId < b.messageId) return -1
  if (a.messageId > b.messageId) return 1
  return 0
}
```

  `apps/desktop/src/renderer/src/utils/virtual-window.ts`（新建，spec §4.3.1）：

```ts
// 自研轻量虚拟列表数学（D3/D5）：估高+实测混合前缀和 + 二分窗口 + 锚点捕获/恢复/高度补偿。
// 全部纯函数可单测；组件层只做 ResizeObserver 实测写入 + 窗口渲染 + 锚点保存。
import type { Message, ScrollAnchor } from '@shared/contracts'

/** 虚拟列表 overscan（组件层常量，单测以入参为准） */
export const OVERSCAN_PX = 400

function countFences(text: string): number {
  let n = 0
  for (const line of text.split('\n')) if (line.trimStart().startsWith('```')) n++
  return Math.ceil(n / 2)
}

/** 纯启发式：未渲染行恒用估算高（实测覆盖后以实测为准） */
export function estimateHeight(m: Message): number {
  const BASE = 36
  const LINE = 20
  if (m.role === 'user') {
    const lines = Math.max(1, Math.ceil((m.content?.length ?? 1) / 40))
    return BASE + lines * LINE
  }
  if (m.role === 'assistant') {
    let textLen = 0
    let extra = 0
    for (const seg of m.assistantSegments ?? []) {
      textLen += seg.text?.length ?? 0
      if (seg.kind === 'markdown' && seg.text) {
        extra += countFences(seg.text) * 3
        extra += (seg.text.match(/^\s*[-*] |^\s*\d+\. /gm)?.length ?? 0) / 2
      }
    }
    return BASE + Math.ceil(textLen / 45) * LINE + Math.round(extra) * LINE
  }
  return BASE
}

/** 前缀和：prefix[i] = items[0..i-1] 高度累计；实测优先，缺失用 estimateHeight 兜底 */
export function buildPrefix(items: Message[], heights: Record<string, number>): number[] {
  const prefix: number[] = new Array(items.length + 1)
  prefix[0] = 0
  for (let i = 0; i < items.length; i++) {
    const id = items[i].messageId
    prefix[i + 1] = prefix[i] + (heights[id] ?? estimateHeight(items[i]))
  }
  return prefix
}

function lowerBound(arr: number[], target: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

function upperBound(arr: number[], target: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid] <= target) lo = mid + 1
    else hi = mid
  }
  return lo
}

export interface WindowSlice {
  startIndex: number
  endIndex: number
  paddingTop: number
  paddingBottom: number
}

/** 二分窗口：滚动事件只做 O(log n)；上下 overscan 撑开避免滚动闪烁 */
export function computeWindow(
  prefix: number[], scrollTop: number, viewportHeight: number, overscanPx: number
): WindowSlice {
  if (prefix.length <= 1) return { startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0 }
  const top = Math.max(0, scrollTop - overscanPx)
  const bottom = scrollTop + viewportHeight + overscanPx
  const startIndex = Math.max(0, lowerBound(prefix, top) - 1)
  const endIndex = Math.min(prefix.length - 1, upperBound(prefix, bottom) - 1)
  const start = Math.min(startIndex, prefix.length - 1)
  const end = Math.max(start, endIndex)
  return { startIndex: start, endIndex: end, paddingTop: prefix[start], paddingBottom: prefix[prefix.length - 1] - prefix[end] }
}

/** 锚点：首个可见消息 + 视口偏移（D5，向上加载不跳动的前提） */
export function captureAnchor(items: Message[], prefix: number[], scrollTop: number, viewportHeight: number): ScrollAnchor {
  if (items.length === 0) return { messageId: '', offset: 0 }
  const idx = Math.max(0, lowerBound(prefix, scrollTop) - 1)
  return { messageId: items[idx].messageId, offset: scrollTop - prefix[idx] }
}

/** 恢复：锚点消息顶 + offset（items 为恢复时刻的当前 order，锚点消息必在其中才可精确恢复） */
export function restoreScrollTop(items: Message[], prefix: number[], anchor: ScrollAnchor): number {
  if (!anchor.messageId) return 0
  const idx = items.findIndex((m) => m.messageId === anchor.messageId)
  if (idx < 0) return 0
  return prefix[idx] + anchor.offset
}

/** 高度补偿（D5）：锚点上方已渲染行实测 vs 估高变化累计 delta，加回 scrollTop 使锚点可视位移不变 */
export function compensateScroll(deltas: Array<{ old: number; new: number }>): number {
  return deltas.reduce((acc, d) => acc + (d.new - d.old), 0)
}
```

- [ ] **Step 3: 跑测试**——`pnpm -F @cyrene/desktop test -- tests/unit/virtual-window.spec.ts` 预期 PASS。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/src/renderer/src/utils/message-order.ts apps/desktop/src/renderer/src/utils/virtual-window.ts apps/desktop/tests/unit/virtual-window.spec.ts
git commit -m "feat(G2 virtual-window): cmpMsg 排序 + 前缀和二分窗口/锚点数学纯函数（P0-1 不变量）"
```

---

### Task 4: draftStore（Renderer 草稿+滚动锚点内存态/防抖持久化）

**Files:**
- Create: `apps/desktop/src/renderer/src/stores/draft.store.ts`
- Test: `tests/unit/draft.store.spec.ts`

**Interfaces:**
- Consumes: `api.persistSession`/`api.hydratePersistence`（Task 1 类型）、`PersistSessionInput`/`PersistSessionResult`/`SessionPersistenceState`/`ScrollAnchor`、常量 `DRAFT_MAX_BYTES`/`DRAFT_DEBOUNCE_MS`/`DRAFT_MAX_ENTRIES`
- Produces（Task 11/14/15 消费）: `useDraftStore()` 暴露 `drafts: Record<string,string>`、`scrollAnchors: Record<string, ScrollAnchor>`、`overLimit: Record<string, boolean>`、`hydrated: Ref<boolean>`、`saveDraft(conversationId, text): boolean`（超限拒绝返回 false）、`clear(conversationId): void`（空串持久化=清除）、`setScrollAnchor(conversationId, anchor: ScrollAnchor | null): void`、`hydrate(state: SessionPersistenceState): void`、`flush(conversationId): Promise<PersistSessionResult | undefined>`（取消待写并立即持久化）、`purge(conversationId): void`（删会话联动，内存清 + 取消待写）、`removeConversations(ids: string[]): void`（淘汰项清理 + 一次性通知置位 `evictionNotice: Ref<string[]>`）
- 通知口径（P2-1）：`evictionNotice` 每项文案「草稿已满：最早的非激活会话草稿已按策略清理」由消费组件展示后 `dismissEviction()` 清除。

- [ ] **Step 1: 写失败测试**——`tests/unit/draft.store.spec.ts`（新建）：

```ts
// tests/unit/draft.store.spec.ts —— spec §4.4.1：save/get/超限/防抖持久化/切会话 flush/发送清空/删除清理。
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useDraftStore, DRAFT_MAX_BYTES } from '../../src/renderer/src/stores/draft.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import type { SessionPersistenceState } from '@shared/contracts'

const mockApi = {
  persistSession: vi.fn(), hydratePersistence: vi.fn(),
  cacheMessages: vi.fn(), openExternal: vi.fn(),
  getCredentialStatus: vi.fn(), setBackendToken: vi.fn(), clearBackendToken: vi.fn(),
  setEndpoint: vi.fn(), getEndpoint: vi.fn(), getRuntimeInfo: vi.fn(),
  connect: vi.fn(), disconnect: vi.fn(), listConversations: vi.fn(), getMessages: vi.fn(),
  send: vi.fn(), cancel: vi.fn(), activate: vi.fn(), createConversation: vi.fn(),
  renameConversation: vi.fn(), deleteConversation: vi.fn(), getConnectionState: vi.fn(),
  onChatEvent: vi.fn(() => () => {}), onChatState: vi.fn(() => () => {}), onChatReplay: vi.fn(() => () => {}), onChatError: vi.fn(() => () => {})
}

describe('draftStore（spec §4.4.1）', () => {
  beforeEach(() => { setActivePinia(createPinia()); setDesktopApi(mockApi); vi.useFakeTimers(); mockApi.persistSession.mockReset(); mockApi.persistSession.mockResolvedValue({}) })
  afterEach(() => { vi.useRealTimers() })

  it('saveDraft 写入内存 + 800ms 防抖后 persistSession（携带草稿+锚点）', async () => {
    const s = useDraftStore()
    s.setScrollAnchor('c1', { messageId: 'm1', offset: 5 })
    expect(s.saveDraft('c1', '你好')).toBe(true)
    expect(s.drafts['c1']).toBe('你好')
    expect(mockApi.persistSession).not.toHaveBeenCalled()
    vi.advanceTimersByTime(800)
    expect(mockApi.persistSession).toHaveBeenCalledTimes(1)
    expect(mockApi.persistSession).toHaveBeenCalledWith({
      conversationId: 'c1', draft: { text: '你好', updatedAt: expect.any(String) }, scrollAnchor: { messageId: 'm1', offset: 5 }
    })
  })

  it('超限（UTF-8 字节 >100KB）拒绝写入 + overLimit 置位，不静默截断', () => {
    const s = useDraftStore()
    const big = '汉'.repeat(Math.ceil(DRAFT_MAX_BYTES / 3)) // 100KB 字节 → 码点 <100k，按字节算超限
    expect(s.saveDraft('c1', big)).toBe(false)
    expect(s.drafts['c1']).toBeUndefined()
    expect(s.overLimit['c1']).toBe(true)
  })

  it('flush 立即持久化并取消待写防抖（切会话/发送路径）', async () => {
    const s = useDraftStore()
    s.saveDraft('c1', 'x')
    vi.advanceTimersByTime(300)
    await s.flush('c1')
    expect(mockApi.persistSession).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2000)
    expect(mockApi.persistSession).toHaveBeenCalledTimes(1) // 防抖已取消
  })

  it('clear 持久化空串（发送成功清空）；hydrate 水合草稿+锚点', async () => {
    const s = useDraftStore()
    s.saveDraft('c1', 'typing')
    s.clear('c1')
    expect(s.drafts['c1']).toBeUndefined()
    await s.flush('c1')
    expect(mockApi.persistSession).toHaveBeenLastCalledWith({
      conversationId: 'c1', draft: { text: '', updatedAt: expect.any(String) }, scrollAnchor: null
    })
    const state: SessionPersistenceState = {
      drafts: [{ conversationId: 'c9', text: '旧草稿', attachmentLocalIds: [], updatedAt: 't' }],
      scrollAnchors: { c9: { messageId: 'm9', offset: 3 } }, conversations: [], messageSnapshots: {}
    }
    s.hydrate(state)
    expect(s.drafts['c9']).toBe('旧草稿')
    expect(s.scrollAnchors['c9']).toEqual({ messageId: 'm9', offset: 3 })
  })

  it('removeConversations 清被淘汰项 + evictionNotice 置位（P2-1 不静默）', () => {
    const s = useDraftStore()
    s.saveDraft('old', 'x'); s.saveDraft('new', 'y')
    s.removeConversations(['old'])
    expect(s.drafts['old']).toBeUndefined()
    expect(s.evictionNotice).toContain('old')
  })

  it('purge 删会话联动：清内存草稿/锚点 + 取消待写', () => {
    const s = useDraftStore()
    s.saveDraft('c1', 'x'); s.setScrollAnchor('c1', { messageId: 'm1', offset: 0 })
    s.purge('c1')
    expect(s.drafts['c1']).toBeUndefined()
    expect(s.scrollAnchors['c1']).toBeUndefined()
  })
})
```

  预期 FAIL：`draft.store` 不存在。

- [ ] **Step 2: 实现**——`apps/desktop/src/renderer/src/stores/draft.store.ts`（新建）：

```ts
// 草稿+滚动锚点内存态（spec §4.1/§4.4.1 D1/D4）：Renderer 只持内存态，防抖/切会话经 persistSession 持久化归 Main。
// 超限（D4）两层口径：①单草稿 100KB UTF-8 字节 → 拒绝+横幅；②50 会话上限 → Main 淘汰 + evictedConversationIds 通知。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { PersistSessionResult, ScrollAnchor, SessionPersistenceState } from '@shared/contracts'
import { api } from './desktop-api'

export const DRAFT_MAX_BYTES = 100 * 1024
export const DRAFT_DEBOUNCE_MS = 800
export const DRAFT_MAX_ENTRIES = 50

function nowIso(): string { return new Date().toISOString() }
function byteLength(s: string): number { return new TextEncoder().encode(s).byteLength }

export const useDraftStore = defineStore('draft', () => {
  const drafts = ref<Record<string, string>>({})
  const scrollAnchors = ref<Record<string, ScrollAnchor>>({})
  const overLimit = ref<Record<string, boolean>>({})
  const hydrated = ref(false)
  const evictionNotice = ref<string[]>([])
  /** convId → pending timer：防抖窗口内再次保存重置；flush/purge 取消 */
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  function schedulePersist(conversationId: string): void {
    const prev = timers.get(conversationId)
    if (prev !== undefined) clearTimeout(prev)
    timers.set(conversationId, setTimeout(() => { timers.delete(conversationId); void persistNow(conversationId) }, DRAFT_DEBOUNCE_MS))
  }

  async function persistNow(conversationId: string): Promise<PersistSessionResult | undefined> {
    timers.delete(conversationId)
    try {
      const res = await api.persistSession({
        conversationId,
        draft: { text: drafts.value[conversationId] ?? '', updatedAt: nowIso() },
        scrollAnchor: scrollAnchors.value[conversationId] ?? null
      })
      if (res?.evictedConversationIds?.length) {
        evictionNotice.value = res.evictedConversationIds
      }
      return res
    } catch {
      return undefined // fail-open（C1 同款）：持久化失败保内存态，下次触发重试
    }
  }

  function saveDraft(conversationId: string, text: string): boolean {
    if (byteLength(text) > DRAFT_MAX_BYTES) {
      overLimit.value[conversationId] = true
      return false // 拒绝写入、不静默截断；横幅「草稿已满」+ 清空按钮
    }
    drafts.value[conversationId] = text
    overLimit.value[conversationId] = false
    schedulePersist(conversationId)
    return true
  }

  function clear(conversationId: string): void {
    delete drafts.value[conversationId]
    overLimit.value[conversationId] = false
    schedulePersist(conversationId) // persistNow 读 drafts[id] ?? '' → 空串=清除（Main 保留条目但 text 为空）
  }

  function setScrollAnchor(conversationId: string, anchor: ScrollAnchor | null): void {
    if (anchor === null) delete scrollAnchors.value[conversationId]
    else scrollAnchors.value[conversationId] = anchor
  }

  function hydrate(state: SessionPersistenceState): void {
    const next: Record<string, string> = {}
    for (const d of state.drafts) next[d.conversationId] = d.text
    drafts.value = next
    scrollAnchors.value = { ...state.scrollAnchors }
    hydrated.value = true
  }

  async function flush(conversationId: string): Promise<PersistSessionResult | undefined> {
    const prev = timers.get(conversationId)
    if (prev !== undefined) { clearTimeout(prev); timers.delete(conversationId) }
    return persistNow(conversationId)
  }

  function purge(conversationId: string): void {
    const prev = timers.get(conversationId)
    if (prev !== undefined) { clearTimeout(prev); timers.delete(conversationId) }
    delete drafts.value[conversationId]
    delete scrollAnchors.value[conversationId]
    delete overLimit.value[conversationId]
  }

  /** 淘汰项清理（P2-1）：被 Main 淘汰的会话草稿/锚点一并从内存清，并置一次性通知 */
  function removeConversations(ids: string[]): void {
    for (const id of ids) {
      const prev = timers.get(id)
      if (prev !== undefined) { clearTimeout(prev); timers.delete(id) }
      delete drafts.value[id]
      delete scrollAnchors.value[id]
      delete overLimit.value[id]
    }
    if (ids.length) evictionNotice.value = [...evictionNotice.value, ...ids]
  }

  function dismissEviction(): void { evictionNotice.value = [] }

  return {
    drafts, scrollAnchors, overLimit, hydrated, evictionNotice,
    saveDraft, clear, setScrollAnchor, hydrate, flush, purge, removeConversations, dismissEviction
  }
})
```

- [ ] **Step 3: 跑测试**——`pnpm -F @cyrene/desktop test -- tests/unit/draft.store.spec.ts` 预期 PASS（超限用例注意：`'汉'.repeat(Math.ceil(100*1024/3))` 的 UTF-8 字节 ≈ 3 字节/汉 → ≈100KB+，而码点 ≈34953 < 100000，zod 层放行、store 层按字节拒——正是 Main 权威 + Renderer 即时守卫双保险的写照）。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/src/renderer/src/stores/draft.store.ts apps/desktop/tests/unit/draft.store.spec.ts
git commit -m "feat(G2 draft-store): 草稿+滚动锚点内存态/防抖持久化/超限守卫/淘汰通知"
```

---

### Task 5: cacheStore（Renderer 离线水合 + 消息快照分片推送）

**Files:**
- Create: `apps/desktop/src/renderer/src/stores/cache.store.ts`
- Test: `tests/unit/cache.store.spec.ts`

**Interfaces:**
- Consumes: `api.cacheMessages`/`api.hydratePersistence`、`CacheMessagesInput`/`SessionPersistenceState`、`MAX_IPC_MESSAGE_BYTES`
- Produces（Task 6/7/11 消费）: `useCacheStore()` 暴露 `conversations: Ref<Conversation[]>`、`snapshots: Ref<Record<string, Message[]>>`、`lastActiveConversationId: Ref<string | undefined>`、`hydrated: Ref<boolean>`、`hydrate(state): void`、`pushMessages(conversationId: string, messages: Message[], updatedAt: string): Promise<void>`（分片推送）、`snapshotMessages(conversationId): Message[] | undefined`、`syncConversations(list: Conversation[]): void`、`purge(conversationId): void`；模块级纯函数 `chunkMessages(messages: Message[], maxBytes: number): Message[][]`（≤200 条/批 + 字节预算；单条超限跳过）

- [ ] **Step 1: 写失败测试**——`tests/unit/cache.store.spec.ts`（新建）：

```ts
// tests/unit/cache.store.spec.ts —— spec §4.1/§4.5：离线水合、分片推送、快照查询、列表同步。
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCacheStore, chunkMessages } from '../../src/renderer/src/stores/cache.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { MAX_IPC_MESSAGE_BYTES } from '@shared/contracts'
import type { Message, SessionPersistenceState } from '@shared/contracts'

const mockApi = {
  cacheMessages: vi.fn(), persistSession: vi.fn(), hydratePersistence: vi.fn(), openExternal: vi.fn(),
  getCredentialStatus: vi.fn(), setBackendToken: vi.fn(), clearBackendToken: vi.fn(),
  setEndpoint: vi.fn(), getEndpoint: vi.fn(), getRuntimeInfo: vi.fn(),
  connect: vi.fn(), disconnect: vi.fn(), listConversations: vi.fn(), getMessages: vi.fn(),
  send: vi.fn(), cancel: vi.fn(), activate: vi.fn(), createConversation: vi.fn(),
  renameConversation: vi.fn(), deleteConversation: vi.fn(), getConnectionState: vi.fn(),
  onChatEvent: vi.fn(() => () => {}), onChatState: vi.fn(() => () => {}), onChatReplay: vi.fn(() => () => {}), onChatError: vi.fn(() => () => {})
}

function m(id: string, t: string): Message {
  return { messageId: id, conversationId: 'c1', role: 'user', content: 'x', status: 'completed', createdAt: t }
}

describe('cacheStore（spec §4.5）', () => {
  beforeEach(() => { setActivePinia(createPinia()); setDesktopApi(mockApi); mockApi.cacheMessages.mockResolvedValue(undefined) })

  it('hydrate 载入会话列表/快照/上次活动会话', () => {
    const s = useCacheStore()
    const state: SessionPersistenceState = {
      drafts: [], scrollAnchors: {}, lastActiveConversationId: 'c1',
      conversations: [{ id: 'c1', title: 'A', updatedAt: 't' }],
      messageSnapshots: { c1: [m('m1', 't')] }
    }
    s.hydrate(state)
    expect(s.conversations.map((c) => c.id)).toEqual(['c1'])
    expect(s.lastActiveConversationId).toBe('c1')
    expect(s.snapshotMessages('c1')?.[0]?.messageId).toBe('m1')
    expect(s.snapshotMessages('nope')).toBeUndefined()
  })

  it('pushMessages 调 cacheMessages（≤200 条单批）', async () => {
    const s = useCacheStore()
    await s.pushMessages('c1', [m('m1', 't')], 'now')
    expect(mockApi.cacheMessages).toHaveBeenCalledWith({ conversationId: 'c1', messages: [m('m1', 't')], updatedAt: 'now' })
  })

  it('syncConversations 更新内存会话列表（在线 list 后供离线切换判定）', () => {
    const s = useCacheStore()
    s.syncConversations([{ id: 'c9', title: '新', updatedAt: 't' }])
    expect(s.conversations.map((c) => c.id)).toEqual(['c9'])
  })

  it('purge 删会话联动清快照', () => {
    const s = useCacheStore()
    s.hydrate({ drafts: [], scrollAnchors: {}, conversations: [{ id: 'c1', title: 'A', updatedAt: 't' }], messageSnapshots: { c1: [m('m1', 't')] } })
    s.purge('c1')
    expect(s.snapshotMessages('c1')).toBeUndefined()
  })
})

describe('chunkMessages（P1-2 分片：≤200 条/批 + 字节预算；单条超限跳过）', () => {
  it('≤200 条且 ≤预算 → 单批', () => {
    const msgs = Array.from({ length: 5 }, (_, i) => m(`m${i}`, `t${i}`))
    expect(chunkMessages(msgs, MAX_IPC_MESSAGE_BYTES)).toHaveLength(1)
  })
  it('>200 条 → 按 200 分片', () => {
    const msgs = Array.from({ length: 450 }, (_, i) => m(`m${i}`, `t${i}`))
    const chunks = chunkMessages(msgs, MAX_IPC_MESSAGE_BYTES)
    expect(chunks.length).toBe(3)
    expect(chunks[0]).toHaveLength(200)
    expect(chunks[1]).toHaveLength(200)
    expect(chunks[2]).toHaveLength(50)
  })
  it('超预算 → 按字节继续分片；单条超限整条跳过', () => {
    const hugeText = 'x'.repeat(1024 * 1024) // 1MiB 单条 → msgBytes≈1MiB+200
    const big: Message = { ...m('big', 't'), content: hugeText }
    const small: Message = m('s', 't') // msgBytes = 200 + 1 = 201
    const chunks = chunkMessages([big, small], 300) // big 超 300 跳过；small 201 < 300 入批
    expect(chunks).toHaveLength(1)
    expect(chunks[0].map((x) => x.messageId)).toEqual(['s'])
  })
})
```

  预期 FAIL：`cache.store` 不存在。

- [ ] **Step 2: 实现**——`apps/desktop/src/renderer/src/stores/cache.store.ts`（新建）：

```ts
// 离线缓存内存态（spec §4.1/§4.5 D2）：启动水合离线视图 + 已确认消息快照分片推送。
// Main 是持久化边界：会话列表缓存由 Main 在 listConversations 服务时派生，消息快照由本 store 推送。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { MAX_IPC_MESSAGE_BYTES, type Conversation, type Message, type SessionPersistenceState } from '@shared/contracts'
import { api } from './desktop-api'

export const CACHE_PUSH_CHUNK = 200

function estBytes(s: string): number { return new TextEncoder().encode(s).byteLength }
function msgBytes(m: Message): number {
  let n = 200 // 元数据近似
  n += estBytes(m.content ?? '')
  for (const seg of m.assistantSegments ?? []) n += estBytes(seg.text ?? '')
  return n
}

/** 分片（P1-2）：先按条数 ≤200，再按字节预算拆；单条超限整条跳过（Main 侧另有整批拒绝兜底 IPC_MESSAGE_TOO_LARGE） */
export function chunkMessages(messages: Message[], maxBytes: number): Message[][] {
  const chunks: Message[][] = []
  let cur: Message[] = []
  let curBytes = 0
  for (const m of messages) {
    const b = msgBytes(m)
    if (b > maxBytes) continue // 罕见超大消息：跳过 + 计数由调用侧告警
    if (cur.length >= CACHE_PUSH_CHUNK || curBytes + b > maxBytes) {
      if (cur.length) { chunks.push(cur); cur = []; curBytes = 0 }
    }
    cur.push(m)
    curBytes += b
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

export const useCacheStore = defineStore('cache', () => {
  const conversations = ref<Conversation[]>([])
  const snapshots = ref<Record<string, Message[]>>({})
  const lastActiveConversationId = ref<string>()
  const hydrated = ref(false)

  function hydrate(state: SessionPersistenceState): void {
    conversations.value = [...state.conversations]
    snapshots.value = { ...state.messageSnapshots }
    lastActiveConversationId.value = state.lastActiveConversationId
    hydrated.value = true
  }

  /** 已确认消息增量推送（loadPage / generation.completed / send ack 后调用）；best-effort fail-open */
  async function pushMessages(conversationId: string, messages: Message[], updatedAt: string): Promise<void> {
    const chunks = chunkMessages(messages, MAX_IPC_MESSAGE_BYTES)
    for (const chunk of chunks) {
      try { await api.cacheMessages({ conversationId, messages: chunk, updatedAt }) } catch { /* 缓存缺落由后端调和兜底 */ }
    }
  }

  function snapshotMessages(conversationId: string): Message[] | undefined {
    return snapshots.value[conversationId]
  }

  /** 在线 list 成功后同步内存会话列表（供离线切换 activateLocal 判定；持久化列表由 Main 派生） */
  function syncConversations(list: Conversation[]): void {
    conversations.value = [...list]
  }

  function purge(conversationId: string): void {
    delete snapshots.value[conversationId]
  }

  return { conversations, snapshots, lastActiveConversationId, hydrated, hydrate, pushMessages, snapshotMessages, syncConversations, purge }
})
```

- [ ] **Step 3: 跑测试**——`pnpm -F @cyrene/desktop test -- tests/unit/cache.store.spec.ts` 预期 PASS。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/src/renderer/src/stores/cache.store.ts apps/desktop/tests/unit/cache.store.spec.ts
git commit -m "feat(G2 cache-store): 离线水合内存态 + 消息快照分片推送 + 列表同步"
```

---

### Task 6: messageStore 有序插入 + loadOlder + loadSnapshot + 快照推送钩子（P0-1）

**Files:**
- Modify: `apps/desktop/src/renderer/src/stores/message.store.ts`
- Modify: `tests/unit/message.store.spec.ts`

**Interfaces:**
- Consumes: `cmpMsg`（Task 3）、`useCacheStore().pushMessages`（Task 5）、`api.getMessages`
- Produces（Task 7/14 消费）: `hasMoreBefore: Ref<boolean>`、`beforeCursor: Ref<string | undefined>`、`loadingOlder: Ref<boolean>`；`setPageMeta(page: MessagePage): void`（首页 nextCursor 初始化）；`loadOlder(): Promise<void>`（防重入 + 保留游标失败重试）；`loadSnapshot(conversationId: string, messages: Message[]): void`（排序载入 + hasMoreBefore=false）；`resetConversation` 同步清 `hasMoreBefore/beforeCursor/loadingOlder`；`upsertMessage` 改为二分有序插入；`loadPage` 合并前防御性排序

- [ ] **Step 1: 写失败测试**——`tests/unit/message.store.spec.ts` 末尾追加 describe（复用既有 `mockApi`/`setCurrent`/`started()` 模式；`mockApi` 已含 Task 1 的 +4 方法）：

```ts
describe('G2 历史懒加载：有序插入 / loadOlder / loadSnapshot（spec §4.3.3 P0-1）', () => {
  function pageMsg(id: string, createdAt: string, role: 'user' | 'assistant' = 'user'): Message {
    return { messageId: id, conversationId: 'conv-1', role, status: 'completed', createdAt, ...(role === 'user' ? { content: id } : { assistantSegments: [] }) }
  }

  it('upsertMessage 有序插入：before 页（更旧）前插，order 恒 (createdAt, messageId) 升序', () => {
    const store = useMessageStore()
    store.loadPage({ items: [pageMsg('m3', 't3'), pageMsg('m1', 't1')], hasMore: true, nextCursor: 'c1' }) // 防御性排序
    expect(store.order).toEqual(['m1', 'm3'])
    store.loadPage({ items: [pageMsg('m2', 't2'), pageMsg('m0', 't0')], hasMore: false, nextCursor: undefined }) // 更早页前插
    expect(store.order).toEqual(['m0', 'm1', 'm2', 'm3'])
    expect(store.byId['m1']?.content).toBe('m1')
  })

  it('重复 messageId 原位替换不重插（loadPage 二次去重）', () => {
    const store = useMessageStore()
    store.loadPage({ items: [pageMsg('m1', 't1'), pageMsg('m2', 't2')], hasMore: false, nextCursor: undefined })
    store.loadPage({ items: [{ ...pageMsg('m2', 't2'), content: 'updated' }], hasMore: false, nextCursor: undefined })
    expect(store.order).toEqual(['m1', 'm2'])
    expect(store.byId['m2']?.content).toBe('updated')
  })

  it('非时间序页免疫：乱序 items 合并后仍升序', () => {
    const store = useMessageStore()
    store.loadPage({ items: [pageMsg('b', 't2'), pageMsg('a', 't1'), pageMsg('c', 't3')], hasMore: false, nextCursor: undefined })
    expect(store.order).toEqual(['a', 'b', 'c'])
  })

  it('setPageMeta 首页 nextCursor → hasMoreBefore/beforeCursor（激活首屏后初始化）', () => {
    const store = useMessageStore()
    store.setPageMeta({ items: [pageMsg('m1', 't1')], hasMore: true, nextCursor: 'cur-x' })
    expect(store.hasMoreBefore).toBe(true)
    expect(store.beforeCursor).toBe('cur-x')
  })

  it('loadOlder 携带 before 游标拉更早页并入 + 推进游标；防重入', async () => {
    const store = useMessageStore()
    // 首页 items 必须经 loadPage 插入（order 由 loadPage/loadSnapshot 维护）；setPageMeta 只初始化游标、不载入 items（评审 P0-1）
    store.loadPage({ items: [pageMsg('m2', 't2'), pageMsg('m3', 't3')], hasMore: true, nextCursor: 'cur-1' })
    store.setPageMeta({ items: [pageMsg('m2', 't2'), pageMsg('m3', 't3')], hasMore: true, nextCursor: 'cur-1' })
    expect(store.order).toEqual(['m2', 'm3']) // setPageMeta 不改 order
    mockApi.getMessages.mockResolvedValue({ items: [pageMsg('m1', 't1')], hasMore: false, nextCursor: undefined })
    await store.loadOlder()
    expect(mockApi.getMessages).toHaveBeenCalledWith({ conversationId: 'conv-1', before: 'cur-1' })
    expect(store.order).toEqual(['m1', 'm2', 'm3']) // 新页 items 有序前插
    expect(store.hasMoreBefore).toBe(false)
    expect(store.beforeCursor).toBeUndefined()
    expect(store.loadingOlder).toBe(false)
  })

  it('loadOlder 失败保留游标 + lastError 公开（可重试），不改已渲染消息', async () => {
    const store = useMessageStore()
    store.loadPage({ items: [pageMsg('m2', 't2')], hasMore: true, nextCursor: 'cur-1' }) // 先载入已渲染消息（评审 P0-1）
    store.setPageMeta({ items: [pageMsg('m2', 't2')], hasMore: true, nextCursor: 'cur-1' })
    mockApi.getMessages.mockRejectedValue(new Error('网络错误'))
    await store.loadOlder()
    expect(store.beforeCursor).toBe('cur-1')
    expect(store.hasMoreBefore).toBe(true)
    expect(store.lastError?.message).toContain('网络错误')
    expect(store.order).toEqual(['m2']) // 失败不改已渲染 order
  })

  it('loadSnapshot 排序载入 + hasMoreBefore=false（离线水合/离线切换，P1-1）', () => {
    const store = useMessageStore()
    store.loadSnapshot('conv-1', [pageMsg('m2', 't2'), pageMsg('m0', 't0')]) // 非时间序快照
    expect(store.order).toEqual(['m0', 'm2'])
    expect(store.hasMoreBefore).toBe(false)
    expect(store.beforeCursor).toBeUndefined()
  })

  it('resetConversation 清 pagination 状态', () => {
    const store = useMessageStore()
    store.setPageMeta({ items: [pageMsg('m1', 't1')], hasMore: true, nextCursor: 'c' })
    store.resetConversation('conv-1')
    expect(store.hasMoreBefore).toBe(false)
    expect(store.beforeCursor).toBeUndefined()
    expect(store.loadingOlder).toBe(false)
  })
})
```

  预期 FAIL：`setPageMeta`/`loadOlder`/`loadSnapshot`/`hasMoreBefore` 不存在；`loadPage` 乱序测试因 append 语义 fail。

- [ ] **Step 2: 实现**——`message.store.ts` 修改（插 `cmpMsg` import + 状态 + 有序插入 + 三个新方法 + resetConversation 扩展 + 快照推送钩子）：

  顶部 import 追加：
```ts
import { cmpMsg } from '../utils/message-order'
import { useCacheStore } from './cache.store'
```

  状态声明（`lastError` 之后追加）：
```ts
  /** G2：向上加载更早历史（before 游标，docs/02 §19 倒序 keyset） */
  const hasMoreBefore = ref(false)
  const beforeCursor = ref<string>()
  const loadingOlder = ref(false)
```

  `upsertMessage` 改为有序插入：
```ts
  /** 按 messageId 去重 + (createdAt, messageId) 升序二分有序插入（P0-1）：新 key 插到第一个「不早于自己」的 key 之前（同序插其后，稳定）；已存在原位替换 */
  function upsertMessage(msg: Message): void {
    if (byId.value[msg.messageId] !== undefined) { byId.value[msg.messageId] = msg; return }
    let lo = 0
    let hi = order.value.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (cmpMsg(byId.value[order.value[mid]], msg) <= 0) lo = mid + 1
      else hi = mid
    }
    order.value.splice(lo, 0, msg.messageId)
    byId.value[msg.messageId] = msg
  }
```

  `loadPage` 防御性排序 + 快照推送钩子：
```ts
  function loadPage(page: MessagePage): void {
    const items = [...page.items].sort(cmpMsg) // 后端 before 页已归一化升序，再排一次免疫非时间序页（P0-1）
    for (const m of items) upsertMessage(m)
    const conversationId = useConversationStore().currentId
    if (conversationId && items.length) void useCacheStore().pushMessages(conversationId, items, nowIso()) // best-effort，非离线快照路径
  }
```

  `resetConversation` 扩展（清 pagination 状态）：
```ts
  function resetConversation(_conversationId: string): void {
    byId.value = {}
    order.value = []
    activeGenerationId.value = undefined
    generationByConversation.value = {}
    hasMoreBefore.value = false
    beforeCursor.value = undefined
    loadingOlder.value = false
  }
```

  `setPageMeta` / `loadOlder` / `loadSnapshot`（`loadPage` 之后追加）：
```ts
  /** 激活首屏后初始化向上分页：首页 nextCursor 即「更早一页」的 before 游标（toMessagePage has_more 语义） */
  function setPageMeta(page: MessagePage): void {
    hasMoreBefore.value = page.hasMore && !!page.nextCursor
    beforeCursor.value = page.nextCursor
  }

  /** 向上加载更早消息（CyMessageList 顶部哨兵触发）：防重入、失败保留游标可重试 */
  async function loadOlder(): Promise<void> {
    const conversationId = useConversationStore().currentId
    if (!conversationId || loadingOlder.value || !hasMoreBefore.value || !beforeCursor.value) return
    loadingOlder.value = true
    try {
      const page = await api.getMessages({ conversationId, before: beforeCursor.value })
      loadPage(page)
      hasMoreBefore.value = page.hasMore
      beforeCursor.value = page.nextCursor ?? undefined
    } catch (e) {
      lastError.value = parsePublicError(messageOf(e)) // 保留游标，可重试
    } finally {
      loadingOlder.value = false
    }
  }

  /** 离线水合/离线切换载入快照（P0-1/P1-1）：排序载入 + 离线不可加载更早 */
  function loadSnapshot(conversationId: string, messages: Message[]): void {
    resetConversation(conversationId)
    for (const m of [...messages].sort(cmpMsg)) upsertMessage({ ...m, conversationId })
    hasMoreBefore.value = false
    beforeCursor.value = undefined
    loadingOlder.value = false
  }
```

  `generation.completed` 分支（`finalizeAssistant` 后）加快照推送；`send` 成功后（`optimistic.status = 'acknowledged'` 处）加推送：
```ts
      case 'generation.completed': {
        // ... 既有守卫
        finalizeAssistant(acc.getState().messageId, acc)
        const finalMsg = byId.value[acc.getState().messageId]
        if (finalMsg) void useCacheStore().pushMessages(useConversationStore().currentId ?? finalMsg.conversationId, [finalMsg], nowIso())
        activeGenerationId.value = undefined
        break
      }
```
  `send` 成功返回后调用方清草稿（评审 P2-2，spec §4.4.1）：签名改为 `async function send(text: string): Promise<boolean>`（true=已受理成功、false=失败保留草稿；既有调用方忽略返回值不破坏）；错误分支 `return false`：
```ts
      if (ref?.serverMessageId) migrateKey(key, ref.serverMessageId, optimistic)
      optimistic.status = 'acknowledged' // 无 serverMessageId 也 acknowledged(P2-1)
      void useCacheStore().pushMessages(conversationId, [optimistic], nowIso()) // send ack 已确认消息快照
      return true // P2-2：成功返回 true，调用方据此清草稿
    } catch (e) {
      optimistic.status = 'failed'
      lastError.value = parsePublicError(messageOf(e))
      return false // P2-2：失败返回 false，调用方保留草稿
    } finally {
      sending.value = false
    }
  }
```

  返回对象追加导出：`hasMoreBefore, beforeCursor, loadingOlder, setPageMeta, loadOlder, loadSnapshot`。

- [ ] **Step 3: 跑测试**——`pnpm -F @cyrene/desktop test -- tests/unit/message.store.spec.ts` 预期 PASS（既有用例不回归：流式/乐观发送 createdAt≈nowIso() 排序后仍落末尾；loadReplay 迟到历史落正确时序）。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/src/renderer/src/stores/message.store.ts apps/desktop/tests/unit/message.store.spec.ts
git commit -m "feat(G2 message-store): upsertMessage 有序二分插入 + loadOlder/loadSnapshot + 快照推送钩子"
```

---

### Task 7: conversationStore 离线视图 + activateLocal + 在线恢复 + 首页分页初始化

**Files:**
- Modify: `apps/desktop/src/renderer/src/stores/conversation.store.ts`
- Modify: `tests/unit/conversation.store.spec.ts`

**Interfaces:**
- Consumes: `messageStore.setPageMeta/loadSnapshot/resetConversation`、`cacheStore.snapshotMessages/syncConversations`、`connectionStore.state.status`
- Produces（Task 11/15 消费）: `offlineView: Ref<boolean>`；`setOfflineCache(conversations: Conversation[]): void`（离线水合装载 + offlineView=true）；`activateLocal(id: string): Promise<void>`（仅 disconnected：校验 id ∈ cacheStore.conversations → currentId 本地切换 + loadSnapshot + hasMoreBefore=false；无快照 → 空态 + 提示；离线视图下在线 activate 拒绝）；`activate` 增加：首页后 `messageStore.setPageMeta(p)`、离线视图在线拒绝；`initializeConnected` 离线恢复：`offlineView` 为真时对 `currentId` 走真实 `activate(id)` 覆盖快照视图 + `offlineView=false`；`list()` 成功同步 `cacheStore.syncConversations`；`remove()` 成功后 `draftStore.purge(id)` + `cacheStore.purge(id)`

- [ ] **Step 1: 写失败测试**——`tests/unit/conversation.store.spec.ts` 追加（复用既有 `mockApi`/`convA`/`convB`；`mockApi` 已含 Task 1 +4 方法；`useCacheStore`/`useDraftStore` 走同一 pinia）：

```ts
import { useCacheStore } from '../../src/renderer/src/stores/cache.store'
import { useDraftStore } from '../../src/renderer/src/stores/draft.store'

describe('G2 离线视图 / activateLocal / 在线恢复（spec §4.5.3 P1-1）', () => {
  it('activate 首屏后 setPageMeta 初始化 hasMoreBefore（有 nextCursor 才可向上加载）', async () => {
    mockApi.activate.mockResolvedValue({ conversationId: 'conv-1' })
    mockApi.getMessages.mockResolvedValue({ items: [], hasMore: true, nextCursor: 'cur-1' })
    const conv = useConversationStore()
    await conv.activate('conv-1')
    expect(useMessageStore().hasMoreBefore).toBe(true)
    expect(useMessageStore().beforeCursor).toBe('cur-1')
  })

  it('setOfflineCache 装载缓存列表 + offlineView=true', () => {
    const conv = useConversationStore()
    conv.setOfflineCache([convA, convB])
    expect(conv.items).toHaveLength(2)
    expect(conv.offlineView).toBe(true)
  })

  it('activateLocal（disconnected + 缓存会话）载入快照、不调 api.activate/getMessages、hasMoreBefore=false', async () => {
    useConnectionStore().state.status = 'disconnected'
    const cache = useCacheStore()
    cache.syncConversations([convA])
    cache.hydrate({ drafts: [], scrollAnchors: {}, conversations: [convA], messageSnapshots: { [convA.id]: [{ messageId: 'm1', conversationId: convA.id, role: 'user', content: 'hi', status: 'completed', createdAt: 't' }] } })
    mockApi.activate.mockClear(); mockApi.getMessages.mockClear()
    const conv = useConversationStore()
    await conv.activateLocal(convA.id)
    expect(conv.currentId).toBe(convA.id)
    expect(conv.offlineView).toBe(true)
    expect(mockApi.activate).not.toHaveBeenCalled()
    expect(mockApi.getMessages).not.toHaveBeenCalled()
    expect(useMessageStore().order).toEqual(['m1'])
    expect(useMessageStore().hasMoreBefore).toBe(false)
  })

  it('activateLocal 非缓存会话 → 拒绝 + 提示', async () => {
    useConnectionStore().state.status = 'disconnected'
    const conv = useConversationStore()
    await conv.activateLocal('not-cached')
    expect(conv.error?.code).toBe('OFFLINE_NOT_CACHED')
    expect(conv.currentId).toBeUndefined()
  })

  it('离线视图下 activate 拒绝；在线恢复 activate 正常并清 offlineView', async () => {
    useConnectionStore().state.status = 'disconnected'
    const conv = useConversationStore()
    conv.setOfflineCache([convA])
    await conv.activate('conv-1')
    expect(conv.error?.code).toBe('OFFLINE_VIEW')
    useConnectionStore().state.status = 'connected'
    mockApi.activate.mockResolvedValue({ conversationId: 'conv-1' })
    mockApi.getMessages.mockResolvedValue({ items: [], hasMore: false, nextCursor: undefined })
    await conv.activate('conv-1')
    expect(conv.offlineView).toBe(false)
    expect(conv.error).toBeUndefined()
  })
})
```

  预期 FAIL：`offlineView`/`activateLocal`/`setOfflineCache` 不存在；`activate` 未调用 `setPageMeta`。

- [ ] **Step 2: 实现**——`conversation.store.ts` 修改：

  import 追加：
```ts
import { useCacheStore } from './cache.store'
import { useDraftStore } from './draft.store'
```

  状态追加：
```ts
  const offlineView = ref(false) // 离线视图：activateLocal/setOfflineCache 置位，恢复后 false
```

  `list()` 成功后同步 cacheStore（在 `items.value = p.items` 之后）：
```ts
      items.value = p.items
      useCacheStore().syncConversations(p.items) // 在线列表 → 内存缓存（供离线切换判定；持久化列表由 Main 派生）
```

  `initializeConnected` 离线恢复分支（插入到 `if (currentId.value)` 分支开头，safeList 之后——离线时 currentId 已由水合设置，走「已有活动会话」分支；P1-1 要求恢复时真实 activate 覆盖快照视图）：
```ts
      if (currentId.value) {
        if (!await safeList()) return
        if (offlineView.value) {
          // P1-1 在线恢复：离线快照视图 → 真实 activate 拉后端首屏覆盖 + 清 offlineView
          offlineView.value = false
          initializedFor.value = key
          ready.value = true // P2-3：恢复即就绪（快照已可视；activate 异步拉首屏覆盖，不阻塞就绪门控）
          void activate(currentId.value)
          return
        }
        const activeId = useConnectionStore().state.activeConversationId
        if (activeId && activeId !== currentId.value) await activate(activeId)   // I4:后端活动会话变了 → 切过去
        initializedFor.value = key
        ready.value = true
        return
      }
```

  `activate` 开头离线拒绝 + 清 offlineView + 首页 setPageMeta：
```ts
  async function activate(id: string): Promise<void> {
    if (offlineView.value && useConnectionStore().state.status === 'disconnected') {
      error.value = { code: 'OFFLINE_VIEW', message: '离线视图下请使用本地缓存会话' }
      return
    }
    offlineView.value = false
    const myEpoch = ++epoch
    busy.value = true
    currentId.value = id
    const messageStore = useMessageStore()
    messageStore.resetConversation(id)
    messageStore.applyPendingReplay(id)
    try {
      await api.activate(id)
      if (myEpoch !== epoch) return
      const p = await api.getMessages({ conversationId: id })
      if (myEpoch !== epoch) return
      messageStore.loadPage(p)
      messageStore.setPageMeta(p) // 首页 nextCursor → 更早一页游标（G2）
      error.value = undefined
    } catch (e) {
      if (myEpoch !== epoch) return
      error.value = parsePublicError(messageOf(e))
    } finally {
      if (myEpoch === epoch) busy.value = false
    }
  }
```

  新方法 `setOfflineCache` / `activateLocal`（`remove` 之后追加）：
```ts
  /** 离线水合装载缓存会话列表（bootstrap disconnected 分支）；offlineView 置位 */
  function setOfflineCache(conversations: Conversation[]): void {
    items.value = [...conversations]
    offlineView.value = true
    error.value = undefined
  }

  /** 离线会话切换（P1-1）：绕过 api.activate/getMessages，从 cacheStore 换入 messageStore */
  async function activateLocal(id: string): Promise<void> {
    if (useConnectionStore().state.status !== 'disconnected') return
    const cache = useCacheStore()
    if (!cache.conversations.some((c) => c.id === id)) {
      error.value = { code: 'OFFLINE_NOT_CACHED', message: '该会话离线不可读' }
      return
    }
    currentId.value = id
    offlineView.value = true
    const messageStore = useMessageStore()
    messageStore.resetConversation(id)
    const snap = cache.snapshotMessages(id)
    if (snap && snap.length) messageStore.loadSnapshot(id, snap)
    // 无快照 → 空态 + 提示（CyChatView 空态文案按 offlineView 区分）
    error.value = undefined
  }
```

  `remove()` 成功分支联动清内存草稿/锚点/快照：
```ts
      if (wasActive) {
        currentId.value = undefined
        useMessageStore().resetConversation(id)
      }
      useDraftStore().purge(id)
      useCacheStore().purge(id)
```

  返回对象追加：`offlineView, setOfflineCache, activateLocal`。

- [ ] **Step 3: 跑测试**——`pnpm -F @cyrene/desktop test -- tests/unit/conversation.store.spec.ts` 预期 PASS（既有用例：`activate` 多调一次 `setPageMeta` 无副作用；`useConnectionStore().state.status` 默认 'disconnected'，既有 `activate` 用例需注意 `offlineView` 默认 false 不受影响）。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/src/renderer/src/stores/conversation.store.ts apps/desktop/tests/unit/conversation.store.spec.ts
git commit -m "feat(G2 conversation-store): 离线视图 activateLocal + 在线恢复 + 首页分页初始化 + 删除联动清理"
```

---

### Task 8: Main SessionStore（草稿+锚点+会话列表缓存+消息快照+配额+损坏隔离+字节预算）

**Files:**
- Create: `apps/desktop/src/main/persistence/session-store.ts`
- Test: `tests/unit/session-store.spec.ts`

**Interfaces:**
- Consumes: `atomicWriteFile`（`main/credentials/atomic-write.ts`）、`openSafeFile`（`main/persistence/safe-open.ts`）、`MAX_IPC_MESSAGE_BYTES`、`PersistSessionInput`/`CacheMessagesInput`/`SessionPersistenceState`/`ScrollAnchor`、`ConversationDraftSchema`/`MessageSchema`（防御校验）、`Logger`、`CyreneError`/`CyreneErrorCode`
- Produces（Task 9 装配）: `SessionStore` 类：
  - `constructor(deps: { appCache: string; safeRoot: string; logger: Logger; countDiagnostic(code: string): void; getActiveConversationId(): string | undefined })`
  - `async load(): Promise<void>`（损坏隔离读取两个文件，不阻塞启动）
  - `hydrate(): SessionPersistenceState`（响应字节预算降级：①快照只保留 lastActive+最近 N；②每会话截前 M + 超长正文截断留元数据；③仍超限→空快照+告警计数）
  - `async persistSession(input: PersistSessionInput): Promise<PersistSessionResult>`（100KB UTF-8 字节权威校验 + 50 条目淘汰最旧非激活 + 淘汰项返回 `evictedConversationIds`）
  - `async cacheMessages(input: CacheMessagesInput): Promise<void>`（整批字节预算 >4MiB → `IPC_MESSAGE_TOO_LARGE`；逐条 `MessageSchema` 校验丢非法 + 计数；按 messageId 去重合并；每会话 ≤300 封顶；top-20 淘汰）
  - `async syncConversationList(conversations: Conversation[]): Promise<void>`（top-20 + 淘汰带快照）
  - `async setActiveConversation(id: string): Promise<void>`（写 drafts-v1 顶层 lastActiveConversationId）
  - `async purgeConversation(id: string): Promise<void>`（删草稿+锚点+快照+缓存会话列表，评审 P2-1）
  - `async clearAll(): Promise<void>`（unlink 两个文件，「清除缓存」工具，本批不暴露删除 API）

- [ ] **Step 1: 写失败测试**——`tests/unit/session-store.spec.ts`（新建，Main 侧 node 环境，用真实 temp 目录；`SessionStore` 不 import electron，无需 mock）：

```ts
// tests/unit/session-store.spec.ts —— spec §4.4.2/§4.5/§5：草稿配额/淘汰告知/快照去重封顶/top-20/损坏隔离/字节预算/不写正文日志。
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionStore } from '../../src/main/persistence/session-store'
import type { Conversation, Message } from '@shared/contracts'

function msg(id: string, createdAt: string, extra = ''): Message {
  return { messageId: id, conversationId: 'c1', role: 'user', content: `hi${extra}`, status: 'completed', createdAt }
}
function conv(id: string, updatedAt: string): Conversation { return { id, title: id, updatedAt } }

async function makeStore(activeConv = 'c1') {
  const base = await mkdtemp(join(tmpdir(), 'cyrene-session-'))
  const safeRoot = await realpath(base)
  const counts: string[] = []
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const s = new SessionStore({
    appCache: base, safeRoot, logger: logger as never,
    countDiagnostic: (code: string) => { counts.push(code) },
    getActiveConversationId: () => activeConv
  })
  await s.load()
  return { s, base, counts, logger }
}

describe('SessionStore（spec §4.4.2/§4.5）', () => {
  let env: { s: SessionStore; base: string; counts: string[]; logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } } | undefined
  afterEach(async () => { if (env) await rm(env.base, { recursive: true, force: true }); env = undefined })

  it('persistSession 写草稿+锚点，hydrate 读回一致；文件出现且含 schemaVersion', async () => {
    env = await makeStore()
    await env.s.persistSession({ conversationId: 'c1', draft: { text: '你好', updatedAt: 't1' }, scrollAnchor: { messageId: 'm1', offset: 5 } })
    const h = env.s.hydrate()
    expect(h.drafts.find((d) => d.conversationId === 'c1')?.text).toBe('你好')
    expect(h.scrollAnchors['c1']).toEqual({ messageId: 'm1', offset: 5 })
    const raw = JSON.parse(await readFile(join(env.base, 'drafts-v1.json'), 'utf8'))
    expect(raw.schemaVersion).toBe(1)
  })

  it('单草稿 UTF-8 >100KB 拒绝 DRAFT_LIMIT_EXCEEDED（权威校验，防御 untrusted renderer）', async () => {
    env = await makeStore()
    const big = '汉'.repeat(1024 * 40) // ~120KB 字节
    await expect(env.s.persistSession({ conversationId: 'c1', draft: { text: big, updatedAt: 't' }, scrollAnchor: null }))
      .rejects.toMatchObject({ code: 'DRAFT_LIMIT_EXCEEDED' })
  })

  it('>50 条目淘汰 updatedAt 最旧非激活条目，淘汰项经 evictedConversationIds 返回（P2-1）', async () => {
    env = await makeStore('keep')
    for (let i = 0; i < 52; i++) {
      const id = i === 0 ? 'keep' : `c${i}`
      await env.s.persistSession({ conversationId: id, draft: { text: `d${i}`, updatedAt: `t${String(i).padStart(3, '0')}` }, scrollAnchor: null })
    }
    const h = env.s.hydrate()
    expect(h.drafts.length).toBe(50)
    expect(h.drafts.some((d) => d.conversationId === 'keep')).toBe(true) // 激活会话不淘汰
    expect(env.counts).toContain('draft:evicted')
  })

  it('cacheMessages 逐条 MessageSchema 校验丢非法 + 计数；同 messageId 去重不重复', async () => {
    env = await makeStore()
    await env.s.cacheMessages({ conversationId: 'c1', messages: [msg('m1', 't1'), msg('m1', 't1'), { ...msg('bad', 't2'), messageId: '' }], updatedAt: 't' })
    const h = env.s.hydrate()
    expect(h.messageSnapshots['c1']).toHaveLength(1)
    expect(h.messageSnapshots['c1'][0].messageId).toBe('m1')
    expect(env.counts).toContain('cache:drop-invalid')
  })

  it('cacheMessages 整批字节 >4MiB 拒绝 IPC_MESSAGE_TOO_LARGE（P1-2）', async () => {
    env = await makeStore()
    const big = Array.from({ length: 60 }, () => msg(`m${Math.random()}`, 't', 'x'.repeat(80_000))) // 60×80KB ≈ 4.8MB
    await expect(env.s.cacheMessages({ conversationId: 'c1', messages: big, updatedAt: 't' })).rejects.toMatchObject({ code: 'IPC_MESSAGE_TOO_LARGE' })
  })

  it('每会话快照 ≤300 封顶（保留最新 createdAt）；top-20 会话淘汰含快照', async () => {
    env = await makeStore()
    const many = Array.from({ length: 350 }, (_, i) => msg(`m${i}`, `t${String(i).padStart(3, '0')}`))
    await env.s.cacheMessages({ conversationId: 'c1', messages: many, updatedAt: 't' })
    expect(env.s.hydrate().messageSnapshots['c1']).toHaveLength(300)
    for (let i = 0; i < 25; i++) await env.s.syncConversationList([conv(`c${i}`, `u${i}`)])
    const h = env.s.hydrate()
    expect(h.conversations).toHaveLength(20)
    expect(h.conversations.every((c) => c.id !== 'c0')).toBe(true)
  })

  it('purgeConversation 联动清草稿+锚点+快照+缓存会话列表（评审 P2-1，syncConversationList 是并集合并不 purge 会残留）', async () => {
    env = await makeStore()
    await env.s.persistSession({ conversationId: 'c1', draft: { text: 'x', updatedAt: 't1' }, scrollAnchor: { messageId: 'm1', offset: 5 } })
    await env.s.cacheMessages({ conversationId: 'c1', messages: [msg('m1', 't1')], updatedAt: 't1' })
    await env.s.syncConversationList([conv('c1', 'u1')])
    await env.s.purgeConversation('c1')
    const h = env.s.hydrate()
    expect(h.drafts.find((d) => d.conversationId === 'c1')).toBeUndefined()
    expect(h.scrollAnchors['c1']).toBeUndefined()
    expect(h.messageSnapshots['c1']).toBeUndefined()
    expect(h.conversations.some((c) => c.id === 'c1')).toBe(false) // P2-1：缓存会话列表同步移除
  })

  it('整文件 JSON 损坏 → 隔离重建 .corrupt-<ts> + 空缓存，不抛错不阻塞', async () => {
    env = await makeStore()
    await rm(env.base, { recursive: true, force: true })
    const base2 = await mkdtemp(join(tmpdir(), 'cyrene-session2-'))
    const safeRoot2 = await realpath(base2)
    const s2 = new SessionStore({
      appCache: base2, safeRoot: safeRoot2, logger: env.logger as never,
      countDiagnostic: () => {}, getActiveConversationId: () => undefined
    })
    // P2-4：必须 mode 0600 写入——openSafeFile 在 POSIX 对 existing-read 校验权限位（0400 且无 group/other），
    // 默认 0644 会先抛 SafeOpenError（权限路径）而非 JSON.parse 失败；0600 才走真实「整文件损坏 → 隔离重建」分支
    await writeFile(join(base2, 'message-cache-v1.json'), '{ 损坏 非法 JSON', { encoding: 'utf8', mode: 0o600 })
    await s2.load()
    expect(s2.hydrate().conversations).toHaveLength(0)
    const files = await readdir(base2)
    expect(files.some((f) => f.startsWith('message-cache-v1.json.corrupt-'))).toBe(true)
    await rm(base2, { recursive: true, force: true })
  })

  it('条目级 schema 失败丢条目不污染整文件（损坏不污染）', async () => {
    env = await makeStore()
    await env.s.cacheMessages({ conversationId: 'c1', messages: [msg('ok', 't')], updatedAt: 't' })
    const raw = JSON.parse(await readFile(join(env.base, 'message-cache-v1.json'), 'utf8'))
    raw.snapshots.c1.messages.push({ messageId: '', conversationId: 'c1', role: 'user', status: 'completed', createdAt: 't' })
    await writeFile(join(env.base, 'message-cache-v1.json'), JSON.stringify(raw), 'utf8')
    const s2 = new SessionStore({
      appCache: env.base, safeRoot: await realpath(env.base), logger: env.logger as never,
      countDiagnostic: () => {}, getActiveConversationId: () => undefined
    })
    await s2.load()
    const snap = s2.hydrate().messageSnapshots['c1']
    expect(snap).toHaveLength(1)
    expect(snap[0].messageId).toBe('ok')
  })

  it('hydrate 响应字节预算降级（超 4MiB → 截断正文保留骨架，P1-2）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'cyrene-session3-'))
    const safeRoot3 = await realpath(base)
    const counts: string[] = []
    const s2 = new SessionStore({
      appCache: base, safeRoot: safeRoot3, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      countDiagnostic: (code: string) => { counts.push(code) }, getActiveConversationId: () => undefined
    })
    // 直接注入大快照文件（绕过 cacheMessages 入参限制，构造 >4MiB 水合状态）
    await writeFile(join(base, 'message-cache-v1.json'), JSON.stringify({
      schemaVersion: 1,
      conversations: [{ id: 'c1', title: 'A', updatedAt: 't' }],
      snapshots: { c1: { messages: [{ messageId: 'm1', conversationId: 'c1', role: 'user', content: 'x'.repeat(5 * 1024 * 1024), status: 'completed', createdAt: 't' }], updatedAt: 't', lastSyncAt: 't' } }
    }), 'utf8')
    await s2.load()
    const h = s2.hydrate()
    expect(h.messageSnapshots['c1'][0].content!.length).toBeLessThanOrEqual(2000) // ② 截断正文保留元数据
    expect(counts).toContain('hydrate:degraded')
    await rm(base, { recursive: true, force: true })
  })

  it('hydrate 草稿字节裁剪：50×100KB 草稿超 4MiB → lastActive 优先、按 updatedAt 保留最近 N + 降级计数（评审 P1-1）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'cyrene-session4-'))
    const safeRoot4 = await realpath(base)
    const counts: string[] = []
    const s2 = new SessionStore({
      appCache: base, safeRoot: safeRoot4, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      countDiagnostic: (code: string) => { counts.push(code) }, getActiveConversationId: () => 'c0'
    })
    // 直接注入 drafts 文件（50 会话 × 100KB，构造 >4MiB 草稿态；persistSession 单条 100KB 上限允许此规模）
    const entries: Record<string, { text: string; updatedAt: string }> = {}
    for (let i = 0; i < 50; i++) entries[`c${i}`] = { text: 'x'.repeat(100 * 1024), updatedAt: `t${String(i).padStart(3, '0')}` }
    await writeFile(join(base, 'drafts-v1.json'), JSON.stringify({ schemaVersion: 1, entries, scrollAnchors: {}, lastActiveConversationId: 'c0' }), { encoding: 'utf8', mode: 0o600 })
    await s2.load()
    const h = s2.hydrate()
    expect(counts).toContain('hydrate:drafts-degraded') // 降级计数（含快照降级 'hydrate:degraded'）
    expect(h.drafts.some((d) => d.conversationId === 'c0')).toBe(true) // 激活会话草稿优先保留（updatedAt 最旧但激活优先）
    expect(h.drafts.length).toBeLessThan(50) // 50×100KB=5MB → 裁到预算内
    expect(h.drafts.length).toBeGreaterThan(0)
    expect(h.drafts.length * 100 * 1024).toBeLessThanOrEqual(4 * 1024 * 1024) // 出参 ≤4MiB 不变量（近似：条数 × 100KB）
    await rm(base, { recursive: true, force: true })
  })

  it('不写草稿/消息正文到日志（spy logger 断言无文本）', async () => {
    env = await makeStore()
    await env.s.persistSession({ conversationId: 'c1', draft: { text: 'SECRET_DRAFT_ABC', updatedAt: 't' }, scrollAnchor: null })
    const joined = [...env.logger.info.mock.calls, ...env.logger.warn.mock.calls, ...env.logger.error.mock.calls].map((c) => JSON.stringify(c)).join('\n')
    expect(joined).not.toContain('SECRET_DRAFT_ABC')
  })
})
```

  预期 FAIL：`session-store` 不存在。

- [ ] **Step 2: 实现**——`apps/desktop/src/main/persistence/session-store.ts`（新建）：

```ts
// 阶段 3 G2 Main 持久化（spec §4.4.2/§4.5，docs/06 §14 Main 持久化边界）：
// drafts-v1.json（草稿+锚点+lastActive，高频小）+ message-cache-v1.json（会话列表+消息快照，低频大）。
// 纪律：版本化 schemaVersion + 逐条校验 + 整文件损坏隔离重建（不污染）+ 配额（100KB/条、50 会话、20 会话缓存、300 条/会话）+ 淘汰告知 + 正文永不写日志。
import { join, basename, dirname } from 'path'
import { rename, unlink } from 'fs/promises'
import { atomicWriteFile } from '../credentials/atomic-write'
import { openSafeFile } from './safe-open'
import { MAX_IPC_MESSAGE_BYTES, type Conversation, type ConversationDraft, type Message, type PersistSessionInput, type PersistSessionResult, type ScrollAnchor, type SessionPersistenceState } from '@shared/contracts'
import { ConversationDraftSchema, ConversationSchema, MessageSchema } from '@shared/schemas'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import type { Logger } from '../diagnostics/logger'

export const DRAFT_MAX_BYTES = 100 * 1024
export const DRAFT_MAX_ENTRIES = 50
export const CACHE_TOP_N = 20
export const CACHE_MESSAGES_PER_CONV = 300

interface DraftEntry { text: string; updatedAt: string }
interface SnapshotEntry { messages: Message[]; updatedAt: string; lastSyncAt: string }
interface DraftsFile { schemaVersion: 1; entries: Record<string, DraftEntry>; scrollAnchors: Record<string, ScrollAnchor>; lastActiveConversationId?: string }
interface CacheFile { schemaVersion: 1; conversations: Conversation[]; snapshots: Record<string, SnapshotEntry> }

export interface SessionStoreDeps {
  appCache: string
  safeRoot: string
  logger: Logger
  countDiagnostic(code: string): void
  getActiveConversationId(): string | undefined
}

function estBytes(s: string): number { return new TextEncoder().encode(s).byteLength }
function msgBytes(m: Message): number {
  let n = 200
  n += estBytes(m.content ?? '')
  for (const seg of m.assistantSegments ?? []) n += estBytes(seg.text ?? '')
  return n
}
function nowIso(): string { return new Date().toISOString() }

export class SessionStore {
  private readonly draftsFile: string
  private readonly cacheFile: string
  private drafts: DraftsFile = { schemaVersion: 1, entries: {}, scrollAnchors: {} }
  private cache: CacheFile = { schemaVersion: 1, conversations: [], snapshots: {} }

  constructor(private readonly deps: SessionStoreDeps) {
    this.draftsFile = join(deps.appCache, 'drafts-v1.json')
    this.cacheFile = join(deps.appCache, 'message-cache-v1.json')
  }

  /** 损坏隔离读取：整文件 JSON 失败 → rename .corrupt-<ts> 重建空；条目级失败丢条目不污染（FE-S1-P2-02 纪律） */
  async load(): Promise<void> {
    this.drafts = await this.readFile(this.draftsFile, (raw) => {
      const out: DraftsFile = { schemaVersion: 1, entries: {}, scrollAnchors: {} }
      const data = raw as { entries?: unknown; scrollAnchors?: unknown; lastActiveConversationId?: unknown }
      if (data.entries && typeof data.entries === 'object') {
        for (const [k, v] of Object.entries(data.entries as Record<string, unknown>)) {
          const parsed = ConversationDraftSchema.safeParse({ conversationId: k, text: (v as { text?: string })?.text ?? '', attachmentLocalIds: [], updatedAt: (v as { text?: string; updatedAt?: string })?.updatedAt ?? '' })
          if (parsed.success) out.entries[k] = { text: parsed.data.text, updatedAt: parsed.data.updatedAt }
          else { this.deps.countDiagnostic('draft:drop-invalid'); continue }
        }
      }
      if (data.scrollAnchors && typeof data.scrollAnchors === 'object') {
        for (const [k, v] of Object.entries(data.scrollAnchors as Record<string, unknown>)) {
          if (v && typeof v === 'object' && typeof (v as ScrollAnchor).messageId === 'string' && typeof (v as ScrollAnchor).offset === 'number') {
            out.scrollAnchors[k] = v as ScrollAnchor
          } else this.deps.countDiagnostic('draft:drop-invalid-anchor')
        }
      }
      if (typeof data.lastActiveConversationId === 'string') out.lastActiveConversationId = data.lastActiveConversationId
      return out
    })
    this.cache = await this.readFile(this.cacheFile, (raw) => {
      const data = raw as { conversations?: unknown; snapshots?: unknown }
      const out: CacheFile = { schemaVersion: 1, conversations: [], snapshots: {} }
      if (Array.isArray(data.conversations)) {
        for (const c of data.conversations as unknown[]) {
          const parsed = ConversationSchema.safeParse(c)
          if (parsed.success) out.conversations.push(parsed.data)
          else this.deps.countDiagnostic('cache:drop-invalid-conv')
        }
      }
      if (data.snapshots && typeof data.snapshots === 'object') {
        for (const [k, v] of Object.entries(data.snapshots as Record<string, unknown>)) {
          const snap = v as { messages?: unknown; updatedAt?: string; lastSyncAt?: string }
          if (snap && Array.isArray(snap.messages)) {
            const messages: Message[] = []
            for (const m of snap.messages as unknown[]) {
              const parsed = MessageSchema.safeParse(m)
              if (parsed.success) messages.push(parsed.data)
              else this.deps.countDiagnostic('cache:drop-invalid')
            }
            out.snapshots[k] = { messages, updatedAt: snap.updatedAt ?? '', lastSyncAt: snap.lastSyncAt ?? '' }
          } else this.deps.countDiagnostic('cache:drop-invalid-snapshot')
        }
      }
      return out
    })
  }

  private async readFile<T>(file: string, parse: (raw: unknown) => T): Promise<T> {
    try {
      const { fd } = await openSafeFile(file, { mode: 'existing', purpose: 'read', safeRoot: this.deps.safeRoot })
      try { return parse(JSON.parse(await fd.readFile('utf8'))) } finally { await fd.close() }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return parse({}) // 首次启动无文件 → 空
      // 整文件损坏：隔离保留现场（不含正文），重建空
      this.deps.logger.warn('persistence:corrupt-isolated', { file: basename(file) })
      this.deps.countDiagnostic('persistence:corrupt-isolated')
      await rename(file, `${file}.corrupt-${nowIso().replace(/[:.]/g, '-')}`).catch(() => {})
      return parse({})
    }
  }

  private async writeDrafts(): Promise<void> {
    await atomicWriteFile(this.draftsFile, JSON.stringify(this.drafts), { safeRoot: this.deps.safeRoot })
  }
  private async writeCache(): Promise<void> {
    await atomicWriteFile(this.cacheFile, JSON.stringify(this.cache), { safeRoot: this.deps.safeRoot })
  }

  /** 响应装箱：默认全量；超 MAX_IPC_MESSAGE_BYTES 时按顺序降级（spec §4.2 P1-2），降级记诊断计数、不记正文 */
  hydrate(): SessionPersistenceState {
    const drafts = Object.entries(this.drafts.entries).map(([conversationId, e]) => ({
      conversationId, text: e.text, attachmentLocalIds: [], updatedAt: e.updatedAt
    }))
    let state: SessionPersistenceState = {
      drafts,
      scrollAnchors: { ...this.drafts.scrollAnchors },
      lastActiveConversationId: this.drafts.lastActiveConversationId,
      conversations: this.cache.conversations,
      messageSnapshots: Object.fromEntries(Object.entries(this.cache.snapshots).map(([k, v]) => [k, v.messages]))
    }
    if (this.stateBytes(state) <= MAX_IPC_MESSAGE_BYTES) return state
    this.deps.countDiagnostic('hydrate:degraded')
    // ① 快照只保留 lastActive + updatedAt 最近 N（N 由预算反推）
    const keys = Object.keys(state.messageSnapshots).sort((a, b) =>
      (this.cache.snapshots[b]?.updatedAt ?? '').localeCompare(this.cache.snapshots[a]?.updatedAt ?? ''))
    const lastId = state.lastActiveConversationId
    const ordered = lastId ? [lastId, ...keys.filter((k) => k !== lastId)] : keys
    const kept: Record<string, Message[]> = {}
    for (const k of ordered) {
      kept[k] = state.messageSnapshots[k]
      state = { ...state, messageSnapshots: kept }
      if (this.stateBytes(state) <= MAX_IPC_MESSAGE_BYTES) break
    }
    if (this.stateBytes(state) > MAX_IPC_MESSAGE_BYTES) {
      // ② 每会话截前 M + 超长正文截断保留元数据（离线可读骨架）
      for (const k of Object.keys(state.messageSnapshots)) {
        state.messageSnapshots[k] = state.messageSnapshots[k].slice(0, 50).map((m) => ({
          ...m,
          content: m.content && estBytes(m.content) > 2000 ? m.content.slice(0, 2000) : m.content,
          assistantSegments: m.assistantSegments?.map((s) => (s.text && estBytes(s.text) > 2000 ? { ...s, text: s.text.slice(0, 2000) } : s))
        }))
      }
    }
    if (this.stateBytes(state) > MAX_IPC_MESSAGE_BYTES) {
      // ③ 草稿裁剪（评审 P1-1，防 50×100KB=5MB 草稿破 4MiB 不变量）：快照已降级仍超 → lastActive 优先、其余按 updatedAt 最近保留，
      //    逐条入内直至预算；被裁会话的锚点一并清（该会话本地态整体放弃，连接后由后端全量调和）
      this.deps.countDiagnostic('hydrate:drafts-degraded')
      const lastId = state.lastActiveConversationId
      const orderedDrafts = [...state.drafts].sort((a, b) =>
        (a.conversationId === lastId ? -1 : b.conversationId === lastId ? 1 : 0) || b.updatedAt.localeCompare(a.updatedAt))
      const keptDrafts: ConversationDraft[] = []
      for (const d of orderedDrafts) {
        keptDrafts.push(d)
        state = { ...state, drafts: keptDrafts }
        if (this.stateBytes(state) > MAX_IPC_MESSAGE_BYTES) {
          keptDrafts.pop()
          state = { ...state, drafts: keptDrafts }
        }
      }
      const keptIds = new Set(keptDrafts.map((d) => d.conversationId))
      const anchors = { ...state.scrollAnchors }
      for (const k of Object.keys(anchors)) if (!keptIds.has(k)) delete anchors[k]
      state = { ...state, drafts: keptDrafts, scrollAnchors: anchors }
    }
    if (this.stateBytes(state) > MAX_IPC_MESSAGE_BYTES) {
      // ④ 兜底仍超 → 空草稿+空快照拒绝路径（启动不阻塞，连接后由后端全量调和；保证出参 ≤4MiB 不变量）
      this.deps.countDiagnostic('hydrate:rejected')
      return { drafts: [], scrollAnchors: {}, lastActiveConversationId: this.drafts.lastActiveConversationId, conversations: [], messageSnapshots: {} }
    }
    return state
  }

  private stateBytes(state: SessionPersistenceState): number {
    let n = 1024
    for (const d of state.drafts) n += estBytes(d.text)
    for (const c of state.conversations) n += estBytes(c.title)
    for (const msgs of Object.values(state.messageSnapshots)) for (const m of msgs) n += msgBytes(m)
    return n
  }

  /** 草稿+锚点 upsert；配额权威执行（D4）：单条 >100KB 拒、条目 >50 淘汰最旧非激活（P2-1 淘汰项返回） */
  async persistSession(input: PersistSessionInput): Promise<PersistSessionResult> {
    if (estBytes(input.draft.text) > DRAFT_MAX_BYTES) {
      throw new CyreneError(CyreneErrorCode.DRAFT_LIMIT_EXCEEDED, '草稿超过 100KB 上限')
    }
    this.drafts.entries[input.conversationId] = { text: input.draft.text, updatedAt: input.draft.updatedAt }
    if (input.scrollAnchor) this.drafts.scrollAnchors[input.conversationId] = input.scrollAnchor
    else delete this.drafts.scrollAnchors[input.conversationId]

    const evicted: string[] = []
    const keys = Object.keys(this.drafts.entries)
    if (keys.length > DRAFT_MAX_ENTRIES) {
      const activeId = this.deps.getActiveConversationId()
      const excess = keys.length - DRAFT_MAX_ENTRIES
      const candidates = keys
        .filter((k) => k !== activeId)
        .sort((a, b) => this.drafts.entries[a].updatedAt.localeCompare(this.drafts.entries[b].updatedAt))
      for (const k of candidates.slice(0, excess)) {
        delete this.drafts.entries[k]
        delete this.drafts.scrollAnchors[k]
        evicted.push(k)
      }
      this.deps.countDiagnostic('draft:evicted')
    }
    await this.writeDrafts() // fail-open 由调用方兜底（成功路径 throw 说明配额被拒，不影响操作）
    return evicted.length ? { evictedConversationIds: evicted } : {}
  }

  /** 已确认消息快照增量：整批字节预算校验 + 逐条 schema 校验 + 去重合并 + ≤300 封顶 + top-20 淘汰（P1-2） */
  async cacheMessages(input: { conversationId: string; messages: Message[]; updatedAt: string }): Promise<void> {
    if (input.messages.reduce((acc, m) => acc + msgBytes(m), 0) > MAX_IPC_MESSAGE_BYTES) {
      throw new CyreneError(CyreneErrorCode.IPC_MESSAGE_TOO_LARGE, '消息快照超过单条 IPC 大小上限')
    }
    const valid: Message[] = []
    for (const m of input.messages) {
      const parsed = MessageSchema.safeParse(m)
      if (parsed.success) valid.push(parsed.data)
      else this.deps.countDiagnostic('cache:drop-invalid')
    }
    const snap = this.cache.snapshots[input.conversationId] ?? { messages: [], updatedAt: '', lastSyncAt: nowIso() }
    const merged = new Map<string, Message>()
    for (const m of [...snap.messages, ...valid]) merged.set(m.messageId, m)
    snap.messages = [...merged.values()].sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.messageId < b.messageId ? -1 : 1).slice(-CACHE_MESSAGES_PER_CONV)
    snap.updatedAt = input.updatedAt
    snap.lastSyncAt = nowIso()
    this.cache.snapshots[input.conversationId] = snap
    const listIdx = this.cache.conversations.findIndex((c) => c.id === input.conversationId)
    if (listIdx >= 0) this.cache.conversations[listIdx] = { ...this.cache.conversations[listIdx], updatedAt: input.updatedAt }
    this.trimCache()
    await this.writeCache()
  }

  /** 会话列表缓存（Main 派生，listConversations 服务时调用；无需 Renderer 推送） */
  async syncConversationList(conversations: Conversation[]): Promise<void> {
    const merged = new Map<string, Conversation>()
    for (const c of [...this.cache.conversations, ...conversations]) merged.set(c.id, c)
    this.cache.conversations = [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, CACHE_TOP_N)
    this.trimCache()
    await this.writeCache()
  }

  private trimCache(): void {
    this.cache.conversations = [...this.cache.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, CACHE_TOP_N)
    const ids = new Set(this.cache.conversations.map((c) => c.id))
    for (const k of Object.keys(this.cache.snapshots)) if (!ids.has(k)) delete this.cache.snapshots[k]
  }

  /** 在线 activate 成功 → 记录 lastActiveConversationId（下次启动离线水合定位目标会话） */
  async setActiveConversation(id: string): Promise<void> {
    this.drafts.lastActiveConversationId = id
    await this.writeDrafts()
  }

  /** 删除会话联动（spec §4.5.1）：purge 草稿+锚点+快照+缓存会话列表（评审 P2-1——syncConversationList 是并集合并，不 purge 会残留被删会话） */
  async purgeConversation(id: string): Promise<void> {
    delete this.drafts.entries[id]
    delete this.drafts.scrollAnchors[id]
    delete this.cache.snapshots[id]
    this.cache.conversations = this.cache.conversations.filter((c) => c.id !== id) // P2-1：缓存会话列表移除被删会话
    await this.writeDrafts()
    await this.writeCache()
  }

  /** 「清除缓存」工具实现（docs/07 §243）：删除两个文件；本批不暴露删除 IPC，由设置组接入 */
  async clearAll(): Promise<void> {
    await unlink(this.draftsFile).catch(() => {})
    await unlink(this.cacheFile).catch(() => {})
    this.drafts = { schemaVersion: 1, entries: {}, scrollAnchors: {} }
    this.cache = { schemaVersion: 1, conversations: [], snapshots: {} }
  }
}
```

  注：`CyreneErrorCode` 需含 `DRAFT_LIMIT_EXCEEDED` 与 `IPC_MESSAGE_TOO_LARGE`——若 `shared/errors/index.ts` 无此两码，本任务一并追加（见 Step 2b）。

- [ ] **Step 2b: 若缺错误码**——检查 `apps/desktop/src/shared/errors/index.ts` 的 `CyreneErrorCode` 枚举；无 `DRAFT_LIMIT_EXCEEDED`/`IPC_MESSAGE_TOO_LARGE` 则追加（测试断言沿用字符串 'DRAFT_LIMIT_EXCEEDED'/'IPC_MESSAGE_TOO_LARGE' 已隐含枚举值）。

- [ ] **Step 3: 跑测试**——`pnpm -F @cyrene/desktop test -- tests/unit/session-store.spec.ts` 预期 PASS。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/src/main/persistence/session-store.ts apps/desktop/src/shared/errors/index.ts apps/desktop/tests/unit/session-store.spec.ts
git commit -m "feat(G2 session-store): 草稿/锚点/会话列表/消息快照持久化 + 配额淘汰告知 + 损坏隔离 + 字节预算"
```

---

### Task 9: Main IPC —— 通道 schema + persistence-handlers（含 openExternal 白名单）+ 装配 + chat-service 钩子

**Files:**
- Modify: `apps/desktop/src/main/ipc/channels.ts`
- Create: `apps/desktop/src/main/persistence/persistence-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/handlers.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/main/chat/chat-service.ts`
- Test: `tests/unit/persistence-handlers.spec.ts`

**Interfaces:**
- Consumes: `SessionStore`（Task 8）、`registerHandler`/`createIpcHandler`、Task 2 的 schemas、`shell`（electron）
- Produces: `registerPersistenceHandlers(deps: { sessionStore: SessionStore; sanitize: MessageSanitizer; logger: Logger }): void`；`openExternal(url: string): void`（http/https 白名单 + `new URL` 校验 + ≤2048 字符 + 非法 scheme 拒）；`chat-service` 钩子：`listConversations` 写 `sessionStore.syncConversationList`、`activate` 写 `sessionStore.setActiveConversation`、`deleteConversation` 写 `sessionStore.purgeConversation`（均 fail-open catch）

- [ ] **Step 1: 写失败测试**——`tests/unit/persistence-handlers.spec.ts`（新建，`vi.mock('electron')` 捕获 `ipcMain.handle` + `shell.openExternal`）：

```ts
// tests/unit/persistence-handlers.spec.ts —— 四通道接线 + openExternal http/https 白名单 + responseSchema 镜像。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createIpcHandler } from '../../src/main/ipc/executor'
import { IpcChannels, type IpcResult } from '@shared/contracts'
import { SessionPersistenceStateSchema, PersistSessionResultSchema, CacheMessagesInputSchema, OpenExternalInputSchema } from '@shared/schemas'
import { openExternal } from '../../src/main/persistence/persistence-handlers'
import { CyreneError } from '@shared/errors'

const sanitize = (m: string): string => m
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

const { mockShell } = vi.hoisted(() => ({ mockShell: { openExternal: vi.fn() } }))
vi.mock('electron', () => ({ shell: mockShell, BrowserWindow: class {}, ipcMain: { handle: vi.fn() } }))

describe('openExternal（spec §4.2 http/https 白名单）', () => {
  beforeEach(() => mockShell.openExternal.mockClear())
  it('http/https 通过 → shell.openExternal', () => {
    openExternal('https://example.com/')
    expect(mockShell.openExternal).toHaveBeenCalledWith('https://example.com/')
  })
  it('非 http/https scheme（file:/cyrene:/javascript:）拒绝', () => {
    expect(() => openExternal('file:///etc/passwd')).toThrow()
    expect(() => openExternal('cyrene://x')).toThrow()
    expect(() => openExternal('javascript:alert(1)')).toThrow()
    expect(mockShell.openExternal).not.toHaveBeenCalled()
  })
  it('非法 URL / 超 2048 字符拒绝', () => {
    expect(() => openExternal('not a url')).toThrow()
    expect(() => openExternal('https://e.com/' + 'a'.repeat(2100))).toThrow()
  })
})

describe('persistence 四通道接线（request/response schema 组合）', () => {
  it('chatHydratePersistence 无参 + SessionPersistenceStateSchema 响应', async () => {
    const h = createIpcHandler(z.undefined(), SessionPersistenceStateSchema, () => ({ drafts: [], scrollAnchors: {}, conversations: [], messageSnapshots: {} }), { sanitize })
    const res = (await h(undefined)) as IpcResult<unknown>
    expect(res.ok).toBe(true)
  })
  it('chatPersistSession 用 PersistSessionInputSchema 入参 + PersistSessionResultSchema 响应（含 evictedConversationIds）', async () => {
    const h = createIpcHandler(
      PersistSessionInputSchema,
      PersistSessionResultSchema,
      () => ({ evictedConversationIds: ['old'] }),
      { sanitize }
    )
    const res = (await h({ conversationId: 'c1', draft: { text: 'x', updatedAt: 't' }, scrollAnchor: null })) as IpcResult<unknown>
    expect(res.ok).toBe(true)
    expect((res as { ok: true; data: { evictedConversationIds: string[] } }).data.evictedConversationIds).toEqual(['old'])
  })
  it('chatCacheMessages 入参 schema 拒绝非法消息（空 messageId）', async () => {
    const h = createIpcHandler(CacheMessagesInputSchema, z.undefined(), () => {}, { sanitize })
    const bad = await h({ conversationId: 'c1', messages: [{ messageId: '', conversationId: 'c1', role: 'user', status: 'completed', createdAt: 't' }], updatedAt: 't' })
    expect(bad.ok).toBe(false)
  })
  it('appOpenExternal 入参 schema（OpenExternalInputSchema）', async () => {
    const h = createIpcHandler(OpenExternalInputSchema, z.undefined(), () => {}, { sanitize })
    expect((await h({ url: 'https://e.com' })).ok).toBe(true)
    expect((await h({ url: 42 })).ok).toBe(false)
  })
})
```

  预期 FAIL：`persistence-handlers` 不存在 / `openExternal` 未导出。

- [ ] **Step 2: 实现**——`apps/desktop/src/main/ipc/channels.ts`：import 追加 `PersistSessionInputSchema, CacheMessagesInputSchema, OpenExternalInputSchema, SessionPersistenceStateSchema, PersistSessionResultSchema`（`@shared/schemas`），文件末尾追加 request schema（响应 schema 别名引用共享定义，与既有 chat* 模式一致）：

```ts
export const chatHydratePersistenceSchema = z.undefined()
export const chatPersistSessionSchema = PersistSessionInputSchema
export const chatCacheMessagesSchema = CacheMessagesInputSchema
export const chatOpenExternalSchema = OpenExternalInputSchema
// 响应 schema：共享定义在 shared/schemas/ipc-response，别名保持引用兼容
export const sessionPersistenceStateResponseSchema = SessionPersistenceStateSchema
export const persistSessionResultResponseSchema = PersistSessionResultSchema
```

  `apps/desktop/src/main/persistence/persistence-handlers.ts`（新建）：

```ts
// 阶段 3 G2 持久化四通道（spec §4.2）：hydrate / persist-session / cache-messages / open-external。
import { z } from 'zod'
import { IpcChannels, type IpcChannelName, type IpcResult } from '@shared/contracts'
import { CacheMessagesInputSchema, OpenExternalInputSchema, PersistSessionInputSchema, PersistSessionResultSchema, SessionPersistenceStateSchema } from '@shared/schemas'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import { shell } from 'electron'
import type { MessageSanitizer } from '../diagnostics/sanitize'
import type { Logger } from '../diagnostics/logger'
import { createIpcHandler } from '../ipc/executor'
import { registerHandler } from '../ipc/registry'
import {
  chatCacheMessagesSchema, chatHydratePersistenceSchema, chatOpenExternalSchema, chatPersistSessionSchema
} from '../ipc/channels'
import type { SessionStore } from './session-store'

/** 外部链接：http/https 白名单 + new URL 校验 + ≤2048 字符；非法 scheme 直接拒绝（含 file:/cyrene:/javascript:） */
export function openExternal(url: string): void {
  if (url.length > 2048) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, '外部链接过长')
  let u: URL
  try { u = new URL(url) } catch { throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, '外部链接非法') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, '仅允许 http/https 外部链接')
  }
  void shell.openExternal(u.toString())
}

export function registerPersistenceHandlers(deps: { sessionStore: SessionStore; sanitize: MessageSanitizer; logger: Logger }): void {
  const { sessionStore, sanitize, logger } = deps
  const handle = <TReq, TRes>(
    requestSchema: z.ZodType<TReq>, responseSchema: z.ZodType<TRes>,
    fn: (req: TReq) => TRes | Promise<TRes>, channel: IpcChannelName
  ): ((raw: unknown) => Promise<IpcResult<TRes>>) =>
    createIpcHandler(requestSchema, responseSchema, fn, { sanitize, channel, logger })

  registerHandler(IpcChannels.chatHydratePersistence, handle(chatHydratePersistenceSchema, SessionPersistenceStateSchema, () => sessionStore.hydrate(), IpcChannels.chatHydratePersistence), 0)
  registerHandler(IpcChannels.chatPersistSession, handle(chatPersistSessionSchema, PersistSessionResultSchema, (req) => sessionStore.persistSession(req), IpcChannels.chatPersistSession), 1)
  registerHandler(IpcChannels.chatCacheMessages, handle(chatCacheMessagesSchema, z.undefined(), (req) => sessionStore.cacheMessages(req), IpcChannels.chatCacheMessages), 1)
  registerHandler(IpcChannels.appOpenExternal, handle(chatOpenExternalSchema, z.undefined(), (req) => openExternal(req.url), IpcChannels.appOpenExternal), 1)
}
```

  `apps/desktop/src/main/ipc/handlers.ts`：`registerHandlers` deps 增 `sessionStore: SessionStore`，末尾调 `registerPersistenceHandlers({ sessionStore: deps.sessionStore, sanitize, logger: deps.logger })`。

  `apps/desktop/src/main/index.ts`：装配 `SessionStore`——**必须在 `createChatService` 之前**（chat-service 钩子需要它）。`getActiveConversationId` 闭包引用 `chatBridge.svc`（此时未赋值，但只在 connect 后的 persistSession 才调用，懒绑定安全）。在 `const chatSvc = createChatService({...})` 之前插入：

```ts
    const sessionStore = new SessionStore({
      appCache: dirs.appCache,
      safeRoot,
      logger: diagnostics.logger,
      countDiagnostic: (code: string) => diagnostics?.logger.warn('persistence:diagnostic', { code }),
      getActiveConversationId: () => chatBridge.svc?.getConnectionState().activeConversationId
    })
    await sessionStore.load() // 损坏隔离，不阻塞启动
```

  `createChatService({...})` 的 deps 追加 `sessionStore`，`registerHandlers({..., sessionStore })`（registerHandlers deps 增 `sessionStore: SessionStore`，末尾调 `registerPersistenceHandlers({ sessionStore: deps.sessionStore, sanitize, logger: deps.logger })`）。

  `apps/desktop/src/main/chat/chat-service.ts`：`ChatServiceDeps` 增 `sessionStore?: SessionStore`（import type），三个方法加钩子（fail-open）：
```ts
    listConversations: async (input) => {
      const p = await adapter.listConversations(input)
      deps.sessionStore?.syncConversationList(p.items).catch(() => {}) // 持久化失败不影响操作结果（C1 fail-open）
      return p
    },
    activate: async (id) => {
      const r = await adapter.activateConversation(id)
      deps.sessionStore?.setActiveConversation(id).catch(() => {}) // 记录 lastActiveConversationId
      return r
    },
    deleteConversation: async (id) => {
      await adapter.deleteConversation(id)
      deps.sessionStore?.purgeConversation(id).catch(() => {}) // 联动删草稿+锚点+快照
    },
```

- [ ] **Step 3: 跑测试**——`pnpm -F @cyrene/desktop test -- tests/unit/persistence-handlers.spec.ts` 预期 PASS；`pnpm -F @cyrene/desktop test -- tests/unit/chat-service.spec.ts` 预期 PASS（既有用例不受 sessionStore 可选影响）；`pnpm -F @cyrene/desktop typecheck` 预期 PASS。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/src/main/ipc/channels.ts apps/desktop/src/main/persistence/persistence-handlers.ts apps/desktop/src/main/ipc/handlers.ts apps/desktop/src/main/index.ts apps/desktop/src/main/chat/chat-service.ts apps/desktop/tests/unit/persistence-handlers.spec.ts
git commit -m "feat(G2 persistence-ipc): 四通道 handler + openExternal 白名单 + SessionStore 装配 + chat-service 钩子"
```

---

### Task 10: Preload 4 方法 + DesktopApiLike 同步 + 信封解包测试

**Files:**
- Modify: `apps/desktop/src/preload/desktop-api.ts`
- Modify: `apps/desktop/src/preload/index.d.ts`
- Modify: `tests/unit/desktop-api-chat.spec.ts`

**Interfaces:**
- Consumes: Task 1 契约 + Task 2 schemas + `unwrap`（既有）
- Produces: `desktopApi.hydratePersistence()/persistSession(input)/cacheMessages(input)/openExternal(url)`（`unwrap(res, schema)` 信封解包）；`Window.desktopApi` 类型同步

- [ ] **Step 1: 写失败测试**——`tests/unit/desktop-api-chat.spec.ts` 追加 describe（复用既有 `importDesktopApi()`/`mockIpc.invoke` mock 模式；`beforeEach` 已 `mockIpc.invoke.mockReset()`）：

```ts
describe('阶段 3 G2 新通道（persistSession/cacheMessages/hydratePersistence/openExternal）', () => {
  it('persistSession 调 chat:persist-session 并解包 PersistSessionResult（含 evictedConversationIds）', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({ ok: true, data: { evictedConversationIds: ['old'] } })
    await expect(desktopApi.persistSession({ conversationId: 'c1', draft: { text: '草稿', updatedAt: 't' }, scrollAnchor: null }))
      .resolves.toEqual({ evictedConversationIds: ['old'] })
    expect(mockIpc.invoke).toHaveBeenCalledWith('chat:persist-session', { conversationId: 'c1', draft: { text: '草稿', updatedAt: 't' }, scrollAnchor: null })
  })
  it('cacheMessages 调 chat:cache-messages（void 信封）', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({ ok: true, data: undefined })
    const input = { conversationId: 'c1', messages: [{ messageId: 'm1', conversationId: 'c1', role: 'user', content: 'hi', status: 'completed', createdAt: 't' }], updatedAt: 't' }
    await expect(desktopApi.cacheMessages(input)).resolves.toBeUndefined()
    expect(mockIpc.invoke).toHaveBeenCalledWith('chat:cache-messages', input)
  })
  it('hydratePersistence 调 chat:hydrate-persistence（0 参）并解包 SessionPersistenceState', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    const state = { drafts: [{ conversationId: 'c1', text: '草稿', attachmentLocalIds: [], updatedAt: 't' }], scrollAnchors: {}, conversations: [], messageSnapshots: {} }
    mockIpc.invoke.mockResolvedValue({ ok: true, data: state })
    await expect(desktopApi.hydratePersistence()).resolves.toEqual(state)
    expect(mockIpc.invoke).toHaveBeenCalledWith('chat:hydrate-persistence')
  })
  it('openExternal 调 app:open-external（{url} 包裹, void）', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({ ok: true, data: undefined })
    await expect(desktopApi.openExternal('https://example.com/')).resolves.toBeUndefined()
    expect(mockIpc.invoke).toHaveBeenCalledWith('app:open-external', { url: 'https://example.com/' })
  })
  it('hydratePersistence 失败信封 → 抛 [code] message', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({ ok: false, error: { code: 'LOAD_FAILED', message: '水合失败' } })
    await expect(desktopApi.hydratePersistence()).rejects.toThrow('[LOAD_FAILED] 水合失败')
  })
  it('persistSession 响应 schema 校验失败（缺 evictedConversationIds 形状）→ [SCHEMA_VALIDATION_FAILED]', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({ ok: true, data: { bogus: 1 } })
    await expect(desktopApi.persistSession({ conversationId: 'c1', draft: { text: '', updatedAt: 't' }, scrollAnchor: null }))
      .rejects.toThrow('[SCHEMA_VALIDATION_FAILED] IPC 响应校验失败')
  })
})
```

- [ ] **Step 2: 实现**——`apps/desktop/src/preload/desktop-api.ts`：

  import 追加（`@shared/contracts`）：`CacheMessagesInput, OpenExternalInput, PersistSessionInput, PersistSessionResult, SessionPersistenceState`；`@shared/schemas` 追加：`CacheMessagesInputSchema, OpenExternalInputSchema, PersistSessionInputSchema, PersistSessionResultSchema, SessionPersistenceStateSchema`。

  方法（`getConnectionState` 之后、订阅函数之前）：
```ts
async function hydratePersistence(): Promise<SessionPersistenceState> {
  return unwrap(await invoke<SessionPersistenceState>(IpcChannels.chatHydratePersistence), SessionPersistenceStateSchema)
}
async function persistSession(input: PersistSessionInput): Promise<PersistSessionResult> {
  return unwrap(await invokeWithArgs<PersistSessionResult>(IpcChannels.chatPersistSession, input), PersistSessionResultSchema)
}
async function cacheMessages(input: CacheMessagesInput): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.chatCacheMessages, input), z.undefined())
}
async function openExternal(url: string): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.appOpenExternal, { url }), z.undefined())
}
```

  `desktopApi` 对象追加：`hydratePersistence, persistSession, cacheMessages, openExternal`。

  `apps/desktop/src/preload/index.d.ts`：import 类型追加 `CacheMessagesInput, OpenExternalInput, PersistSessionInput, PersistSessionResult, SessionPersistenceState`；`Window.desktopApi` 追加 4 方法签名。

- [ ] **Step 3: 跑测试**——`pnpm -F @cyrene/desktop test -- tests/unit/desktop-api-chat.spec.ts` 预期 PASS；`pnpm -F @cyrene/desktop typecheck` 预期 PASS。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/src/preload/desktop-api.ts apps/desktop/src/preload/index.d.ts apps/desktop/tests/unit/desktop-api-chat.spec.ts
git commit -m "feat(G2 preload): 四新通道信封解包 + Window.desktopApi 类型同步"
```

---

### Task 11: bootstrap 离线水合 + 离线切换 + main.ts 装配（P1-1/P2-2）

**Files:**
- Modify: `apps/desktop/src/renderer/src/bootstrap.ts`
- Modify: `apps/desktop/src/renderer/src/main.ts`
- Modify: `tests/unit/renderer-bootstrap.spec.ts`

**Interfaces:**
- Consumes: `api.hydratePersistence`、`stores.draft.hydrate`、`stores.cache.hydrate`、`stores.conversation.setOfflineCache/activateLocal`
- Produces: `BootstrapStores` 扩展 `draft: { hydrate(state: SessionPersistenceState): void }`、`cache: { hydrate(state: SessionPersistenceState): void }`、`conversation` 增 `setOfflineCache(conversations: Conversation[]): void; activateLocal(id: string): Promise<void>`；`createRendererBootstrap.register()` 流程：注册订阅 → `hydratePersistence()` 水合 draft/cache → `getConnectionState()` snapshot：connected → 走既有编排（缓存不进入 messageStore，P2-2）；disconnected → `setOfflineCache` + `activateLocal(target)`（lastActive 或 updatedAt 最近会话，P1-1）

- [ ] **Step 1: 改既有 helpers + 写失败测试**——`tests/unit/renderer-bootstrap.spec.ts`：**先改 `makeFake()` 与 `makeStores()` 两个顶层 helper**（否则既有 4 用例因 register() 新流程访问 `api.hydratePersistence`/`stores.draft.hydrate` 运行时崩溃）：

```ts
function makeFake() {
  const stateHandlers: Array<(s: ConnectionState) => void> = []
  let resolveSnapshot: ((s: ConnectionState) => void) | undefined
  let rejectSnapshot: ((e: Error) => void) | undefined
  const api = {
    onChatEvent: vi.fn(() => () => {}),
    onChatState: vi.fn((h: (s: ConnectionState) => void) => { stateHandlers.push(h); return () => {} }),
    onChatReplay: vi.fn(() => () => {}),
    onChatError: vi.fn(() => () => {}),
    getConnectionState: vi.fn(() => new Promise<ConnectionState>((res, rej) => { resolveSnapshot = res; rejectSnapshot = rej })),
    hydratePersistence: vi.fn(async () => ({ drafts: [], scrollAnchors: {}, conversations: [], messageSnapshots: {} })), // G2 新增
    fireState: (s: ConnectionState) => stateHandlers.forEach((h) => h(s)),
    resolveSnapshot: (s: ConnectionState) => resolveSnapshot?.(s),
    rejectSnapshot: (e: Error) => rejectSnapshot?.(e)
  }
  return api
}
function makeStores() {
  return {
    connection: { setState: vi.fn(), setError: vi.fn() },
    message: { applyEvent: vi.fn(), handleConnectionStateChange: vi.fn(), loadReplay: vi.fn() },
    conversation: { onConnected: vi.fn(async () => {}), onActiveConversationAppeared: vi.fn(async () => {}) },
    draft: { hydrate: vi.fn() },                    // G2 新增
    cache: { hydrate: vi.fn() }                     // G2 新增
  }
}
```

  追加 G2 describe（`stores.conversation` 需补 `setOfflineCache`/`activateLocal`——在 G2 用例内用 `Object.assign(stores.conversation, { setOfflineCache: vi.fn(), activateLocal: vi.fn(async () => {}) })` 或扩展 makeStores）：

```ts
import type { SessionPersistenceState } from '@shared/contracts'

const offlineState: SessionPersistenceState = {
  drafts: [{ conversationId: 'c1', text: '草稿', attachmentLocalIds: [], updatedAt: 't' }],
  scrollAnchors: {}, lastActiveConversationId: 'c1',
  conversations: [{ id: 'c1', title: 'A', updatedAt: 't' }],
  messageSnapshots: { c1: [] }
}

describe('G2 持久化水合 + 离线视图（spec §4.5.3 P1-1/P2-2）', () => {
  function makeG2Stores() {
    const stores = makeStores()
    return {
      ...stores,
      conversation: { ...stores.conversation, setOfflineCache: vi.fn(), activateLocal: vi.fn(async () => {}) }
    }
  }
  it('register 调 hydratePersistence 并水合 draft/cache store', async () => {
    const api = makeFake(); const stores = makeG2Stores()
    ;(api.hydratePersistence as ReturnType<typeof vi.fn>).mockResolvedValue(offlineState)
    createRendererBootstrap(api as never, stores as never).register()
    await Promise.resolve()
    expect(api.hydratePersistence).toHaveBeenCalled()
    expect(stores.draft.hydrate).toHaveBeenCalledWith(offlineState)
    expect(stores.cache.hydrate).toHaveBeenCalledWith(offlineState)
  })
  it('disconnected snapshot → setOfflineCache + activateLocal(lastActive)（离线视图可读，消息快照进 messageStore）', async () => {
    const api = makeFake(); const stores = makeG2Stores()
    ;(api.hydratePersistence as ReturnType<typeof vi.fn>).mockResolvedValue(offlineState)
    createRendererBootstrap(api as never, stores as never).register()
    api.resolveSnapshot({ status: 'disconnected' })
    await Promise.resolve()
    expect(stores.conversation.setOfflineCache).toHaveBeenCalledWith(offlineState.conversations)
    expect(stores.conversation.activateLocal).toHaveBeenCalledWith('c1')
  })
  it('disconnected 且 lastActive 不在缓存 → 退化到 updatedAt 最近会话', async () => {
    const api = makeFake(); const stores = makeG2Stores()
    ;(api.hydratePersistence as ReturnType<typeof vi.fn>).mockResolvedValue({ ...offlineState, lastActiveConversationId: 'gone', conversations: [{ id: 'c2', title: 'B', updatedAt: 'z' }] })
    createRendererBootstrap(api as never, stores as never).register()
    api.resolveSnapshot({ status: 'disconnected' })
    await Promise.resolve()
    expect(stores.conversation.activateLocal).toHaveBeenCalledWith('c2')
  })
  it('connected snapshot → 不激活离线视图、不把快照写进 messageStore（P2-2 缓存不进入 Store）', async () => {
    const api = makeFake(); const stores = makeG2Stores()
    ;(api.hydratePersistence as ReturnType<typeof vi.fn>).mockResolvedValue(offlineState)
    createRendererBootstrap(api as never, stores as never).register()
    api.resolveSnapshot({ status: 'connected', connectionId: 'c1', activeConversationId: 'conv1' })
    await Promise.resolve()
    expect(stores.conversation.setOfflineCache).not.toHaveBeenCalled()
    expect(stores.conversation.activateLocal).not.toHaveBeenCalled()
    expect(stores.conversation.onConnected).toHaveBeenCalledWith('c1')
  })
})
```

  预期 FAIL：`BootstrapStores` 无 draft/cache；register() 未做离线分支（`stores.conversation.setOfflineCache`/`activateLocal` 未被调）。

- [ ] **Step 2: 实现**——`bootstrap.ts` 修改：

  `BootstrapStores` 扩展：
```ts
import type { Conversation, SessionPersistenceState } from '@shared/contracts'

export interface BootstrapStores {
  connection: { setState(s: ConnectionState): void; setError(e: PublicError): void }
  message: { applyEvent(e: unknown): void; handleConnectionStateChange(s: ConnectionState): void; loadReplay(conversationId: string, messages: unknown[]): void }
  conversation: {
    onConnected(connectionId?: string): Promise<void>
    onActiveConversationAppeared(activeId: string): Promise<void>
    setOfflineCache(conversations: Conversation[]): void
    activateLocal(id: string): Promise<void>
  }
  draft: { hydrate(state: SessionPersistenceState): void }
  cache: { hydrate(state: SessionPersistenceState): void }
}
```

  `register()` 尾部：**替换既有「getConnectionState snapshot 水合」块**（epoch 守卫保留；新流程先 `hydratePersistence` 再取 snapshot，两条写 messageStore 的路径——离线水合 vs 在线后端水合——不同时激活，P2-2）：
```ts
    const captured = stateEpoch
    void api.hydratePersistence().then((state) => {
      stores.draft.hydrate(state)
      stores.cache.hydrate(state)
      return api.getConnectionState().then((snapshot) => {
        if (stateEpoch === captured) applyChatState(snapshot)
        if (snapshot.status === 'disconnected') {
          // 离线水合（P2-2 只发生在 disconnected 分支；connected 分支缓存不进入 messageStore）
          stores.conversation.setOfflineCache(state.conversations)
          const ids = new Set(state.conversations.map((c) => c.id))
          const target = state.lastActiveConversationId && ids.has(state.lastActiveConversationId)
            ? state.lastActiveConversationId
            : state.conversations[0]?.id
          if (target) void stores.conversation.activateLocal(target) // P1-1：绕过 api.activate/getMessages 载入快照
        }
      }).catch((e) => {
        stores.connection.setError(e instanceof Error ? { code: 'UNKNOWN', message: e.message } : { code: 'UNKNOWN', message: String(e) })
      })
    }).catch((e) => {
      // 持久化水合失败 fail-open：不影响启动，随后连接建立由后端全量调和
      stores.connection.setError(e instanceof Error ? { code: 'UNKNOWN', message: e.message } : { code: 'UNKNOWN', message: String(e) })
    })
```

  `apps/desktop/src/renderer/src/main.ts`：bootstrap 传入 draft/cache：
```ts
  createRendererBootstrap(window.desktopApi, {
    connection: useConnectionStore(),
    message: useMessageStore(),
    conversation: useConversationStore(),
    draft: useDraftStore(),
    cache: useCacheStore()
  }).register()
```
  （`useDraftStore`/`useCacheStore` import 追加。）

- [ ] **Step 3: 跑测试**——`pnpm -F @cyrene/desktop test -- tests/unit/renderer-bootstrap.spec.ts` 预期 PASS（既有用例的 `makeStores` 缺 draft/cache → 用 `as never` 已兼容，若类型收紧则按测试文件补对象）。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/src/renderer/src/bootstrap.ts apps/desktop/src/renderer/src/main.ts apps/desktop/tests/unit/renderer-bootstrap.spec.ts
git commit -m "feat(G2 bootstrap): 持久化水合 + disconnected 离线视图水合/activateLocal 切换（P1-1/P2-2）"
```

---

### Task 12: Markdown 代码块包裹 + clipboard + 尾沿防抖（纯逻辑）

**Files:**
- Modify: `apps/desktop/src/renderer/src/utils/markdown.ts`
- Create: `apps/desktop/src/renderer/src/utils/clipboard.ts`
- Create: `apps/desktop/src/renderer/src/utils/debounce-trailing.ts`
- Modify: `tests/unit/markdown-sanitize.spec.ts`

**Interfaces:**
- Consumes: `marked`、`renderMarkdown` 既有
- Produces（Task 13 消费）: `wrapCodeBlocks(html: string): string`（sanitize 后字符串处理，语言标签 + 复制按钮占位，无高亮库）；`trimCodeText(text: string): string`（复制文本尾部换行 trim）；`copyText(text: string, env?: { navigator?: { clipboard?: { writeText(t: string): Promise<void> } }; document?: Document }): Promise<boolean>`（navigator.clipboard 优先 + execCommand 兜底，Web API 不经 IPC）；`createTrailingDebounce<TArgs extends unknown[]>(fn: (...args: TArgs) => void, delayMs: number, env?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout }): (...args: TArgs) => void`

- [ ] **Step 1: 写失败测试**——`tests/unit/markdown-sanitize.spec.ts` 追加 + 新 `tests/unit/clipboard.spec.ts` / `tests/unit/debounce-trailing.spec.ts`：

`markdown-sanitize.spec.ts` 追加：
```ts
import { renderMarkdown, wrapCodeBlocks, trimCodeText } from '../../src/renderer/src/utils/markdown'

describe('阶段 3 G2 代码块（spec §4.6.1 D7）', () => {
  it('renderMarkdown 输出含 cy-code-block 包裹 + 语言标签 + 保留 <code>（复制取文）', () => {
    const html = renderMarkdown('```ts\nconst a = 1\n```')
    expect(html).toContain('cy-code-block')
    expect(html).toContain('cy-code-lang')
    expect(html).toContain('ts')
    expect(html).toContain('<code class="language-ts">')
  })
  it('wrapCodeBlocks 无语言 → 默认「代码」', () => {
    expect(wrapCodeBlocks('<pre><code>plain</code></pre>')).toContain('代码')
  })
  it('trimCodeText 去尾部换行', () => {
    expect(trimCodeText('a\nb\n\n')).toBe('a\nb')
  })
  it('代码内容含 <script> 被 sanitize 转义/剥离不执行（CSP 纵深）', () => {
    const html = renderMarkdown('```html\n<script>alert(1)</script>\n```')
    expect(html).not.toContain('<script>alert')
  })
})
```

`tests/unit/clipboard.spec.ts`（新建）：
```ts
// tests/unit/clipboard.spec.ts —— copyText：navigator.clipboard 优先 + execCommand 兜底（依赖注入，spec §4.6.1）。
import { describe, expect, it, vi } from 'vitest'
import { copyText } from '../../src/renderer/src/utils/clipboard'

describe('copyText', () => {
  it('navigator.clipboard.writeText 优先', async () => {
    const writeText = vi.fn(async () => {})
    const env = { navigator: { clipboard: { writeText } } }
    await expect(copyText('hi', env)).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('hi')
  })
  it('clipboard 抛错 → execCommand 兜底（document 注入）', async () => {
    const writeText = vi.fn(async () => { throw new Error('denied') })
    const execCommand = vi.fn(() => true)
    const doc = { createElement: () => ({ value: '', setAttribute: vi.fn(), style: {}, select: vi.fn(), remove: vi.fn() }), body: { appendChild: vi.fn(), removeChild: vi.fn() }, execCommand } as never
    await expect(copyText('hi', { navigator: { clipboard: { writeText } }, document: doc })).resolves.toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
  })
  it('无 clipboard 无 document → false', async () => {
    await expect(copyText('hi', {})).resolves.toBe(false)
  })
})
```

`tests/unit/debounce-trailing.spec.ts`（新建）：
```ts
// tests/unit/debounce-trailing.spec.ts —— 尾沿防抖（流式渲染 80ms 节流，spec §4.6.3）。
import { describe, expect, it, vi } from 'vitest'
import { createTrailingDebounce } from '../../src/renderer/src/utils/debounce-trailing'

describe('createTrailingDebounce', () => {
  it('连续调用合并到停顿后一次执行（尾沿）', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const env = { setTimeout: vi.fn((cb: () => void, ms: number) => setTimeout(cb, ms)), clearTimeout }
    const d = createTrailingDebounce(fn, 80, env)
    d('a'); vi.advanceTimersByTime(40); d('b'); vi.advanceTimersByTime(80)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('b')
    vi.useRealTimers()
  })
  it('停顿后最终文本必渲染（防抖不吞末次调用）', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const d = createTrailingDebounce(fn, 80, { setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms), clearTimeout })
    d('final'); vi.advanceTimersByTime(80)
    expect(fn).toHaveBeenCalledWith('final')
    vi.useRealTimers()
  })
})
```

  预期 FAIL：`wrapCodeBlocks`/`trimCodeText`/`copyText`/`createTrailingDebounce` 不存在。

- [ ] **Step 2: 实现**——

  `apps/desktop/src/renderer/src/utils/clipboard.ts`（新建）：
```ts
// 复制工具（spec §4.6.1）：navigator.clipboard 优先 + document.execCommand 兜底。Web API，不经 IPC。
export interface ClipboardEnv {
  navigator?: { clipboard?: { writeText(text: string): Promise<void> } }
  document?: Pick<Document, 'createElement' | 'body' | 'execCommand'>
}

export async function copyText(text: string, env: ClipboardEnv = {}): Promise<boolean> {
  const nav = env.navigator ?? (typeof navigator !== 'undefined' ? navigator : undefined)
  if (nav?.clipboard?.writeText) {
    try { await nav.clipboard.writeText(text); return true } catch { /* 降级 execCommand */ }
  }
  const doc = env.document ?? (typeof document !== 'undefined' ? document : undefined)
  if (doc) {
    const ta = doc.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    doc.body.appendChild(ta)
    ta.select()
    const ok = doc.execCommand('copy')
    doc.body.removeChild(ta)
    return ok
  }
  return false
}
```

  `apps/desktop/src/renderer/src/utils/debounce-trailing.ts`（新建）：
```ts
// 尾沿防抖（spec §4.6.3 流式渲染 80ms 节流）：可注入定时器便于单测。
export interface TimerEnv {
  setTimeout: (cb: () => void, ms: number) => unknown
  clearTimeout: (id: unknown) => void
}

export function createTrailingDebounce<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  delayMs: number,
  env?: TimerEnv
): (...args: TArgs) => void {
  const st = env?.setTimeout ?? ((cb: () => void, ms: number) => setTimeout(cb, ms))
  const ct = env?.clearTimeout ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>))
  let timer: unknown
  return (...args: TArgs): void => {
    if (timer !== undefined) ct(timer)
    timer = st(() => { timer = undefined; fn(...args) }, delayMs)
  }
}
```

  `apps/desktop/src/renderer/src/utils/markdown.ts`（追加两个导出 + `renderMarkdown` 尾接包裹）：
```ts
/** 代码块包裹（sanitize 后字符串处理，spec §4.6.1 D7）：语言标签 + 复制按钮占位；无高亮库，代码内容保持转义文本。
 *  保留 `<code>` 元素（复制交互经 `pre code` 取 textContent），语言从 `language-xxx` class 提取，无则「代码」。 */
export function wrapCodeBlocks(html: string): string {
  return html.replace(/<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/gi, (m, attrs: string, body: string) => {
    const langMatch = /class="[^"]*\blanguage-([a-zA-Z0-9_+-]+)[^"]*"/.exec(attrs)
    const lang = langMatch ? langMatch[1] : '代码'
    return `<div class="cy-code-block"><div class="cy-code-head"><span class="cy-code-lang">${lang}</span><button type="button" class="cy-code-copy" aria-label="复制代码">复制</button></div><pre><code${attrs}>${body}</code></pre></div>`
  })
}

/** 复制文本：去尾部换行（spec §4.6.1） */
export function trimCodeText(text: string): string {
  return text.replace(/\n+$/, '')
}

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false })
  return wrapCodeBlocks(sanitizeHtml(html)) // sanitize 后再包裹，复制按钮不被打回
}
```

- [ ] **Step 3: 跑测试**——`pnpm -F @cyrene/desktop test -- tests/unit/markdown-sanitize.spec.ts tests/unit/clipboard.spec.ts tests/unit/debounce-trailing.spec.ts` 预期 PASS。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/src/renderer/src/utils/markdown.ts apps/desktop/src/renderer/src/utils/clipboard.ts apps/desktop/src/renderer/src/utils/debounce-trailing.ts apps/desktop/tests/unit/markdown-sanitize.spec.ts apps/desktop/tests/unit/clipboard.spec.ts apps/desktop/tests/unit/debounce-trailing.spec.ts
git commit -m "feat(G2 markdown): 代码块包裹/复制文本 + clipboard 工具 + 尾沿防抖"
```

---

### Task 13: CyMarkdown 组件 —— 代码块复制/外部链接/流式防抖

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/CyMarkdown.vue`
- 验收门禁：`pnpm -F @cyrene/desktop typecheck:web` + `pnpm -F @cyrene/desktop build`（组件任务无单测基线，G3 同款纪律）

**Interfaces:**
- Consumes: `renderMarkdown`/`trimCodeText`、`copyText`、`createTrailingDebounce`（Task 12）、`api.openExternal`（`stores/desktop-api`）
- Produces: 事件委托 `@click`（`.cy-code-copy` → 复制 + 「已复制」反馈；`a[href]` → `preventDefault` + `confirm` + `api.openExternal`）；`html` 改为 ref + 80ms 尾沿防抖重解析（首次挂载立即渲染、停顿/完成保证最终文本）

- [ ] **Step 1: 重写 script 与模板**

```vue
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { renderMarkdown, trimCodeText } from '../utils/markdown'
import { copyText } from '../utils/clipboard'
import { createTrailingDebounce } from '../utils/debounce-trailing'
import { api } from '../stores/desktop-api'

const props = defineProps<{ source: string }>()

const MARKDOWN_DEBOUNCE_MS = 80
const html = ref('')
let disposed = false
// 尾沿防抖：流式 delta 高频变化合并重解析；停顿/完成保证最终文本（spec §4.6.3）
const scheduleRender = createTrailingDebounce(() => { if (!disposed) html.value = renderMarkdown(props.source) }, MARKDOWN_DEBOUNCE_MS)

watch(() => props.source, () => scheduleRender())
onMounted(() => { html.value = renderMarkdown(props.source) })
onBeforeUnmount(() => { disposed = true })

/** 事件委托（CSP-safe，无内联 handler，spec §4.6.1/§4.6.2） */
function onClick(e: MouseEvent): void {
  const target = e.target as HTMLElement
  const copyBtn = target.closest<HTMLElement>('.cy-code-copy')
  if (copyBtn) {
    const block = copyBtn.closest<HTMLElement>('.cy-code-block')
    const code = block?.querySelector<HTMLElement>('pre code')
    if (code) {
      void copyText(trimCodeText(code.textContent ?? '')).then((ok) => {
        if (!ok) return
        copyBtn.textContent = '已复制'
        setTimeout(() => { if (copyBtn.isConnected) copyBtn.textContent = '复制' }, 1500)
      })
    }
    e.preventDefault()
    return
  }
  const link = target.closest<HTMLAnchorElement>('a[href]')
  if (link) {
    const href = link.getAttribute('href') ?? ''
    if (/^https?:\/\//i.test(href)) {
      if (window.confirm('在浏览器中打开外部链接？')) void api.openExternal(href)
    }
    e.preventDefault() // 一律阻止默认导航（app 窗口内不开窗）
  }
}
</script>

<template>
  <div class="cy-markdown" v-html="html" @click="onClick" />
</template>
```

  样式追加（`:deep()`）：
```css
.cy-markdown :deep(.cy-code-block) { margin: 0 0 8px; border-radius: 8px; overflow: hidden; border: 1px solid var(--cy-border); background: var(--cy-surface-soft); }
.cy-markdown :deep(.cy-code-head) { display: flex; align-items: center; justify-content: space-between; padding: 4px 8px; background: var(--cy-surface); }
.cy-markdown :deep(.cy-code-lang) { color: var(--cy-muted); font-size: 11px; }
.cy-markdown :deep(.cy-code-copy) { border: 0; background: transparent; color: var(--cy-muted); font-size: 11px; cursor: pointer; }
.cy-markdown :deep(.cy-code-copy:hover) { color: var(--cy-text); }
.cy-markdown :deep(.cy-code-block pre) { margin: 0; border: 0; border-radius: 0; }
```

- [ ] **Step 2: 验证门禁**——`pnpm -F @cyrene/desktop typecheck:web` + `pnpm -F @cyrene/desktop build` 预期 PASS；`pnpm -F @cyrene/desktop test -- tests/unit/markdown-sanitize.spec.ts` 不回退。

- [ ] **Step 3: 提交**

```bash
git add apps/desktop/src/renderer/src/components/CyMarkdown.vue
git commit -m "feat(G2 CyMarkdown): 代码块复制按钮/外部链接委托/流式尾沿防抖"
```

---

### Task 14: CyMessageList 自研虚拟列表 + CyChatView 接入（D3/D5/D6）

**Files:**
- Create: `apps/desktop/src/renderer/src/components/CyMessageList.vue`
- Modify: `apps/desktop/src/renderer/src/components/CyChatView.vue`
- 验收门禁：`pnpm -F @cyrene/desktop typecheck:web` + `pnpm -F @cyrene/desktop build`

**Interfaces:**
- Consumes: `messageStore.order/byId/hasMoreBefore/loadingOlder/isStreaming`（`activeGenerationId`）、`conversationStore.currentId`、`draftStore.setScrollAnchor/flush`、`virtual-window` 全函数、`OVERSCAN_PX`；`conversationStore.offlineView`
- Produces: 自渲染虚拟窗口（`computeWindow` 切 `visibleIds` + 上下 padding）；ResizeObserver 实测写 `heights`；`atBottom` 判定 + 流式跟随 + 悬浮「回到底部」；顶部哨兵触发 `loadOlder()`；锚点捕获（滚动/窗口变化时 `captureAnchor` → 存 `lastAnchor`/`lastConvId`）→ `currentId` 变化 watch 中「先捕获后 flush」`draftStore.setScrollAnchor(old, anchor)` + `draftStore.flush(old)`；回会话恢复策略（D6：锚点在页→`restoreScrollTop`；不在且有更早→首屏顶部；否则→底部）；高度补偿（锚点上方实测变化累计 delta 调 scrollTop）；空态（`isEmpty`）/流式占位（底部相邻）；离线视图空态提示

- [ ] **Step 1: 创建 CyMessageList.vue**

```vue
<script setup lang="ts">
// CyMessageList：自研轻量虚拟列表（spec §4.3.2/§4.3.4 D3/D5/D6）。
// 估高 + ResizeObserver 实测 + 前缀和二分窗口；向上加载锚点不跳动；切会话草稿+锚点 flush。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useConnectionStore } from '../stores/connection.store'
import { useConversationStore } from '../stores/conversation.store'
import { useMessageStore } from '../stores/message.store'
import { useDraftStore } from '../stores/draft.store'
import CyMessageBubble from './CyMessageBubble.vue'
import { buildPrefix, captureAnchor, computeWindow, estimateHeight, restoreScrollTop, OVERSCAN_PX } from '../utils/virtual-window'

const messageStore = useMessageStore()
const conversationStore = useConversationStore()
const connectionStore = useConnectionStore()
const draftStore = useDraftStore()

const container = ref<HTMLElement>()
const heights = ref<Record<string, number>>({})          // 实测高（ResizeObserver）
const rowEls = new Map<string, HTMLElement>()            // messageId → 行元素
const resizeObs = ref<ResizeObserver>()

/** 窗口化后的可见顺序（order 恒 (createdAt, messageId) 升序，P0-1 不变量） */
const items = computed(() => messageStore.order.map((id) => messageStore.byId[id]).filter(Boolean))
const prefix = computed(() => buildPrefix(items.value, heights.value))
const scrollTop = ref(0)
const viewportHeight = ref(600)
const atBottom = ref(true)
const pendingCompensation = ref(0)

/** 连续维护的锚点（scroll/窗口变化时更新；切会话时「先捕获后 flush」用它） */
const lastAnchor = ref<{ conversationId: string; anchor: ReturnType<typeof captureAnchor> }>()
/** 评审 P1-2：loadOlder 前捕获的锚点（前插后 restoreScrollTop 恢复可视位置，向上翻不跳动） */
const pendingLoadAnchor = ref<ReturnType<typeof captureAnchor>>()

const isStreaming = computed(() => !!messageStore.activeGenerationId)
const isEmpty = computed(() => items.value.length === 0)

const win = computed(() => {
  const w = computeWindow(prefix.value, scrollTop.value, viewportHeight.value, OVERSCAN_PX)
  return {
    startIndex: w.startIndex,
    endIndex: w.endIndex,
    paddingTop: w.paddingTop,
    paddingBottom: w.paddingBottom,
    visibleIds: items.value.slice(w.startIndex, w.endIndex + 1).map((m) => m.messageId)
  }
})

/** D6 恢复守卫：每会话激活只恢复一次 */
let restoreEpoch = 0

function onScroll(): void {
  const el = container.value
  if (!el) return
  scrollTop.value = el.scrollTop
  atBottom.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 40
  captureCurrent()
  // 顶部哨兵：更早历史 + 非加载中 → loadOlder（D5）。
  // 评审 P1-2：前插前 captureAnchor、前插完成后 restoreScrollTop——否则新页整块前插会把锚点/可视消息往下推
  //（scrollTop 数值不变但内容上移，用户视角跳动）。
  if (el.scrollTop <= 40 && messageStore.hasMoreBefore && !messageStore.loadingOlder) {
    pendingLoadAnchor.value = captureAnchor(items.value, prefix.value, el.scrollTop, el.clientHeight)
    void messageStore.loadOlder().then(() => restoreLoadAnchor())
  }
}

/** 评审 P1-2：loadOlder 有序插入后恢复锚点可视位置（restoreScrollTop 让前缀和含前插高度；估高误差由 onRowResized 补偿） */
function restoreLoadAnchor(): void {
  const el = container.value
  const anchor = pendingLoadAnchor.value
  if (!el || !anchor?.messageId) return
  pendingLoadAnchor.value = undefined
  void nextTick(() => {
    const target = restoreScrollTop(items.value, prefix.value, anchor)
    if (target > 0 && container.value) {
      container.value.scrollTop = target
      scrollTop.value = container.value.scrollTop
      atBottom.value = container.value.scrollTop + container.value.clientHeight >= container.value.scrollHeight - 40
    }
  })
}

/** 持续捕获锚点（切会话时用它做「先捕获再 flush」） */
function captureCurrent(): void {
  const el = container.value
  if (!el || items.value.length === 0) return
  const a = captureAnchor(items.value, prefix.value, el.scrollTop, el.clientHeight)
  if (a.messageId) lastAnchor.value = { conversationId: conversationStore.currentId ?? '', anchor: a }
}

/** 行实测：写 heights 并补偿锚点上方变化（D5，防估→实测推走锚点；评审 P1-2 前插行首测按实测-估高补差） */
function onRowResized(id: string, entry: ResizeObserverEntry): void {
  const h = entry.contentRect.height
  const prev = heights.value[id]
  if (prev === h) return
  heights.value[id] = h
  const anchorId = lastAnchor.value?.anchor.messageId ?? pendingLoadAnchor.value?.messageId
  if (anchorId === id) return
  const anchorIdx = anchorId ? items.value.findIndex((m) => m.messageId === anchorId) : -1
  const idx = items.value.findIndex((m) => m.messageId === id)
  if (anchorIdx > 0 && idx >= 0 && idx < anchorIdx) {
    // P1-2：前插行首测（prev undefined，此前用估高渲染）按「实测-估高」补差，防估高误差把锚点推走；
    // 已测行按实测增量（既有 D5 语义）
    const delta = prev !== undefined ? h - prev : h - estimateHeight(items.value[idx])
    pendingCompensation.value += delta
    if (container.value && pendingCompensation.value !== 0) {
      container.value.scrollTop += pendingCompensation.value
      scrollTop.value = container.value.scrollTop
      pendingCompensation.value = 0
    }
  }
}

/** 切会话：先捕获（持续维护的 lastAnchor）再 flush 旧会话草稿+锚点（D6 时序定死）；
 *  恢复不在 currentId watch 里做（activate 首屏异步，nextTick 时 order 仍空），改由 items.length watch 在页面加载后触发 */
let pendingRestoreId: string | undefined
watch(() => conversationStore.currentId, (id, oldId) => {
  restoreEpoch++
  if (oldId && lastAnchor.value && lastAnchor.value.conversationId === oldId) {
    draftStore.setScrollAnchor(oldId, lastAnchor.value.anchor)
    void draftStore.flush(oldId)
  }
  heights.value = {}
  scrollTop.value = 0
  atBottom.value = true
  pendingRestoreId = id ?? undefined
})

/** 回会话恢复策略（D6）：锚点在已加载页→精确恢复；不在且有更早→首屏顶部；否则→底部（离线 loadSnapshot 同步载入也走此路径） */
watch(() => items.value.length, (len) => {
  if (len > 0 && pendingRestoreId === conversationStore.currentId) {
    pendingRestoreId = undefined
    void nextTick(() => restoreScrollFor(conversationStore.currentId!))
  }
})

function restoreScrollFor(id: string): void {
  const el = container.value
  if (!el) return
  const anchor = draftStore.scrollAnchors[id]
  const idx = anchor ? items.value.findIndex((m) => m.messageId === anchor.messageId) : -1
  if (anchor && idx >= 0) {
    el.scrollTop = restoreScrollTop(items.value, prefix.value, anchor)
  } else if (anchor && messageStore.hasMoreBefore) {
    el.scrollTop = 0 // 首屏顶部边界：可继续上翻，不突兀跳底
  } else {
    el.scrollTop = el.scrollHeight
  }
  scrollTop.value = el.scrollTop
  atBottom.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 40
}

function backToBottom(): void {
  const el = container.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  atBottom.value = true
}

/** 行引用注册（ResizeObserver 观察） */
function setRowEl(id: string, el: Element | null): void {
  if (el) { rowEls.set(id, el as HTMLElement); resizeObs.value?.observe(el) }
  else { const prev = rowEls.get(id); if (prev) { resizeObs.value?.unobserve(prev); rowEls.delete(id) } }
}

onBeforeUnmount(() => { resizeObs.value?.disconnect() })

onMounted(() => {
  resizeObs.value = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const id = entry.target.getAttribute('data-message-id')
      if (id) onRowResized(id, entry)
    }
  })
  const el = container.value
  if (el) viewportHeight.value = el.clientHeight
  if (el && !conversationStore.offlineView) el.scrollTop = el.scrollHeight
})
</script>

<template>
  <div ref="container" class="cy-messages" aria-live="polite" @scroll.passive="onScroll">
    <div v-if="isEmpty" class="cy-empty">
      <p>{{ conversationStore.offlineView ? '该会话离线不可读或为空' : '新会话,开始对话' }}</p>
    </div>
    <template v-else>
      <div :style="{ height: win.paddingTop + 'px' }" class="cy-vlist-pad" />
      <div
        v-for="id in win.visibleIds"
        :key="id"
        :data-message-id="id"
        :ref="(el) => setRowEl(id, el as Element | null)"
        class="cy-vlist-row"
      >
        <CyMessageBubble :message="messageStore.byId[id]" />
      </div>
      <div :style="{ height: win.paddingBottom + 'px' }" class="cy-vlist-pad" />
      <div v-if="isStreaming" class="cy-streaming-placeholder">
        <span class="cy-typing-dot" />
        <span>生成中…</span>
      </div>
    </template>

    <button v-if="!atBottom && !isEmpty" class="cy-back-bottom" title="回到底部" @click="backToBottom">↓ 回到底部</button>
  </div>
</template>

<style scoped>
.cy-messages { position: relative; display: flex; flex: 1; flex-direction: column; min-height: 0; padding: 0 16px; overflow-y: auto; background: linear-gradient(180deg, var(--cy-surface) 0%, var(--cy-pane) 100%); }
.cy-vlist-row { display: flex; flex-direction: column; gap: 9px; padding: 6px 0; }
.cy-empty { display: grid; flex: 1; place-items: center; color: var(--cy-muted); font-size: 13px; }
.cy-back-bottom { position: sticky; bottom: 12px; align-self: center; padding: 6px 12px; border: 1px solid var(--cy-border); border-radius: 999px; background: var(--cy-surface); color: var(--cy-muted); font-size: 12px; cursor: pointer; }
.cy-streaming-placeholder { display: inline-flex; align-items: center; align-self: flex-start; gap: 8px; padding: 9px 13px; margin: 6px 0; color: var(--cy-muted); background: var(--cy-surface); border: 1px solid var(--cy-border); border-radius: 13px; font-size: 12px; }
.cy-typing-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--cy-accent-strong); animation: cy-pulse 1s ease-in-out infinite; }
@keyframes cy-pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
</style>
```

  注：`restoreEpoch` 仅在 currentId watch 自增（会话切换代次守卫，防切回后旧异步恢复覆盖新会话）；高度补偿 delta 语义已在 Task 3 `compensateScroll` 纯函数单测覆盖，组件内 `onRowResized` 做同式累计；评审 P1-2 的 loadOlder 前插锚点保持由 Task 3 新增前插回环纯函数测试覆盖（captureAnchor→前插→restoreScrollTop 后锚点消息+偏移不变），组件 `onScroll`/`restoreLoadAnchor`/`onRowResized` 即该机制的接线。

- [ ] **Step 2: CyChatView 接入**——删除 `watch([visibleIds, isStreaming])` 回底块与全量 `v-for`/空态/流式占位，模板改为：

```vue
    <CyMessageList />
    <CyChatInput />
```

  script 删去 `messagesRef`/`visibleIds`/`isEmpty`/`isStreaming` 中不再使用的部分（保留 `convTitle`/`canAct`/`newConversation`/状态展示）；`CyMessageBubble`/`watch`/`nextTick`/`ref` import 按需收敛；import `CyMessageList`。

- [ ] **Step 3: 验证门禁**——`pnpm -F @cyrene/desktop typecheck:web` + `pnpm -F @cyrene/desktop build` 预期 PASS；`pnpm -F @cyrene/desktop test -- tests/unit/virtual-window.spec.ts` 不回退。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/src/renderer/src/components/CyMessageList.vue apps/desktop/src/renderer/src/components/CyChatView.vue
git commit -m "feat(G2 CyMessageList): 自研虚拟列表 + 锚点捕获/恢复/补偿 + 切会话草稿flush + 回到底部"
```

---

### Task 15: CyChatInput 草稿接入 + 超限横幅 + CyConversationList 离线点击

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/CyChatInput.vue`
- Modify: `apps/desktop/src/renderer/src/components/CyConversationList.vue`
- 验收门禁：`pnpm -F @cyrene/desktop typecheck:web` + `pnpm -F @cyrene/desktop build`

**Interfaces:**
- Consumes: `draftStore.saveDraft/clear/overLimit/evictionNotice/dismissEviction`、`conversationStore.offlineView/activateLocal`、`connectionStore.state.status`
- Produces: 草稿源改 `draftStore`（`computed` get/set）；发送成功 `draftStore.clear`；超限常驻横幅「草稿已满（100KB 上限）」+ 清空按钮；淘汰一次性通知横幅（P2-1）；离线时 sidebar 点击走 `activateLocal`，在线走既有 `activate`

- [ ] **Step 1: CyChatInput 草稿接入**

  script 修改：
```ts
import { useDraftStore } from '../stores/draft.store'
const draftStore = useDraftStore()
const currentId = computed(() => conversationStore.currentId)
const draft = computed({
  get: () => (currentId.value ? draftStore.drafts[currentId.value] ?? '' : ''),
  set: (v: string) => { if (currentId.value) draftStore.saveDraft(currentId.value, v) }
})
const overLimit = computed(() => (currentId.value ? !!draftStore.overLimit[currentId.value] : false))
```
  `send()` 内 await send 返回后清空草稿（评审 P2-2，spec §4.4.1：失败保留草稿，不静默丢失）：
```ts
async function send(): Promise<void> {
  if (!canSend.value) return
  const ok = await messageStore.send(draft.value.trim()) // send 成功返回后才清空
  if (ok && currentId.value) draftStore.clear(currentId.value) // 失败保留草稿（spec §4.4.1）
}
```
  `canSend`/`onEnter` 保持（`draft.value` 语义不变）。

  模板追加（composer 内、断线横幅之后）：
```vue
    <div v-if="overLimit" class="cy-banner cy-error-banner" role="alert">
      <span class="cy-banner-dot" />
      <span>草稿已满（100KB 上限），超出部分未保存</span>
      <button class="cy-clear-draft" @click="currentId && draftStore.clear(currentId)">清空草稿</button>
    </div>
    <div v-if="draftStore.evictionNotice.length" class="cy-banner" role="status">
      <span class="cy-banner-dot" />
      <span>草稿已满：最早的非激活会话草稿已按策略清理（{{ draftStore.evictionNotice.length }} 个）</span>
      <button class="cy-clear-draft" @click="draftStore.dismissEviction()">知道了</button>
    </div>
```
  样式：`.cy-clear-draft { border: 0; background: transparent; color: var(--cy-accent-strong); font-size: 12px; cursor: pointer; margin-left: auto; }`。

- [ ] **Step 2: CyConversationList 离线点击**

  script 追加 `offlineClick`：
```ts
/** 离线视图：点击其他缓存会话 → activateLocal（P1-1 绕过 api.activate/getMessages）；在线 → 既有 activate */
function activateConv(id: string): void {
  if (connectionStore.state.status === 'disconnected') void conversationStore.activateLocal(id)
  else void conversationStore.activate(id)
}
```
  模板 `@click="conversationStore.activate(c.id)"` 改为 `@click="activateConv(c.id)"`。

- [ ] **Step 3: 验证门禁**——`pnpm -F @cyrene/desktop typecheck:web` + `pnpm -F @cyrene/desktop build` 预期 PASS；`pnpm -F @cyrene/desktop test -- tests/unit/draft.store.spec.ts tests/unit/conversation.store.spec.ts` 不回退。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/src/renderer/src/components/CyChatInput.vue apps/desktop/src/renderer/src/components/CyConversationList.vue
git commit -m "feat(G2 input/sidebar): 草稿源接入 draftStore + 超限/淘汰横幅 + 离线点击 activateLocal"
```

---

### Task 16: 集成测试（持久化生命周期 + 损坏恢复）+ 门禁全量 + 文档同步

**Files:**
- Create: `tests/integration/persistence-lifecycle.spec.ts`
- Modify: `tests/integration/helpers/app.ts`（`launchApp` 增可选 `seedFiles`，损坏恢复用例启动前注入非法 JSON）
- Modify: `docs/16-Cyrene-阶段执行检查清单与进度跟踪-v0.1.md`、`README.md`、`CLAUDE.md`、`docs/06-*.md`、`docs/03-*.md`、`docs/07-*.md`（文档同步，中文）

**Interfaces:**
- Consumes: Task 8/9 装配、既有 `ipcSecurity`/`trustBoundary` 集成测试模式（`launchApp` + 经 IPC 调 handler）
- Produces: 集成测试（经 IPC `persistSession`/`cacheMessages` → userData 文件出现预期行；`deleteConversation` → purge；`hydratePersistence` 回读一致；`persistSession` 触发淘汰响应含 `evictedConversationIds`；`cacheMessages` 超 4MiB 整批拒绝 `IPC_MESSAGE_TOO_LARGE`；损坏恢复：预写非法 JSON → 启动 hydrate 不抛 + `.corrupt-<ts>` 文件存在）

- [ ] **Step 1: 改 helpers + 写集成测试**——先改 `tests/integration/helpers/app.ts`：`launchApp` 增可选 `seedFiles`（预置损坏文件到真实 userData 路径 `join(userData, 'Cyrene', relPath)`，供损坏恢复用例在启动前注入）：

```ts
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join, extname, resolve, sep, dirname } from 'path'

/** 启动时预置文件（seedFiles.relPath 相对 userData 根，如 'app-cache/message-cache-v1.json'）——损坏恢复测试在 load() 前注入非法 JSON。
 *  目录 0700、文件 0600：否则 ensureUserDataDirs（0700 无 group/other）与 openSafeFile 读（0400 无 group/other）会因权限误判损坏/拒绝启动 */
export async function launchApp(seedFiles?: Array<{ relPath: string; content: string }>): Promise<LaunchedApp> {
  const electronPath = ELECTRON_EXEC
  const userData = mkdtempSync(join(tmpdir(), 'cy-int-ud-'))
  for (const f of seedFiles ?? []) {
    const p = join(userData, 'Cyrene', f.relPath)
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
    writeFileSync(p, f.content, { mode: 0o600 })
  }
  // ...（其余 env/launch 逻辑不变）...
}
```

  `tests/integration/persistence-lifecycle.spec.ts`（新建）：

```ts
// tests/integration/persistence-lifecycle.spec.ts —— spec §5：经 IPC 持久化生命周期（写→读→删）+ 淘汰告知 + IPC 大小上限 + 损坏隔离。
// 断言文件存在 + schemaVersion + 条目结构；草稿/缓存为敏感内容，不读正文断言（只比 schemaVersion/条目数/ID）。
import { describe, expect, it } from 'vitest'
import { launchApp, closeApp, type LaunchedApp } from './helpers/app'

async function readJsonFile(launched: LaunchedApp, relPath: string): Promise<unknown> {
  return launched.app.evaluate(({ app }, path) => {
    const fs = require('fs')
    const p = require('path').join(app.getPath('userData'), path)
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  }, relPath)
}
async function readDir(launched: LaunchedApp, relPath: string): Promise<string[]> {
  return launched.app.evaluate(({ app }, path) => {
    const fs = require('fs')
    return fs.readdirSync(require('path').join(app.getPath('userData'), path))
  }, relPath)
}
function msg(id: string, t: string) {
  return { messageId: id, conversationId: 'c1', role: 'user' as const, content: 'hi', status: 'completed' as const, createdAt: t }
}

describe('持久化生命周期（spec §5）', () => {
  it('persistSession/cacheMessages → 文件出现预期行 + hydrate 回读一致 + deleteConversation purge（含缓存会话列表，评审 P2-1）', async () => {
    // P2-1：预置缓存会话列表含 c1（无该种子断言无从验证删除联动清理列表）
    const launched = await launchApp([{ relPath: 'app-cache/message-cache-v1.json', content: JSON.stringify({ schemaVersion: 1, conversations: [{ id: 'c1', title: '会话', updatedAt: 't1' }], snapshots: {} }) }])
    try {
      const { page } = launched
      await page.evaluate(() => window.desktopApi.persistSession({ conversationId: 'c1', draft: { text: '草稿', updatedAt: 't1' }, scrollAnchor: { messageId: 'm1', offset: 5 } }))
      await page.evaluate(() => window.desktopApi.cacheMessages({ conversationId: 'c1', messages: [msg('m1', 't1')], updatedAt: 't1' }))
      const drafts = (await readJsonFile(launched, 'app-cache/drafts-v1.json')) as { schemaVersion: number; entries: Record<string, unknown> }
      expect(drafts.schemaVersion).toBe(1)
      expect(Object.keys(drafts.entries)).toContain('c1')
      const cache = (await readJsonFile(launched, 'app-cache/message-cache-v1.json')) as { schemaVersion: number; snapshots: Record<string, { messages: unknown[] }> }
      expect(cache.schemaVersion).toBe(1)
      expect(cache.snapshots['c1'].messages).toHaveLength(1)
      const h = await page.evaluate(() => window.desktopApi.hydratePersistence())
      expect(h.drafts.find((d) => d.conversationId === 'c1')?.text).toBe('草稿')
      expect(h.scrollAnchors['c1']).toEqual({ messageId: 'm1', offset: 5 })
      expect(h.messageSnapshots['c1']).toHaveLength(1)
      expect(h.conversations.some((c) => c.id === 'c1')).toBe(true) // P2-1：删除前缓存列表含 c1
      // deleteConversation → Main purge 草稿+锚点+快照+缓存会话列表（spec §4.5.1 + P2-1 删除联动）
      await page.evaluate(() => window.desktopApi.deleteConversation('c1'))
      const h2 = await page.evaluate(() => window.desktopApi.hydratePersistence())
      expect(h2.drafts.find((d) => d.conversationId === 'c1')).toBeUndefined()
      expect(h2.messageSnapshots['c1']).toBeUndefined()
      expect(h2.conversations.some((c) => c.id === 'c1')).toBe(false) // P2-1：删除联动清理缓存会话列表
    } finally { await closeApp(launched) }
  })

  it('persistSession 触发 50 会话淘汰 → 响应含 evictedConversationIds（P2-1）', async () => {
    const launched = await launchApp()
    try {
      const { page } = launched
      const last = await page.evaluate(async () => {
        let res: { evictedConversationIds?: string[] } = {}
        for (let i = 0; i < 52; i++) {
          res = await window.desktopApi.persistSession({ conversationId: `c${i}`, draft: { text: `d${i}`, updatedAt: `t${String(i).padStart(3, '0')}` }, scrollAnchor: null })
        }
        return res
      })
      expect(last.evictedConversationIds?.length ?? 0).toBeGreaterThan(0)
    } finally { await closeApp(launched) }
  })

  it('cacheMessages 超 4MiB 整批拒绝（IPC_MESSAGE_TOO_LARGE，P1-2）', async () => {
    const launched = await launchApp()
    try {
      const { page } = launched
      const big = Array.from({ length: 60 }, (_, i) => ({ ...msg(`m${i}`, `t${i}`), content: 'x'.repeat(80_000) }))
      const err = await page.evaluate(async (messages) => {
        try { await window.desktopApi.cacheMessages({ conversationId: 'c1', messages, updatedAt: 't' }); return null }
        catch (e) { return (e as Error).message }
      }, big)
      expect(err).toContain('IPC_MESSAGE_TOO_LARGE')
    } finally { await closeApp(launched) }
  })

  it('损坏恢复：启动前预置非法 JSON 缓存文件 → hydrate 空不抛 + .corrupt-<ts> 隔离文件存在（spec §4.5.2）', async () => {
    const launched = await launchApp([{ relPath: 'app-cache/message-cache-v1.json', content: '{ 损坏 非法 JSON' }])
    try {
      const { page } = launched
      const h = await page.evaluate(() => window.desktopApi.hydratePersistence())
      expect(h.conversations).toEqual([])
      const files = await readDir(launched, 'app-cache')
      expect(files.some((f) => f.startsWith('message-cache-v1.json.corrupt-'))).toBe(true)
    } finally { await closeApp(launched) }
  })
})
```

- [ ] **Step 2: 跑集成**——`xvfb-run -a pnpm -F @cyrene/desktop test:integration` 预期 23+1 全绿。

- [ ] **Step 3: 门禁全量复跑**

```bash
pnpm -F @cyrene/desktop typecheck
pnpm -F @cyrene/desktop lint
pnpm -F @cyrene/desktop test
xvfb-run -a pnpm -F @cyrene/desktop test:integration
pnpm -F @cyrene/desktop build
pnpm -F @cyrene/desktop check:contract
pnpm -F @cyrene/desktop package && xvfb-run -a pnpm -F @cyrene/desktop verify:artifact -- --smoke
```
  预期：typecheck / lint（--max-warnings=0）/ test（527 + 新增）/ test:integration（23 + 1）/ build / check:contract（13/13）/ package + smoke 全绿。

- [ ] **Step 4: 文档同步（中文，spec §6）**

  - `docs/16-*.md` §6：勾选 G2 历史懒加载/虚拟列表/每会话草稿/离线缓存/代码块复制/Markdown 增强对应项 + 测试数字更新；
  - `README.md` / `CLAUDE.md`：阶段 3 G2 落地状态 + 三态标记「**已开发、未联调**」（游标分页契约已真实联调，新用户流待真实后端复跑）；
  - `docs/06-*.md` §7/§8.3/§9：与「草稿/缓存持久化归 Main」一致，补实施注记（版本/状态照 doc 13 纪律）；
  - `docs/03-*.md` §7.4/§7.6：目标行为已描述，无冲突只补实施注记；
  - `docs/07-*.md` §1/§6.3：安全面变更（新 IPC `appOpenExternal` URL 白名单、Main 持久化新文件、`MAX_IPC_MESSAGE_BYTES` 落地）交叉 review 注记。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/tests/integration/persistence-lifecycle.spec.ts apps/desktop/tests/integration/helpers/app.ts docs/16-Cyrene-阶段执行检查清单与进度跟踪-v0.1.md README.md CLAUDE.md docs/06-Cyrene-前端状态管理与本地存储设计-v0.2.md docs/03-Cyrene-前端UI与交互设计-v0.2.md docs/07-Cyrene-Electron前端安全设计-v0.2.md
git commit -m "feat(G2 integration+docs): 持久化生命周期/损坏恢复集成测试 + 门禁复跑 + 文档同步（已开发、未联调）"
```

---

## 自审记录

按 writing-plans 技能自审清单逐项核对：

**1. Spec coverage（spec 每节/每条验收 → 任务，无 gap）**

| Spec 章节/验收 | 覆盖任务 |
|---|---|
| §4.1 总览：draftStore/cacheStore/Main SessionStore 分层 | T4/T5/T8 |
| §4.2 IPC 面：4 新通道 + MAX_IPC_MESSAGE_BYTES + 字节预算降级 + openExternal 白名单 + preload/DesktopApiLike/bootstrap 同步 | T1/T2/T9/T10/T11 |
| §4.3.1 纯函数层：estimateHeight/buildPrefix/computeWindow/captureAnchor/restoreScrollTop/compensateScroll + P0-1 不变量 | T3（含 P0-1 断言） |
| §4.3.2 组件层：CyMessageList 窗口化/atBottom/回到底部/顶部哨兵/流式占位/空态 | T14 |
| §4.3.3 Store 层：upsertMessage 有序二分插入 + loadOlder 有序合并 + loadSnapshot 排序 + setPageMeta + 防重入/失败保留游标 | T6 |
| §4.3.4 D6 切会话恢复三策略 + 先捕获再 flush 时序 | T14（restoreScrollFor/currentId watch） |
| §4.4.1 draftStore：save/clear/超限守卫/防抖/flush/删除联动 | T4 |
| §4.4.2 Main 草稿部分：100KB 权威校验 + 50 会话淘汰 + evictedConversationIds + 不写正文日志 | T8 |
| §4.5.1 缓存数据与写路径：Main 派生列表 + Renderer 推送 + ≤300 封顶 + top-20 淘汰 + 删除联动 | T8/T5/T7 |
| §4.5.2 损坏恢复：整文件隔离重建 + 条目级不污染 + 不阻塞启动 | T8/T16 |
| §4.5.3 启动水合：hydratePersistence + disconnected 分支离线水合 + connected 分支缓存不进 Store（P2-2）+ activateLocal 离线切换（P1-1）+ 在线恢复 | T11/T7 |
| §4.6.1 代码块：wrapCodeBlocks + 复制交互 + clipboard | T12/T13 |
| §4.6.2 外部链接：委托 + confirm + api.openExternal | T13/T9 |
| §4.6.3 流式渲染 80ms 尾沿防抖 | T12/T13 |
| §5 验收：新增单测清单（virtual-window/draft/session-store/message.store/markdown/clipboard/renderer-bootstrap/ipc-schema）+ 集成 + 门禁 | T3/T4/T5/T8/T9/T11/T12/T16 |
| §6 文档同步 | T16 |
| §7 已知限制（记录不实现）：深锚点/离线发送/非缓存会话/IPC 降级代价/快照 best-effort/高亮库 | 记入 Global Constraints 范围边界与文档 |

**2. Placeholder scan**：全文无 TBD/TODO/「类似 Task N」/红字；代码步骤均给真实实现（含 Task 10 的 desktop-api-chat.spec 四个新通道真实断言、Task 16 的集成测试真实代码 + `launchApp` seed 扩展）。

**3. Type consistency（跨任务签名一致）**
- 新 IPC 三处同步：`IpcChannels`（T1）→ Main `channels.ts`/handlers（T9）→ Preload（T10）→ `DesktopApiLike`（T1 类型先行）全对齐 `chatHydratePersistence`/`chatPersistSession`/`chatCacheMessages`/`appOpenExternal`。
- `MAX_IPC_MESSAGE_BYTES` 单一定义于 `shared/contracts/ipc.ts`（T1），T5 分片 / T8 入参校验与出参装箱统一引用。
- `upsertMessage` 有序插入（T6）用 `cmpMsg`（T3）；`loadPage`/`loadSnapshot` 均排序；`order` 恒 (createdAt, messageId) 升序不变量贯穿 T3 测试、T6 store、T14 虚拟列表。
- `loadSnapshot(conversationId, messages)`（T6）被 T7 `activateLocal` 与 T11 bootstrap 调用，签名一致；`activateLocal(id): Promise<void>`（T7）被 T11/T15 调用一致。
- `draftStore`：`saveDraft(id,text):boolean`/`clear`/`setScrollAnchor`/`hydrate`/`flush`/`purge`/`removeConversations`/`evictionNotice`（T4）——T14 用 `setScrollAnchor`+`flush`+`scrollAnchors`，T15 用 `saveDraft`/`clear`/`overLimit`/`evictionNotice`/`dismissEviction`，全对齐。
- `cacheStore`：`hydrate`/`pushMessages(convId, messages, updatedAt)`/`snapshotMessages`/`syncConversations`/`purge`（T5）——T6 推送钩子、T7 activateLocal/sync、T11 hydrate 全对齐。
- `SessionStore` 方法（T8）：`load/hydrate/persistSession→PersistSessionResult/cacheMessages/syncConversationList/setActiveConversation/purgeConversation/clearAll`——T9 handler/chat-service 钩子调用一致；`persistSession` 返回 `evictedConversationIds`（P2-1）在 T4 通知消费一致。
- `virtual-window`：`computeWindow` 返回 `{startIndex,endIndex,paddingTop,paddingBottom}`（T3）→ T14 `win` computed 消费一致；`restoreScrollTop(items, prefix, anchor)`（T3 签名含 items）→ T14 `restoreScrollFor` 一致。
- `bootstrap`：`BootstrapStores` 扩展 draft/cache（T11）→ `main.ts` 传真实 store 一致。

**遗留开放项（记录，待后续批次/联调）**
- 深锚点跳转依赖 `getMessageContext`（RealBackend 未实现，阶段 7 / 历史查看器）。
- 离线发送不可用（连接层职责）；离线会话切换仅覆盖最近 20 缓存会话、列表为启动时快照。
- IPC 降级代价：非活动会话消息骨架可能被截断、整批拒绝缺落，连接后由后端全量调和兜底。
- 自研虚拟列表高度校正若 E2E 抖动，备选 Chromium `content-visibility:auto`（本批默认不用）。
- 代码块无语法高亮（阶段 7 评估）。
