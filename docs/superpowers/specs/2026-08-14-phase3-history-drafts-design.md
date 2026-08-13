# 阶段 3 G2：历史与聊天体验（历史懒加载 / 每会话草稿 / 离线缓存 / 代码块复制 / Markdown 增强）设计

**日期：** 2026-08-14
**依据：** docs/03 §7.4/§7.6（历史懒加载与滚动规则、Markdown/代码块）、docs/06 §3/§7/§8/§9/§12（状态分类、草稿、会话缓存、损坏恢复）、docs/10 §6.1/§6.2、docs/16 §6（阶段 3 任务清单与验收门槛）、docs/02 §19（游标分页契约：`before/_id` 倒序 keyset）、docs/07 §1/§2（信任边界与资产）、二次联调 spec（bootstrap 水合 + DesktopApiLike 窄接口模式）
**范围：** Electron 阶段 3 G2 组——历史游标懒加载 + 虚拟列表 + 滚动锚点、每会话草稿持久化、最近 20 会话离线缓存与损坏恢复、代码块复制按钮 + 基础样式（不引入高亮库）、CyMarkdown 增强
**目的：** 把「聊天体验」从阶段 2 的「最新一页 + 无条件回底」升级为「可向上翻完整历史不跳动、切换会话不丢草稿与合理滚动位置、离线可读最近会话、代码块可复制」，并保持信任边界（持久化归 Main、Renderer 只持内存态）与最小依赖（不引入三方虚拟列表/高亮库）。
**决策：** 本批决策由我按推荐定案并记录于 §4.7——D1（草稿+滚动锚点持久化归 Main，新 IPC，Renderer 只持内存态）、D2（离线缓存归 Main 版本化 JSON + 损坏隔离 + Renderer 推送消息快照）、D3（虚拟列表自研轻量窗口化：估高+实测校正+锚点补偿，不引入三方库）、D4（草稿超限=提示并阻止新输入 + 50 会话上限淘汰不静默、告知被淘汰项）、D5（向上加载锚点=锚点消息 ID+视口偏移+ResizeObserver 高度补偿）、D6（切换会话滚动恢复策略）、D7（Markdown 增强范围：代码块语言标签+复制、外部链接经 Main http/https 白名单打开、流式渲染节流）。
**文档状态：** v2（自审 2 轮定稿后经独立评审修订，2026-08-14）。**评审修订轮次（独立评审，修复 P0-1 + P1-1 + P1-2，处理 P2-1 + P2-2）**：P0-1 修正 §4.3.3「upsertMessage 去重已保证 prepend 顺序」的错误假设——现有 `upsertMessage`（message.store.ts:57-61）对新 key 一律 `order.value.push()` 追加末尾，`before` 页会被追加到列表底部而非前插，`computeWindow/captureAnchor/restoreScrollTop/compensateScroll` 全失效；定案有序插入机制（`upsertMessage` 改 (createdAt, messageId) 升序二分插入 + `loadPage` 合并前防御性排序）+ 不变量（order 恒 (createdAt, messageId) 升序、锚点上方前缀和语义不变）+ 离线水合/离线切换前快照排序，验收/测试同步补；P1-1 补离线会话切换路径（disconnected 时点击其他缓存会话 → `activateLocal` 绕过 `api.activate/getMessages` 从 cacheStore 换入 messageStore，在线恢复真实 activate）；P1-2 为 `chatHydratePersistence`/`chatCacheMessages` 设单条 IPC 消息字节上限（`MAX_IPC_MESSAGE_BYTES = 4 MiB`）+ 超限降级策略（分页/截断/拒绝+告警），对齐 docs/07 §6.3「设置单条 IPC 消息大小上限」；P2-1 统一 50 会话淘汰与超限提示口径（`chatPersistSession` 响应携带 `evictedConversationIds`，淘汰不静默、告知被淘汰项，对齐用户决策「超限提示」）；P2-2 统一 §4.5.3 connected/disconnected 分支措辞（connected 时缓存不进入 Store、离线水合只在 disconnected 分支发生）。

---

## 1. 背景与目标

阶段 2 已真实联调通过（B-01，2026-08-14），主链「发送 → 流式 → 渲染」可用。但聊天体验仍是「最新一页」：

| 现状 | 缺口 |
|---|---|
| `CyChatView` 对 `messageStore.order` 全量 `v-for`，无虚拟列表 | 长历史全量 DOM + 全量 markdown 渲染，数量大时卡顿 |
| `CyChatView` `watch([visibleIds, isStreaming])` **无条件回底** | 用户上滚阅读旧消息时，新内容/切会话会强制跳底，违反 docs/03 §7.6「用户主动上滚后暂停自动滚动」 |
| 只有 `activate` 拉第一页（`getMessages` 无 `before`） | 无向上懒加载更早消息的能力 |
| `CyChatInput` 草稿是组件内 `ref('')` | 切会话即丢草稿、重启即丢，不满足「每会话草稿」 |
| Main 无草稿/缓存持久化 | 无离线缓存、无损坏恢复 |
| `CyMarkdown` 只渲染，代码块无复制按钮/语言标签 | 不满足 docs/03 §7.4「代码块显示语言、复制按钮」 |
| `CyMarkdown` 每个 delta 全量重解析 | 流式期间高频重解析（docs/03 §7.4「降低重复解析频率」） |

本批目标（对 docs/16 §6 任务清单）：

1. **历史游标懒加载**：向上滚动到顶附近自动加载更早消息（`before` 游标，BackendAdapter 已支持 `before/after/limit`），**加载不改变当前可视锚点、向上加载不跳动**；
2. **虚拟列表**：自研轻量窗口化，长历史只渲染可视窗口 ± overscan，不引入三方库；
3. **每会话草稿**：切会话/重启不丢、发送成功后清空、删除会话删草稿、超限提示；
4. **离线缓存**：最近 20 会话消息快照 + 会话列表，启动/短暂离线可读，损坏恢复重建不污染，后端为 source of truth；
5. **代码块复制 + 基础样式**：一键复制、语言标签、等宽/背景/简单着色，**不引入高亮库**（阶段 7 再评估）；
6. **Markdown 增强**：在 marked + 消毒基础上（链接可打开、流式渲染节流）。

