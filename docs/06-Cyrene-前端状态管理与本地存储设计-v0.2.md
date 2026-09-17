# Cyrene 前端状态管理与本地存储设计

**文档状态：** 维护中
**最后核验：** 2026-08-29
**适用阶段：** 阶段 1～8
**权威范围：** 状态所有权、本地缓存、持久化和损坏恢复设计
**初始文档日期：** 2026-08-03

> **状态说明：** 正文中的带日期实施/联调注记只代表当时快照；当前阶段、阻塞项和最近验证统一读取 [doc 16](16-Cyrene-前端实施任务清单与进度跟踪.md)。

---

## 1. 目标

- 明确每类状态由谁拥有；
- 避免会话、消息、工具调用在多个 Store 中互相复制；
- 支持流式消息、断线恢复、草稿和最近会话缓存；
- 将敏感凭据与普通设置分开；
- 本地数据损坏或版本升级时可以恢复；
- 后端仍是会话历史的主要事实来源。

## 2. 状态分类

| 类型 | 示例 | 事实来源 | 是否持久化 |
|---|---|---|---|
| 远程业务状态 | 会话、消息、后端工具结果 | 后端 | 最近数据缓存 |
| 本地业务状态 | Desktop 工具权限、执行记录 | Main | 脱敏持久化 |
| UI 状态 | 当前页面、折叠栏、滚动位置、Live2D 栏布局（可见/折叠/宽度） | Renderer | 选择性持久化（布局记忆走 localStorage `cyrene.layout.v1`，见 §8.5） |
| 临时交互状态 | 对话框、悬停、加载中 | Renderer | 不持久化 |
| 用户设置 | 发送键、主题、Live2D 模型/表情设置 | Main 配置 | 持久化 |
| 安全凭据 | Token、刷新凭据 | 系统安全存储 | 加密/安全存储 |
| 诊断状态 | 连接状态、错误摘要 | Main/Renderer | 短期或脱敏日志 |

## 3. Store 划分

> **实施注记（2026-08-11，阶段 2 块 C）：** `connectionStore`/`conversationStore`/`messageStore` 三 store 已落地（`renderer/src/stores/`），命名与职责遵循本节；`messageStore` 经 2A `StreamAccumulator` 应用领域事件、乐观发送用 `clientMessageId` key、断线 in-flight 置 `interrupted`、重连回放经 `onSessionReplay`→`loadReplay`。其余 store（tool/live2d/settings 等）随对应阶段落地。
>
> **实施注记（2026-08-14，阶段 3）：** 新增 `layoutStore`（G1 布局响应式，见 §3.13）、`draftStore`（G2 每会话草稿）、`cacheStore`（G2 离线缓存）、`attachmentStore`（G3 附件待发送队列/上传）、`historyViewerStore`（G4 历史查看器查询/分页/跳转）；CyMessageList 虚拟列表与滚动锚点由 messageStore 消费；草稿/滚动锚点经 Main 持久化（`persistSession`/`hydratePersistence`/`cacheMessages` IPC + `session-store.ts`），附件上传/媒体代理经 attachment 通道与 `main/attachments/`（`media-service.ts`/`upload-service.ts`）。
>
> **实施注记（2026-08-16，阶段 4 批次 B）：** 新增 `voiceStore`（三模式语音编排 + TTS 播放状态 + 麦克风错误，见 §3.9 落地形状）与 `settingsStore`（voice/dictation 本地设置，见 §3.7 落地形状；启动 `hydrate()` 装载 + 500ms 防抖 `settingsSave` 持久化，fail-open 回默认）。语音设置存 Main `dirs.config/settings.json`（受管目录，`main/settings/settings-service.ts` 原子写 + zod + 版本化 + 损坏隔离），非后端契约。`messageStore` 扩展：`applyEvent` 增 `voice_session.turn` 分支（后端预分配 messageId 装配 user 消息）+ `sendVoiceCommit(recordingId, text)`（乐观消息 + `api.voiceCommit` + migrate，复用 send 路径）。`connectionStore` 对 `VOICE_ERROR_CODES`（`shared/contracts/voice.ts`）不展示全局连接错误横幅（语音族错误经 `voice.error` 在语音 UI 展示，D-P15）。
>
> **指向（2026-09-15）：** 多角色／身份面另有 **4 个 store 未在本节逐条列出**（`character-catalog`／`character-editor`／`character-runtime`／`character-identity`，见 `renderer/src/stores/character-*.store.ts` 与 `identity.store.ts:22`）——它们的状态所有权、持久化与离线语义按 [多角色与自定义角色前端架构设计](Cyrene-多角色与自定义角色前端架构设计.md) §9 执行，**不在本文件重复**。

### 3.1 `appStore`

- 应用是否初始化；
- 当前页面；
- 客户端版本；
- 平台和能力摘要；
- 全局不可恢复错误。

### 3.2 `connectionStore`

- 连接状态；
- 当前 Backend 会话 ID；
- 协议版本；
- 最近心跳；
- 重连次数；
- 可公开的认证状态；
- **语音族错误横幅抑制（阶段 4 批次 B，D-P15）：** `setError` 对语音族错误码（`VOICE_ERROR_CODES`：`STT_UNAVAILABLE`/`STT_PROFILE_NOT_FOUND`/`VOICE_SESSION_CONFLICT`/`VOICE_SESSION_NOT_FOUND`/`VOICE_RECORDING_TOO_LONG`/`VOICE_RECORDING_NOT_FOUND`/`DICTATION_NOT_FOUND`/`PLAYBACK_NOT_FOUND`）不展示全局连接错误横幅——语音错误是会话级预期错误，经 `voice.error` 在语音 UI 展示；
- 不保存认证 Token 明文。

### 3.3 `conversationStore`

- 规范化会话实体；
- 会话排序和分页游标；
- 当前会话 ID；
- 列表查询状态；
- 每个会话的草稿引用。
- 会话搜索查询、结果游标和累计 Token 摘要。

