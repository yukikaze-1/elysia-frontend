# Cyrene 阶段3 G4 设计：统一聊天历史查看器 + Emoji/表情包 + 无障碍

**日期：** 2026-08-14
**依据：** docs/03 §6/§7.7/§8.5/§14/§15（查看器细节与验收）、docs/02 §11/§19（查询/搜索/资源/跳转契约）、docs/12 D-05/D-06/D-07（查询接口/跳转 ID/表情包）、docs/16 §6 与 docs/10 §6.1（阶段3 任务与验收）、docs/07（Renderer 信任边界与媒体加载）
**审查对象基线：** `main@a576404`（B-01 已真实联调通过后 HEAD）
**范围：** 阶段3 **G4 组**——统一聊天历史查看器（QQ 式：关键词/本地自然日/分类/不透明游标分页/来源跳转）、Emoji 与表情包（插入光标/待发送附件/历史集中查看）、键盘/焦点/中文输入法/基础无障碍；「绘画资源」概念清理方案（文档改动在实施阶段执行）。与 G3（附件/媒体组）的边界在 §2/§4.6 显式声明。
**目的：** 完成阶段3 历史查看器与表情产品闭环：查看器组合查询并跳回来源消息/分段；原消息搜索与会话媒体统一进查看器；Emoji 不自动发送、表情包作为待发送附件并在查看器表情分类集中查看；主要操作键盘可达、IME 合成不误触发送、查看器打开不阻塞聊天流；「绘画资源」提法清理为后端六分类口径。
**决策：** 本批决策按推荐定案并记录（D1～D15，详细理由见 §5）——D1 查看器形态=全窗覆盖式模态；D2 ChatHistoryQuery 契约收敛到 docs/02 §19 形状；D3 日期时区换算=shared/domain 纯函数双端复用；D4 查看器状态归属=独立 historyViewerStore；D5 来源跳转=activate(id, anchor?) 复用 epoch 守卫 + getMessageContext 上下文窗口 + 高亮；D6 高亮=非纯颜色指示；D7 Emoji=光标插入 + 最近优先（localStorage 非敏感例外）；D8 表情包=内置 st_ 清单 + PendingSticker 待发送 + stickerId 发送，收藏/同步不做；D9 贴图/媒体=复用 G3 通用媒体代理 `cyrene://renderer/__cyrene-media/sticker/{stickerId}`，prod 同源 `img-src 'self'` 即放行、dev 两处 `img-src` 追加 `cyrene:`，不放开 img-src 到后端任意源；D10 不阻塞=纯 DOM 覆盖层 + store 继续应用事件；D11 查询=显式提交（带 IME 守卫）、scope 默认全部会话；D12 分页=不透明游标 + 滚动锚点 + busy 防重入；D13 收藏/同步标注后续；D14 无障碍=焦点陷阱/初始焦点/Esc 返回/IME 守卫复用与硬化（isCompositionEnter 纯函数 + .prevent 移入发送路径）；D15 统一查询路径=关键词/日期/分类全部经 queryChatHistory（search 端点 category 参数）单一路径，资源端点不做独立 UI。
**文档状态：** v1 定稿（自审 2 轮：占位符/内部一致性（D15 补入决策表与头部）/范围/歧义（「发送引用」语义界定）+ IME 事实核验（守卫正确性确认 + 硬化措辞修正）；未调用 code-review 技能，采用手工自审清单）；**评审修订轮次（2026-08-14 独立评审，修复 P1-1 + P2-1~2-4）**：P1-1 补 `cyrene-media://` 协议输入校验（stickerId 白名单 `^st_[A-Za-z0-9-]+$`/fetch host 钉定配置后端 origin/scheme 权限注册（app ready 前 `registerSchemesAsPrivileged`）/MIME 白名单/失败回 404 占位，对齐 protocol/handler.ts 防线）；P2-1 全篇 `docs/02 §11.5` → `docs/02 §11`（内容实际在 §11 末段行 633）；P2-2 跳转失败错误呈现统一两分支（查看器已关闭 → 聊天区错误横幅；仍开着 → 查看器内提示）；P2-3 跳转后分页续接（上下文窗口后补首页 getMessages 游标初始化 + loadPage 去重合并，messageStore 增 `nextCursor`/`loadEarlier`）；P2-4 CSP `img-src` 三处（csp.ts/dev-csp.ts/index.html）同步追加 `cyrene-media:`（AND 交集，缺一失效）；**修订轮次 2（2026-08-14 重验，协议统一到 G3 + P3 硬化）**：P2-1 媒体协议统一到 G3 机制——D9 从独立 `cyrene-media://` scheme 改为复用 `cyrene://renderer/__cyrene-media/sticker/{stickerId}`，删除 `registerCyreneMediaScheme`/独立 scheme 特权注册（沿用既有 `cyrene` scheme）；CSP 改为 prod 同源 `img-src 'self'` 即放行、dev 两处 `img-src` 追加 `cyrene:`（P2-4 的 `cyrene-media:` 方案被本次统一取代）；P3-1 贴图分支继承 G3 导航 deny（`__cyrene-media` 前缀）+ `Sec-Fetch-Dest: document` 拒绝；P3-2 代理响应加 1MB 大小上限（对齐 docs/07 行 101 协议/域名/大小/MIME 四项，公开静态贴图免鉴权）；P3-3 钉定 history 项 `resource.url` → stickerId 映射（pathname 末段提取 + 白名单校验；resource 增 `stickerId?` 字段列为待后端确认）；P3-4 MIME 校验改剥参匹配（`split(';')[0].trim() === 'image/png'`，容忍参数）。

---

## 1. 背景与目标

B-01 已真实联调封口（2026-08-14，十项复跑全绿），阶段2 主链转「已真实联调」，阶段3 转为主线。G4 组承接阶段3 中「历史查看器 + 表情 + 无障碍」这一块：

- 当前聊天区只有纵向流式消息，没有统一的历史检索入口；docs/03 §7.7 要求 QQ 式历史查看器：顶部关键词搜索、本地自然日日期筛选、分类筛选（全部/图片视频/表情/文件/音频/链接）、不透明游标分页、来源跳转（跳回来源消息/回复组分段，命中 Inner Voice 定位回复组）。
- 「聊天记录」与「资源」两个入口打开同一个查看器；「资源」快捷入口直接定位图片/视频分类。
- Emoji 插入光标位置不自动发送；表情包（内置 `st_` 清单，`/api/stickers`）可作为待发送附件，历史查看器表情分类集中查看；收藏/同步**不做**（用户已拍板）。
- 「绘画资源」概念需清理：PRD 无绘画功能、后端资源分类仅 `image/link/video/audio/file/sticker`；docs/10 §6.1、docs/03 §7.7/§15、docs/16 §6 中的提法要改（本 spec 给出方案，实际文档改动在实施阶段做）。
- 键盘、焦点、中文输入法（IME）、基础无障碍：主要操作可键盘完成、IME 合成不误触发送。

**完成目标：** 查看器可组合查询（关键词/日期/分类）并跳回来源消息/分段；查看器打开不阻塞聊天流；搜索失败/无结果不清空现有聊天内容；打开时懒加载目标附近历史并高亮来源；Emoji/表情包不自动发送；主要操作键盘可达；`ChatHistoryQuery`/`getMessageContext`/`chat:list-stickers` 契约落地并经 Mock 全链路可测。

## 2. 范围（做 vs 不做）

**本组做：**