**完成标准（对照 docs/16 §6 验收门槛 + docs/03 §7.6）：**
- 向上加载更早消息时当前可视锚点不动（单测覆盖锚点数学 + 组件层不跳动的行为验证）；
- 切换会话不丢草稿；滚动位置「合理」恢复（策略见 D6）；
- 草稿损坏可恢复、超限有提示并阻止继续增长；
- 代码块可一键复制、基础样式可读；
- typecheck、lint、全部既有单测/集成（527 单测 / 23 集成）+ 新增测试、build、check:contract(13/13) 全绿；
- 文档同步：docs/16 §6 勾选 + 测试数字、README/CLAUDE.md 状态更新。
- **状态标记：** 本批代码为阶段 3 新功能，Mock 驱动验证，标「已开发、未联调」（游标分页契约本身已真实联调，但懒加载/虚拟滚动/草稿/缓存/代码复制的完整用户流待真实后端复跑验收，不标「已完成」）。

## 2. 范围（本批做 vs 不做）

**本批做：**
- 历史向上懒加载（`before` 游标）+ 锚点保持 + 虚拟列表（自研窗口化）；
- 每会话草稿（文本）本地持久化（Main）+ 超限提示/阻止 + 删除会话联动删除；
- 最近 20 会话离线缓存（会话列表 + 消息快照 + 滚动锚点）与损坏恢复；
- 代码块：语言标签 + 复制按钮 + 基础样式（无高亮库）；
- Markdown 增强：外部链接点击（确认后经 Main http/https 白名单 `shell.openExternal`）、流式渲染节流、表格横向滚动（已有基础，保持）；
- 相关 IPC（新通道 + schema + preload + DesktopApiLike + bootstrap 水合）、单测/集成、文档同步。

**本批不做（明确排除）：**
- 附件/拖拽/粘贴（G3 附件组；`ConversationDraft.attachmentLocalIds` 契约保留为空，G3 接入）；
- 图片/视频/音频/文件媒体渲染（G3）；
- 统一聊天历史查看器（关键词/日期/分类搜索，docs/03 §7.7，G2 之外的组）；
- 语法高亮库（阶段 7 再评估，用户已锁定）；
- 跨会话消息缓存的 Renderer Store 化（保持单会话 messageStore，见 §4.4 取舍）；
- 断线自动重试发送/离线发送队列（连接层职责，非本组）；
- `getMessageContext` 深锚点跳转（RealBackend 尚未实现该接口，留阶段 7 / 历史查看器）；
- 多客户端同会话（首次联调已定单写者口径）。

## 3. 现状与技术约束

### 3.1 现状（代码证据）

| 位置 | 现状 |
|---|---|
| `renderer/src/components/CyChatView.vue:68-71` | `watch([visibleIds, isStreaming])` 无条件 `scrollTop = scrollHeight`，无 atBottom 判定、无「回到底部」 |
| 同上 `:95` | `v-for="id in visibleIds"` 全量渲染，无窗口化 |
| `stores/message.store.ts` | 单会话模型：`resetConversation` 清空；`loadPage` 只追加；无 `before` 游标/`hasMoreBefore` 状态。**根因（P0-1）**：`upsertMessage`（:57-61）对新 key 一律 `order.value.push()` 追加末尾，非时间序——before 页（更旧消息）会被追加到列表底部，`order` 非 (createdAt, messageId) 升序，锚点前缀和语义失效 |
| `stores/conversation.store.ts:110-130` | `activate` 只 `getMessages({conversationId})` 拉最新一页，无更早分页 |
| `components/CyChatInput.vue:13` | 草稿 `ref('')` 组件内局部，切会话即丢 |
| `components/CyMarkdown.vue` | `computed(renderMarkdown)` 每次 prop 变化全量重解析；`<pre><code>` 无复制按钮/语言标签；链接无点击处理 |
| `utils/markdown.ts` | marked + 轻量消毒（CSP 已拦内联脚本，消毒为纵深防御） |
| `main/` | 无草稿/缓存持久化；`credentials/atomic-write.ts` 的 `atomicWriteFile`（O_EXCL temp + fsync + rename + 0600 + safe-open）可复用；`persistence/user-data-dirs.ts` 已有 `app-cache` 0700 目录 |
| `transport/real-backend.ts:504-515` | `getConversationMessages` 支持 `before/after/limit`；before 方向 `nextCursor = cursor ?? 末条 _id`，`hasMore` 指示是否还有更早 |
| `shared/contracts/backend.ts:50-55` | `ConversationMessagesQuery{ conversationId, before?, after?, limit? }` 已定义 |
| `renderer/src/bootstrap.ts` + `stores/desktop-api.types.ts` | 启动水合（连接状态）+ DesktopApiLike 窄接口模式——新 IPC 照此扩展 |
| `main/index.ts:169-179` | 装配根：`dirs`（含 `app-cache`）已可得，session-store 在此装配 |

### 3.2 技术约束

- **信任边界（docs/07 §1）**：Renderer untrusted；Main 是持久化边界（docs/06 §14）。草稿是用户输入、缓存是敏感聊天内容（docs/06 §8.3：不得进日志/诊断包、清除会话缓存时一并删除）→ 两者持久化必须归 Main userData（0700 + safe-open + atomicWrite），Renderer 只持内存态。新 IPC 通道均 schema 校验、不暴露任意路径。
- **后端为 source of truth（docs/06 §1/§11）**：缓存/草稿只是本地便利副本；连接建立后由后端数据覆盖/调和，缓存绝不替代后端历史。
- **游标分页契约（docs/02 §19）**：`before={_id}` 倒序 keyset、`after={messageId}` 正序增量；`nextCursor` 为 opaque 串；「向上加载更早」= `before` 链。
- **最小依赖**：不引入 vue-virtual-scroller / @tanstack/virtual / highlight.js 等；虚拟窗口数学做成纯函数单测，组件薄。
- **既有测试模式**：store 测试经 `stores/desktop-api` 注入 mock api（`message.store.spec.ts` 模式）；新 IPC 通道须同步 `DesktopApiLike` + preload + Main handler + schema（handlers/executor 双层校验模式，二次联调 spec §4.2）。
- **失败语义**：持久化（草稿/缓存）失败 fail-open（审计 C1 同款：持久化失败不改变操作结果），草稿保内存态、缓存保内存态，下次触发重试；损坏恢复不阻塞启动。
- **流式交互**：虚拟列表必须与 streaming 兼容（流式消息高度增长、自动回底/暂停回底切换）。

## 4. 设计

### 4.1 总览：数据流与组件