> **落地更正（2026-09-15，对照代码逐字复核；指上方末行「会话搜索查询、结果游标和累计 Token 摘要」）：** 该项**未按本节形状落地**——① 没有 `searchStore`（全仓 grep `useSearchStore|searchStore` **0 命中**），历史查看器的查询/分页/范围态落在 `stores/historyViewer.store.ts`；会话列表内的搜索只是组件本地 `ref` 过滤**标题**（`components/CyConversationList.vue:31-36`，未含摘要，与 doc 03 §5.2「搜索会话标题和摘要」也不一致）。② **累计 Token 摘要没有消费方**：后端 `conversationUsage` 最远只到 `shared/domain/stream-accumulator.ts:181` 的 `state`，renderer 全仓 grep `conversationUsage` **0 命中**；文档设想的「后端缺失时按唯一 `generationId` 本机累计并标 `client_sum`」（§5 处理规则）**未实现**。本行按**设计期口径**读。 〔**2026-09-16 取代**：②中「没有消费方/0 命中」已不成立——会话级累计已消费并展示（§3.4 的 `sessionUsageByConversation` 与输入框下方 Token 条）；**但"后端缺失时按 `generationId` 本机累计并标 `client_sum`"这条兜底仍未实现**（有意不做，见 doc 02 §9.3）。①（`searchStore` 缺失）仍然成立。〕

### 3.4 `messageStore`

- 按 ID 规范化的消息；
- 每个会话的消息 ID 顺序；
- 分页游标；
- 流式消息缓冲；
- 父回复到有序句子/多媒体分段的映射；
- 消息级 Token、实际模型和心情；
- 会话级 Token 累计（服务端口径，按会话 ID 归属）；
- 发送确认状态；
- 不保存渲染后的 HTML。

> **C2 展示半边注记（2026-09-15）：** `messageStore` 增 `sessionUsageByConversation`（`Record<conversationId, ConversationTokenUsage>`）与其派生 `currentSessionUsage`、`lastTurnUsage`。为什么落在本 store 而不是新开一个：它是**唯一**同时看得到实时 `generation.completed.conversationUsage`、回放 `session.token_stats`（随 `chat:replay` 到达）、以及"这一代属于哪个会话"归属表与传输栅栏的地方——换一个 store 收这份数据就得把三者各复制一遍。寿命：按会话 ID 键控（切换会话不清、切回仍在），**端点切换**（`clearBackendData`）与**删除会话**（`remove`）清，瞬态断线重连**不清**。**有意不写进消息表**——它不是任何一条消息的属性，混进 `Message` 会跟着消息去分页/缓存/去重，产生第二份真相。`lastTurnUsage` 从**消息表**派生（回放/重启后同样可得），而不是记"最后一次 completed 的 usage"。契约与口径见 doc 02 §9.3 注记。

### 3.5 `toolStore`

- 后端公开工具状态；
- Desktop Runtime 的公开调用状态；
- 工具卡片排序；
- 当前等待权限的调用 ID；
- 不拥有实际执行器和完整敏感参数。

> **阶段 6 决策注记（2026-08-19 定案；2026-08-20 批次 A 落地契约与归档配对，store 本体归批次 B）：** `toolStore` 只存统一 `ToolCallRecord`，权威键 = `sourceCallId`（LLM `tool_call_id`）；三来路归一化——`tool.request`（Desktop 本地状态机）、`tool.started/tool.completed`（Backend 展示 + Desktop 服务端确认）、归档重建（`assistant.tool_calls + role=tool`）。**实时记录为易失视图；归档/REST 回放是历史持久权威**，重连 replay 与历史查看器由归档重建。**批次 A 已落地**：领域契约（`shared/contracts/tool.ts`）、三事件映射（`FrameMapper` 脱敏）、归档配对（`rest-mapper.pairToolCalls` → `Message.toolCalls`，REST 历史 + WS 回放双路径）；toolStore 状态机与卡片渲染归批次 B。完整更新点见 `docs/review/2026-08-19-阶段6-工具双轨统筹决策记录.md` 与 `docs/review/2026-08-20-阶段6批次A-决策记录.md`。

> **阶段 6 批次 B 注记（2026-08-20）**：`toolStore` 已落地（`stores/tool.store.ts`，`init()` 启动装配订阅 `api.onToolEvent`，bootstrap 旁路 `applyBackendEvent`）——**三来路归一化落地**：① `tool:event` 推送（desktop 本地状态机，权威；`upsertLocal`）；② `chat:event` `tool.started/tool.completed`（backend 只读展示；`ToolRequestEvent` 分支仅防御性处理——desktop 请求批次 B 起不再经 chat:event，D6B-08）；③ `Message.toolCalls` 归档（`hydrateFromMessage`，只读卡片数据源为消息本体，toolStore 不复制，不清 live）。**合并规则（D6B-21）**：desktop 本地记录已存在 → 后端 started/completed 不覆盖（**本地状态机裁决优先**）；本地不存在（纯 backend 工具）→ 新建只读记录。**终态单向守卫**：同 id 终态后忽略非终态更新。**双区渲染数据源**：实时区 `CyLiveToolCards` 读 `liveOrder`（上限 3，`generation.started` 清空但**只清终态记录**——awaiting_permission/running 保留，权限窗不消失；trimLiveOrder 只逐出最旧终态）；归档区读 `message.toolCalls`。`waitingForApproval` computed（供权限窗宿主 CyChatView 与 Live2D `waiting_permission` 接线，D6B-13）；`pendingPathSummary` 侧信道（仅 `awaiting_permission` 期间暂存 `pathSummary`，终态即弃，不进领域记录，H-1）；`captureState`（capture 选择/预览态）；`ToolCallRecord` 契约增可选 `attachmentCount?`（`MessageSchema.toolCalls` 同步补 `ToolCallRecordSchema`——修复 preload `safeParse` 剥字段缺陷）。详见 `docs/review/2026-08-20-阶段6批次B-决策记录.md`。

### 3.6 `live2dStore`

- 模型加载状态；
- 当前业务状态和表现指令；
- 用户设置；
- 性能模式；
- 不保存 SDK 实例、WebGL 对象或高频嘴部值。

> **阶段 7 批次 B（2026-08-25，GPU 上下文恢复，Mock 驱动，标「已开发、未联调」）：** **GPU 上下文恢复 = Live2D 渲染层 + 进程级兜底**（面 D）。渲染层——阶段 5 批次 C 已落地：`adapter.initialize` 半初始化 try/catch 兜底 + `reset(modelId?)` GPU 丢失**一次重建**（rebuildGuard finally 复位非永久；成功恢复 ready + 重放 settings/CharacterState；失败 → 静态头像）。进程级——**`child-process-gone` GPU 分支**（`index.ts` 抽 `handleChildProcessGone(details, deps)`）：只留痕 `gpu:crash`（audit）**不 reload**——Live2D 经 `webglcontextlost` + `restoreLostContext`/`rebuild` 间接覆盖该症状（7B 不动 Live2D 层，链路是间接的：GPU 进程崩溃 → Chromium 自动重启 GPU → 各 Renderer 的 WebGL context 置 lost → `webglcontextlost` 触发 → Live2D 恢复）。单测见 `gpu-process.spec.ts`。

