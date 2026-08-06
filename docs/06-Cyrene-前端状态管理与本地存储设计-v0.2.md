# Cyrene 前端状态管理与本地存储设计

**文档版本：** v0.2  
**文档状态：** 首轮 Review 已修订 / 待后端数据模型对齐  
**适用范围：** Vue Renderer、Electron Main、本地配置与缓存  
**文档日期：** 2026-08-03
**最后复核日期：** 2026-08-04

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
| UI 状态 | 当前页面、折叠栏、滚动位置 | Renderer | 选择性持久化 |
| 临时交互状态 | 对话框、悬停、加载中 | Renderer | 不持久化 |
| 用户设置 | 发送键、Live2D、主题 | Main 配置 | 持久化 |
| 安全凭据 | Token、刷新凭据 | 系统安全存储 | 加密/安全存储 |
| 诊断状态 | 连接状态、错误摘要 | Main/Renderer | 短期或脱敏日志 |

## 3. Store 划分

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
- 不保存认证 Token 明文。

### 3.3 `conversationStore`

- 规范化会话实体；
- 会话排序和分页游标；
- 当前会话 ID；
- 列表查询状态；
- 每个会话的草稿引用。
- 会话搜索查询、结果游标和累计 Token 摘要。

### 3.4 `messageStore`

- 按 ID 规范化的消息；
- 每个会话的消息 ID 顺序；
- 分页游标；
- 流式消息缓冲；
- 父回复到有序句子/多媒体分段的映射；
- 消息级 Token、实际模型和心情；
- 发送确认状态；
- 不保存渲染后的 HTML。

### 3.5 `toolStore`

- 后端公开工具状态；
- Desktop Runtime 的公开调用状态；
- 工具卡片排序；
- 当前等待权限的调用 ID；
- 不拥有实际执行器和完整敏感参数。

### 3.6 `live2dStore`

- 模型加载状态；
- 当前业务状态和表现指令；
- 用户设置；
- 性能模式；
- 不保存 SDK 实例、WebGL 对象或高频嘴部值。

### 3.7 `settingsStore`

- Renderer 可见的非敏感设置副本；
- 保存状态和校验错误；
- 更新通过 Desktop API 交给 Main；
- Main 是持久化事实来源。

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

## 8. 本地持久化分层

### 8.1 普通配置

保存到应用数据目录的版本化配置文件：

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
  layout: {
    conversationPaneCollapsed: boolean;
    live2dPaneVisible: boolean;
    live2dPaneWidth: number;
  };
}
```

输入法转写的执行位置由 `dictationSttProfileId` 所指 Profile 决定，不再另存一个可能冲突的 `dictationRuntime`。切换 STT Profile 时，Store 必须从 Profile 重新派生并展示 Backend、本机或 Local Worker 数据去向。

安全策略由 Main 单独持久化，包含沙盒目录、规范化路径黑名单、域名黑名单、权限审批历史和有效授权。Renderer 只获得公开摘要和撤销接口。

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

### 8.3 会话缓存

缓存目的仅是改善启动和短暂离线体验：

- 最近会话摘要；
- 最近访问会话的有限消息；
- 最后同步时间和游标；
- 每个会话最近的消息/会话 Token 摘要、资源索引摘要和滚动锚点；
- 不替代后端历史；
- 可由用户清除；
- 设置容量和过期时间。

Inner Voice 与 Public Reply 可以作为后端历史的一部分在当前会话内显示，但本地缓存将它们视为敏感聊天内容：不得进入日志或诊断包；清除会话缓存时一并删除；若产品启用“仅缓存 Public Reply”，Adapter 必须保留后端重新拉取 Inner Voice 的能力并在离线状态明确说明。

### 8.4 工具审计

由 Main 持久化脱敏记录。Renderer 获得分页后的公开摘要，不直接读取日志文件。

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

## 14. 验收标准

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