```
┌──────────────────────── Renderer（untrusted，只持内存态）────────────────────────┐
│                                                                                  │
│  draftStore（草稿+滚动锚点内存态/防抖持久化）        cacheStore（离线水合+消息快照推送）│
│        │ debounce/flush on switch                       │  push on page/complete/ack│
│        ▼                                                    ▼                        │
│  api.persistSession / api.hydratePersistence   api.cacheMessages / api.hydratePersistence│
└──────────────────────────────────────────────────────────────────────────────────┘
                                   │ IPC（schema 校验，无路径）
┌──────────────────────────────────▼────────────────────────────────────────────────┐
│ Main（持久化边界）                                                                   │
│  SessionStore（新建，main/persistence/session-store.ts）                            │
│    ├─ drafts-v1.json        （草稿 + 滚动锚点，schemaVersion + 逐条校验 + 配额）       │
│    ├─ message-cache-v1.json （会话列表 + 每会话消息快照，schemaVersion + 损坏隔离）    │
│    └─ atomicWriteFile + safe-open + userData/app-cache（0700）                     │
│  列表缓存：listConversations 服务时自动写入（Main 派生，无额外 IPC）                    │
│  删除联动：deleteConversation 时 purge 草稿+锚点+缓存                                 │
│  openExternal：http/https 白名单 → shell.openExternal（Markdown 外部链接）            │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**Renderer 新增 Store：**
- `draftStore`：`drafts: Record<convId, string>`、`scrollAnchors: Record<convId, ScrollAnchor>`、`saveDraft(convId, text)`（超限守卫 + 防抖持久化）、`flush(convId)`（切会话/发送时立即持久化）、`setScrollAnchor(convId, anchor)`、启动 `hydratePersistence` 水合。
- `cacheStore`：启动 `hydratePersistence` 离线水合（会话列表 + 活动会话消息快照 + 滚动锚点）、`pushMessages(convId, messages, updatedAt)`（页面加载 / `generation.completed` / send ack 后推送已确认消息增量）、`pushList(conversations)`（会话列表变化时）、`snapshotMessages(convId): Message[] | undefined`（离线切换时取缓存会话快照，见 §4.5.3 P1-1）。离线视图只读（`canAct` 已按 connected 门控发送）。

**Main 新增模块：**
- `main/persistence/session-store.ts`：草稿 + 滚动锚点 + 会话列表缓存 + 消息快照缓存 + 配额 + 损坏隔离 + 删除联动。两个文件（草稿小且高频、缓存大且低频，分开独立损坏）。

### 4.2 IPC 面（新通道）

`shared/contracts/ipc.ts` 新增（PushChannels 不变，均为命令通道）：

```ts
export const IpcChannels = {
  ...existing,
  chatHydratePersistence: 'chat:hydrate-persistence',   // 启动水合：草稿+锚点+会话列表+消息快照
  chatPersistSession: 'chat:persist-session',           // 草稿+滚动锚点 upsert（防抖/切会话 flush）
  chatCacheMessages: 'chat:cache-messages',             // 已确认消息快照增量推送
  appOpenExternal: 'app:open-external'                  // Markdown 外部链接（http/https 白名单）
} as const
```

Request/Response 契约（新增 `shared/contracts/persistence.ts`，schema 放 `shared/schemas/`）：

```ts
export interface ScrollAnchor { messageId: string; offset: number }   // 视口顶 → 锚点消息顶的偏移

export interface SessionPersistenceState {
  drafts: ConversationDraft[]                       // 已有契约（conversation.ts:26-32），attachmentLocalIds 留空（G3）
  scrollAnchors: Record<string, ScrollAnchor>
  lastActiveConversationId?: string                 // 离线水合时定位「上次活动会话」的展示目标
  conversations: Conversation[]                     // 最近 20（按 updatedAt）
  messageSnapshots: Record<string, Message[]>       // 最近 20 会话，每会话 ≤300 条
}

export interface PersistSessionInput {
  conversationId: string
  draft: { text: string; updatedAt: string }        // 空串=清除
  scrollAnchor: ScrollAnchor | null                 // 离开该会话时的可视锚点
}
export interface CacheMessagesInput {
  conversationId: string
  messages: Message[]                               // 已确认（后端来源）消息增量，Main 按 messageId 去重合并
  updatedAt: string
}
export interface OpenExternalInput { url: string }
```

- `chatHydratePersistence`（无参）→ `SessionPersistenceState`（`SessionPersistenceStateSchema`）。**响应大小上限（P1-2）**：Main 装箱前按字节预算估算（`messages`/`assistantSegments` 的 `text` UTF-8 字节累计 + 元数据近似），超过 `MAX_IPC_MESSAGE_BYTES`（4 MiB，shared 常量，对齐 docs/07 §6.3「设置单条 IPC 消息大小上限」）时**降级**（按优先级）：①快照只保留 `lastActiveConversationId` + `updatedAt` 最近 N 会话（N 由预算反推）；②每会话快照截到前 M 条（超长文本条目截断正文、保留 role/时间/ID 元数据，离线可读骨架）；③仍超限 → 拒绝 + 告警（启动不阻塞，走空水合 + 连接后由后端全量调和）。任何降级记诊断计数（不记正文）。
- `chatPersistSession`（`PersistSessionInputSchema`）→ `{ evictedConversationIds?: string[] }`；Main 校验：`text` UTF-8 ≤100KB（超限抛 `DRAFT_LIMIT_EXCEEDED`，防御性）、`scrollAnchor.messageId` 非空；写 `drafts-v1.json`。**淘汰告知（P2-1）**：本次写入触发 50 会话上限淘汰时，响应携带本次被淘汰条目的 `conversationId`（其草稿与滚动锚点一并淘汰），Renderer 对每个被淘汰项弹一次性通知「草稿已满：最早的非激活会话草稿已按策略清理」，不静默丢数据。
- `chatCacheMessages`（`CacheMessagesInputSchema`）→ void；Main 先做**入参大小上限（P1-2）**：整批 `messages[]` 估算字节 ≤`MAX_IPC_MESSAGE_BYTES`，超限 → 拒绝整批 + 告警（错误码 `IPC_MESSAGE_TOO_LARGE`），Renderer 降级为**分片推送**（≤200 条/批，并按字节预算分片）；单条超限的罕见超大消息（如超长代码块）→ 截断到预算内或整条跳过 + 计数告警。之后逐条 `MessageSchema` 校验，非法条丢弃 + 计数（untrusted renderer 防御），按 messageId 去重合并、每会话 ≤300 条封顶、top-20 淘汰，写 `message-cache-v1.json`。
- `appOpenExternal`（`OpenExternalInputSchema`：`url` `z.string().refine(仅 http/https)`）→ void；Main `new URL(url)` 校验 `protocol ∈ {http:, https:}` 且 `url` 长度 ≤2048 字符 → `shell.openExternal(url)`；非法 scheme 直接拒绝（含 `file:/cyrene:/javascript:`）。
- **单条 IPC 消息大小上限常量（P1-2，docs/07 §6.3 落地）**：`MAX_IPC_MESSAGE_BYTES = 4 MiB` 定义于 `shared/contracts`（注释引用 docs/07 §6.3）；上述四个新通道的响应/入参统一以它为准——Main 侧对出参做字节预算装箱、对入参做字节预算校验，超限一律走「分页/截断/拒绝+告警」降级，降级记诊断计数、不记正文。

**preload + DesktopApiLike + bootstrap 同步扩展**（照二次联调 spec §4.1 模式）：`desktop-api.ts` 新增 `hydratePersistence/persistSession/cacheMessages/openExternal`（`unwrap(res, schema)` 信封解包），`desktop-api.types.ts` 的 `DesktopApiLike` 同步（窄接口），`main.ts` 将新 store 传入 bootstrap。

### 4.3 历史懒加载 + 虚拟列表 + 滚动锚点（决策 D3/D5/D6）

#### 4.3.1 纯函数层（`renderer/src/utils/virtual-window.ts`，全部可单测）

```ts
// 前缀和 + 二分：估算高（未渲染行）与实测高（已渲染行）混合累计
// heights: Record<messageId, number>（实测优先，缺失用 estimateHeight 兜底）
export function estimateHeight(m: Message): number            // 按类型/文本长度启发式（user 短文本/assistant markdown 加权）
export function buildPrefix(items: Message[], heights: Record<string, number>): number[]
export function computeWindow(prefix: number[], scrollTop: number, viewportHeight: number, overscanPx: number):
  { startIndex: number; endIndex: number; paddingTop: number; paddingBottom: number }