### 3.7 `settingsStore`

- Renderer 可见的非敏感设置副本；
- 保存状态和校验错误；
- 更新通过 Desktop API 交给 Main；
- Main 是持久化事实来源。

**落地形状（阶段 4 批次 B；子树清单已过期，2026-09-15 就地补）：** `settingsStore` 持有 `SettingsState{version:1, voice, dictation}`（`shared/contracts/voice.ts`）——`voice{enabled, realtimeEnabled, autoReadReply, showCaptions, consentBackendStt, micDeviceId?}` + `dictation{sttProfileId?, insertMode}`；`hydrate()` 启动装载（失败 fail-open 用默认）、`setVoice`/`setDictation` 本地改 + **500ms 防抖** `api.settingsSave` 持久化；`applyDictationInsert(text)` 按 `insertMode` 追加草稿末尾或替换选区（D-P4）。持久化落 Main `dirs.config/settings.json`（§8.1），**不是后端契约**。

> **补记（2026-09-15）：** 上句 `SettingsState{version, voice, dictation}` **已不是当前形状**——现为 `{version, voice, dictation, live2d, tools, appearance}`（`shared/contracts/voice.ts:58-65`）。本 store 实际持有**四棵子树** `voice`/`dictation`/`live2d`/`appearance`（`stores/settings.store.ts:99-102` 装载、`:168-186` 四个 setter）；`tools` **不归它**（Main 专属，见下文批次 C 注记）。

> **阶段 6 批次 C 注记（2026-08-21）**：`SettingsState` 增 **`tools: { grants: PermissionGrant[] }`** 子树（契约见 `shared/contracts/tool.ts`；`ToolsSettingsSchema.default({ grants: [] })`，**version 保持 1**——新增可选字段带 default，旧文件无 `tools` → 空 grants，向后兼容不触发损坏重建；`ToolsSettingsPatchSchema` 无默认子 schema（IP-1 先例，防单字段 patch clobber）；`SettingsService.save` 子树 merge 不 clobber voice/live2d）。**GrantStore 边界**：grants 属 **Main 专属**（`main/tools/grant-store.ts`：list/add/revoke/prune/matches + 装载期逐条校验 + 审计 `grant:*` 事件 + save 失败 fail-open（内存生效 + 审计 + 日志））；**settingsStore 不消费 tools 子树**——授权管理 UI 以 `tool:grants`（Main 直读）为权威刷新源（`settings:load` 为 invoke 非推送，grant 变更后设置页组件本地刷新，F-12），与渲染面现状一致。

### 3.8 `modelServiceStore`

- LLM、STT、TTS 三类 Profile 的公开配置；
- 内置/自定义来源、自定义 Profile 编辑草稿和类型化校验错误；
- 当前激活的 LLM、直接语音 STT、TTS Profile ID，以及输入法转写专用 STT Profile ID；
- 连接测试、试听和切换状态；
- 凭据是否已配置；
- 不保存或回显密钥明文。
- 自定义 Profile 的凭据输入仅存在于当前表单组件，提交结束立即清除。

### 3.9 `voiceStore`

- 麦克风授权状态；
- 普通录音输入、待发送音频和实时语音会话；
- 直接语音的临时/最终字幕；字幕不得合并到文字草稿；
- 按住说话转文字会话、选定 STT Profile、执行位置和最终草稿插入结果；
- 当前音频输入设备；
- 原始音频缓冲不进入 Pinia 持久化。

**落地形状（阶段 4 批次 B）：** state 为 `mode: 'idle'|'recording'|'record_pending'|'realtime'|'dictating'` + `caption`（仅展示，**绝不写草稿**）+ `record{elapsedMs, audioBuffer, transcript?}` + `realtime{sessionId?, caption, turnCount, unacked, lastAckedSeq}` + `dictation{caption}` + `tts{playingStreamId?, url?, playing, durationMs?}` + `micError?/error?/captureReady`；动作 `init()`（bootstrap 调用，独立订阅 `onChatEvent`）、`handleEvent` 路由（`voice.transcript`/`voice_session.*`/`dictation.*`/`audio.session.*`/`voice.error`）、三模式 start/stop/discard/commit（**D-P19：控制帧先于采集**；统一守卫 `mode==='idle' && connected` + enabled 开关）、consent（D-P16）、背压窗口（D-P12：`MAX_UNACKED_FRAMES=200` 暂停采集、ack 恢复、5s 无 ack 兜底）、TTS 播放门（D-P8/D-P1：`autoReadReply` 关则丢弃、`onended`/`onerror` 清态）、`reset()`（断线/会话切换停采集清态，不调后端 cancel——adapter socket close 已清）。采集走 `renderer/src/voice/PcmCapture`（getUserMedia 16k mono + AudioWorklet→ScriptProcessor 降级，20ms=320 样本=640B 聚合）。

### 3.10 `searchStore`

- 会话搜索，以及统一聊天历史查看器的当前/全部会话范围、关键词、本地日期、IANA 时区、分类、分页游标、查询快照、命中 ID 与加载状态；
- 命中只引用 `conversationId/messageId/segmentId`，不复制消息正文事实；
- 跳转时负责触发目标上下文页加载，不直接修改消息实体。

### 3.11 `resourceStore`

- 按会话和类型索引图片、视频、音频、表情包、文件和链接资源；
- 资源分页游标、缩略图/播放状态和来源消息引用；
- 为统一聊天历史查看器提供分类索引，不再维护独立资源窗口状态；
- 不保存二进制内容或本地绝对路径。

### 3.12 `stickerStore`

- 内置及用户可用表情包清单、稳定资源 ID 和版本；
- 最近使用排序、缩略图状态和发送前选择状态；
- 已发送表情只引用消息中的 `sticker` 分段，不复制消息事实；
- 不持久化来源文件绝对路径或未验证的远程脚本资源。