1. 统一聊天历史查看器（全窗覆盖模态）：入口按钮（聊天记录/资源）、关键词搜索、本地自然日日期筛选、分类 tabs（全部/图片视频/表情/文件/音频/链接）、scope 切换（当前会话/全部会话）、不透明游标分页与滚动锚点、来源跳转与高亮、空态/错误态/加载态。
2. 查看器数据通道：`queryChatHistory`（`/api/search/messages`）与 `getMessageContext`（`/api/messages/{mid}/context`）在 RealBackend/MockBackend + IPC + Preload + 契约/响应 Schema 落地。
3. Emoji 选择器（光标位置插入、最近使用优先、不自动发送）。
4. 表情包：内置 `st_` 清单（`/api/stickers` → 新 IPC `chat:list-stickers`）、表情包面板、选择进待发送区（PendingSticker）、发送 wire 带 `stickerId`、查看器表情分类集中查看、消息气泡内 sticker 分段渲染。
5. 无障碍：查看器/选择器/表情包面板的焦点陷阱、初始焦点、Esc 关闭与焦点返回、Tab 顺序、焦点可见、分类/表情键盘可达、IME 守卫复用与硬化、aria-live 播报、高亮非纯颜色。
6. 文档清理方案（§4.10）：docs/10 §6.1、docs/03 §7.7/§15、docs/16 §6 的「绘画资源」提法替换；docs/00/01/08/13 同概念提法顺带清扫建议。
7. MockBackend 实现 queryChatHistory/getMessageContext/listStickers，使查看器在 Mock 模式下全链路可演示、可自动化测试。

**本组不做（含与 G3 的边界）：**

- **文件附件上传/下载/媒体渲染管线（G3 组）**：图片/视频/音频/文件在消息内的预览播放、附件上传状态机、签名 URL 流程属于 G3。G4 只消费 G3 定义的附件接口的**待发送条目**形状（本组定义 sticker 特有部分），并在 G3 未落地前用最小接口约定（§4.6）不重叠实现。贴图/媒体静态图渲染**复用 G3 通用媒体代理**（D9，`cyrene://renderer/__cyrene-media/sticker/{stickerId}`）。
- 表情包**收藏/同步/自定义表情包**（用户已拍板砍掉；标注后续，§5 D13）。
- 会话列表的标题/摘要搜索（docs/03 §7.6 的「按会话标题搜索」属会话列表能力，不在查看器内）。
- 消息虚拟滚动/大数据量性能收敛（阶段7）；本组用日期分组 + 分页，不做虚拟列表。
- 实时会话媒体索引视图（`/api/sessions/{id}/resources` 的独立资源窗口）——资源项经查看器分类查询统一呈现，不建独立 UI（D15，见 §4.2）。
- 历史会话离线缓存与损坏恢复（阶段3 其他组）。
- Live2D 表情联动（阶段5）。

## 3. 现状与技术约束

### 3.1 现状（关键证据）

| 位置 | 现状 | 与本组的关系 |
|---|---|---|
| `src/shared/contracts/backend.ts:87-99` | `ChatHistoryQuery extends PageQuery { keyword?, fromDate?, toDate?, category? }`；`ChatHistoryPage { items: Message[], nextCursor?, hasMore }` | 契约是**占位形状**：`items` 直接用 `Message[]`（无法表达命中片段/资源/分段 ID），`keyword/fromDate/toDate` 未接线。需收敛到 docs/02 §11 形状（D2） |
| `src/main/transport/real-backend.ts:552` | `queryChatHistory` 抛 `notImplemented`；`getMessageContext`(:548) 同样 | 无 REST 实现；本组落地 `/api/search/messages`、`/api/messages/{mid}/context` 映射 |
| `src/main/transport/mock-backend.ts:206` | `queryChatHistory` 返回 `{items: [], hasMore: false}` | 无数据；本组实现可过滤的 Mock 历史（记录已发消息 + 预置样例） |
| `src/main/ipc/channels.ts` / `chat-handlers.ts` | 无 queryChatHistory/getMessageContext/listStickers 通道与 handler | 本组新增 3 个通道 |
| `src/preload/desktop-api.ts` | 无对应方法 | 本组新增 3 方法 + DesktopApiLike 同步 |
| `src/renderer/src/components/CyChatView.vue` | 聊天区；header 有「新建」按钮；`visibleIds` 渲染 messageStore | 本组在 header 加「聊天记录」「资源」入口按钮 + 挂载查看器 |
| `src/renderer/src/components/CyChatInput.vue:41-45` | IME 守卫 `e.isComposing || e.keyCode === 229` 正确（Enter 组词不发送）；但模板 `@keydown.enter.exact.prevent` 的 `.prevent` 在 handler 早退（IME 组词确认 Enter）时**仍先于 handler 无条件 preventDefault** | 核验结论：Chromium 下 IME 候选确认不依赖页面默认动作，组词不误发送已由守卫保证；两处**硬化**：① `.prevent` 移入发送路径（防默认行为被无条件阻断的边界风险、意图显式化）；② 守卫抽纯函数与查看器搜索框共用（D14，§4.7） |
| `src/renderer/src/stores/message.store.ts` | `byId/order` 仅存当前会话已加载窗口；无高亮状态；`loadPage` 去重插入 | 跳转高亮需新增 `highlightMessageId/highlightSegmentId` 与上下文窗口加载 |
| `src/renderer/src/stores/conversation.store.ts:110-130` | `activate(id)` 带 epoch 竞态守卫 + currentId 立即切换 + `resetConversation` + `applyPendingReplay` + 首页 `getMessages` | 跳转复用其守卫：扩展 `activate(id, anchor?)` |
| `src/main/protocol/csp.ts` / `config/dev-csp.ts` | `img-src 'self' data:`（打包）/ `img-src 'self' data: blob:`（dev）；renderer/index.html 同 | 后端媒体 URL 直连会被 CSP 拦；贴图走 G3 通用媒体代理（D9，prod 同源 `'self'` 即放行、dev 两处 `dev-csp.ts`+meta 追加 `cyrene:`） |
| docs/02 §19 | `/api/search/messages`（query/conversationId/date_from/date_to/timezone/category/cursor/limit，上限 100）；`/api/messages/{mid}/context`；`/api/sessions/{id}/resources`；sticker wire `stickerId` + `/static/stickers/{id}.png` | 后端契约基线（frontend-handoff-v2 已确认）；搜索 item 的**具体字段形状未在表内逐字段列出**（见 §7 开放项） |

### 3.2 技术约束

- **Renderer 不可信（docs/01/07）**：查看器查询/跳转只经 Preload 窄接口调用 Main；Renderer 不得直接 fetch 后端 REST。媒体/贴图 URL 不得以后端任意源直连渲染（CSP 保持收紧，D9）。
- **Main 是协议差异消化点（docs/01/02）**：`ChatHistoryQuery` 的 `localDate+timeZone` → 后端 `date_from/date_to` 半开区间换算、`category` 枚举映射、结果归一化为前端 `ChatHistoryItem` 全部在 Adapter/RealBackend 内完成；wire 字段不泄漏进 Vue。
- **不透明游标（docs/02 §11）**：分页用 `nextCursor`（后端 base64 串），前端不解析其内容；追加更早结果时用稳定排序键保持滚动锚点。
- **单写者口径（FE-INT-RISK-01）**：查看器为只读消费，不产生写入，不受单写者约束影响；跳转 activate 复用既有激活路径。
- **D-07 已确认**（docs/16 §6 行 104）：内置 sticker 稳定 `st_` ID + `/api/stickers`；收藏/同步为产品决策（本组砍掉）。`/api/stickers` 的**响应字段形状未记录**（开放项，§7）。
- **无日期库依赖**：项目当前无 dayjs/luxon；日期换算用纯函数 + `Intl`（不做 naive `new Date(...)` 本地假设，避免 UTC 跨日错误，D3）。