// 向上加载锚点：加载更早页前后保持可视锚点不动
export function captureAnchor(items: Message[], prefix: number[], scrollTop: number, viewportHeight: number): ScrollAnchor
export function restoreScrollTop(prefix: number[], anchor: ScrollAnchor): number   // 锚点消息顶 + offset
// 高度补偿：锚点上方已渲染行实测高度变化 → 累计 delta 调 scrollTop（D5，防 estimate→measured 推走锚点）
export function compensateScroll(heightsDeltaAboveAnchor: Array<{ old: number; new: number }>): number
```

设计要点：
- `estimateHeight` 是纯启发式（user ~ 行数×行高；assistant 按 markdown 特征加权，如含代码块/长列表），实测（ResizeObserver）覆盖后以实测为准；**未渲染行恒用估算**。
- `buildPrefix` 在 heights 变化/items 变化时重建（重建低频），滚动事件只做二分，O(log n)。
- **prepend 不跳动的机制（D5）**：`loadOlder` 前 `captureAnchor`（当前首可见消息 + 视口偏移）；store prepend 后按 `restoreScrollTop` 恢复。新加载的更早行在锚点上方、若进入 overscan 会渲染并被实测 → 实测与估高的差会推走锚点 → 由**高度补偿 effect** 修正：监听锚点上方已渲染行的高度变化，累计 delta 同步调整 scrollTop，保证锚点稳在视口同一位移。这是「向上加载不跳动」的机制保证。

#### 4.3.2 组件层（`CyMessageList.vue` 新建）

- 滚动容器；`visibleIds` 经 `computeWindow` 切出 `[startIndex, endIndex]`，上下 padding 撑开，窗口内 `v-for` → `CyMessageBubble`。
- 每行 `ref` 挂 ResizeObserver → 写 `heights` map（实测）。
- **atBottom 判定**：`scrollTop + viewportHeight ≥ scrollHeight - threshold`；`atBottom && 有新内容（流式）` → 跟随回底；`!atBottom` → 显示「回到底部」悬浮按钮（docs/03 §7.6），点击回底并恢复跟随。
- **顶部哨兵**：`scrollTop ≤ threshold` 且 `hasMoreBefore` 且非加载中 → `loadOlder()`。
- 流式消息常驻窗口底部（与「生成中…」占位相邻）。
- 空态保持（`isEmpty` 时渲染空态，不窗口化）。

#### 4.3.3 Store 层（`message.store.ts` / `conversation.store.ts` 扩展）

`message.store.ts` 新增（单会话内）：
- `hasMoreBefore: Ref<boolean>`、`beforeCursor: Ref<string | undefined>`、`loadingOlder: Ref<boolean>`。
- **`upsertMessage` 改为有序插入（P0-1 修复）**：现有实现（:57-61）对新 key 一律 `order.value.push()` 追加末尾——`before` 页（更旧消息）会被追加到列表底部而非前插，`order` 非时间序，`computeWindow`/`captureAnchor`/`restoreScrollTop`/`compensateScroll`（均假设「新行插入锚点上方、前缀和=可视位移」）全部失效。改为按比较器 `cmpMsg(a,b)` = `a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.messageId < b.messageId ? -1 : 1` 二分定位：新 key 插到 `order` 中第一个「不早于自己」的 key 之前（同 `(createdAt, messageId)` 时插在其后，保持稳定）；已存在 key → 原位替换内容、不重插。排序插入对既有路径安全：流式 `generation.started` 与乐观发送 `send` 的 `createdAt≈nowIso()`，排序后仍落在末尾（等价原 append 但更稳）；`loadReplay`/`applyPendingReplay` 的迟到历史快照也能落到正确时序位置。
- `async loadOlder()`：`beforeCursor` 未定义或 `loadingOlder` 时返回（防重入）；调用 `api.getMessages({ conversationId, before: beforeCursor })` → `loadPage`（**有序合并**：`loadPage` 合并前对页内 items 按 `cmpMsg` 防御性升序排序——后端 `toMessagePage` 已对 before 页归一化为升序，再排一次以免疫非时间序页——再逐条经有序插入的 `upsertMessage` 并入既有 `order`）→ 更新 `hasMoreBefore/beforeCursor`（用返回页的 `nextCursor`，`has_more=false` 时置 undefined）；失败 → 保留游标 + `lastError` 公开错误（可重试），不改动已渲染消息。**首页 `beforeCursor` 初始化：`activate` 首屏页的 `nextCursor` 即「更早一页」的 `before` 游标（`toMessagePage` 在 `has_more` 时返回 `cursor ?? 末条 _id`）——首页有 `nextCursor` 才可向上加载。**prepend 的锚点保持由 CyMessageList 在调用前后 capture/restore。
- **`loadSnapshot(convId, messages)`（离线水合/离线切换，P0-1/P1-1）**：`resetConversation(convId)` 后把 `messages` 按 `cmpMsg` 升序排序再逐条有序插入（离线快照推送未必时间序，**水合前必须排序**），`hasMoreBefore=false`（离线不可加载更早，仅读缓存快照）。在线首屏不用此路径（仍走 `loadPage`）。

**不变量（P0-1，验收/测试锚点）**：同会话内 `order` 恒为 `(createdAt, messageId)` 升序；锚点上方前缀和语义不变——`captureAnchor` 捕获的「锚点消息顶 = sum(锚点上方各渲染行高度)」在插入更早行后因锚点上方新增行而增量增长，由 `compensateScroll` 累计 delta 修正，锚点可视位移不变。

`conversation.store.ts`：
- `activate` 首屏后根据 `page.nextCursor` 初始化 `hasMoreBefore`（后端 `has_more` 语义）——把 `nextCursor` 存入 messageStore。

#### 4.3.4 切换会话滚动恢复（决策 D6）

- 会话离开时：`CyMessageList` 在 `currentId` 变化**前**捕获锚点 → `draftStore.setScrollAnchor(convId, anchor)` → `draftStore.flush(convId)`（一次 `persistSession` 同时携带草稿 + 锚点落盘）。时序定死：先捕获再 flush，避免 flush 携带旧/缺锚点。
- 回到会话（`activate` 首屏已加载后）恢复策略：
  1. 保存的锚点消息 **在已加载页内** → `restoreScrollTop` 精确恢复；
  2. 锚点不在已加载页 且 `hasMoreBefore`（有更早历史）→ 恢复至**已加载首屏顶部**（边界：可继续上翻，不突兀跳底）；
  3. 无保存锚点 或 无更早历史 → **底部**（最新，默认跟随）。
- 理由：策略 2 避免「读过旧历史后切回却落到最新」的割裂；策略 1 覆盖常规近端阅读。深锚点（锚点远在已加载页之外）需要 `getMessageContext` 按目标消息拉上下文——RealBackend 未实现，留阶段 7 / 历史查看器。

### 4.4 每会话草稿（决策 D1/D4）

#### 4.4.1 Renderer（`draftStore` 新建 + `CyChatInput.vue` 改造）

- `CyChatInput` 草稿源改为 `draftStore`：`const draft = computed({ get: () => draftStore.drafts[conversationStore.currentId ?? ''] ?? '', set: v => draftStore.saveDraft(currentId, v) })`。
- 切会话（`currentId` 变化）时 `draftStore.flush(oldId)`（立即持久化）+ 读新会话草稿（内存态已有；无则空）。
- 发送成功清空当前草稿（`send` 返回后 `draftStore.clear(convId)`）。
- **超限守卫（D4）**：`saveDraft` 内 `TextEncoder().encode(text).byteLength > 100KB` → 拒绝写入 + `overLimit: Ref<boolean>` 置位；`CyChatInput` 显示常驻横幅「草稿已满（100KB 上限）」，提供「清空草稿」按钮；`textarea` 不吞用户输入、但超出部分被拒绝（守卫返回旧值，不静默截断）。发送/发送确认等正常操作不受影响。
- 持久化触发：输入停止 800ms 防抖（docs/06 §7「输入停止一小段时间后保存」）+ 切会话/发送时 flush。崩溃最多丢 800ms 草稿（已知限制，§7）。
- 删除会话（`conversationStore.remove`）联动：清内存草稿 + 锚点，Main 侧 `deleteConversation` handler 内 purge。

#### 4.4.2 Main（`session-store.ts` 的草稿部分）

- 文件 `app-cache/drafts-v1.json`：`{ schemaVersion: 1, entries: Record<convId, { text, updatedAt }>, scrollAnchors: Record<convId, ScrollAnchor> }`。
- 写入：`atomicWriteFile`（复用 credentials 版，0600 + O_EXCL temp + fsync + rename + safe-open 包含性复核）；POSIX dir fsync 同款。
- 配额（权威执行，防御 untrusted renderer）：
  - 单草稿 `text` UTF-8 >100KB → 拒绝 + `DRAFT_LIMIT_EXCEEDED`；
  - 条目数 >50 → 淘汰 `updatedAt` 最旧且非当前激活会话的条目（激活会话 ID 由 `getConnectionState().activeConversationId` 提供；**该条目草稿与其滚动锚点一并淘汰**；淘汰计数值入诊断，不记正文）。**不静默淘汰（P2-1）**：被淘汰条目的 `conversationId` 经 `chatPersistSession` 响应 `evictedConversationIds` 返回给 Renderer，由 Renderer 对被淘汰项弹一次性通知（「草稿已满：最早的非激活会话「X」的草稿已按策略清理」），对齐用户决策「超限提示」（100KB/会话超限提示 + 会话数上限淘汰提示两层口径，见 D4）。
- 读取：逐条校验（`PersistSessionDraftSchema`），非法条目丢弃 + 计数；整文件 JSON 解析失败 → 隔离重建（见 4.5.2）。
- **永不写日志正文**（草稿为敏感用户输入）；诊断只记计数/ID。

### 4.5 离线缓存（决策 D2）

#### 4.5.1 数据与写路径

- 文件 `app-cache/message-cache-v1.json`：`{ schemaVersion: 1, conversations: Conversation[], snapshots: Record<convId, { messages: Message[], updatedAt, lastSyncAt }> }`。
- 会话列表：**Main 派生**——`ChatService.listConversations` 服务时把响应合并进缓存（去重按 id，按 updatedAt 取 top-20，无需 Renderer 推送）。
- 消息快照：**Renderer 推送**（`chatCacheMessages`）——因 Main 无法从 WS delta 事件重组 assistant 消息，由已装配的 Renderer 在以下时机推送**已确认**消息增量：
  - `activate` 首屏 / `loadOlder` 页面加载后；
  - `generation.completed`（assistant 消息最终态落位后）；
  - `send` ack（`serverMessageId` 确认后）。
  - Main 逐条 `MessageSchema` 校验（防御）、按 messageId 去重合并、每会话取最新 ≤300 条、top-20 淘汰（updatedAt 最旧移除，含其快照）。
- **快照时序不保证（P0-1）**：Renderer 推送增量未必时间序（`loadOlder` 更早页与 `generation.completed` 新消息可能交错推送）；Main 按 messageId 去重合并后**不重排**（缓存为消息集合，顺序在 Renderer 水合/载入时决定）。离线水合/离线切换载入前必须按 `(createdAt, messageId)` 升序排序（§4.3.3 `loadSnapshot`）。
- 删除联动：`deleteConversation` handler 内 purge 该会话草稿 + 锚点 + 快照。
- **内容敏感性**：缓存含 Inner Voice / Public Reply，视为敏感聊天内容（docs/06 §8.3）：不写日志/诊断包；「清除缓存」时整文件删除（用户可清除缓存是 docs/07 §243 要求——设置中心提供清除入口，UI 项随设置组落地，本批提供 `chat:hydrate-persistence` 不暴露删除 API，删除实现为文件 unlink 的清除工具函数）。

#### 4.5.2 损坏恢复（docs/06 §12 + 阶段 0 FE-S1-P2-02 同款纪律）

- **整文件 JSON 解析失败**：将文件隔离重命名 `message-cache-v1.json.corrupt-<ISO ts>`（保留现场供诊断，诊断**不含正文**），以空缓存重建，不阻塞启动；
- **条目级 schema 校验失败**：丢弃非法条目（会话/快照级），其余保留——**损坏不污染**（单条重建，不整文件拒绝）；
- 损坏/空缓存恢复后：连接建立时由后端全量调和（`initializeConnected` + `activate` 首屏覆盖缓存视图），与 docs/06 §12「从后端恢复」一致；
- `drafts-v1.json` 同款隔离逻辑（草稿损坏重建为空，连接后正常）。

#### 4.5.3 启动水合（bootstrap 扩展）

`bootstrap.register()` 内、注册订阅之后：
1. `api.hydratePersistence()` → `draftStore`（草稿 + 锚点）+ `cacheStore`（会话列表 + 消息快照 + `lastActiveConversationId`）；
2. `getConnectionState()` snapshot：若 `disconnected` → 用缓存水合离线视图（`conversationStore.setOfflineCache(conversations)`；`messageStore.loadSnapshot(lastActiveConversationId ?? updatedAt 最近会话, 快照)`；读-only：发送门控 `canAct` 已按 connected 拦截）；若 `connected` → 走既有后端水合，**缓存不进入 Store**（消息快照不载入 messageStore，仅 draftStore 草稿/锚点与 cacheStore 会话列表内存态保留，随后由 `initializeConnected` + `activate` 首屏覆盖）。**统一口径（P2-2）**：离线水合只发生在 disconnected snapshot 分支；connected 分支的缓存只作「后续可能进入离线」的内存储备，绝不作为在线消息源。
3. 启动代次守卫（epoch）保持既有逻辑，缓存水合不与 push 竞态冲突（`chatCacheMessages` 推送只在 connected 且会话已装配后发生；离线水合只在 disconnected snapshot 分支发生——两条写 messageStore 的路径不同时激活）。

**离线会话切换路径（P1-1）：** 目标「离线可读最近 20 会话」不止覆盖 lastActive——disconnected 时点击列表其他缓存会话必须绕过 `conversationStore.activate`（其无条件走 `api.activate` + `api.getMessages`，离线必失败）：
- `conversationStore.activateLocal(id)`：仅当 `connectionState.status === 'disconnected'`（离线视图）可用。校验 `id ∈ cacheStore.conversations`（最近 20 缓存）；通过 → `currentId.value = id`（本地切换，**不调** `api.activate`/`getMessages`）、`messageStore.resetConversation(id)`、取 `cacheStore.snapshotMessages(id)` 存在则 `messageStore.loadSnapshot(id, snap)`（排序载入，`hasMoreBefore=false`），置 `offlineView=true`；无快照 → 空态 + 提示「该会话离线不可读」。离线视图下在线路径不可用：`activate` 在离线视图直接拒绝并提示。
- **在线恢复**：连接恢复 → `connected` snapshot → 既有 `initializeConnected` 流程对 `currentId` 走真实 `activate(id)`（拉后端首屏覆盖快照视图）、`offlineView=false`（epoch 守卫处理竞态）。
- **数据流**：sidebar 点击 `currentId !== id` 时由视图层判定：离线 → `activateLocal(id)`；在线 → 既有 `activate(id)`。
- **已知限制（记录 §7）**：离线只读最近 20 缓存会话；非缓存会话离线不可读；离线不可加载更早历史（`hasMoreBefore=false`）；离线会话列表为启动时快照、不实时更新。

**Main 侧 `lastActiveConversationId` 维护：** `ChatService.activate` 成功时通知 session-store 记录（写入 `drafts-v1.json` 顶层），供下次启动离线水合定位目标会话。

### 4.6 代码块复制 + Markdown 增强（决策 D7）

#### 4.6.1 代码块（`utils/markdown.ts` + `CyMarkdown.vue`）

- 渲染后处理：在 sanitizeHtml 之后对输出做一次代码块包裹（纯字符串处理，`<pre>` 外套 `<div class="cy-code-block"><span class="cy-code-lang">lang</span>` + 复制按钮占位 `</div>`），语言从 `language-xxx` class 提取（无则「代码」）。**不引入高亮库**：代码内容保持 marked 的转义文本，不做 token 着色，只加基础样式（等宽字体、背景、圆角、横向滚动、语言标签/复制按钮弱化样式）。样式放 `CyMarkdown.vue` `:deep()`。
- 复制交互：`CyMarkdown` 根元素**事件委托** `@click`，命中 `.cy-code-copy` → 取同块 `<pre><code>` 的 `textContent`（尾部换行 trim）→ `copyText(text)`（`utils/clipboard.ts`：`navigator.clipboard.writeText` 优先，`document.execCommand('copy')` 临时 textarea 兜底；Web API，不经 IPC）→ 按钮短暂显示「已复制」。CSP-safe：无内联 handler。
- `utils/clipboard.ts` 导出 `copyText` 纯函数（可单测，依赖注入 `navigator`/`document`）。

#### 4.6.2 外部链接（docs/03 §7.4「外部链接带外部打开提示」）

- `CyMarkdown` 事件委托命中 `a[href]` → `preventDefault` → 原生 `confirm('在浏览器中打开外部链接？')` → `api.openExternal(href)`。
- Main `appOpenExternal` handler 校验 `http/https` 白名单后 `shell.openExternal`（见 4.2）。渲染层不做 `window.open`（受 `setWindowOpenHandler` 管控，避免在应用窗口内导航）。
- 内部链接（`cyrene://` 等非 http/https）一律拒绝（应用内无历史查看器内链跳转需求，留历史查看器组）。