> **未落地标注（2026-09-15，对照代码逐字复核）——§3.10／§3.11／§3.12 三个 store 在实现中不存在，也无同名取代物：** 全仓 grep `useSearchStore|useResourceStore|useStickerStore` **0 命中**（`apps/desktop` 全域）。实际落点见下三条：
> ① **历史查看器的查询/范围/分页/命中态**在 `stores/historyViewer.store.ts`（跳转锚点 `:125-127`，经 `CyHistoryViewer.vue:234` → `conversationStore.jumpToMessage`）；
> ② **会话媒体/表情/文件的分类索引**是后端搜索结果的资源臂——组件 `CyHistoryResultItem.vue:11-16` 按 `hit.resource.kind` 渲染，**renderer 侧没有资源索引 store**；
> ③ **表情面板**清单与选择态是组件本地 `ref`（`components/CyStickerPanel.vue:14-37`，经 `api.listStickers()` 拉 `stickerId` 清单；待发送队列 `CyChatInput.vue:170` 的 `pendingStickers`，模板见 `:512`；行号 2026-09-18 复核更新）。
> ⇒ 三节按**设计期口径**读，不得当作已落地 store。

### 3.13 `layoutStore`

- 有效布局计算（按**窗口宽度**推导：`layout/effective-layout.ts` 纯函数 + `layout/constants.ts` 的区宽常量与 `MIN_WINDOW_WIDTH`）；
  > **2026-09-12 更正（全评 M-23）**：原表述写"断点 1200/736/520/320"，而 `BREAKPOINTS` 常量已删除——
  > 实测窗口硬最小宽度为 1100，故 736/520/320 三档在实现层面**从未可达**，配套 CSS 媒体查询也已移除。
  > **本 store 的有效布局计算不受影响**（它按宽度推导折叠/关闭，一直在生效）；删掉的只是那个死常量与死媒体查询。
  > 详见 docs/03 §3.1 的范围修正注。
- 会话栏折叠态、Live2D 栏可见/折叠/宽度；
- 布局记忆经 Renderer localStorage（键 `cyrene.layout.v1`，`layout/layout-storage.ts`）读写（§8.5）；不进入 Main 配置。

## 4. 规范化数据结构

```typescript
interface EntityState<T> {
  byId: Record<string, T>;
  allIds: string[];
}

interface ConversationState {
  entities: EntityState<Conversation>;
  orderedIds: string[];
  selectedId?: string;
  nextCursor?: string;
  hasMore: boolean;
  loadState: "idle" | "loading" | "ready" | "error";
}

interface MessageState {
  entities: EntityState<Message>;
  idsByConversation: Record<string, string[]>;
  cursorByConversation: Record<string, string | undefined>;
  streamByGeneration: Record<string, StreamAccumulator>;
}
```

同一个消息实体只保存一次。列表和回复关系使用 ID 引用。

## 5. 流式消息状态

```typescript
interface StreamAccumulator {
  generationId: string;
  messageId: string;
  responseId: string;
  orderedSegmentIds: string[];
  segments: Record<string, SegmentAccumulator>;
  lastFlushAt: number;
  status: "streaming" | "completing" | "interrupted" | "completed" | "failed";
}

interface SegmentAccumulator {
  segmentId: string;
  segmentIndex: number;
  channel: "inner_voice" | "public_reply";
  kind: "text" | "markdown" | "image" | "video" | "audio" | "file" | "sticker" | "link";
  expectedSequence: number;
  pendingChunks: Record<number, string>;
  committedText: string;
  renderText: string;
  completed: boolean;
}
```

处理规则：

- 先按 `responseId` 找到唯一父 Message，再按 `segmentId` 合并字符增量；
- `segmentIndex` 决定 Inner Voice/Public Reply 和多媒体分段的全局顺序；
- 重复增量忽略；
- 发现缺口时短暂等待或请求恢复；
- 按时间片更新 `renderText`，避免逐 Token 重绘；
- 两种通道可以交错到达，互不覆盖；
- `segment.completed` 只完成一个分段，`generation.completed` 才完成父回复；
- 父完成事件到达但存在序列缺口时先进入 `completing`，完成补传或明确标记不完整后再进入终态；
- 完成后将有序 `AssistantSegment[]`、Token、模型和心情写回同一 Message，并删除高频缓冲；
- 会话 Token 优先覆盖为后端 `conversationUsage`；缺失时只按唯一 `generationId` 对已完成回复做本机累计，并把来源标为 `client_sum`，重复完成事件不得重复相加；
- Assistant 的可见回复正文只写入 `assistantSegments`，不得同时复制到 `Message.content`；
- 中断时保留 `committedText`；
- 不把未完成 Markdown 的渲染 HTML 持久化。

## 6. 乐观消息和确认

发送时先创建本地消息：

```typescript
interface PendingMessageRef {
  clientMessageId: string;
  clientRequestId: string;
  conversationId: string;
  serverMessageId?: string;
  status: "pending" | "acknowledged" | "failed";
}
```

确认后：

- 将服务端 ID 与本地 ID 绑定；
- 保持 UI 列表位置；
- 清除待发送队列；
- 失败时保留原文和附件引用；
- 重试继续使用同一 `clientRequestId`，避免重复消息。

## 7. 草稿

每个会话独立保存：

```typescript
interface ConversationDraft {
  conversationId: string;
  text: string;
  attachmentLocalIds: string[];
  updatedAt: string;
}

interface PendingAttachmentState {
  localId: string;
  source: "picker" | "drag_drop" | "paste";
  name: string;
  size: number;
  mediaType: string;
  status: "selected" | "validating" | "ready" | "uploading" | "failed" | "cancelled";
}
```

规则：

- 输入停止一小段时间后保存；
- 发送成功后清空；
- 上传中的临时句柄在重启后不自动恢复；
- 点击选择、拖拽和粘贴只改变 `source`，其余校验与上传状态完全一致；
- 敏感文件内容不进入草稿；
- 草稿数量和总大小设置上限；
- 删除会话时删除其草稿。

> **阶段 7 批次 B（2026-08-25，断线草稿自动保存，Mock 驱动，标「已开发、未联调」）：** `messageStore.handleConnectionStateChange` 在**断线/error** 时补 `flush(cid)`（调用 `useDraftStore` 的 `flush(conversationId)`）——防断线把当前草稿丢在内存态；`persistNow` 为 fail-open（保内存态，持久化失败不阻断）。**不改发送状态机**（用户拍板 D7B-04——不新增「离线发消息队列」）；断线后经既有重连 replay 恢复同步。单测见 `draft-persist.spec.ts`。

## 8. 本地持久化分层

### 8.1 普通配置

保存到应用数据目录的版本化配置文件：