## 4. 设计

### 4.1 总体架构与组件

新增/改动清单（实施阶段落地，本 spec 只设计）：

**Renderer 新增组件**（`src/renderer/src/components/`）：

| 组件 | 职责 |
|---|---|
| `CyHistoryViewer.vue` | 全窗覆盖模态：header（关闭/scope 切换/关键词输入/日期输入/分类 tabs/搜索按钮）、结果列表（日期分组 + 命中行）、加载更多、空态/错误态/加载态、来源跳转按钮 |
| `CyHistoryResultItem.vue` | 单条命中行：时间/发送者/命中片段/类型 chip/跳转按钮；媒体项显示来源 + 类型 + 缩略图（经受信协议） |
| `CyEmojiPicker.vue` | 弹出面板（Emoji / 表情包 两个 tab）：Emoji 网格（最近优先）、表情包网格；键盘可达、Esc 关闭 |
| `CyStickerPanel.vue` | 表情包 tab 子组件：内置 st_ 清单网格、加载/失败/重试、选择→PendingSticker |

**Renderer 新增 store**：`src/renderer/src/stores/historyViewer.store.ts`（D4）。
**Renderer 改动 store**：`message.store.ts`（+`highlightMessageId/highlightSegmentId/setHighlight/clearHighlight`、`nextCursor` 与 `loadEarlier`（跳转后分页续接，§4.5））、`conversation.store.ts`（`activate(id, anchor?)` + `jumpToMessage`）、`desktop-api.types.ts`（+3 方法）。
**Renderer 改动组件**：`App.vue`（挂 `CyHistoryViewer`）、`CyChatView.vue`（header 入口按钮）、`CyChatInput.vue`（IME 硬化 + Emoji/表情包按钮 + 面板挂载 + sticker 分段渲染）、`CyMessageBubble.vue`（sticker 分段渲染）。

**Main 改动**：`real-backend.ts`（queryChatHistory/getMessageContext/listStickers + REST schema/types）、`mock-backend.ts`（三方法 Mock 实现）、`chat-service.ts`（透传）、`chat-handlers.ts` + `channels.ts`（3 通道）、`protocol/`（**复用既有 `cyrene` scheme，无需新 scheme 注册**——`registerCyreneProtocolHandler` 增 `__cyrene-media/sticker/{stickerId}` 分支，对齐 G3 resolveMedia 分支：stickerId 白名单 `^st_[A-Za-z0-9-]+$/fetch host 钉定配置后端 origin/MIME 剥参白名单 `image/png`/1MB 大小上限/失败回 404 占位，继承 G3 导航 deny（`__cyrene-media` 前缀）+ `Sec-Fetch-Dest: document` 拒绝；CSP：prod 同源 `img-src 'self'` 即放行（`protocol/csp.ts` 不变）；dev 页面跨源需 **dev 两处** `img-src` 追加 `cyrene:`——`config/dev-csp.ts`（dev 中间件）+ `renderer/index.html` meta（dev 宽松），docs/07 G-9 dev 头与 meta 取 AND 交集，缺一即被剔除失效）、`shared/domain/`（日期/时区纯函数 + `stickerIdFromResourceUrl` 解析）。

**Shared 契约改动**：`shared/contracts/backend.ts`（ChatHistoryQuery/ChatHistoryItem/HistoryCategory/ChatHistoryScope/ConversationResource）、`shared/contracts/message.ts`（SendMessageInput +`stickerId?`）、新增 `shared/contracts/sticker.ts`（StickerItem/StickerManifest）、`shared/contracts/ipc.ts`（+3 通道）、`shared/schemas/ipc-response.ts`（+3 响应 Schema）。

### 4.2 数据流

**查看器查询（统一路径，D15）：**

```
UI(关键词/日期/分类/scope) → historyViewerStore.submitQuery()
  → api.queryChatHistory(ChatHistoryQuery)        [Preload → IPC → ChatService → BackendAdapter → RealBackend]
  → RealBackend: GET /api/search/messages?query&conversationId&date_from&date_to&timezone&category&cursor&limit
  → REST Schema 校验 → RestMapper 归一化 → ChatHistoryPage{ items: ChatHistoryItem[], nextCursor, hasMore }
  → store 追加结果 / 更新分页 / 清 busy / 写 error
  → CyHistoryViewer 按 createdAt 本地日期分组渲染
```

- 关键词/日期/分类**任意组合**都走同一条 `queryChatHistory` 路径（后端 search 端点原生支持 `category` 参数），满足「原消息搜索、会话媒体统一进查看器」；`/api/sessions/{id}/resources` 端点本组只作字段补全参考，不建独立 UI（避免重复面板，D15）。
- **「发送引用」语义界定**（docs/16 §6「发送引用与历史分类」）：本组把 Emoji（文本，进入消息 `content`，可经关键词命中）与表情包（`stickerId`，落为 sticker 分段）**发送时携带的引用**作为历史可定位依据——Emoji 经关键词可搜，贴图经 category=sticker 可查并跳回来源消息；「发送引用」即此 messageId/stickerId 定位链路，不另做引用/回复（quote）UI。
- scope=当前会话时传 `conversationId`（当前 `conversationStore.currentId`）；scope=全部会话不传。
- 分类筛选：`全部` → category=all（列表按日期分组）；`图片/视频/表情/文件/音频/链接` → 对应枚举。**「资源」入口**打开时预置 category=`image_video`（D4 `open(category?)` 预置；入口见 §2）。

**来源跳转（D5）：**

```
查看器命中行(点击跳转)
  → historyViewerStore.jumpTo(hit)   // 记录触发按钮 ref 供焦点返回
  → 关闭查看器(焦点返回触发按钮)
  → conversationStore.jumpToMessage(conversationId, messageId, segmentId?)
      → 若已是当前会话:直接 loadContextWindow(anchor)
      → 否则:activate(id, { anchor })——epoch 守卫复用;currentId 切换 + resetConversation + applyPendingReplay
              后改拉 getMessageContext({conversationId, messageId: anchor, before:5, after:5}) 上下文窗口替代首页
      → 上下文窗口 upsert 进 messageStore;按 messageId 定位锚点消息
      → 分页续接:再补一次首页 getMessages({conversationId}) 取 nextCursor 初始化(「加载更早」可续接;仅作游标初始化,经 loadPage 去重合并,见 §4.5「跳转后分页续接」)
      → setHighlight(messageId, segmentId?) —— CyChatView 滚动到该消息 + 高亮
      → 命中 Inner Voice(segmentId 属于 inner_voice 通道):定位父回复组(messageId 即回复组根) + 按当前折叠设置决定展开
  → 失败:查看器已关闭后失败 → 聊天区错误横幅「无法定位消息」(复用 conversationStore.error),不清空聊天内容;若失败发生在查看器仍开着时(如跳转校验失败提前返回)在查看器错误区提示(§4.5 两分支)
```

- `activate(id, anchor?)` 是对现有 `activate` 的**最小扩展**（anchor 缺省时行为完全不变），复用 epoch 竞态守卫与 currentId 立即切换语义（§3.1 证据），避免为跳转另写一套竞态逻辑。
- `getMessageContext` 返回 `MessagePage`（含锚点消息的 before/after 窗口）；前端已知锚点 `messageId`，无需额外标识字段。
- 打开查看器时若正有生成进行，跳转仍先关闭查看器再切换会话——与现有「激活新会话会 resetConversation」语义一致；生成事件由 store 的 generationId 守卫照常丢弃/处理，不因查看器打开而丢帧（D10）。

**表情与表情包（D7/D8）：**

```
Emoji: 选择 → 光标处插入 draft(selectionStart/End 拼接,不自动发送) → 本地最近清单更新(localStorage)
表情包: /api/stickers → chat:list-stickers → StickerManifest
  → 选择 → 待发送区新增 PendingSticker{ stickerId, name? }(G3 附件条目接口,见 §4.6)
  → 发送时 SendMessageInput{ conversationId, text?, clientRequestId, stickerId } → wire payload 带 stickerId
  → 历史:sticker 消息按 messageId 落库 → 查看器「表情」分类集中查看(后端 category=sticker) → 可跳回来源