#### 4.6.3 流式渲染节流（docs/03 §7.4「降低重复解析频率」）

- `CyMarkdown` 的 `html` 计算加**尾沿防抖**（~80ms）：流式 delta 高频变化时合并重解析，停顿/完成时保证最终文本渲染。实现为可注入定时器的纯 util（`utils/debounce-trailing.ts` 或组件内小函数 + `vi.useFakeTimers` 单测）。
- 不缓存渲染 HTML 到 Store（docs/06 §3.4「不保存渲染后的 HTML」）。

### 4.7 决策汇总

| # | 决策 | 定案 | 理由 |
|---|---|---|---|
| D1 | 草稿+滚动锚点持久化边界 | **Main**（新 IPC `persistSession`/`hydratePersistence`，Renderer 只持内存态） | 信任边界（docs/07 §1：Main 是持久化边界、防 Renderer 被攻破扩大；docs/06 §14）；草稿为敏感用户输入，存 Main userData(0700) 避免 Renderer 自身存储可被任意 XSS 静默读取；配额权威执行；复用 safe-open/atomicWrite 地基。docs/06 §9「草稿→本地轻量存储」落为 Main 侧版本化 JSON |
| D2 | 离线缓存归属与机制 | **Main** 版本化 JSON（schemaVersion + 逐条校验 + 损坏隔离重建）+ **Renderer 推送已确认消息快照** | 缓存为敏感聊天内容（docs/06 §8.3）持 Main 一致；损坏恢复沿用 FE-S1-P2-02「损坏重建不污染」+ docs/06 §12；Main 无法从 WS delta 重组 assistant 消息 → 快照由装配后的 Renderer 推送、Main 校验去重封顶淘汰；后端为 source of truth，缓存仅离线/启动兜底 |
| D3 | 虚拟列表方案 | **自研轻量窗口化**（估高 + ResizeObserver 实测 + 前缀和二分），**不引入三方库** | 项目最小依赖；聊天消息变高（markdown/代码块）需估高+实测；窗口数学纯函数可单测；避免三方依赖治理与体积。权衡记录：复杂度集中在高度校正与流式交互，以纯函数+组件隔离控制；若 E2E 抖动，备选 Chromium `content-visibility:auto`（默认不用） |
| D4 | 草稿超限产品行为 | 两层口径，均对齐用户决策「超限提示」：**① 单草稿 100KB 超限**（UTF-8 字节计）→ 提示并阻止新输入（不静默截断；提供清空按钮）；**② 50 会话上限** → 淘汰 updatedAt 最旧非激活条目，**淘汰不静默**——`chatPersistSession` 响应 `evictedConversationIds` 告知被淘汰项，Renderer 弹一次性通知 | 截断/静默淘汰都丢数据且不可见；阻止增长+横幅保留既有文本、允许手动清空；淘汰告知让用户知晓被清理的会话草稿；配额 Main 权威 + Renderer 即时守卫双保险 |
| D5 | 向上加载锚点机制 | **锚点消息 ID + 视口偏移 + ResizeObserver 高度补偿**（对锚点上方已渲染行高度变化累计 delta 调 scrollTop） | overscan 行实测与估高之差会把锚点推走；补偿使「向上加载不跳动」有机制保证且纯函数可单测 |
| D6 | 切换会话滚动恢复策略 | 锚点在已加载页→精确恢复；不在且 hasMoreBefore→首屏顶部（边界）；否则→底部 | 覆盖「读旧历史后切回」不跳底的合理体验；深锚点待 `getMessageContext`（阶段 7） |
| D7 | Markdown 增强范围 | 代码块=语言标签+复制按钮+基础样式（无高亮库）；外部链接=确认后经 Main http/https 白名单 `shell.openExternal`；流式渲染 80ms 尾沿防抖 | 对应 docs/03 §7.4；链接经 Main 校验避免任意 scheme 逃逸；防抖降流式重解析；复制用 Web API（不经 IPC） |