> **落地校正（2026-09-15，对照代码逐字复核）——本代码块是设计期形状，**从未落地**，字段名几乎全部对不上：** 全仓 grep `PersistedSettingsV2` **只在 docs 命中**（`src` 0 命中）；其 `schemaVersion`/`connection`/`chat`/`modelSelection` 四段在代码里**没有任何对应物**（`enterToSend`/`autoScroll`/`autoPlayTts`/`llmProfileId` 均 0 命中）。
> **真实落盘形状是 `SettingsState`**（`shared/contracts/voice.ts:58-65`；schema `shared/schemas/ipc-response.ts:409-414`；默认值 `:427-434`）：`{ version: 1, voice, dictation, live2d, tools, appearance }`。
> 其中 `voice` = `enabled/realtimeEnabled/autoReadReply/showCaptions/consentBackendStt/micDeviceId?/silenceAutoStop/silenceStopMs`，`dictation` = `sttProfileId?/insertMode`，`appearance` 当前**只有** `fontScale`（`shared/contracts/appearance.ts:9-12`）。
> 下方原代码块按「历史设计形状」保留不改写；请与 §3.7 落地形状、§8.1 两条迁移注记一起读。

```typescript
interface PersistedSettingsV2 {
  schemaVersion: 2;
  connection: {
    serverUrl: string;
  };
  chat: {
    enterToSend: boolean;
    autoScroll: boolean;
    codeFontSize: number;
    autoPlayTts: boolean;
  };
  live2d: Live2DSettings;
  modelSelection: {
    llmProfileId?: string;
    voiceSttProfileId?: string;
    ttsProfileId?: string;
    dictationSttProfileId?: string;
  };
  voice: {
    enabled: boolean;
    realtimeEnabled: boolean;
    dictationEnabled: boolean;
    inputDeviceId?: string;
    voiceActivityDetection: boolean;
  };
  appearance: {
    fontScale: number;
    codeFontSize: number;
    accentColor: string;
    theme: "system" | "light" | "dark";
  };
}
```

> **迁移注记（2026-08-14，阶段 3 G1）：** `PersistedSettingsV2.layout` 字段（`conversationPaneCollapsed`/`live2dPaneVisible`/`live2dPaneWidth`）已从普通配置**移除**，布局属「UI 状态·选择性持久化」，改走 Renderer localStorage（键 `cyrene.layout.v1`，见 §8.5）。旧配置中的 `layout` 块在迁移时**忽略**（不读取、不迁移）；清除 localStorage 即恢复默认布局。
>
> **迁移注记（2026-08-16，阶段 4 批次 B）：** 语音与转写本地设置（`voice.enabled`/`realtimeEnabled`/`autoReadReply`/`showCaptions`/`consentBackendStt`/`micDeviceId` + `dictation.sttProfileId`/`insertMode`）不再走 `PersistedSettingsV2.voice` 旧形状（含 `dictationEnabled`/`voiceActivityDetection`），改由独立 `SettingsState` 持久化到 Main **`dirs.config/settings.json`**（`main/settings/settings-service.ts`：注入 `safeRoot` + 复用 `atomicWriteFile` tmp+rename + zod + 版本化 + 损坏备份 `.corrupt` 回默认 fail-open）。`SettingsState` 结构见 §3.7；默认值 `enabled=true`、`realtimeEnabled=false`、`autoReadReply=true`、`showCaptions=true`、`consentBackendStt=false`、`micDeviceId=undefined`、`dictation.sttProfileId=undefined`、`dictation.insertMode='append'`。

输入法转写的执行位置由 `dictationSttProfileId` 所指 Profile 决定，不再另存一个可能冲突的 `dictationRuntime`。切换 STT Profile 时，Store 必须从 Profile 重新派生并展示 Backend、本机或 Local Worker 数据去向。

> **保存失败可见性注记（2026-09-13，M-19）：** 设置保存这条链此前有**两处**让失败到达不了用户，本轮都修了：
> ① **改动被丢弃**——`settings.store.persist()` 的 `pending = {}` 在 `await` **之前**执行，写盘失败即丢掉该 patch（用户看到开关即时生效、重启后被静默还原）。现失败时把这份 patch **merge 回待写队列**（等待期间的新改动优先），并安排**一次**延时自动重试（不是按 500ms 防抖节奏重试——磁盘满/权限不足是持续失败，那样等于热循环打盘）；再失败则留给下一次修改或退出 flush。
> ② **失败不可见**——`saveError` / `saved` 是**死状态**（全仓无组件渲染），而 Live2D 子页写着"500ms 自动保存"。现设置中心**头部下方常驻三态**：正在保存／已保存／**保存失败（`role="alert"`，并明确"改动仍保留在待写队列"）**；文案经 `error-message.ts` 单一来源，跨 IPC 只传 code（`SETTINGS_SAVE_FAILED` 单次写失败；隔离失败复用 `PERSISTENCE_DEGRADED`），**不含任何本地路径**。
> ③ 顺带修掉一处**启动路径缺陷**（H-11b 同族、本轮排查发现）：`SettingsService.load()` 的损坏隔离失败会**上抛**，而组合根是 eager `await settingsSvc.load()`（注释写着"不阻塞启动"；落点原为 `main/index.ts`，2026-09-17 架构整改 Prompt 2 后为 `src/main/bootstrap/services.ts:174`）——"配置文件是符号链接 / 被 AV 或备份代理锁住导致改名失败"会让**整个应用起不来**。现转降级态：保留默认内存态、**拒绝后续写入**（保现场，与 `SessionStore` 同纪律）、留痕计数，启动照常。
> 口径细节见 doc 11 §9（原「跨端同步四态」已按本地保存语义改写为三态）与 [M-19 决策记录](review/2026-09-13-M-19-设置保存失败可见性-决策记录.md)。

安全策略由 Main 单独持久化，包含沙盒目录、规范化路径黑名单、域名黑名单、权限审批历史和有效授权。Renderer 只获得公开摘要和撤销接口。

> **迁移注记（2026-08-21，阶段 6 批次 C）：** `SettingsState` 增 `tools: { grants: PermissionGrant[] }` 子树（`ToolsSettingsSchema.default({grants: []})`，**version 保持 1**——旧文件无 `tools` 字段走 default 填充空 grants，不触发 `.corrupt` 重建，无迁移脚本）。**GrantStore 边界注记**：grants 读写归 Main `grant-store.ts`（`settings.tools.grants` 是唯一持久化面）；目录授权属**本机受信面**——settings.json 被篡改（形状合法）可注入非黑名单敏感目录 grant，防护 = 黑名单 step 5 恒先拒（`/etc` 注入无效）+ schema strict 只允 read/write + 装载期逐条校验剔除畸形条目（`settings:grant-invalid` 日志）+ 形状失败 corrupt 隔离回默认（grant 全清 fail-safe），「无永久 grant」保证仅在创建流成立（装载期不复查 expiresAt 上限）为接受风险（doc 07 注记 N-8）。Renderer 经 `tool:grants`（只读）+ `tool:grant-revoke`（撤销）交互，settingsStore 不消费 tools（`tool:grants` 为授权管理权威刷新源，F-12）。