```

### 4.3 契约与 IPC 变更

**`shared/contracts/backend.ts`（D2，对齐 docs/02 §11/§19）：**

```ts
export type HistoryCategory = 'all' | 'image_video' | 'sticker' | 'file' | 'audio' | 'link'
export type ChatHistoryScope =
  | { type: 'conversation'; conversationId: string }
  | { type: 'all_conversations' }

export interface ChatHistoryQuery extends PageQuery {
  scope: ChatHistoryScope
  query?: string              // 关键词(原 keyword,统一为 query 与后端对齐)
  localDate?: string          // YYYY-MM-DD(用户本地自然日);同时必须传 timeZone
  timeZone: string            // IANA 时区名(Intl.DateTimeFormat().resolvedOptions().timeZone)
  category: HistoryCategory
  cursor?: string             // 不透明游标
  limit: number               // 必填(后端上限 100;默认 50)
}

export interface ChatHistoryItem {
  hitId: string               // 前端稳定性键(由 Adapter 派生,如 `${conversationId}:${messageId}:${segmentId??''}`)
  conversationId: string
  messageId: string           // 必可跳转(D-06)
  responseId?: string         // 后端弃用别名 generationId 对齐:跳转回复组根时用 messageId,responseId 仅供展示兼容
  segmentId?: string          // 分段命中尽量返回
  senderLabel: string         // 发送者(user/assistant/系统/工具)
  snippet?: string            // 命中片段
  resource?: ConversationResource  // 媒体/贴图项资源描述
  createdAt: string
  sortKey: string             // 稳定排序键(Adapter 派生,如 `${createdAt}|${messageId}`)
}

export interface ChatHistoryPage {
  items: ChatHistoryItem[]
  nextCursor?: string
  hasMore: boolean
  snapshotId?: string         // 可选:避免查询期间新消息致分页重复/漏项(docs/02 §11)
}