## 5. 验收标准

**门禁（实施后控制器复跑）：**
- `pnpm typecheck`、`pnpm lint`、`pnpm test`（527 + 新增单测）、`xvfb-run -a pnpm test:integration`（23 + 新增集成）、`pnpm build`、`pnpm -F @cyrene/desktop check:contract`（13/13）全绿；
- `pnpm package` + `xvfb-run -a verify:artifact -- --smoke` 不回归（本批动 renderer UI + Main 持久化，打包路径受牵连，须复跑）。

**新增单测（目标）**：
- `tests/unit/virtual-window.spec.ts`：`estimateHeight` 启发式、`buildPrefix`（估高+实测混合）、`computeWindow`（空/恰好/overscan/越界 clamp）、`captureAnchor/restoreScrollTop/compensateScroll`（prepend 前后锚点位移不变、高度校正补偿 delta；**P0-1**：非时间序页有序归并后 `buildPrefix`/`computeWindow`/锚点不变量——order 恒 (createdAt, messageId) 升序时前缀和与可视位移一致）；
- `tests/unit/scroll-anchor.spec.ts`：锚点捕获/恢复数学 + 补偿累计（或并入 virtual-window.spec）；
- `tests/unit/draft.store.spec.ts`：save/get/切会话不丢/发送清空/超限阻止 + overLimit 置位/防抖持久化/切会话 flush/删除清内存；
- `tests/unit/session-store.spec.ts`（Main）：草稿配额（>100KB 拒绝、>50 淘汰最旧非激活、**淘汰项经 `evictedConversationIds` 返回，P2-1**）、锚点 upsert、消息快照去重（同 messageId 不重复）、每会话 ≤300 封顶、top-20 淘汰、损坏恢复（整文件 JSON 解析失败→隔离重建空；条目级 schema 失败→丢条目不污染）、atomicWrite、**IPC 大小上限（P1-2）**（`chatCacheMessages` 整批 >4 MiB 拒绝 + 单条超大截断/跳过计数；`chatHydratePersistence` 响应超限降级装箱）、不写日志正文（spy logger 断言无草稿文本）；
- `tests/unit/message.store.spec.ts`（扩展）：`loadOlder` **有序合并**（before 页插入后 `order` 仍 (createdAt, messageId) 升序、与既有消息不重复、重复 messageId 原位替换不重插、非时间序页免疫）、`loadSnapshot` 排序载入（P0-1）、`hasMoreBefore/beforeCursor` 推进、失败保留游标可重试、`loadingOlder` 防重入；
- `tests/unit/markdown.spec.ts`（扩展）：代码块包裹（语言标签提取/无语言默认）、复制文本提取（textContent 尾换行 trim）、sanitize 仍生效（代码内容含 `<script>` 转义不执行）、流式防抖（fake timers 合并重解析、最终文本必渲染）；
- `tests/unit/clipboard.spec.ts`：`copyText` navigator.clipboard 优先 + execCommand 兜底（注入 mock）；
- `tests/unit/ipc-schema.spec.ts`（扩展）：新通道 request/response schema 镜像契约（`PersistSessionInput`/`CacheMessagesInput`/`OpenExternalInput`/`SessionPersistenceState`）；
- `tests/unit/renderer-bootstrap.spec.ts`（扩展）：disconnected snapshot → 缓存离线水合（会话列表 + 消息快照 + 锚点）；connected snapshot → 走后端水合不被缓存覆盖；**离线切换 `activateLocal`（切到其他缓存会话载入快照、不调 `api.activate/getMessages`、`hasMoreBefore=false`）与在线恢复（connected 后真实 activate 覆盖快照视图）**（P1-1）。