### 8.2 安全凭据

Token 和刷新凭据通过 Main 使用系统安全存储；Renderer 只获得：

```typescript
interface CredentialStatus {
  configured: boolean;
  originLabel?: string;
  expiresAt?: string;
  accountLabel?: string;
}
```

不提供读取明文 Token 的 Desktop API。

自定义模型 Profile 按所有权分层保存：后端 Profile 由后端保存，Desktop Profile 的非敏感配置由 Main 保存、密钥进入系统安全存储，Local Worker Profile 由 Main 保存公开引用并由 Worker 管理其秘密。Renderer 只缓存公开字段、凭据状态和编辑中的一次性密钥输入；提交结束立即清除。

> **阶段 7 批次 B（2026-08-25，缓存损坏统一层——凭据 fail-closed 不拉平，Mock 驱动，标「已开发、未联调」）：** 本批落地**缓存损坏统一层** `createCorruptIsolation(deps)`（`main/persistence/corrupt-isolation.ts`，注入 logger/audit/countDiagnostic/safeRoot/realpath 可单测），返回 `{ isolate(file, tag, safeRoot?) → 把损坏文件 rename 为 `.corrupt-<tag>-<ts>` 隔离副本；dropInvalid(code) → 计数；pruneCorrupt(file, tag) → 下次成功 load 时清同 tag 旧副本只留最新一份（有界保留）}`。**语义按 store 各自声明**——统一骨架 + 语义可配，绝不拉平。采用者：**settings / session-store / character-draft-store**（`settings-service.ts` 备份名由 `.corrupt` 迁移为 `.corrupt-<tag>-<ts>`、补 `countDiagnostic` 注入；`session-store.ts` 用 isolate+dropInvalid、**移除既有 countDiagnostic 防双计数**；**第三处 `character-draft-store` 为本注记原缺项**——`main/persistence/character-draft-store.ts:103` 构造 `createCorruptIsolation`，`:181` `isolate` / `:168` `pruneCorrupt(file,'character-drafts')` / `:133,:139,:151,:159` `dropInvalid`，同文 `:90-99` 记其与 SessionStore／SettingsService 同纪律的降级位）。**credentials（安全凭据）不纳入统一层**（主会话裁决）——理由：① 凭据形态是 fail-closed（损坏/形状失败 → 拒绝使用该凭据，绝不「重建空凭据」），与统一层的「隔离 + 重建默认 + fail-open」冲突；② 不为密文增 `.corrupt-*` 磁盘备份副本（即使密文也扩大攻击面）；③ 5 参构造注入为 settings/session-store 的损坏处理定制、纳入凭据不划算；④ 既有 CredentialStore 自身已 fail-closed（阶段 0/1 整改 FE-S1-P1-03 的 `EMPTY_FILE` 工厂化）。`.corrupt-*` 隔离副本（尤其 message-cache-v1.json）留存聊天正文，经 `pruneCorrupt` 有界保留、**不纳入日志/审计/诊断导出**（doc 01/07 注明）。

### 8.3 会话缓存

缓存目的仅是改善启动和短暂离线体验：

- 最近会话摘要；
- 最近访问会话的有限消息；
- 最后同步时间和游标；
- 每个会话最近的消息/会话 Token 摘要、资源索引摘要和滚动锚点；
- 不替代后端历史；
- 可由用户清除；
- 设置容量和过期时间。

> **就地更正（2026-09-15，对照代码逐字复核）：** 上列第三条中只有**滚动锚点**落在实现里（`ScrollAnchor` 随草稿存 `drafts-v1.json`：`main/persistence/session-store.ts:41`、`:330`），**「会话级 Token 摘要」与「资源索引摘要」在本机缓存里没有对应字段**——会话快照的落盘形状是 `CacheFile { schemaVersion, conversations, snapshots{ messages, updatedAt, lastSyncAt } }`（`:42`、`:40`），全仓 grep `resourceIndex|tokenSummary` **0 命中**；且后端 `conversationUsage` 到前端只走到 `StreamAccumulator`（`shared/domain/stream-accumulator.ts:181`），无消费者（见本文件 §3.3 注记）。⇒ 本行按**设计期口径**读，不得当作已交付能力。 〔**2026-09-16 取代**：「无消费者」已不成立（会话级累计已消费并展示）。**但本条的主张仍然成立**：「会话级 Token 摘要」与「资源索引摘要」**在本机缓存文件里确实没有对应字段**（`CacheFile` 形状未变），Token 条的数据不落本机缓存、也不随缓存恢复——它按会话 ID 存在内存 store 里。〕

Inner Voice 与 Public Reply 可以作为后端历史的一部分在当前会话内显示，但本地缓存将它们视为敏感聊天内容：不得进入日志或诊断包；清除会话缓存时一并删除；若产品启用“仅缓存 Public Reply”，Adapter 必须保留后端重新拉取 Inner Voice 的能力并在离线状态明确说明。

### 8.4 工具审计

由 Main 持久化脱敏记录。Renderer 获得分页后的公开摘要，不直接读取日志文件。

### 8.5 UI 状态·选择性持久化（布局记忆）

布局相关 UI 状态（窗口位置/大小、会话栏折叠、Live2D 栏可见/折叠/宽度）属**非敏感展示偏好**，走 Renderer localStorage（键 `cyrene.layout.v1`），**不进入 Main 配置**：

> **就地更正（2026-09-15，对照代码逐字复核；doc 03 §3.2 为同一处，一起改）——上句的「窗口位置/大小」在实现中不存在、也刻意不持久化：** `StoredLayoutV1` 只有 `{version, conversationCollapsed, live2dVisible, live2dWidth}`（`layout/layout-storage.ts:15-20`）；全仓 grep `getBounds|setBounds|lastVisited` **0 命中**，窗口位置与大小由 Main 创建窗口时决定（`main/windows/main-window.ts` 的 `minWidth` = `layout/constants.ts` 的 `MIN_WINDOW_WIDTH`），Renderer 不读也不写。上句其余部分（会话栏折叠、Live2D 栏可见/折叠/宽度）与 `LayoutPrefs` 三字段一致（`effective-layout.ts:7-11`），**保留**。