export interface ConversationResource {
  messageId: string
  timestamp: string
  kind: 'image' | 'link' | 'video' | 'audio' | 'file' | 'sticker'
  url: string                 // 后端资源项 URL(附件为稳定路径;渲染经受信协议/签发,D9)
  stickerId?: string          // P3-3:sticker 项渲染专用(可省)。后端直接返回则跳过解析;缺省由 resource.url pathname 末段提取+白名单校验(§4.6,待后端确认)
}
```

> 注意：现有 `ChatHistoryPage{ items: Message[] }` 改为 `items: ChatHistoryItem[]`，字段更丰富（命中片段/资源/分段 ID），同时保留 `nextCursor/hasMore` 兼容分页消费。`MessageContextQuery`/`MessagePage` 已有，`getMessageContext → MessagePage` 不改。

**`shared/contracts/message.ts`（G4 专属发送扩展）：**

```ts
export interface SendMessageInput {
  conversationId: string
  text: string
  clientRequestId: string
  stickerId?: string   // G4:表情包发送(wire stickerId, st_ 前缀)
}
```

**新增 `shared/contracts/sticker.ts`：**

```ts
export interface StickerItem {
  id: string              // st_ 前缀稳定 ID(D-07)
  name?: string
  url?: string            // 若清单自带完整 URL 则用;否则由 id 派生 /static/stickers/{id}.png
  version?: string
}
export interface StickerManifest { items: StickerItem[] }
```

**`shared/contracts/ipc.ts`（+3 通道）：**

```ts
chatQueryHistory: 'chat:query-history',
chatGetMessageContext: 'chat:get-message-context',
chatListStickers: 'chat:list-stickers'
```

**`shared/schemas/ipc-response.ts`（+3 响应 Schema）：** `ChatHistoryItemSchema`、`ChatHistoryPageSchema`（数组元素改 ChatHistoryItem，`PageSchema(ChatHistoryItemSchema)`）、`StickerManifestSchema`。`getMessageContext` 复用 `MessagePageSchema`。响应 Schema 严格镜像契约（C1 语义，禁止为宽松放宽必填）。

**IPC request schema（`channels.ts`）：** `chatQueryHistorySchema`（scope/query/localDate/timeZone/category/cursor/limit 全字段 zod）、`chatGetMessageContextSchema`（conversationId/messageId/before/after，与现有 MessageContextQuery 对齐）、`chatListStickersSchema`（`z.undefined()`）。

**Preload（`desktop-api.ts`）**：新增 `queryChatHistory(input): Promise<ChatHistoryPage>`、`getMessageContext(input): Promise<MessagePage>`、`listStickers(): Promise<StickerManifest>`（`unwrap` + 对应响应 Schema 防御）；`desktop-api.types.ts` DesktopApiLike 同步 +3。

**RealBackend REST 映射（`real-backend.ts` + `protocol-v2/rest-schemas.ts` + `rest-types.ts` + `rest-mapper.ts`）：**

- `queryChatHistory(input)`：构造 `/api/search/messages` 查询串——`query`、`conversationId`（scope=conversation 时）、`date_from/date_to`（D3 换算）、`timezone`、`category`（后端枚举映射 `image_video→image|video` 或后端直接接受组合值，以实际 `frontend_contract` 为准，开放项 §7）、`cursor`、`limit`；响应 Schema `SearchMessagesResponseSchema` 校验失败 → `SCHEMA_VALIDATION_FAILED`；映射为 `ChatHistoryPage`。
- `getMessageContext(input)`：`GET /api/messages/{mid}/context?conversationId&before&after` → `MessageContextResponseSchema{anchor, before, after, conversationId}` → 归一化为 `MessagePage`（before/after 合并 + 锚点消息，稳定排序）。
- `listStickers()`：`GET /api/stickers` → `StickerManifestSchema`；字段缺失/畸形 → 明确错误，不静默丢字段（docs/02 对齐语义）。

### 4.4 组合查询映射与日期时区（D3）

**日期换算（Main 侧，纯函数，`src/shared/domain/history-date.ts`）：**

```ts
/** localDate(YYYY-MM-DD) + IANA timeZone → 半开区间 [startOfLocalDay, nextDayStart) 的 UTC ISO 串 */
export function localDateToHalfOpenRange(localDate: string, timeZone: string): { from: string; to: string }
/** ISO 时间 → 用户本地自然日标签(YYYY-MM-DD),供结果日期分组 */
export function isoToLocalDate(iso: string, timeZone: string): string
```

- 实现用 `Intl.DateTimeFormat` + 时间组件（`getTimeZoneOffsetAtDate` 这类纯计算），**禁止** `new Date(y,m,d-1)` / 手动 `+8h` 之类的 naive 换算（docs/02 §11 明确「避免 UTC 跨日错误」）。
- 两函数无 Electron/无状态依赖，放 `shared/domain` 双端复用；单测覆盖跨日/夏令时/午夜附近。

**UI 筛选 → ChatHistoryQuery 构建（`historyViewer.store` 内纯函数 `buildQuery(state): ChatHistoryQuery`）：**

| UI 状态 | 映射 |
|---|---|
| scope | 当前会话 → `{type:'conversation', conversationId}`；全部会话 → `{type:'all_conversations'}` |
| 关键词 | → `query`（空串不传） |
| 日期（`<input type="date">`） | → `localDate` + `timeZone`（`Intl.DateTimeFormat().resolvedOptions().timeZone`） |
| 分类 tabs | → `category` |
| 分页 | → `cursor`（首次 undefined）+ `limit: 50` |

### 4.5 来源跳转链路（D5，细节）

- `message.store.ts` 新增 `highlightMessageId` / `highlightSegmentId` / `setHighlight(messageId, segmentId?)` / `clearHighlight()`（高亮在滚动触发或 6s 后自动清除，D6）。
- `conversation.store.ts` 新增 `jumpToMessage(conversationId, messageId, segmentId?)`：
  - 若 `currentId === conversationId`：直接 `loadContextWindow(messageId)`（拉 `getMessageContext` 窗口 + `loadPage` 合并 + setHighlight）；
  - 否则：`activate(conversationId, { anchor: messageId })`——复用 epoch 守卫；上下文窗口加载完成后 setHighlight。
- **跳转后分页续接（P2-3）**：`getMessageContext` 返回 `MessageContextResponse{anchor, before, after, conversationId}`（docs/02 §19 行 965）**无游标字段**；若仅保留上下文窗口，messageStore 只有窗口内约 11 条且无 `nextCursor`，「加载更早」会因游标缺失直接 return（镜像 `conversationStore.getMore` 的 `!nextCursor` 早退模式），无法继续向上加载更早消息。**方案（精确数据流）**：上下文窗口落地后，**再补一次首页 `getMessages({ conversationId, limit: 20 })` 做游标初始化**——该首页请求的 `nextCursor`（opaque `before` 游标）写入 messageStore 的 `nextCursor`，首页 items 与上下文窗口经 `loadPage` 去重合并（upsert 按 `messageId`，按 `createdAt` 稳定排序，重复消息不双写）；此后「加载更早」走 `getMessages({ conversationId, before: nextCursor })` 正常续接（更新 `nextCursor`、失败保留旧结果可重试）。`currentId === conversationId` 分支的 `loadContextWindow` 同样在窗口落地后执行一次游标初始化。messageStore 相应新增 `nextCursor` 状态与 `loadEarlier` action（`!nextCursor` 直接 return，行为镜像 `conversationStore.getMore`），完整数据流见 §4.2 跳转流。
- `CyChatView.vue`：`watch` highlight 状态 → `nextTick` 后滚动锚点消息 `scrollIntoView({ block: 'center' })` + 高亮 class；`clearHighlight` 由滚动事件/定时器触发。**Inner Voice 命中**：`segmentId` 存在且属于 inner_voice 通道时，定位父回复组（消息根 `messageId`），按当前折叠设置决定是否自动展开（docs/03 §7.7「命中 Inner Voice 时先定位回复组，再按用户当前折叠设置决定是否自动展开」）；当前无折叠设置持久化，默认保持折叠、仅高亮回复组容器并给 inner_voice summary 一个「命中」视觉标记。
- 跳转失败（会话已删/消息不存在/上下文窗口空），**两分支统一**：**查看器已关闭后失败 → 聊天区错误横幅**（复用 `conversationStore.error`）展示「无法定位消息」；**失败发生在查看器仍开着时**（如跳转参数/校验失败，未关闭即提前返回）→ 查看器错误区提示「无法定位消息」。两分支均**不清空当前聊天内容**（docs/03 §7.7「搜索失败或无结果不清空现有聊天内容」）。

### 4.6 Emoji 与表情包（D7/D8，含 G3 边界）

**Emoji（D7）：**

- `CyEmojiPicker.vue` Emoji tab：常用 Emoji 网格 + 最近使用优先（`recent` 列表：本会话内存 + `localStorage` 持久化，键 `cyrene:ui:recent-emoji`）。
- 插入逻辑：读取 textarea `selectionStart/selectionEnd`，`draft = draft.slice(0,start) + emoji + draft.slice(end)`，光标移到插入后；**不自动发送**；插入后最近清单更新（去重、最多 24 个）。
- **持久化边界说明（D7 理由）**：docs/06 定义 Main 持久化敏感类（settings/credentials/audit/security policy）；最近 Emoji 为**非敏感纯展示偏好**，localStorage 例外合理；若后续统一到设置持久化通道再迁移（记录开放项）。

**表情包（D8）：**

- `chat:list-stickers` 拉 `/api/stickers` 内置清单；加载中/失败重试/空清单三态。
- 选择表情 → 待发送区新增 **PendingSticker**。**G3 边界（显式声明）**：G4 只消费 G3 附件待发送条目的**最小接口约定**——条目为判别联合：`{ kind: 'file', localId, ... }`（attachment 含 localId）与 `{ kind: 'sticker', stickerId, ... }`（**sticker 分支不含 localId**，以 stickerId 为身份）；本组在 G3 未落地前定义 `PendingSticker { kind: 'sticker'; stickerId: string; name?: string }` 挂到 Composer 待发送区（组件级，不实现上传状态机，上传/文件校验归 G3）。若 G3 先落地统一附件 store，本组改为复用其条目类型，行为语义不变。
- 发送：`messageStore.send` 扩展支持 `stickerId`（`SendMessageInput` 透传）；`real-backend.sendMessage` wire payload 追加 `stickerId`（docs/02 §19 已确认 wire 支持 `stickerId`）。
- 气泡渲染：`CyMessageBubble.vue` 对 `kind:'sticker'` 分段渲染贴图（G3 媒体代理 URL，D9）；user 贴图消息（content 为空 + stickerId）经 Adapter 归一化为 sticker 分段或 `Message.stickerId` 字段（**开放项**：后端历史中用户贴图消息的 wire 表示待确认，§7）。
- 查看器「表情」分类：category=sticker 查询集中展示已发送表情包，可跳回来源（D8）。

**贴图/媒体加载（D9，复用 G3 通用媒体代理，含输入校验）：**

- Renderer 不直连后端任意源；贴图复用 G3 媒体代理机制 **`cyrene://renderer/__cyrene-media/sticker/{stickerId}`**（沿用既有 `cyrene` scheme + `renderer` host，**无需新 scheme 注册/无需特权注册**），Renderer `<img src="cyrene://renderer/__cyrene-media/sticker/{stickerId}">` → Main 以配置后端 origin 下的公开静态 URL `/static/stickers/{id}.png` fetch → MIME 白名单校验（`image/png`）→ 流回。
- **复用 G3 handler 分支（P2-1）**：在既有 `registerCyreneProtocolHandler`（`src/main/protocol/handler.ts`）的 `pathname.startsWith('/__cyrene-media/')` 分支下新增 `mediaType='sticker'` 子分支（对齐 G3 resolveMedia 分支形态）；不新增 `registerCyreneMediaScheme()`/独立 scheme 特权注册（`cyrene` scheme 的 `registerSchemesAsPrivileged` 已由阶段1/G3 注册）。
- **导航与文档请求防护（P3-1，继承 G3）**：`__cyrene-media` 前缀导航判 `deny`（`classifyNavigation`，防媒体字节作顶层文档）+ 媒体分支拒绝 `Sec-Fetch-Dest: document`——本组贴图分支与 G3 附件分支同样适用，双保险。
- **stickerId 白名单校验（P1-1）**：URL 解析后校验 `{stickerId}` 必须匹配 `^st_[A-Za-z0-9-]+$`（D-07 `st_` 前缀 + 安全字符白名单）；URL host 必须等于 `renderer` 且 pathname 前缀为 `/__cyrene-media/sticker/`；pathname 含其余非法字符 → 直接回 404，**不做任何 fetch**。畸形 id 不得拼入后端任意路径/越界（对齐 G3 的「派生目标先校验再 fetch」防线语义）。
- **fetch host 钉定（P1-1）**：fetch 目标 URL（`/static/stickers/{stickerId}.png`）的 origin 必须等于配置的后端 origin（RealBackend 的 baseUrl）；配置缺失/畸形/非白名单 → 拒绝回 404，绝不落到其它主机。
- **MIME 白名单（P1-1 + P3-4）**：响应 `Content-Type` 经**剥参后匹配** `split(';')[0].trim() === 'image/png'` 校验（容忍 `; charset=` 等参数，严格相等会误拒）；不符 → 404/占位，不注入未知类型内容（docs/07 行 101「远程资源先验证协议、域名、大小、MIME 和鉴权，再交给 Renderer」）。
- **响应大小上限（P3-2）**：代理响应体超 **1MB** 上限 → 中止/回 404 占位（docs/07 行 101 四项对齐：协议/域名/大小/MIME；贴图属**公开静态资源，鉴权项不适用**）。
- **异常回 404/占位（P1-1）**：校验失败/拉取失败/超时 → 回 404，Renderer 占位「表情加载失败」+ 重试，不注入未知类型内容。
- **历史项 URL → stickerId 映射（P3-3）**：`ChatHistoryItem.resource.url` 是后端路径（如 `/static/stickers/st_xxx.png`），渲染需 stickerId。**钉定映射**：解析函数 `stickerIdFromResourceUrl(url)`（`shared/domain/sticker-url.ts` 纯函数，可单测）——`new URL(url, 配置后端 origin).pathname` 取末段去 `.png` 后缀得 `stickerId` → 白名单 `^st_[A-Za-z0-9-]+$` 校验 → 通过后构造 `cyrene://renderer/__cyrene-media/sticker/{stickerId}` 渲染 URL；校验失败 → 该历史项按「无贴图」占位处理，不注入任意 URL。`ConversationResource` 契约增可选 `stickerId?` 字段（后端可直接返回则跳过解析，**列为待后端确认项，§7**）。
- **CSP（P2-4 修订，重验#2 修正机制归因）**：prod 下页面与贴图同源（均 `cyrene://renderer`），`img-src 'self'` 即放行**无需改 `protocol/csp.ts`**；dev 页面在 http://localhost（跨源），`img-src` 追加 `cyrene:` 只需改 **dev 两处**——`src/main/config/dev-csp.ts`（dev 中间件 `img-src 'self' data: blob: cyrene:`）+ `src/renderer/index.html` meta CSP（dev 宽松，`img-src` 同加 `cyrene:`）。说明：`buildRendererCsp()`（csp.ts）只在打包/preview 经 `cyrene://` 协议响应头注入，**不参与 dev 的 AND 交集**（dev 文档由 Vite http 提供，仅叠加 dev-csp 中间件头 + meta）；docs/07 G-9 的「dev meta 与 prod 头 AND 交集」指 dev-csp 头与 meta 两者都必须含 `cyrene:`，缺一即被交集剔除失效。
- **G3 关系（P2-1，已统一）**：本组贴图直接复用 G3 通用媒体代理（`/__cyrene-media/sticker/` 子路径），不保留独立 `cyrene-media://` 命名；**无迁移成本**（§7 开放项已升级为已统一）。