**新增集成（目标）**：
- 持久化生命周期：经 IPC `persistSession`/`cacheMessages` → userData 文件出现预期行（断言文件存在 + schemaVersion + 条目，不读正文断言）；`deleteConversation` → 草稿/锚点/快照 purge；`hydratePersistence` 返回与写入一致；**`chatPersistSession` 触发淘汰时响应含 `evictedConversationIds`；`chatCacheMessages` 超 4 MiB 整批拒绝（断言 `IPC_MESSAGE_TOO_LARGE`）**（P1-2/P2-1）；
- 损坏恢复：写入含非法 JSON 的缓存文件 → 启动 `hydratePersistence` 不抛、返回空 + 隔离文件存在（`.corrupt-<ts>`）。

**验收门槛对照（docs/16 §6）**：
- 历史懒加载不改变当前可视锚点；向上加载不跳动（virtual-window/scroll-anchor 单测 + 手动验证）；
- 切换会话不丢草稿与合理滚动位置（draft.store 单测 + 策略单测 + 手动）；
- 草稿损坏可恢复、超限有提示（session-store 损坏恢复 + 超限单测 + UI 横幅）；
- 代码块可一键复制、基础样式可读（markdown/clipboard 单测 + 手动复制验证）。

**状态标记：** 本批完成后 README/CLAUDE.md/docs16 同步，标「已开发、未联调」（阶段 3 新功能 Mock 驱动；游标分页契约已真实联调，新用户流待真实后端复跑）。