- 由 `layoutStore` 读写（`layout/layout-storage.ts`），组件只消费 store，不直接触碰 localStorage；
- 数据形状含窗口尺寸、当前宽度下的有效布局（`effective-layout.ts`）、会话栏折叠态、Live2D 栏可见/折叠/宽度；
  > **就地更正（2026-09-15，对照代码逐字复核）：** 上句的「窗口尺寸」**不是持久化字段**——落盘形状 `StoredLayoutV1` 只有 `{version, conversationCollapsed, live2dVisible, live2dWidth}` 四项（`layout/layout-storage.ts:15-20`、写入见 `:74-79`、读入经 `:41-45`）；`viewportWidth` 是**运行时值**，首帧由 `window.innerWidth` 播种（`stores/layout.store.ts:18`）、由 resize 更新（`:82-91`），既不读自也不写入 localStorage。有效布局是纯函数计算结果（`effective-layout.ts:35-45`），同样不落盘。本句其余部分（会话栏折叠态、Live2D 栏可见/折叠/宽度）与 §3.13 一致，保留。
- 首帧用 `window.innerWidth` 播种；窗口 resize 后重算有效布局；toggle 按目标态设置并置 override；
- 不做跨会话同步；清除 localStorage 即恢复默认布局；
- 权限对话框、敏感预览等状态一律不持久化。

## 9. 数据库或文件选择

Demo 可以按复杂度选择：

| 数据 | 推荐方式 |
|---|---|
| 普通设置 | 版本化 JSON 或配置存储 |
| 安全凭据 | 系统安全存储 |
| 最近会话缓存 | SQLite 或轻量嵌入式存储 |
| 工具审计 | SQLite 或轮转 JSONL |
| 草稿 | 本地轻量存储 |
| 沙盒、黑名单与授权 | Main 管理的版本化策略存储 |
| 临时语音 | 只存在于会话临时目录，完成后清理 |

如果使用 SQLite，数据库只由 Main 访问，Renderer 通过具名接口查询。

## 10. 版本与迁移

每个持久化结构包含 `schemaVersion`。

迁移规则：

1. 先复制或事务备份旧数据；
2. 按版本逐级迁移；
3. 每一步可重复执行；
4. 迁移失败保留旧文件；
5. 普通缓存可以清空重建；
6. 凭据迁移失败不得降级为明文；
7. 记录错误码，但不记录秘密值。

## 11. 同步与冲突

- 后端会话和消息是事实来源；
- 本地乐观消息只在确认前临时存在；
- 同一实体以服务端 `updatedAt` 或版本字段判断更新；
- 会话删除后清理本地索引、草稿和滚动状态；
- 服务端标题变化时更新本地标题；
- 本地未确认的重命名失败时回滚；
- 工具执行结果不能通过普通会话同步覆盖 Main 的幂等记录。

## 12. 启动恢复

```text
读取并迁移设置
      ↓
恢复非敏感 UI 状态
      ↓
载入最近会话缓存
      ↓
建立后端连接
      ↓
增量同步或重新拉取
      ↓
确认 pending 消息和工具状态
```

缓存损坏时：隔离损坏文件 → 使用默认状态启动 → 从后端恢复 → 提示用户可导出诊断信息。

> **实现状态注记（2026-09-13，H-11b renderer 半边落地）：** 上句四步此前**只实现到第三步**——隔离（2026-09-11 起为 fail-closed：隔离失败即置降级态并拒绝一切写入，保现场）与"用默认状态启动"都在，但「**提示用户**」这一步在实现里从未存在：`SessionStore.getLastError()` 全仓只有测试在读，Renderer 侧 `draft.store.persistNow` 又无条件 fail-open 吞掉写入失败，于是用户看到的是"一切正常"，重启后草稿全丢。现补齐：
>
> - 降级态随**启动水合**一次性告知（`SessionPersistenceState.persistenceDegraded`），这是用户进入应用后第一个能知道"本地保存已停用"的时刻——不必等到下一次键入被拒；
> - 用户在**任何视图**下都能看到全局横幅（`CyPersistenceBanner`，挂 `App.vue` 根部）：`SessionStore` 管的是 `drafts-v1.json` 与 `message-cache-v1.json` **两个**文件，挂在聊天区会导致切到设置页就看不见；
> - 跨 IPC 的只有**无路径投影**（文件名基名 + 封闭触发标签 `read-failed:<errno>`／`not-an-object`／`schema-version-mismatch:<n>`）；含 fs 原文（可能含绝对路径）的完整原因仍只在 Main 的 `getLastError()`／日志／诊断里，符合「Renderer 不得收到绝对本地路径」的边界；
> - 错误码拆两类：`PERSISTENCE_DEGRADED`（本进程内不会自愈，建议先备份再重启）与 `PERSISTENCE_WRITE_FAILED`（单次写失败，恢复可写后自动重试）——两类用户动作不同，此前都被兜底成 `UNKNOWN/内部错误`；
> - **拒绝写入的语义未变**（仍然 fail-closed），操作级 fail-open 也未变（聊天/连接/删除照常可用，只是不落盘）。
>
> 「提示用户可导出诊断信息」继续由既有诊断页承担。**残余**：`cache-messages` 通道的**单次**写失败仍是 fire-and-forget（`cache.store.pushMessages` 的 `catch { 缓存缺落由后端调和兜底 }` 是有意设计），未接 UI；**M-19（设置保存失败不可见）仍未修**，它与 doc 11 §9 的四态一起属产品决定。详见 [H-11b renderer 半边决策记录](review/2026-09-13-H-11b-renderer半边-持久化降级对用户可见-决策记录.md)。

## 13. 容量和清理

- 限制本地消息缓存总量；
- 附件临时文件设置过期时间；
- 语音输入临时音频在转写、取消或失败后按策略清理；
- 输入法转写音频不得进入草稿、消息缓存或 Pinia 持久化，最终文字合并后立即清理；
- 日志和审计按大小与日期轮转；
- Live2D 资源不写入业务数据库；
- 清除缓存不删除系统安全凭据，除非用户明确选择；
- 退出时清理无引用上传临时文件；
- 不依赖用户手工清理才能避免无限增长。