### 4.7 无障碍与 IME（D14）

**查看器（模态）：**

- `role="dialog"` + `aria-modal="true"` + `aria-label="聊天历史"`；打开时焦点进关键词输入框；Tab/Shift+Tab 焦点陷阱（`keydown` 循环回拦）；Esc 关闭；关闭后焦点返回触发按钮（触发前记录 `document.activeElement`）。
- Tab 顺序固定：关闭 → scope 切换 → 关键词 → 日期 → 分类 tabs → 结果项 → 加载更多。
- 所有可交互元素 `:focus-visible` 明确样式（不依赖颜色区分态，docs/03 §14「状态不能只依赖颜色」「焦点样式清晰可见」）。
- 搜索输入 Enter 带 IME 守卫（见下）+ 触发提交；Esc 在输入态先清空输入框（可选）再关闭。
- 结果数/错误/空态经 `aria-live="polite"` 播报。
- 高亮：`aria-live` 播报「已定位到消息」+ 非纯颜色指示（「已定位」chip），满足「状态不能只依赖颜色」。

**Emoji/表情包面板：**

- 打开焦点进面板；Tab 遍历网格项（每项 `aria-label`：emoji 字符或贴图名）；Enter/Space 插入；Esc 关闭并回焦点到输入区；插入后焦点留在 textarea。
- 面板与聊天流无遮挡冲突（随 Composer 弹出）。

**IME（核验结论 + 硬化）：**

- **核验结论**：`CyChatInput.vue` 现有 IME 守卫（`e.isComposing || e.keyCode === 229`）正确且完整——IME 组词期间 Enter 不会触发发送；`@keydown.enter.exact.prevent` + 守卫是 Chromium 下标准组合（候选确认不依赖页面默认动作）。
- **硬化 ①（`.prevent` 收敛）**：`@keydown.enter.exact.prevent` 的 `.prevent` 在 handler 早退（组词确认 Enter）时仍无条件 preventDefault。为消除任何输入法在默认行为被阻断时的边界风险并使意图显式，去掉 `.prevent` 修饰符，改为 `onEnter` 内**通过守卫后**调用 `e.preventDefault()` 再 `send()`。
- **硬化 ②（守卫复用）**：抽取纯函数守卫 `isCompositionEnter(e: KeyboardEvent): boolean`（`e.isComposing || e.keyCode === 229`），`CyChatInput.onEnter` 与查看器搜索框共用并单测（`tests/unit/ime-guard.spec.ts`）。
- 搜索框与 Emoji 面板输入同样遵循：IME 合成期间 Enter 不触发搜索/不插入。

### 4.8 错误处理

| 场景 | 行为 |
|---|---|
| 搜索失败（网络/后端 5xx/超时） | 查看器错误区展示 `parsePublicError` 消息；**保留上次成功结果**；重试按钮；**不影响聊天区** |
| 查询无结果 | 空态「没有找到相关聊天记录」；不清空聊天内容（docs/03 §7.7） |
| 分页加载失败 | 保留当前页 + 底部「加载失败，重试」；busy 复位 |
| 跳转定位失败 | 两分支：查看器已关闭 → 聊天区错误横幅「无法定位消息」（复用 conversationStore.error）；查看器仍开着（校验失败提前返回）→ 查看器错误区提示；均**不清空当前聊天内容** |
| 贴图清单加载失败 | 表情包 tab 显示失败 + 重试；Emoji tab 不受影响 |
| 贴图/媒体渲染失败 | 占位 + 重试，不注入未知内容（D9） |
| 未连接/会话未就绪 | 查看器可打开；查询经 Main 失败 → 查看器错误区「未连接，无法查询历史」（不 gating 入口，避免复杂度） |

**通用原则**：所有 Main 侧协议错误显式报错（`SCHEMA_VALIDATION_FAILED` 等），不静默丢字段；Renderer 只展示 `PublicError.message`，不展示堆栈/wire 字段（docs/07）。

### 4.9 测试计划

**新增单测**（`tests/unit/`）：