## 6. 文档同步

- 本 spec 落 `docs/superpowers/specs/2026-08-14-phase3-history-drafts-design.md`；
- 实施后更新 `docs/16` §6（勾选对应任务 + 测试数字）、`README.md` / `CLAUDE.md`（阶段 3 G2 落地状态 + 三态标记）；
- `docs/06` §7/§8.3/§9 若与「草稿/缓存持久化归 Main」措辞冲突则补实施注记（版本/状态照 doc 13 交叉 review 纪律）；
- `docs/03` §7.4/§7.6 已描述目标行为，无冲突则只做实施注记；
- 安全面变更（新 IPC `appOpenExternal`、Main 持久化新文件）→ `docs/07` 交叉 review（URL 白名单 + 持久化边界）。

## 7. 已知限制（记录，待后续批次/联调）

- **崩溃丢草稿窗口**：草稿持久化 800ms 防抖，异常崩溃最多丢该窗口内输入（正常退出/切会话/发送均 flush）。
- **深锚点跳转**：锚点远在已加载页之外时退化为「首屏顶部边界」，精确跳转依赖 `getMessageContext`（RealBackend 未实现，留阶段 7 / 历史查看器）。
- **离线发送不可用**：离线缓存只读（canAct 按 connected 门控），断线发送队列属连接层职责。
- **离线会话切换限制（P1-1）**：离线只读最近 20 缓存会话；非缓存会话离线不可读（提示）；离线不可加载更早历史（`hasMoreBefore=false`）；离线会话列表为启动时快照、不实时更新。在线恢复后由真实 `activate` 覆盖，期间不可离线发送。
- **IPC 大小上限降级代价（P1-2）**：`chatHydratePersistence` 响应超 4 MiB 降级时，非活动会话的消息骨架可能被截断（保留元数据、正文截断），连接建立后由后端全量调和补齐；`chatCacheMessages` 整批拒绝时该批快照缺落，连接后由后端调和兜底。
- **消息快照推送是 best-effort**：Renderer 崩溃/未推送时缓存缺最近增量，连接后由后端全量调和（缓存仅兜底）。
- **自研虚拟列表的高度校正**：若真实 E2E 出现滚动抖动，备选 Chromium `content-visibility:auto`（本批默认不用，避免锚点怪癖）。
- **渲染层 XSS 残留风险**：草稿虽存 Main，但水合后渲染层内存态仍存在（必须显示）；防护靠既有 CSP + 消毒，不新增。
- **高亮库**：代码块无语法高亮（阶段 7 评估）。

## 8. 自审记录

- 自审轮数：2 轮（spec 自审清单 + code-review 视角复核）+ 独立评审 1 轮（2026-08-14，修复 P0-1/P1-1/P1-2、处理 P2-1/P2-2，详见文档状态头）。
- 首轮自审修复：①虚拟列表 prepend 的 overscan 实测高度会推走锚点——补 D5 高度补偿机制（初稿只写「估算恢复」）；②`chatCacheMessages` 未写 untrusted renderer 防御——补 MessageSchema 逐条校验 + 非法丢弃；③`appOpenExternal` 未写 scheme 白名单细节——补 `file:/cyrene:/javascript:` 拒绝 + `setWindowOpenHandler` 理由；④缺「删除会话联动删草稿/缓存」落点——补 conversationStore.remove 内存清 + Main delete handler purge。
- 第二轮复核修复：⑤离线水合缺「展示哪个会话」目标——补 `lastActiveConversationId`（契约 + ChatService.activate 维护 + 水合使用）；⑥50 条目淘汰未提滚动锚点——补「草稿与其锚点一并淘汰」；⑦切会话 capture→flush 时序未定死——补「先捕获再 flush，一次 persistSession 携带两者」；⑧`loadOlder` 的 beforeCursor 空串分支表述自相矛盾——改为「首页 nextCursor 即更早游标」的明确语义。
- 第二轮复核通过项：占位符（无）、内部一致性（决策与 §4 设计、§5 验收一一对应）、范围聚焦（不做项列明）、歧义（100KB 度量=UTF-8 字节、防抖窗口 800ms、cap 常量 300 条/20 会话/50 草稿均定值）。