> **性能面注记（2026-08-26，阶段 7 批次 C，已开发、未联调）：** 补「虚拟化 + 缓存 + 内存有界」三条——① 消息/历史虚拟列表 DOM 有界：历史查看器（7C 虚拟化）与消息列表（阶段 3）均经虚拟窗口渲染，DOM 节点数不随会话/结果数线性；② 渲染缓存：`renderMarkdown` 模块级 `Map<string,string>`（source→HTML，完成态 segment 命中免 re-parse），`clearMarkdownCache()` 挂 `resetConversation`（会话切换清空）——缓存上界以「会话内渲染分段总数」为界，非病态增长面（敏感文本 post-sanitize、仅会话内清空、不跨信任边界，接受档见决策记录 §8.6）；③ 测量驱动的内存有界：性能测量 suite（`perf-gate.spec.ts`）断言历史查看器 DOM 节点有界（硬失败）+ JS 堆上限（告警非硬失败，`usedJSHeapSize` 采样≥3 次取稳定值）——若实测 byId/cache.snapshots/historyViewer.items 无病态增长，记观察项不强行加上限（决策 D7C-05）。**三态=已开发、未联调**。

> **7D 注记（2026-08-28，附件/录音内存卫生 + 缓存上限确认，已真实联调）：** **缓存上限已落地确认（无新增）**——草稿 `DRAFT_MAX_BYTES=100KB`/`DRAFT_MAX_ENTRIES=50`、离线缓存最近 20 会话（阶段 3/4 已落地），本次仅文档化 + `[~]`→`[x]`（doc 16 行 420）。**附件内存卫生**：`PendingAttachment` 为内存态待发队列，**不经 `__cyrene-media` 落盘、零 `URL.revokeObjectURL`（全 renderer grep 零命中，无 Blob URL 泄漏面）**；本批补 `remove(localId)` 清 `kindByLocalId`/`fileByLocalId`（非上传中即时释放 File/ArrayBuffer 强引用，上传中仍短路由 `clearOnSent`/`clear` 兜底——既有语义未破坏）。**录音内存卫生**：录音流式走 `audio.session` 事件 + `voice:audio-chunk` 单向守卫，不经 `createObjectURL`，无 Blob URL 泄漏面；`reset()`/`commit`/`discard` 后已释放（renderer 无音频内嵌引用残留）——为例行确认性记录，无新增代码（Task 1）。**结论：无新磁盘清理面，仅内存卫生补点 + 确认记录**。三态=已真实联调（真机两附件驻留 + UI 移除一目标，`pendingById`/`kindByLocalId`/`fileByLocalId` 三方只清目标、另一保留；验收见 `docs/review/2026-08-28-阶段7批次D-真实联调验收.md`）。

## 14. 验收标准

> **阶段 6 批次 C 注记（2026-08-21）**：settings.tools grants 子树 + GrantStore 边界已落地（见 §3.7/§8.1 注记）——grants 持久化归 Main `settings.json` `tools` 子树（`ToolsSettingsSchema.default({grants: []})`，version 1 向后兼容，无迁移脚本）；授权管理以 `tool:grants`/`tool:grant-revoke` 为交互面，settingsStore 不消费 tools（`tool:grants` 权威刷新源）。

> **阶段 7 批次 B（2026-08-25）注记：** 本批落地「缓存损坏统一层 + 断线草稿自动保存 + live2d GPU 上下文恢复」——对应下表「本地缓存损坏后应用仍可启动」「Main 是设置、凭据和审计持久化边界」等项。`createCorruptIsolation`（`isolate`/`dropInvalid`/`pruneCorrupt`）由 settings/session-store 采用，credentials 不纳入（fail-closed 不拉平，见 §8.2 注记）；`messageStore.handleConnectionStateChange` 断线补 `flush(cid)`（§7 注记）；面 D（GPU 上下文）= Live2D 层（阶段 5 批次 C）+ `gpu:crash` 进程级兜底（§3.6 注记）。**三态 = 已开发、未联调**。

- [x] settings.tools grants 子树落地：`SettingsService.save` 子树 merge 不 clobber voice/live2d，version 1 向后兼容（2026-08-21，批次 C）
- [x] GrantStore 边界落地：grants 读写归 Main（`grant-store.ts`），Renderer 只经 `tool:grants`/`tool:grant-revoke` 交互，settingsStore 不消费 tools（2026-08-21，批次 C）

- [ ] 各 Store 的事实来源明确；
- [ ] 同一消息不会在多个 Store 中保存不同副本；
- [ ] 流式内容支持乱序、重复和中断；
- [ ] Inner Voice 与 Public Reply 在同一消息中独立累计和持久化；
- [ ] 同一 `responseId` 的多个句子分段只归并到一个消息实体，分段顺序稳定；
- [ ] 分段完成不会提前结束父回复；回复级/会话级 Token、实际模型和心情更新正确；
- [ ] 历史懒加载保留锚点；统一历史查看器按关键词、日期和分类查询，命中与资源项只引用消息/分段 ID；
- [ ] 每个会话具有独立草稿；
- [ ] LLM、STT、TTS 当前选择和测试状态由独立 Store 管理；输入法转写单独选择兼容 STT Profile；
- [ ] 自定义三类 LLM/STT/TTS Profile 的新增/编辑草稿、测试和激活状态可恢复，密钥不会持久化到 Renderer；
- [ ] 拖拽附件进入当前会话草稿，未发送前不会自动上传；
- [ ] 原始语音缓冲、模型密钥和安全策略细节不进入 Renderer 持久化；
- [ ] 表情包使用稳定资源 ID；直接语音字幕不进入草稿；输入法转写只保存最终草稿文字，不保存临时音频；
- [ ] 字体、强调色、Live2D 选择和语音设置可以版本化迁移；
- [ ] 认证 Token 不进入普通设置、Renderer Store 或日志；Token 使用统计可以作为业务元数据保存；
- [ ] 本地缓存损坏后应用仍可启动；
- [ ] 数据迁移失败不会覆盖旧数据；
- [ ] 会话缓存可限制、过期和清除；
- [ ] Main 是设置、凭据和审计持久化边界。

## 2026-09-16 落地注记（状态面）

- 目录授权撤销：写盘失败**回滚内存**并抛错（此前内存已撤销、磁盘没有 ⇒ 重启后授权复活）。
- `historyViewer` 的查询/续页加**世代栅栏**：await 回来上下文已变即丢弃结果与错误；`busy` 复位刻意不受栅栏（否则查看器永久卡死）。
- 详见 [A/B/C 三批决策与变异记录](review/2026-09-16-审计剩余项ABC三批落地-决策与变异记录.md)。