| 文件 | 覆盖 |
|---|---|
| `history-date.spec.ts` | `localDateToHalfOpenRange`（普通日/跨 UTC 日/夏令时/午夜）、`isoToLocalDate`（跨时区分组标签） |
| `chat-history-query.spec.ts` | `buildQuery`：scope/关键词空串不传/日期+时区/分类/limit 默认 50；边界（无日期无关键词） |
| `history-viewer.store.spec.ts` | open(category?) 预置、submitQuery 成功/失败（保留旧结果）、loadMore 游标与 busy 防重入、无结果空态、跳转编排（关闭→jumpToMessage→highlight）、**打开不阻塞**（store 事件继续应用） |
| `rest-search-mapper.spec.ts` | 后端 search 响应 → `ChatHistoryItem` 归一化（hitId/sortKey 派生、resource 映射、缺字段显式错误）；畸形 item 处理 |
| `real-backend-search.spec.ts` | queryChatHistory URL 参数（date_from/date_to 半开区间、timezone、category、cursor）、getMessageContext 参数与 MessagePage 归一化、错误映射（含 fetch 注入失败） |
| `sticker.spec.ts` | listStickers 清单归一化、SendMessageInput 带 stickerId 的 wire payload（mock 断言） |
| `sticker-url.spec.ts` | `stickerIdFromResourceUrl`（P3-3）：pathname 末段提取（含/不含 `.png` 后缀、带 query）、白名单校验（st_ 合法 / 畸形 id 拒 / 非 st_ 前缀拒）、通过后构造 `cyrene://renderer/__cyrene-media/sticker/{stickerId}` |
| `ime-guard.spec.ts` | `isCompositionEnter`：isComposing true / keyCode 229 / 正常 Enter 三分支 |
| `mock-backend-search.spec.ts` | Mock queryChatHistory 过滤（关键词/分类/scope/日期）、getMessageContext 窗口切片、listStickers |

**新增集成**（`tests/integration/`）：`history-viewer-ipc.spec.ts`——3 新通道 handler 注册、MockBackend 装配后 queryChatHistory/getMessageContext/listStickers 经 IPC 往返返回预期结果；沿用现有装配测试模式。

**既有测试回归关注**：`message.store.spec`（send 扩展 stickerId 不破坏文本发送）、`conversation.store.spec`（activate 扩展 anchor 缺省行为不变）、`desktop-api-chat.spec`/`chat-handlers.spec`（新通道不破坏既有注册）。

### 4.10 文档清理方案（「绘画资源」概念）

后端资源分类仅 `image/link/video/audio/file/sticker`（docs/02 §19），PRD 无绘画功能；「绘画资源」是历史遗留概念，全部替换为六分类或「会话媒体」口径。**实施阶段按下列替换文案改文档**（本组 spec 只给方案）：

| 文档位置 | 现文（要点） | 替换为 |
|---|---|---|
| docs/10 §6.1 第 135 行 | 「将原消息搜索、绘画资源和会话媒体统一到历史查看器」 | 「将原消息搜索与会话媒体统一到历史查看器（分类：全部、图片/视频、表情、文件、音频、链接）」 |
| docs/03 §7.7 第 236 行 | 「图片/视频分类承载现有绘画资源与会话媒体，表情分类集中展示已发送表情包」 | 「图片/视频分类承载会话媒体（图片、视频），表情分类集中展示已发送表情包」 |
| docs/03 §15 第 443 行 | 「原消息搜索、绘画资源和会话多媒体均已整合进历史查看器」 | 「原消息搜索与会话多媒体均已整合进历史查看器（图片/视频、表情、文件、音频、链接分类）」 |
| docs/16 §6 第 270 行 | 「把原消息搜索、绘画资源与会话媒体统一到历史查看器」 | 「把原消息搜索与会话媒体统一到历史查看器（后端六分类：图片/视频、表情、文件、音频、链接）」 |
| （顺带清扫，同概念）docs/00 第 14 行、docs/01 第 328 行、docs/08 第 346 行、docs/13 第 119 行 | 「绘画资源」提法 | 同一「会话媒体/六分类」口径替换，保持整套文档一致 |

> 边界说明：本组**实施阶段只负责 docs/10 §6.1、docs/03 §7.7/§15、docs/16 §6 四处必改**（用户锁定）；docs/00/01/08/13 为同概念一致性清扫，建议同批次由 G4 实施一并处理并同步文档状态（若拆分另行记录）。

## 5. 决策记录（D1…D15）

| ID | 决策 | 理由 |
|---|---|---|
| D1 | 查看器形态=全窗覆盖式模态（覆盖聊天主区与会话栏，保留导航栏/标题栏），现代 QQ/微信风格 | 历史查看是聚焦任务；覆盖层不改四区布局、避免重排；聊天流在其后继续（不阻塞 D10）；与 QQ 历史搜索交互一致 |
| D2 | `ChatHistoryQuery` 契约收敛到 docs/02 §19 形状（scope/query/localDate/timeZone/category/cursor/limit），`items` 改 `ChatHistoryItem[]`；废弃占位 keyword/fromDate/toDate | docs/02 §19 为已确认后端契约（frontend-handoff-v2），单一来源；占位字段未接线（real-backend 抛 NOT_IMPLEMENTED），无兼容负担；ChatHistoryItem 表达命中片段/资源/分段 ID，跳转必需 |
| D3 | 日期时区换算=shared/domain 纯函数（`localDateToHalfOpenRange`/`isoToLocalDate`，Intl 实现）双端复用 | docs/02 §11 明确「避免 UTC 跨日错误」；项目无日期库；纯函数可单测、Main/Renderer 共用 |
| D4 | 查看器状态归属=独立 `historyViewerStore`（Pinia） | 查询/分页/跳转编排可单测、与组件解耦；chat/message store 不膨胀 |
| D5 | 来源跳转=`activate(id, anchor?)` 最小扩展 + `getMessageContext` 上下文窗口 + `highlightMessageId/SegmentId` | 复用 activate 的 epoch 竞态守卫与 currentId 立即切换语义；避免为跳转另写竞态逻辑；anchor 缺省行为不变（回归零风险） |
| D6 | 高亮=CSS 高亮 + 「已定位」chip（非纯颜色）+ aria-live 播报，滚动/6s 后清除 | docs/03 §14「状态不能只依赖颜色」；不依赖颜色传达定位状态 |
| D7 | Emoji 选择器：光标插入 + 最近使用优先；最近清单存 localStorage（非敏感 UI 偏好例外） | Emoji 是文本编辑语义（不自动发送）；最近优先满足产品（docs/03 §8.5）；非敏感纯展示偏好，localStorage 例外合理，避免为 trivial 偏好增加 Main 持久化 IPC |
| D8 | 表情包：内置 st_ 清单（/api/stickers）+ PendingSticker 待发送 + wire stickerId 发送；收藏/同步不做 | D-07 已确认内置 st_ 清单；docs/02 §19 wire 支持 stickerId；收藏/同步为用户拍板砍掉（记录后续） |
| D9 | 贴图/媒体**复用 G3 通用媒体代理** `cyrene://renderer/__cyrene-media/sticker/{stickerId}`（沿用既有 `cyrene` scheme，无新 scheme 注册；继承 G3 导航 deny + `Sec-Fetch-Dest: document` 拒绝 + 1MB 大小上限；stickerId/MIME/fetch host 白名单校验），CSP：prod 同源 `img-src 'self'` 即放行、dev 两处（`config/dev-csp.ts` + `renderer/index.html` meta）追加 `cyrene:`，不放开后端任意源 | docs/07 信任边界：Renderer 不可信、后端 URL 不得任意注入渲染；CSP 保持收紧；与 G3 统一协议避免两套代理/双 CSP 源；MIME 校验防注入 |
| D10 | 不阻塞语义=查看器纯 DOM 覆盖层；message/conversation store 照常应用事件；查询失败/无结果不清空聊天内容 | docs/03 §7.7「打开查看器不阻塞聊天流」「搜索失败或无结果不清空现有聊天内容」；store 级无阻塞点 |
| D11 | 查询=显式提交（搜索按钮/Enter，带 IME 守卫），不做防抖实时查询；scope 默认「全部会话」+ 切段开关 | 避免每键击后端请求；语义清晰可控；QQ 历史默认全局检索 |
| D12 | 分页=不透明游标（nextCursor）追加更早结果 + 稳定排序键滚动锚点 + busy 防重入 + 失败保留旧结果可重试 | docs/02 §11 游标分页要求；滚动锚点体验（docs/03 §7.6）；防重复请求 |
| D13 | 表情包收藏/同步**不做** | 用户已拍板；记录为后续（docs/16 D-07「收藏/同步为产品决策」悬置） |
| D14 | 无障碍验收点：模态焦点陷阱 + 初始焦点 + Esc 关闭/焦点返回 + Tab 顺序 + 焦点可见 + 键盘可达分类/表情 + IME 守卫复用与硬化（`isCompositionEnter` 纯函数 + `.prevent` 移入发送路径）+ aria-live + 高亮非纯颜色 | docs/03 §14/§15 与 docs/16 §6「主要操作可通过键盘完成」「中文输入法不会触发误发送」；核验确认现有 IME 守卫正确，硬化消除 `.prevent` 无条件阻断默认行为的边界风险并统一两处守卫（§4.7） |
| D15 | 统一查询路径：查看器关键词/日期/分类组合全部经 `queryChatHistory`（search 端点 `category` 参数）单一路径；`/api/sessions/{id}/resources` 端点不做独立 UI，仅作资源字段补全参考 | 单一数据路径满足「原消息搜索与会话媒体统一进查看器」，避免维护互割裂的搜索面板与资源窗口（docs/03 §7.7 首句）；search 端点原生支持 category，无需第二查询通道 |

## 6. 验收标准

对照 docs/16 §6 阶段3 + docs/03 §7.7/§15：

- [ ] 「聊天记录」与「资源」两入口打开**同一个**查看器；「资源」入口预置图片/视频分类；
- [ ] 查看器支持关键词 + 本地自然日 + 分类（全部/图片视频/表情/文件/音频/链接）组合查询，不透明游标分页（busy 防重入 + 滚动锚点）；
- [ ] 点击结果 → 查看器关闭 → 跳回来源消息并高亮（滚动居中 + 非纯颜色指示 + aria-live）；命中 Inner Voice 定位回复组并按折叠设置展示；
- [ ] 查看器打开期间聊天流不中断：生成继续、关闭后显示最新状态（不丢帧、不阻塞）；
- [ ] 搜索失败/无结果**不清空**现有聊天内容；跳转失败不清空当前聊天；
- [ ] Emoji 插入光标位置、不自动发送、最近使用优先；
- [ ] 表情包为内置 st_ 清单（/api/stickers），选择后作为待发送条目、发送 wire 带 stickerId、不自动发送；查看器「表情」分类集中展示并可跳回来源；
- [ ] 消息气泡内 sticker 分段渲染为贴图（G3 媒体代理加载，失败占位可重试）；
- [ ] 主要操作键盘可达：模态焦点陷阱、初始焦点搜索框、Esc 关闭并返回焦点、Tab 顺序、分类 tabs 与表情/贴图项键盘选择、焦点可见；
- [ ] 中文输入法合成期间 Enter 不误发送（查看器搜索框与消息输入区）；IME 守卫硬化（`isCompositionEnter` 纯函数 + `.prevent` 移入发送路径）落地；
- [ ] 「绘画资源」提法在 docs/10 §6.1、docs/03 §7.7/§15、docs/16 §6 清理完成（实施阶段文档改动 + 状态同步）；
- [ ] 契约落地：`ChatHistoryQuery`/`ChatHistoryItem`/`StickerManifest`/`SendMessageInput.stickerId` + 3 IPC 通道 + Preload + 响应 Schema；check:contract 不回归；
- [ ] Mock 模式全链路可演示：查看器组合查询/分页/跳转/表情发送在 MockBackend 上可用；
- [ ] 门禁：`pnpm typecheck` / `pnpm lint` / `pnpm test`（527 单测 + 本组新增）/ `xvfb-run -a pnpm test:integration` / `pnpm build` / `pnpm -F @cyrene/desktop check:contract`（13/13）/ `pnpm package` + `verify:artifact --smoke` 全绿；
- [ ] 状态标记：本组完成标「已开发、未联调」（查看器相关真实后端端点 search/context/stickers 需 B-01 后的真实联调复验，才可升「已真实联调」）。

## 7. 已知限制与开放项

- **搜索 item 字段形状待确认**：docs/02 §19 只给了 `SearchMessagesResponse{items, has_more, cursor}`，item 内字段（是否含 `senderLabel/snippet/kind/url`）未逐字段记录；实施时以 `frontend_contract`（rest.py `SearchMessagesResponse`/item）为准，并保持 check:contract 门禁；若与 docs/02 §11 的 `ChatHistoryItem` 有出入，Adapter 在 Main 内桥接，不泄漏 wire 字段。
- **`/api/stickers` 响应形状待确认**：D-07 确认存在内置 st_ 清单端点，但响应结构未记录；本组按 `StickerManifest{items}` 定义前端契约，实施时对后端响应做 Schema 校验并对齐。
- **后端分类参数取值待确认**：`category=image_video` 后端是直接接受组合值还是 `image|video` 分开；按实际 `frontend_contract` 对齐（D 记录）。
- **历史中用户贴图消息的 wire 表示待确认**：`Message` 模型无 `stickerId` 字段，用户 sticker-only 消息在 REST 历史中的表示（metadata? content?）需后端确认后归一化（可能复用 `Message.stickerId` 或 sticker 分段）。
- **贴图协议已统一（P2-1）**：本组贴图直接复用 G3 通用媒体代理 `cyrene://renderer/__cyrene-media/sticker/{stickerId}`，**无迁移成本**；不再保留独立 `cyrene-media://` 命名（D9 记录）。
- **resource 是否直接回 `stickerId` 待后端确认（P3-3）**：`ChatHistoryItem.resource.url` 后端当前只回路径（如 `/static/stickers/st_xxx.png`）；本组按 pathname 末段提取 + 白名单校验解析（§4.6），若后端可直接回 `stickerId` 字段则跳过解析（`ConversationResource` 契约增可选 `stickerId?`，待联调确认）。
- **最近 Emoji localStorage 例外**：非敏感 UI 偏好；若后续统一设置持久化通道再迁移（D7 记录）。
- **Inner Voice 折叠设置**：当前无折叠设置持久化，命中时保持默认折叠并给高亮视觉标记；折叠偏好持久化属后续。
- **收藏/同步**：表情包收藏/同步不做（D13），标注 docs/16 D-07 悬置为后续产品决策。
- **真实联调**：查看器依赖的 search/context/stickers 端点需真实后端联调复验后升「已真实联调」；本组当前按 Mock 驱动交付标「已开发、未联调」。

## 8. 文档同步（本组范围）

- 本 spec 落 `docs/superpowers/specs/2026-08-14-phase3-historyviewer-emoji-a11y-design.md`；
- 实施完成后（由实施计划/批次报告）更新：
  - docs/10 §6.1、docs/03 §7.7/§15、docs/16 §6 的「绘画资源」清理（§4.10 文案）；
  - docs/16 状态行（阶段3 G4 批次落地 + 测试数字 + 三态标记）；
  - docs/02 §19 搜索/资源/sticker 行补实际确认字段形状（若实施确认）；
  - README/CLAUDE.md 阶段3 状态同步；
- 本 spec 的「已开发、未联调」标记在真实后端联调通过后按三态口径更新。
