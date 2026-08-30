# Cyrene 多角色、用户身份与自定义角色前端架构设计

> **文档状态：** 架构设计稿（目标设计；前端 A 契约层已实施，实时进度以 doc 16 为准）  
> **日期：** 2026-08-30  
> **前端事实基线：** `elysia-frontend@23e7108`  
> **后端契约基线：** `elysia-agent/docs/2026-08-30-character-prompt-customization-backend-architecture-design.md`（该文档事实基线 `elysia-agent@a410a9d`）  
> **前后端契约冻结：** `character-contract-v1`（2026-08-30；与后端 §11～§12 同形）  
> **权威范围：** Electron Main/Preload/Renderer 中用户最小身份、角色目录与编辑、会话选角、角色公开状态、Live2D/TTS 角色关联、缓存迁移和前后端联调  
> **验证口径：** 本文基于当前前端代码与后端目标设计静态核对；文中的新类型、接口、页面和事件均不代表已经实现  
> **明确排除：** 任务中心继续暂缓；Neo4j 关系图谱暂不实现；本文不重写后端 Prompt Compiler、人格演化或记忆隔离实现

---

## 0. 结论与冻结决策

这次前端改造不是增加一个“System Prompt 文本框”，也不是把 Live2D 模型选择器改名为“角色选择器”。前端需要接入一个新的角色领域：**用户先确认“我是谁”，角色作为后端持久化并版本化的实体存在，新会话显式绑定角色实例，聊天、角色公开状态、Live2D 和 TTS 始终围绕同一个角色身份工作。**

本设计冻结以下决策：

1. **后端是角色定义、角色版本、角色实例和用户身份的事实来源。** 前端只保存 UI 状态和受控的未提交编辑草稿，不建立第二套角色数据库。
2. **Renderer 不接触原始后端协议。** REST/WS 原始字段、严格 schema、snake/camel 映射、错误归一和 feature flag 解析继续收口在 Main。
3. **所有关联使用稳定 ID，不使用名字。** `characterId`、`characterInstanceId` 和 `characterRevision` 是身份；“Elysia”“Cyrene”只是可变显示内容。
4. **V1 已有会话不能换角色。** 用户选择另一角色时创建新会话；前端不得提供看似可用、实则改写已有上下文归属的“切换当前会话角色”控件。
5. **“我的档案”与“角色”是两个领域。** 用户名字、希望被如何称呼、代词、语言和时区不放进角色表单，也不放进本地 Live2D 设置。
6. **角色目录、角色编辑和角色运行态分 Store。** 不把 CRUD、长表单、公开状态、会话绑定和 Live2D 全部塞进现有 `conversationStore` 或 `live2dStore`。
7. **用户 authored 的角色内容可以进入 Renderer 编辑，但框架 Prompt 和内部人格状态不能进入 Renderer。** 前端不得请求或展示编译后的 System Prompt、F1/F2/F3、L2/L3/L4、Reflector 缓冲、长期记忆原文或后端模板源码。
8. **角色更新使用不可变版本和显式冲突处理。** 前端必须提交 `expectedRevision`；409 时保留本地草稿并展示冲突，不得静默覆盖。
9. **产品态角色状态与 Live2D 技术状态是两回事。** `CharacterPublicState` 表示角色心情、活动和最近互动；现有 `CharacterState` 实际是本地渲染/交互状态机，目标命名应改为 `Live2DPresentationState`。
10. **Live2D/TTS 默认跟随会话角色，但尊重用户显式覆盖。** 角色版本给出建议资源；本地禁用、固定模型、无障碍和会话服务选择优先级更高。
11. **所有实时表现事件必须经过角色身份守卫。** 迟到的 generation、state、expression、Live2D directive 或 TTS 音频不得作用到另一会话或另一角色。
12. **离线只读、在线写入。** 离线可以显示已缓存会话中的角色摘要和最后公开状态；角色创建、更新、归档、回滚、身份更新和演化重置不进入离线写队列。
13. **能力开关缺省为 false。** 旧后端没有 `character_profiles` 时继续走单角色兼容模式；前端不能靠接口 404 或名字猜测能力。
14. **严格 schema 要求“前端契约先落、后端字段后放量”。** 当前多个 wire/REST schema 使用 `.strict()`；后端提前增加字段会让旧前端整包校验失败，feature flag 本身不能消除未知字段。
15. **产品品牌与角色身份分离。** 窗口名、应用名可继续叫 Cyrene；消息气泡里的发送者、头像、会话角色和角色栏标题必须动态化。
16. **本功能作为阶段 1～7 之后的独立功能批次推进。** 本文不代表阶段 8 已启动，也不恢复已暂缓的任务中心。
17. **开工 wire 口径以 `character-contract-v1` 为准。** REST/WS 字段、状态策略、返回对象、错误信封和放量顺序已在本文 §5～§7、§14、§19 冻结；实现过程中不得各自“顺手优化”命名，变更必须先同时更新前后端文档和契约 fixture。

推荐前端实施顺序：**契约与严格 schema → 能力协商与只读目录 → “我的档案” → 角色编辑/版本 → 新建会话选角 → 公开状态 → Live2D/TTS 身份联动 → 缓存迁移与真实联调。**

---

## 1. 背景、目标与边界

### 1.1 产品背景

Cyrene 面向情感陪伴，但当前前端对“角色”的表达仍主要是：

- 消息气泡固定显示 `Cyrene` 和 `Cy`；
- 用户头像固定显示“我”，没有用户身份初始化流程；
- 右侧“角色”栏本质上是本机 Live2D 模型面板；
- Live2D 只保存一个全局 `modelId`；
- 会话创建请求只有可选 `title`；
- 会话摘要、消息、generation 和音频都没有稳定角色身份；
- 角色“状态”主要由连接、生成、TTS 和工具等待在前端推导，只有回复末尾的 `mood/emotion` 可见。

这能展示一个固定助手，但无法正确承载 Elysia、Cyrene 和自定义角色并存。

### 1.2 设计目标

- 接入后端 `UserIdentityProfile`，完成最小“我”的初始化和后续编辑；
- 展示内置角色与自定义角色的统一目录；
- 支持查看、克隆、创建、编辑、校验、预览、归档、版本查看和回滚；
- 新建会话时选择角色，已有会话稳定显示其绑定角色；
- 将角色身份带入会话缓存、消息回放、流式 generation、角色状态、Live2D 和 TTS；
- 只展示后端明确公开的角色产品态状态；
- 保持 Electron 的 Main/Preload/Renderer 信任边界；
- 保持旧后端、旧会话和旧本地缓存可读；
- 给出可分批实现、可测试、可真实联调的文件和契约方案。

### 1.3 非目标

- 不在前端实现 Prompt 拼装、模板渲染或人格演化；
- 不允许用户编辑后端 framework prompt；
- 不展示 L2/L3/L4、反思缓冲、记忆检索原文或调试 Prompt；
- 不实现 Neo4j 关系图谱、亲密度数值、关系等级或关系事件时间线；
- 不实现角色市场、角色包导入导出、云同步或多用户切换；
- 不实现任意本地 Live2D 文件上传；
- 不在本批重写 Live2D 渲染器、TTS 播放器或模型服务中心；
- 不允许从已有会话直接换角色；
- 不恢复任务中心或 WorkflowEngine UI；
- 不把 Mock 数据结构当成后端正式契约。

### 1.4 与现有阶段的关系

本文是新功能的目标设计，不记录“当前阶段”或完成状态。后续真正立项时：

- 当前状态只写入 doc 16；
- 批次进入/退出条件写入 doc 12；
- 具体技术任务写入 doc 10 或独立 plan；
- 真实联调结果写入 `docs/review/`；
- 本文持续维护架构决策和目标边界。

---

## 2. 当前前端实现事实基线

本节只描述 `elysia-frontend@23e7108` 已存在的行为。

### 2.1 会话领域没有角色身份

`shared/contracts/conversation.ts` 当前为：

```typescript
export interface Conversation {
  id: string
  title: string
  updatedAt: string
  preview?: string
}

export interface CreateConversationInput {
  title?: string
}
```

因此：

- 会话列表只能用会话标题首字作为头像；
- 新建按钮不能选择角色；
- `conversationStore.currentId` 只能表达当前会话，不能表达当前角色实例；
- 离线缓存无法知道会话属于谁；
- 前端如果显示 `Cyrene`，只能依赖硬编码而不是数据。

### 2.2 REST 会话 schema 是严格的

`main/transport/protocol-v2/rest-schemas.ts` 中 `RestSessionSummarySchema` 使用 `.strict()`，当前只接受：

- `conversationId`；
- `title`；
- `messageCount`；
- `updatedAt`；
- `active`。

`RestMapper.toConversation()` 只映射 `id/title/updatedAt`。

后端若直接给 SessionSummary 增加 `character`，当前前端不会“自动忽略”，而是会让会话列表、创建或重命名响应校验失败。这是联调顺序中的 P0 约束。

### 2.3 WS feature 已解析但被丢弃

`RawServerInfo` 已包含：

```typescript
features: Record<string, unknown>
```

但 `RealBackend.handleServerInfo()` 只保留协议版本、服务版本、连接 ID 和模型服务摘要，没有把 feature 映射到 `ConnectionState` 或独立能力模型。Renderer 当前无法可靠判断角色系统是否可用。

### 2.4 generation 只按会话隔离

当前 `GenerationStartedEvent` 有 `conversationId`，中间帧通过 `generationByConversation` 找归属。`generation.completed` 和 `generation.failed` 不包含角色身份。

这能阻止 A 会话的 delta 进入 B 会话，但不能处理：

- 同一会话错误换角色；
- 角色版本在生成中更新；
- 旧角色 expression/音频迟到；
- 回放消息需要保留生成时角色名和版本。

### 2.5 消息 UI 固定角色名

`CyMessageBubble.vue` 当前固定：

- assistant 头像为 `Cy`；
- assistant 名称为 `Cyrene`；
- user 头像为“我”。

其中应用品牌叫 Cyrene 可以保留，但消息发送者不能继续硬编码。未来 assistant 名称应优先取消息角色快照，再退到会话绑定摘要；用户侧可以继续显示“我”，但完整可访问名称来自 `UserIdentityProfile`。

### 2.6 设置中心只有 Live2D 意义上的“角色”

`CySettingsView.vue` 现有五项：模型服务、语音、安全与权限、角色与外观、开发与诊断。其中“角色与外观”只渲染 `CyLive2DPane`。

当前没有：

- 我的档案；
- 角色目录；
- 自定义角色编辑；
- 默认角色；
- 角色版本与归档；
- 角色预览。

### 2.7 Live2D 是全局本地设置

`Live2DSettings` 当前保存一个全局 `modelId`，`live2dStore.init()` 读取它并加载模型。模型选择会调用 `settingsStore.setLive2d({ modelId })` 持久化。

当前右侧面板中的 `characterState` 不是后端人格状态，而是由以下本地现实推导的表现状态：

- 是否连接；
- 是否生成；
- 是否正在朗读；
- 最近回复 emotion；
- 是否等待工具权限；
- 后端 `live2d.directive` 建议。

代码注释也明确指出，当前没有 `conversation → 角色态` 映射。

### 2.8 TTS 没有角色归属

当前 `audio_start/audio/audio_end` 通过 `stream_id` 组装，领域事件只有 `streamId/url/format/durationMs`。如果用户在音频准备期间切换会话，协议本身无法证明音频属于哪个角色。多角色模式下仅靠 `streamId` 不足以安全自动播放或驱动口型。

### 2.9 本地缓存会丢角色字段

`SessionStore` 当前缓存：

- `Conversation[]`；
- 每会话 `Message[]`；
- 草稿、滚动锚点和上次活动会话。

`ConversationSchema` 和 `MessageSchema` 都没有角色快照。即使在线接口先改，若本地 schema/mapper 没有同步，应用重启或离线查看仍会退回固定角色展示。

### 2.10 当前模块可复用与不可复用边界

| 当前模块 | 可复用 | 不应承担的新职责 |
|---|---|---|
| `BackendAdapter/RealBackend` | 认证 REST、WS、错误与协议适配基础 | 把所有角色 UI 状态塞进 transport |
| `chat-service` | 会话命令和事件桥 | 角色目录、编辑草稿、版本冲突的全部编排 |
| `conversationStore` | 会话列表、激活、分页和竞态守卫 | 角色 CRUD、用户档案、实例状态数据库 |
| `messageStore` | generation 组装、会话归属和迟到事件守卫 | 角色目录或 Live2D 资源选择 |
| `settingsStore` | 设备/应用级设置 | 后端角色定义与用户档案的事实来源 |
| `live2dStore` | 本机模型渲染、表现状态和降级 | 人格状态、关系状态或角色版本管理 |
| `voiceStore` | 录音、TTS 播放和口型播放状态 | 决定角色应使用哪个声音 |
| `SessionStore` | 会话离线缓存 | 完整角色数据库或后端写入队列 |

---

## 3. 术语与长期不变量

### 3.1 前端术语

| 术语 | 前端含义 |
|---|---|
| UserIdentityProfile | 后端保存的最小“我”，不是本地登录账号或完整画像 |
| CharacterDefinition | 稳定角色实体；前端目录中的一项 |
| CharacterRevision | 不可变角色内容版本；编辑保存产生新版本 |
| CharacterInstance | 当前用户与某角色持续相处的实例；状态、关系和记忆作用域 |
| CharacterBinding | 会话绑定的角色/实例摘要 |
| CharacterPublicState | 可展示的心情、活动、最近互动等产品态裁剪 |
| CharacterDraft | 尚未保存的前端编辑草稿 |
| Live2DPresentationState | 本机渲染/交互状态机，例如 loading、thinking、speaking、fallback |
| Presentation | 角色版本建议的头像、Live2D 和主题资源引用 |
| Backend capabilities | Main 从 `server_info.features` 归一化的类型化能力开关 |

### 3.2 必须保持的不变量

1. `characterId`、`characterInstanceId` 和 `revision` 不从名称、slug 或数组位置派生。
2. 一个已有会话的 `characterInstanceId` 在 V1 生命周期内不变。
3. Renderer 不根据“当前选择的 Live2D 模型”反推角色身份。
4. Renderer 不根据回复中的自称、头像首字或会话标题猜角色。
5. 角色目录缓存不能覆盖会话/消息携带的历史角色快照。
6. 正在生成的一轮固定使用 `generation.started` 声明的角色身份；角色编辑只影响下一轮。
7. 新连接和会话激活后，角色状态 snapshot 先于增量成为权威基线。
8. 内置角色只读；前端编辑入口必须转换为“克隆后编辑”。
9. 归档不会删除既有会话，也不会让离线历史突然失去身份。
10. 回滚创建新 revision，不修改旧 revision。
11. 角色状态事件缺少实例身份时，在多角色模式下不得驱动 UI。
12. TTS/Live2D 事件身份不匹配时 fail-closed：可以不播放、不动作，但不能作用到错误角色。

---

## 4. 目标分层与依赖方向

```text
Renderer
├─ identityStore
├─ characterCatalogStore
├─ characterEditorStore
├─ characterRuntimeStore
├─ conversationStore / messageStore（只保存绑定与消息快照）
├─ Live2D presentation coordinator
└─ 页面与组件
        │
        │ 具名、schema 校验 IPC
        ▼
Preload
└─ identity / characters / characterState / characterDrafts API
        │
        ▼
Main
├─ CharacterService
├─ CharacterDraftStore（仅未提交本地草稿）
├─ CharacterBackendPort
├─ raw REST/WS schema + mapper
├─ existing ChatService / SessionStore / Live2D registry / Voice media
└─ Credential / connection boundary
        │
        ▼
Backend
├─ UserIdentityProfile
├─ CharacterDefinition / Revision / Instance
├─ Prompt / state / memory isolation
└─ REST + WS authoritative contract
```

依赖只能向下：

- 组件依赖 Store，不直接调用 `window.desktopApi`；
- Store 依赖 Renderer `api` 窄接口，不直接 import Electron；
- Preload 只暴露类型化方法，不暴露任意 channel；
- Main service 依赖 `CharacterBackendPort`，不依赖 Vue/Pinia；
- raw schema 和 mapper 不 import Renderer Store；
- Live2D 可以消费角色绑定和公开状态，但角色域不能依赖 Live2D 引擎。

### 4.1 Main 的职责

- 解析并归一化后端角色 REST/WS；
- 归一化 feature flags，缺失/非法值一律 false；
- 阻止不支持能力时的角色写命令；
- 校验 IPC 入参和出参；
- 保留 `backendCode`、revision、角色 ID 和实例 ID；
- 管理请求取消、同键 in-flight 去重和短期内存缓存；
- 持久化未提交角色编辑草稿；
- 不渲染 UI，不决定表单布局，不拼 Prompt。

### 4.2 Preload 的职责

- 暴露具名 identity/character API；
- 对 invoke 返回值再次做运行时 schema 校验；
- 事件订阅返回 unsubscribe；
- 不暴露 `ipcRenderer`、raw fetch、后端 URL、Token 或任意路径；
- 不允许 Renderer 伪造 `character.state.changed`。

### 4.3 Renderer 的职责

- 展示公开角色数据和用户 authored 内容；
- 管理加载、筛选、选择、草稿、脏状态和错误展示；
- 在 capability、连接状态和后端返回 controls 范围内发起命令；
- 按 stable ID 做缓存和竞态守卫；
- 将角色身份带入会话和消息 UI；
- 协调 Live2D 本地表现，但不定义后端人格状态。

---

## 5. 前端领域契约

目标新增：

```text
apps/desktop/src/shared/contracts/character.ts
apps/desktop/src/shared/schemas/character.ts
```

`contracts/index.ts` 与 `schemas/index.ts` 统一 re-export。角色 wire 类型仍位于 Main transport，不得从 `shared/contracts` 暴露给 Renderer。

### 5.1 ID 与基础枚举

为贴合现有仓库风格，V1 继续使用 string 类型，不强制引入 TypeScript branded type；但命名必须明确：

```typescript
export type CharacterId = string
export type CharacterInstanceId = string
export type CharacterSource = 'builtin' | 'custom'
export type CharacterStatus = 'active' | 'archived'
export type CharacterStatePolicy = 'preserve' | 'reset_evolution'

export interface CharacterListQuery {
  source?: CharacterSource
  status?: CharacterStatus
  search?: string
  cursor?: string
  limit?: number
}

export interface CharacterRevisionQuery {
  characterId: CharacterId
  cursor?: string
  limit?: number
}

export interface Page<T> {
  items: T[]
  hasMore: boolean
  nextCursor?: string
}
```

所有 schema 至少 `.min(1)`；不得用 displayName 代替 ID。

`Page<T>` 是 Renderer 领域形状。后端 raw 分页固定为 `{items, has_more, cursor?}`，只在 Main mapper 转为 `hasMore/nextCursor`；Renderer、Preload 参数和持久化模型不得出现 `has_more`。

### 5.2 类型化后端能力

```typescript
export interface BackendFeatureFlags {
  characterProfiles: boolean
  characterStateStream: boolean
}
```

建议作为 `ConnectionState.features?: BackendFeatureFlags` 的可选字段输出，理由：

- 能力与具体连接绑定；
- 重连后可一次替换，不留下旧连接能力；
- bootstrap 已以 `ConnectionState` push 为权威；
- Renderer 无需再增加一次“能力轮询”。

规则：

- wire `character_profiles === true` 才映射 true；
- wire `character_state_stream === true` 才映射 true；
- 缺省、字符串 `"true"`、数字 1 或其他形状全部 false；
- 新连接到来时整体替换 features，不做浅 merge。

### 5.3 UserIdentityProfile

```typescript
export interface UserIdentityProfile {
  userId: string
  displayName: string
  preferredAddress?: string
  pronouns?: string
  locale: string
  timezone: string
  initialized: boolean
  defaultCharacterId?: CharacterId
  revision: number
  createdAt: string
  updatedAt: string
}

export interface UpdateUserIdentityCommand {
  expectedRevision: number
  displayName: string
  preferredAddress?: string
  pronouns?: string
  locale: string
  timezone: string
  defaultCharacterId?: CharacterId
}
```

前端不增加生日、性别、真实姓名、住址等“顺手收集”字段。`pronouns` 是自由文本，不强制二元枚举。

`initialized/userId/revision/timestamps` 由后端管理，不进入更新命令；首次成功 PUT 后 `initialized=true`。PUT 是完整最小身份替换：省略 `preferredAddress/pronouns` 表示清空，省略 `defaultCharacterId` 表示使用 bootstrap 内置角色。表单必须先取得完整 GET 基线，不能在 profile 尚未加载时提交。

### 5.4 Presentation 与运行默认值

```typescript
export interface CharacterPresentation {
  avatarAssetId?: string
  live2dModelId?: string
  themeColor?: string
}

export interface CharacterRuntimeDefaults {
  voice: {
    providerId?: string
    voiceId?: string
  }
  emotion: {
    idleExpressions: string[]
  }
  wakeWords: string[]
  proactive: {
    enabled: boolean
    intervalSeconds: number
    triggers: string[]
  }
}
```

归一化规则：

- 后端的 `null` 在前端领域层统一为 `undefined`，或统一保留 null；整个角色域只能选一种。建议 mapper 归一为 `undefined`，表单草稿再用空串显示；
- `live2dModelId` 是注册表 ID，不是路径；
- `avatarAssetId` 没有安全解析端点前只显示占位头像；
- `themeColor` 只接受后端已校验的颜色值，Renderer 仍需限制到 CSS 安全格式；
- proactive 配置可以展示/编辑，但后台主动发言的实际启停以后端能力和策略为准。

### 5.5 PromptProfile 与示例

```typescript
export interface CharacterExample {
  user: string
  assistant: string
}

export interface CharacterPromptProfile {
  corePersonality: string
  relationshipStyle: string
  emotionStyle: string
  speakingStyle: string
  conversationInitiative: string
  examples: CharacterExample[]
}
```

这些是用户 authored 数据，不是完整 System Prompt。字段名称和含义必须与后端设计一致，前端不得增加“自定义 F1/F2/F3”“Jinja 模板”“原始 system prompt”输入框。

### 5.6 角色摘要、详情和不可变版本

```typescript
export interface CharacterSummary {
  characterId: CharacterId
  source: CharacterSource
  mutable: boolean
  status: CharacterStatus
  currentRevision: number
  displayName: string
  description: string
  aliases: string[]
  presentation: CharacterPresentation
  updatedAt: string
}

export interface CharacterRevisionContent {
  characterId: CharacterId
  revision: number
  schemaVersion: number
  displayName: string
  description: string
  aliases: string[]
  promptProfile: CharacterPromptProfile
  runtimeDefaults: CharacterRuntimeDefaults
  presentation: CharacterPresentation
  openingMessage?: string
  checksum: string
  compilerVersion: number
  createdBy: 'system' | 'user' | 'migration'
  createdAt: string
}

export interface CharacterDetail {
  summary: CharacterSummary
  current: CharacterRevisionContent
}

export interface CharacterRevisionSummary {
  revision: number
  checksum: string
  createdBy: 'system' | 'user' | 'migration'
  createdAt: string
}
```

`CharacterSummary` 用于列表、会话创建和默认角色选择；完整 authored 内容只在打开详情/编辑时加载，不随列表全量下发。

### 5.7 编辑草稿与保存命令

```typescript
export interface CharacterDraft {
  displayName: string
  description: string
  aliases: string[]
  promptProfile: CharacterPromptProfile
  runtimeDefaults: CharacterRuntimeDefaults
  presentation: CharacterPresentation
  openingMessage?: string
}

export interface CreateCharacterCommand {
  draft: CharacterDraft
}

export interface UpdateCharacterCommand {
  characterId: CharacterId
  expectedRevision: number
  statePolicy: CharacterStatePolicy
  draft: CharacterDraft
}

export interface CloneCharacterCommand {
  characterId: CharacterId
  displayName?: string
}

export interface RollbackCharacterCommand {
  characterId: CharacterId
  targetRevision: number
  expectedRevision: number
  statePolicy: CharacterStatePolicy
}

export type ResetField =
  | 'self_l2'
  | 'state_l3'
  | 'speaking_style_c6'
  | 'reflector'
  | 'mood'

export interface CharacterStateImpact {
  statePolicy: CharacterStatePolicy
  affectedInstances: number
  pendingInstances: number
  resetFields: ResetField[]
}

export interface CharacterMutationResult {
  character: CharacterDetail
  stateImpact: CharacterStateImpact
}

export interface CharacterArchiveResult {
  character: CharacterSummary
  userProfile?: UserIdentityProfile
}
```

保存必须发送完整 draft，而不是向后端做字段级 PATCH。这样 revision checksum、校验和并发语义都由后端对完整版本负责。

`UpdateCharacterCommand` 是前端领域命令；Main 发往后端时将 `draft` 字段展平，wire 不存在额外的 `draft` 包装层。`preview` 因还包含 `userMessage`，保留 `{draft,userMessage}`。`affectedInstances` 是应受本次 revision 影响的 `follow_latest` instance 总数，`pendingInstances` 是其中尚待下一轮原子应用的子集。

### 5.8 校验与预览

```typescript
export interface CharacterValidationIssue {
  severity: 'error' | 'warning'
  code: string
  path: string
  message: string
}

export interface CharacterValidationResult {
  valid: boolean
  issues: CharacterValidationIssue[]
  estimatedPromptChars?: number
}

export interface CharacterPreviewCommand {
  draft: CharacterDraft
  userMessage: string
}

export interface CharacterPreviewResult {
  ephemeral: true
  reply: string
  model?: string
  usage?: {
    input?: number
    output?: number
    total?: number
  }
}
```

Preview 不进入 `messageStore`、会话缓存、历史查看器、TTS 或 Live2D。Preview UI 必须固定显示“临时预览，不会保存到记忆或角色状态”。

### 5.9 会话角色绑定摘要

```typescript
export interface CharacterBindingSnapshot {
  characterId: CharacterId
  characterInstanceId: CharacterInstanceId
  characterRevision: number
  displayName: string
  presentation: CharacterPresentation
}

export interface Conversation {
  id: string
  title: string
  updatedAt: string
  preview?: string
  character?: CharacterBindingSnapshot
}

export interface CreateConversationInput {
  title?: string
  characterId?: CharacterId
}
```

`character` 在迁移期 optional。`character_profiles=true` 后：

- Electron 新建会话 UI 必须解析并显式发送 `characterId`；协议本身允许其他客户端省略并由后端使用 default character；
- 新建结果必须带 `character`；
- 已迁移会话列表/详情必须带 `character`；
- 缺失时视为契约错误，不回退猜测。

旧后端兼容模式下 `characterId` 省略，`character` 可缺失。

### 5.10 消息与 generation 的角色审计

```typescript
export interface CharacterGenerationRef {
  characterId: CharacterId
  characterInstanceId: CharacterInstanceId
  characterRevision: number
  displayName?: string
  presentation?: CharacterPresentation
}

export interface Message {
  // 既有字段……
  character?: CharacterGenerationRef
}
```

规则：

- assistant 消息保存实际生成时角色快照；
- user/tool 消息通常不需要 `character`，但 schema 可按后端归档形状接受 optional；
- 流式消息创建时从 `generation.started` 建立 ref；
- replay/REST 消息优先使用消息自身快照；
- 消息缺 displayName 时可用 `(characterId, characterRevision)` 查 revision cache；
- revision cache 也没有时才退到会话绑定 displayName；
- 最后兜底显示“角色”，绝不硬编码 Cyrene/Elysia。

### 5.11 CharacterPublicState

```typescript
export interface CharacterMood {
  label: string
  intensity: number
  updatedAt: string
}

export interface CharacterPublicStateView {
  mood?: CharacterMood
  currentActivity?: string
  lastInteractionAt?: string
  proactiveEnabled: boolean
  updatedAt: string
}

export interface CharacterPublicState extends CharacterPublicStateView {
  characterId: CharacterId
  characterInstanceId: CharacterInstanceId
  characterRevision: number
  stateVersion: number
}

export interface ResetCharacterEvolutionCommand {
  characterInstanceId: CharacterInstanceId
  expectedStateVersion: number
}

export interface ResetCharacterEvolutionResult {
  state: CharacterPublicState
  resetFields: ResetField[]
}
```

`intensity` 只用于轻量表现，不默认显示“72% 心情值”。前端不得从它推导亲密度或关系等级。

`characterRevision` 与 `stateVersion` 必须分开：前者说明角色内容版本，后者用于演化状态 CAS 和事件顺序。`character-contract-v1` 已冻结 raw 也使用 `characterRevision`，不再允许顶层模糊字段 `revision`。REST snapshot 不带 `conversationId`，因为同一 canonical instance 可绑定多个会话；WS event 才带本次投递关联的 `conversationId`。

V1 reset 清除 L2、L3（含 history/awareness/compression 派生态）、动态 C6、reflector 和 mood，并原子递增一次 `stateVersion`；不删除会话、消息、LTM、relationship、用户档案、角色版本或会话 voice/service 设置。前端必须使用后端返回的 `resetFields` 展示结果，不能自行猜测重置范围。

---

## 6. 后端 REST 与 Main 适配

### 6.1 CharacterBackendPort

为避免继续膨胀单一接口，建议新增子接口，再由现有 `BackendAdapter` 组合：

```typescript
export interface CharacterBackendPort {
  getMe(): Promise<UserIdentityProfile>
  updateMe(input: UpdateUserIdentityCommand): Promise<UserIdentityProfile>

  listCharacters(input: CharacterListQuery): Promise<Page<CharacterSummary>>
  getCharacter(characterId: string): Promise<CharacterDetail>
  createCharacter(input: CreateCharacterCommand): Promise<CharacterDetail>
  updateCharacter(input: UpdateCharacterCommand): Promise<CharacterMutationResult>
  cloneCharacter(input: CloneCharacterCommand): Promise<CharacterDetail>
  archiveCharacter(characterId: string): Promise<CharacterArchiveResult>
  listCharacterRevisions(input: CharacterRevisionQuery): Promise<Page<CharacterRevisionSummary>>
  rollbackCharacter(input: RollbackCharacterCommand): Promise<CharacterMutationResult>
  validateCharacter(draft: CharacterDraft): Promise<CharacterValidationResult>
  previewCharacter(input: CharacterPreviewCommand): Promise<CharacterPreviewResult>

  getCharacterState(instanceId: string): Promise<CharacterPublicState>
  resetCharacterEvolution(input: ResetCharacterEvolutionCommand): Promise<ResetCharacterEvolutionResult>
}

export interface BackendAdapter extends CharacterBackendPort {
  // 既有 chat/model/voice/tool 方法……
}
```

`CharacterService` 只依赖 `CharacterBackendPort`，测试可注入 fake；`MockBackend` 与 `RealBackend` 分别实现。

### 6.2 REST 映射矩阵

| 前端方法 | 后端 REST | Main 行为 |
|---|---|---|
| `getMe` | `GET /api/me` | strict schema → domain profile |
| `updateMe` | `PUT /api/me` | 发送完整最小身份 + expectedRevision |
| `listCharacters` | `GET /api/characters` | query 白名单、cursor/limit/search/source/status |
| `getCharacter` | `GET /api/characters/{id}` | current revision 完整内容 |
| `createCharacter` | `POST /api/characters` | wire 顶层完整 draft；201 `CharacterDetail` |
| `updateCharacter` | `PUT /api/characters/{id}` | Main 展平 expectedRevision + statePolicy + 完整 draft；200 `CharacterMutationResult` |
| `archiveCharacter` | `DELETE /api/characters/{id}` | 只允许 custom；200 `CharacterArchiveResult`，默认角色变化时带新 profile |
| `cloneCharacter` | `POST /api/characters/{id}/clone` | `{displayName?}`；内置/custom 均可克隆；201 `CharacterDetail` |
| `listCharacterRevisions` | `GET /api/characters/{id}/revisions` | 默认只取摘要，不取全部正文 |
| `rollbackCharacter` | `POST /api/characters/{id}/rollback` | `{targetRevision,expectedRevision,statePolicy}`；200 `CharacterMutationResult` |
| `validateCharacter` | `POST /api/characters/validate` | wire 顶层 draft；无效也是 200 + `valid=false`；path 为 JSON Pointer |
| `previewCharacter` | `POST /api/characters/preview` | `{draft,userMessage}`；无状态；不得写消息缓存 |
| `getCharacterState` | `GET /api/character-instances/{id}/state` | 200 完整 `CharacterPublicState` |
| `resetCharacterEvolution` | `POST .../reset-evolution` | `{expectedStateVersion}`；200 `ResetCharacterEvolutionResult` |

#### 6.2.1 Raw wire 与领域映射冻结

- character/profile/state 业务字段在 raw REST 中使用 camelCase；
- 角色列表和 revision 列表 raw 固定为 `{items, has_more, cursor?}`，Main 映射为 `Page<T>{items,hasMore,nextCursor?}`；
- 成功对象直接作为 response body，不存在额外 `{ok,data}`；
- `CharacterDetail` 固定为 `{summary,current}`；
- `CharacterBindingSnapshot` 固定使用 `characterRevision`，不接受含义模糊的 `revision`；
- public state raw 与领域同字段，unknown optional 字段省略；Main 可把 revision authored 字段中的 `null` 归一为 `undefined`；
- `CharacterStatePolicy` 只接受 `preserve | reset_evolution`；
- validate 的 `path` 是 JSON Pointer，例如 `/promptProfile/corePersonality`；
- Preview HTTP 可由 Main abort；取消、超时和失败都不得写入会话、记忆、人格状态、TTS 或 token session 累计。

错误 raw 固定复用后端 `ProtocolError`：

```typescript
interface CharacterProtocolError {
  code: string
  message: string
  retryable: boolean
  requestId: string
  error: string       // 兼容别名，恒等于 message
  details: Record<string, unknown>
  retryAfterMs?: number
}
```

Main 只把 `code` 复制到公开错误的 `backendCode`，并对白名单 `details` 做逐码映射；绝不把 raw body 整体传给 Renderer。

#### 6.2.2 跨仓机器契约接收

后端仍是 wire 单一事实源。FE-A 开始编码前，先取得同一 backend commit 生成的：

- `frontend_contract/contract.schema.json`；
- `frontend_contract/contract.raw.ts`；
- `rest-character.jsonl`、`ws-v2-character.jsonl`；
- 含 `character-contract-v1/backendCommit/schemaHash/verified` 的 handoff manifest。

Electron 不直接 import 后端仓库 TS，而是在 Main 中维护所消费子集的 strict Zod schema，并用上述产物做交叉门禁。`apps/desktop/scripts/check-backend-contract.mjs` 应支持通过环境变量/参数指定远端导出的 contract 目录，不能只硬编码 `/home/yomu/elysia-agent/frontend_contract`；Windows 开发机使用 handoff bundle。每个新增 fixture manifest 先写真实 backend commit/schemaHash、`verified=false`，只有真实 Electron 抓帧复跑后才改为 true。

### 6.3 建议拆分 transport 文件

不要继续把全部角色类型和 schema 追加到已经很长的通用文件中。建议：

```text
main/transport/protocol-v2/
├─ character-rest-types.ts
├─ character-rest-schemas.ts
├─ character-rest-mapper.ts
└─ existing rest-types/rest-schemas/rest-mapper.ts
```

会话和消息中的角色扩展仍需同步既有 rest/raw 文件；角色 CRUD 独立放入 character 文件。

### 6.4 strict schema 纪律

- raw DTO schema 使用 `.strict()`；
- domain/IPC schema 同样精确镜像；
- wire snake/camel 差异只在 mapper 处理；
- 时间字段保持 ISO 字符串，展示层再本地化；
- `intensity` 限制 `[0, 1]`；
- profile/character revision 与 stateVersion 从 1 开始且为正整数；计数器可为 0；
- aliases、examples、wakeWords、triggers 设数量和单项长度上限；
- Prompt authored 字段设 UTF-8/字符上限，Main IPC 与后端保持同等或更严；
- unknown enum、未知字段、绝对路径和非受管 URL fail-closed。

### 6.5 CharacterService

建议新增 `main/characters/character-service.ts`，职责：

- capability gate；
- 同键 GET in-flight 去重；
- 最近角色摘要/详情短期内存缓存；
- 写成功后精确失效缓存；
- 将 archive/defaultCharacter 变化触发 profile/catalog 刷新；
- 保留后端错误码；
- 不做 Prompt 校验真相，不伪造 optimistic revision；
- 不做离线写队列。

缓存建议：

- list：按 query key 保存当前连接内最后成功结果；
- detail：按 `characterId@revision` 保存；
- profile：保存当前连接内最近成功值；
- public state：按 instance 保存最近 snapshot；
- 断连后全部标记 stale，不能作为 mutation 基线；
- 连接 ID 改变时丢弃 in-flight 结果。

---

## 7. WebSocket、事件身份与竞态

### 7.1 BackendEvent 扩展

目标新增：

```typescript
export interface CharacterStateChangedEvent extends BackendEventEnvelope {
  event: 'character.state.changed'
  conversationId: string
  characterId: string
  characterInstanceId: string
  characterRevision: number
  stateVersion: number
  state: CharacterPublicStateView
}

export interface CharacterCatalogChangedEvent extends BackendEventEnvelope {
  event: 'character.catalog.changed'
  characterId: string
  currentRevision: number
  status: CharacterStatus
  updatedAt: string
}
```

generation 事件目标增加：

```typescript
characterId?: string
characterInstanceId?: string
characterRevision?: number
```

迁移期 schema optional；`character_profiles=true` 后 `generation.started/completed/failed` 三条终端路径都必须带齐并与 started 一致。raw WS 使用判别字段 `type`；Main 路由后才归一为领域 `event`。

### 7.2 generation 身份表

当前：

```text
generationId -> conversationId
```

目标：

```typescript
interface GenerationIdentity {
  conversationId: string
  characterId: string
  characterInstanceId: string
  characterRevision: number
}

generationId -> GenerationIdentity
```

处理规则：

1. `generation.started` 必须与当前会话 binding 匹配后才创建流式消息；
2. segment/delta 继续通过 generation map 找身份；
3. completed/failed 若自带身份，必须和 map 一致；
4. 会话切换后迟到事件直接丢弃并写脱敏诊断；
5. 角色 catalog 更新不改变在途 generation identity；
6. 回放同 messageId 以服务端归档快照覆盖本地临时 ref。

### 7.3 角色状态事件

`characterRuntimeStore` 按 `characterInstanceId` 保存 snapshot，并维护：

- `activeConversationId`；
- `activeInstanceId`；
- `connectionEpoch`；
- `lastAppliedStateVersion`；
- stale 标记。

`state` 是完整 `CharacterPublicStateView`，不是 patch；每次用新 view 整体替换该 instance 的公开视图。`updatedAt` 只用于展示/诊断，顺序判断只看 `stateVersion`。连接或会话激活先收 snapshot，之后只在实际变化时收新 snapshot。

只有同时满足以下条件才驱动当前角色栏：

- event conversation 与活动会话一致；
- event instance 与活动会话 binding 一致；
- event characterId 与 binding 一致；
- event `characterRevision` 与 binding 合法，`stateVersion` 严格大于该 instance 已应用值；
- event 属于当前 connection epoch。

不同会话若绑定同一个 canonical instance，可以更新同一 instance cache；但只有活动会话显示。

### 7.4 expression 与 Live2D directive

多角色模式下，以下 raw 事件必须增加身份：

- `expression`；
- `live2d.directive`；
- 任何未来 motion/animation 指令。

至少包括：

```text
conversationId
generationId?  // 存在 generation 时
characterId
characterInstanceId
characterRevision
```

若后端暂时只能给 `generationId`，Main 可以通过 generation identity 表补齐；两者都没有时：

- legacy 单角色模式可按旧策略兼容；
- `character_profiles=true` 时必须忽略，不得默认作用到当前角色。

### 7.5 TTS 音频身份

后端需要在 `audio_start` 或等价起始事件提供：

```typescript
interface AudioIdentity {
  streamId: number
  conversationId: string
  generationId?: string
  characterId: string
  characterInstanceId: string
  characterRevision: number
}
```

`audio_start` 继续使用现有 `stream_id`，Main 从它建立 `streamId -> AudioIdentity`；chunk/end/cancel 无需让后端重复身份。Main 组装后的 `audio.session.started/ready/cancelled` 必须保留上述字段和 `streamId`。`voiceStore` 自动播放前验证：

1. 当前活动会话仍相同；
2. 当前 binding instance 仍相同；
3. stream 未取消；
4. `autoReadReply=true`；
5. TTS/Live2D 没被用户禁用。

身份不匹配时取消/丢弃该音频 URL，并将口型归零。不能出现“切到 Elysia 会话后播放 Cyrene 的迟到语音”。

`generationId` 对非 generation 音频可以省略；`character_profiles=true` 后其余身份字段必填。REST TTS 试听不进入这条聊天自动播放链，也不写角色公开状态。

### 7.6 catalog 变更事件

`character.catalog.changed` 只作失效通知：

- 不携带完整 Prompt；
- Renderer 收到后通过 Main 重新 GET；
- 发起保存的窗口可以直接用 REST 返回值更新；
- 多窗口/未来多设备才依赖事件同步；
- revision 较旧的事件不回退缓存。

---

## 8. IPC 与 Preload 设计

### 8.1 具名 IPC 通道

建议新增：

```text
profile:get-me
profile:update-me

characters:list
characters:get
characters:create
characters:update
characters:clone
characters:archive
characters:list-revisions
characters:rollback
characters:validate
characters:preview

character-instances:get-state
character-instances:reset-evolution

character-drafts:list
character-drafts:get
character-drafts:save
character-drafts:delete
```

禁止增加：

```text
backend:request(path, method, body)
characters:raw-fetch
prompt:compile
prompt:get-system
```

### 8.2 DesktopApi 目标接口

```typescript
interface DesktopApiLike {
  getMe(): Promise<UserIdentityProfile>
  updateMe(input: UpdateUserIdentityCommand): Promise<UserIdentityProfile>

  listCharacters(input: CharacterListQuery): Promise<Page<CharacterSummary>>
  getCharacter(characterId: string): Promise<CharacterDetail>
  createCharacter(input: CreateCharacterCommand): Promise<CharacterDetail>
  updateCharacter(input: UpdateCharacterCommand): Promise<CharacterMutationResult>
  cloneCharacter(input: CloneCharacterCommand): Promise<CharacterDetail>
  archiveCharacter(characterId: string): Promise<CharacterArchiveResult>
  listCharacterRevisions(input: CharacterRevisionQuery): Promise<Page<CharacterRevisionSummary>>
  rollbackCharacter(input: RollbackCharacterCommand): Promise<CharacterMutationResult>
  validateCharacter(draft: CharacterDraft): Promise<CharacterValidationResult>
  previewCharacter(input: CharacterPreviewCommand): Promise<CharacterPreviewResult>

  getCharacterState(instanceId: string): Promise<CharacterPublicState>
  resetCharacterEvolution(input: ResetCharacterEvolutionCommand): Promise<ResetCharacterEvolutionResult>

  listCharacterDrafts(): Promise<CharacterDraftSummary[]>
  getCharacterDraft(key: string): Promise<PersistedCharacterDraft | undefined>
  saveCharacterDraft(input: PersistedCharacterDraft): Promise<void>
  deleteCharacterDraft(key: string): Promise<void>
}
```

WS 角色事件继续走现有 `onChatEvent(BackendEvent)`，不再复制一个并行 raw event bus。

### 8.3 IPC 校验和大小预算

- 所有 request/response 都有共享 zod schema；
- handler 与 preload `unwrap` 两侧都校验；
- authored 内容最大体积必须小于 `MAX_IPC_MESSAGE_BYTES`，并给单角色草稿更低上限；
- validation issue 数量设上限，避免恶意后端制造巨量 UI 节点；
- Preview reply 设最大长度；
- 错误只透出 `code/message/backendCode/retryable` 等白名单字段；
- 任何 Prompt 内容和草稿正文不得进入 IPC 错误 message。

---

## 9. Renderer Store 设计

### 9.1 identityStore

职责：

- `profile`；
- `loading/saving/error`；
- `initialized` 派生；
- expectedRevision 更新；
- revision conflict；
- 默认角色更新；
- 连接 epoch 和 stale。

不负责：

- 角色列表；
- 会话创建；
- 完整“用户画像”；
- 将用户身份写入每条消息。

### 9.2 characterCatalogStore

状态建议：

```typescript
summariesById
order
detailsById
revisionPagesById
listQuery
selectedCharacterId
loadingList/loadingDetail
mutatingById
error
stale
```

职责：

- 目录分页、搜索和筛选；
- detail/revisions 懒加载；
- create/update/clone/archive/rollback 成功结果合并；
- catalog.changed 失效；
- 默认角色是否可用的派生判断。

不负责编辑表单的每个输入字符。

### 9.3 characterEditorStore

状态建议：

```typescript
draftKey
mode: 'create' | 'edit' | 'clone'
baseCharacterId?
baseRevision?
draft
dirty
validation
preview
saving/validating/previewing
conflict?
lastPersistedAt?
```

职责：

- 从详情复制为可编辑 draft；
- 表单局部更新；
- 600～1000ms 防抖写本地 draft；
- 显式 validate/preview/save；
- 冲突时保留草稿；
- 保存成功后删除本地 draft。

不要让 `CharacterSummary` 对象直接成为 `v-model`，否则列表缓存会在保存前被表单原地污染。

### 9.4 characterRuntimeStore

状态建议：

```typescript
byInstanceId: Record<string, CharacterPublicState>
activeBinding?: CharacterBindingSnapshot
staleByInstanceId
loadingByInstanceId
errorByInstanceId
```

职责：

- 会话激活后设置 active binding；
- state REST snapshot；
- state WS 变化时的完整公开视图；
- 身份、连接和 revision 守卫；
- 向角色栏提供产品态状态。

不负责 Live2D canvas、FPS、GPU fallback、鼠标追踪或口型。

### 9.5 conversationStore 的最小改动

`conversationStore` 只增加：

- `Conversation.character` 的保存与合并；
- `currentCharacter` 派生；
- `create(characterId)`；
- activate 后通知 runtime/presentation coordinator；
- legacy binding 缺失态。

它不直接调用角色 CRUD。

### 9.6 messageStore 的最小改动

- generation identity 表从 conversation 扩展到角色身份；
- 流式 assistant message 写 `character`；
- replay/REST 消息保留角色快照；
- late event 同时校验 conversation + instance；
- 不读取 character editor draft；
- 不根据当前 catalog 回写历史 message revision。

### 9.7 bootstrap 编排

连接成功后的目标顺序：

```text
1. 应用/会话本地缓存水合
2. ConnectionState + typed features
3. 若 characterProfiles=false：走 legacy chat 初始化
4. 若 characterProfiles=true：并行 getMe + listCharacters + listConversations
5. 调和 defaultCharacterId 与 active catalog
6. 激活会话后设置 active binding
7. 拉 CharacterPublicState snapshot
8. characterStateStream=true 时继续消费 WS
```

`getMe/listCharacters` 失败不应清空已加载聊天历史，但要禁用新建角色会话并显示可恢复错误。

---

## 10. 产品信息架构与交互

### 10.1 设置中心导航

目标导航建议：

```text
模型服务
我的档案
角色
语音
外观与 Live2D
安全与权限
开发与诊断
```

调整理由：

- “角色”不再等于 Live2D；
- “我的档案”与角色设定分离；
- 现有 `CyLive2DPane` 迁到“外观与 Live2D”，继续管理本机渲染偏好；
- 角色详情中的“呈现”只选择角色建议资源，不复制全部 Live2D 性能设置。

### 10.2 “我的档案”初始化

首次连接且 `profile.initialized=false` 时：

- 展示初始化向导或高优先级提示；
- 允许浏览已有会话；
- 创建新的角色会话前要求先确认最小档案；
- 兼容期可继续浏览/使用旧会话，不让迁移阻塞整个应用；
- 用户可稍后处理，但设置导航持续显示未完成标记。

字段：

- 显示名：必填；
- 希望角色如何称呼：可选；
- 代词/称谓：可选自由文本；
- 语言：默认 `zh-CN`；
- 时区：优先 `Intl.DateTimeFormat().resolvedOptions().timeZone`，用户确认；
- 默认角色：从 active catalog 选择。

保存后说明：“从下一轮对话起生效，不会改写历史消息。”

### 10.3 角色目录页

页面包括：

- 搜索；
- active/archived 筛选；
- builtin/custom 标签；
- 默认角色标记；
- 名称、简介、头像占位、当前 revision；
- 查看详情；
- 内置角色“克隆并自定义”；
- 自定义角色“编辑/归档”；
- 新建角色。

列表不展示完整 Prompt，不展示 L2/L3/L4，不展示“亲密度”。

### 10.4 角色编辑器

建议分区而不是单个超长弹窗：

1. **基本信息**：名称、简介、别名、开场白；
2. **核心人格**：`corePersonality`；
3. **关系方式**：`relationshipStyle`；
4. **情绪与表达**：`emotionStyle`、`speakingStyle`；
5. **对话主动性**：`conversationInitiative`；
6. **示例对话**：0～20 组可排序示例；
7. **声音与呈现**：voice ref、Live2D model ID、主题色；
8. **高级运行默认值**：wake words、proactive，默认折叠；
9. **校验与预览**：问题列表、临时输入和回复；
10. **保存确认**：state policy、revision 和影响说明。

交互纪律：

- textarea 输入按纯文本处理；
- 不将 authored 文本用 `v-html` 预览；
- Preview reply 使用既有安全 Markdown 渲染器；
- 离开有脏草稿的编辑器前确认；
- 本地草稿状态可见；
- 后端 warning 不阻止保存，error 阻止；
- 保存前仍由后端再次校验，前端本地校验不能替代后端。

### 10.5 内置角色

内置角色详情为只读：

- 不显示“编辑并覆盖”；
- 显示“克隆并自定义”；
- 不显示删除/归档；
- 可以设为默认角色；
- 可以用于新建会话；
- 后端更新内置 revision 后从下一轮生效，UI 按 catalog 刷新。

### 10.6 新建会话选角

点击“+”后不再立即创建空会话，而是打开轻量角色选择器：

- 默认角色置顶并预选；
- 支持按名称搜索；
- archived 不可选；
- 展示角色名称、简介和头像；
- 可进入角色详情但不丢当前选择；
- 确认后一次调用 `createConversation({ characterId })`；
- 成功后 activate；
- 重复点击由 busy/in-flight guard 阻止。

选择优先级：

1. 用户本次明确选择；
2. `UserIdentityProfile.defaultCharacterId` 且仍 active；
3. 仅有一个 active 角色时自动预选；
4. 否则要求选择。

前端不得把“上次打开的角色”悄悄写成后端默认角色。

### 10.7 已有会话的角色不可变

会话头部可以显示角色身份，但不提供下拉切换。用户点击角色名可：

- 打开角色详情；
- 新建一个与其他角色的会话；
- 查看当前公开状态。

不能：

- 直接修改已有会话的 `characterId`；
- 用本地 Live2D 下拉冒充角色切换；
- 复制历史到另一角色而不经未来明确的 fork/migrate API。

### 10.8 会话列表与消息气泡

会话列表：

- 头像来自 `conversation.character.presentation/avatar` 或名称首字；
- 主标题仍是会话 title；
- 可在副信息显示角色名；
- legacy 缺 binding 时使用中性占位，不显示硬编码 Cyrene。

消息气泡：

- assistant 名称来自 `message.character.displayName`；
- 缺失时从会话 binding/版本 cache 解析；
- assistant 头像同一来源；
- user 仍可显示“我”，title/aria-label 使用 profile displayName；
- 历史消息不随当前角色改名被静默重写。

### 10.9 角色公开状态展示

右侧角色栏建议展示：

- 角色名称；
- 当前心情 label；
- 可选低权重 intensity 表现，不默认显示百分比；
- `currentActivity` 非空时显示；
- 最近互动相对时间；
- stale/离线标记。

不得展示：

- L2/L3/L4 文本；
- 反思缓冲；
- 记忆命中内容；
- 虚构亲密度；
- 未经后端定义的“关系阶段”。

### 10.10 归档、回滚与重置演化

归档：

- 只对 custom；
- 二次确认；
- 明确“既有会话仍可查看，但不能用它新建会话”；
- 应用 `CharacterArchiveResult.character` 更新目录；若结果带 `userProfile`，立即替换本地档案（说明默认角色已由后端原子回落），再按 catalog 失效策略刷新。

回滚：

- 文案使用“基于版本 N 创建新版本”；
- 不说“覆盖历史”；
- 显示 target revision 时间/checksum 摘要；
- 仍提交 expectedRevision 和 statePolicy。

重置演化：

- 放在角色实例/高级操作，不放普通编辑保存按钮旁；
- 明确重置 L2、L3（含 history/awareness/compression 派生态）、动态 C6、reflector 与 mood；
- 不声称删除消息或长期记忆；
- 两步确认，显示角色名和影响；
- `CHARACTER_BUSY` 时保持页面和草稿，允许稍后重试；
- 成功后直接应用返回的 public state，并按 `resetFields` 显示实际重置类别。

---

## 11. Live2D、TTS 与角色身份

### 11.1 两种状态必须改名分离

当前 `live2d/state-machine.ts` 的 `CharacterState` 实际描述：

```text
offline / idle / listening / thinking / speaking / happy / sad / surprised / ...
```

它是本机表现状态，目标重命名为：

```typescript
type Live2DPresentationState = ...
```

后端公开状态使用 `CharacterPublicState`。二者关系：

- public mood 可以作为低优先级表情建议；
- speaking/listening/tool waiting 等本地现实优先；
- GPU fallback/loading 只属于 presentation；
- public state 请求失败不应让 Live2D 渲染器崩溃；
- presentation 失败不应清空角色 public state。

### 11.2 Live2D 选择模式

现有一个全局 `settings.live2d.modelId` 无法同时支持角色默认值和用户固定选择。目标扩展：

```typescript
interface Live2DSettings {
  // 既有字段……
  selectionMode: 'follow_character' | 'fixed'
  fixedModelId: string | null
}
```

迁移：

- 旧设置 `modelId !== null` → `selectionMode='fixed'`、`fixedModelId=modelId`，保持用户既有选择；
- 旧设置 `modelId === null` → `selectionMode='follow_character'`；
- 完成迁移后删除双重语义的旧 `modelId`，不要长期三字段并存。

有效模型选择优先级：

1. Live2D disabled → 不加载；
2. `selectionMode=fixed` 且 fixed model 可用；
3. 活动会话角色 `presentation.live2dModelId` 且本机可用；
4. 注册表默认/首个可用模型；
5. 静态头像占位。

角色切换触发的模型加载不能调用“持久化 fixedModelId”的现有路径，否则每次打开会话都会篡改用户设置。需要区分：

- `bindCharacterModel(id)`：会话角色驱动，不写设置；
- `setFixedModel(id)`：用户显式固定，写设置；
- `restoreDefaults()`：恢复 follow character，而不是固定首个模型。

### 11.3 角色栏目标结构

右侧栏分为：

```text
角色身份头部
├─ 头像/名称
└─ 当前公开状态

Live2D stage
├─ 画布/静态回退
├─ 本地渲染错误
└─ 重置位置与缩放

低权重控制
└─ 跟随角色 / 固定本机模型（不冒充角色切换）
```

当前“模型”下拉若保留，必须明确标签为“本机 Live2D 模型”或移动到设置页，避免用户以为它在切换对话角色。

### 11.4 模型加载竞态

会话 A→B 快速切换：

1. 递增 presentation epoch；
2. 读取 B binding；
3. 解析有效模型；
4. 异步 switch；
5. 完成时 epoch 不匹配则丢弃提交；
6. B 没模型时回退，不恢复 A 模型身份标签；
7. A 的迟到 expression/directive 被实例守卫丢弃。

### 11.5 TTS 默认值与前端职责

角色 revision 的 voice 是后端运行默认值。前端：

- 在角色编辑器展示当前可选 provider/voice 引用；
- 允许“使用系统默认”；
- 不保存 API key；
- 不自行决定最终 provider；
- 播放后端已经生成的音频；
- 根据音频角色身份决定是否自动播放和驱动当前 Live2D 口型。

现有模型服务中心继续管理可用 provider 和当前服务。角色 voice 引用失效时：

- 目录/编辑器显示 warning；
- 后端按其降级规则使用系统默认；
- 前端不把角色判定为不可聊天；
- 不在角色卡中复制 provider 凭据表单。

---

## 12. 本地持久化、缓存与离线语义

### 12.1 会话缓存扩展

现有 `Conversation`、`Message` schema 增加 optional 角色快照后：

- 旧 `message-cache-v1.json` 仍可读；
- 新缓存保留 binding/message character；
- 条目级校验失败继续丢单条，不污染整文件；
- 不因角色字段缺失把整个旧会话删除；
- 离线 UI 对 legacy 会话显示中性占位。

若仅增加 optional 字段，不必为了文件名而强制升级 v2；若改变字段语义或删除旧字段，再做显式文件迁移。

### 12.2 角色目录缓存

V1 不要求把完整角色 authored 内容加入会话 cache。建议：

- 会话/消息自带足够显示的角色快照；
- catalog summary 可在 Main 保存小型 last-known-good cache，或首版只保内存；
- 完整 detail 不为“离线编辑”持久化；
- stale catalog 只能浏览，不能作为更新 revision 基线。

### 12.3 未提交角色草稿

长表单需要崩溃恢复，但不能塞进 `SessionStore`。建议新增：

```text
appCache/character-drafts-v1.json
```

结构：

```typescript
export interface CharacterDraftSummary {
  key: string
  mode: 'create' | 'edit' | 'clone'
  characterId?: string
  baseRevision?: number
  displayName: string
  updatedAt: string
}

interface PersistedCharacterDraft {
  key: string
  mode: 'create' | 'edit' | 'clone'
  characterId?: string
  baseRevision?: number
  draft: CharacterDraft
  updatedAt: string
}
```

约束：

- Main 原子写；
- safeRoot 校验；
- schemaVersion；
- 逐条校验和损坏隔离；
- 最多 10 条；
- 单条建议不超过 512 KiB；
- 总量建议不超过 2 MiB；
- 保存成功、用户明确丢弃或角色归档后清理相应草稿；
- 日志只写 key/字节数/错误码，不写正文。

### 12.4 离线行为矩阵

| 操作 | 离线行为 |
|---|---|
| 浏览缓存会话 | 允许 |
| 显示缓存角色名/头像/最后状态 | 允许，标 stale |
| 编辑本地未提交草稿 | 允许 |
| 创建/更新/归档/回滚角色 | 禁止，明确提示需连接 |
| 更新“我的档案” | 禁止，不排队 |
| 新建角色会话 | 禁止 |
| 重置角色演化 | 禁止 |
| Preview | 禁止 |
| 切换已有缓存会话 | 允许 |

不实现“重连后自动提交所有角色草稿”。用户重连后再次明确保存。

---

## 13. 安全与隐私

### 13.1 Renderer 可以看到的内容

- 用户自己的最小身份字段；
- 角色公开摘要；
- 当前用户有权编辑的 authored CharacterRevision 内容；
- 角色版本摘要；
- CharacterPublicState；
- Preview public reply；
- 受管 avatar/Live2D 资源引用。

### 13.2 Renderer 不得看到的内容

- 后端 framework prompt；
- 编译后完整 System Prompt；
- F1/F2/F3 模板正文；
- L2/L3/L4 原文；
- Reflector/Consolidator 内部缓冲；
- 长期记忆数据库记录或向量；
- Mongo/Milvus/Neo4j 连接信息；
- Provider API key；
- 服务器绝对路径；
- 后端 traceback 或上游完整响应体。

### 13.3 authored 内容安全

- 输入按纯文本处理；
- 不把字段拼进 DOM `innerHTML`；
- Preview reply 走现有 Markdown + DOMPurify；
- 后端保留标签命中后，前端按 issue path 展示，不尝试自行转义后绕过；
- 粘贴超限时立即提示长度，不静默截断后保存；
- aliases/wakeWords/examples 逐项限制；
- 表单导入文件不在 V1 范围，避免路径和大文件面扩大。

### 13.4 资产安全

- `avatarAssetId/live2dModelId` 只能是受管 ID；
- Renderer 不接收本机绝对路径；
- Live2D 继续通过 Main registry 和 `cyrene://` 受信协议解析；
- 远程 avatar 需要后端签名/代理端点后另行开放；
- `themeColor` 不允许任意 CSS 表达式、`url()` 或变量注入。

### 13.5 日志与诊断

允许记录：

- characterId/instanceId/revision；
- 操作种类；
- HTTP/公开 backendCode；
- 字节数、耗时和 schema 路径；
- 事件被身份守卫丢弃的原因码。

禁止记录：

- authored Prompt 正文；
- Preview 输入/回复全文；
- 用户档案自由文本；
- compiled prompt；
- 内部人格和记忆；
- API key、Token、绝对路径。

---

## 14. 错误与冲突 UX

### 14.1 Main 错误归一

当前 `mapHttpError()` 对多数 409/413/429/503 会落到 `UNKNOWN`。角色接入时至少要：

- 始终保留后端 `code` 为 `backendCode`；
- 409 映射为可识别冲突类公开错误，而非仅 `UNKNOWN`；
- 413 显示内容过大；
- 429 显示限流并保留 `retryAfterMs`；
- 503 显示服务暂不可用；
- 不把后端 body 原样放进 message。

Renderer 业务分支主要看稳定 `backendCode`，通用 `CyreneErrorCode` 用于大类展示。

冲突 details 只按 code 读取公开白名单：revision 冲突允许 `currentRevision`，state 冲突允许 `currentStateVersion`，validation 允许 `issues`。409 不能因为 `retryable=true` 就自动重放旧 mutation；`retryAfterMs` 只控制允许重试场景的退避。

### 14.2 稳定错误码处理

| backendCode | 前端行为 |
|---|---|
| `CHARACTER_NOT_FOUND` | 刷新目录；编辑页保留草稿，提示对象已不存在 |
| `CHARACTER_INSTANCE_NOT_FOUND` | 清 runtime cache；会话显示不可用状态 |
| `CHARACTER_IMMUTABLE` | 关闭编辑入口，提供克隆 |
| `CHARACTER_ARCHIVED` | 禁止新建；既有会话仍可查看 |
| `CHARACTER_VALIDATION` | 将 issues 定位到表单字段 |
| `CHARACTER_RESERVED_CONTENT` | 展示保留内容问题，不提供绕过 |
| `CHARACTER_REVISION_CONFLICT` | 保留草稿；展示当前 revision；提供重新加载/另存副本 |
| `CHARACTER_STATE_CONFLICT` | 刷新状态后重试危险操作，不影响普通聊天 |
| `CHARACTER_BUSY` | 不清表单；提示生成/反思结束后再试 |
| `CHARACTER_BINDING_IMMUTABLE` | 解释需新建会话，不重试 PATCH |
| `CHARACTER_STORAGE_UNAVAILABLE` | 只读降级；禁写 |
| `CHARACTER_PREVIEW_FAILED` | Preview 区局部错误，不污染编辑草稿 |
| `USER_PROFILE_REVISION_CONFLICT` | 保留输入，刷新 profile 后让用户确认重新应用 |
| `MEMORY_SCOPE_VIOLATION` | 通用安全错误；不展示内部 scope 详情 |

### 14.3 revision conflict 页面

409 后禁止自动重发旧 expectedRevision。提供：

1. 查看服务端当前版本摘要；
2. 重新加载（先确认是否丢弃本地草稿）；
3. 将本地草稿另存为新角色；
4. 简单字段差异视图可作为后续；
5. 不提供“强制覆盖”按钮，除非后端未来定义显式安全 API。

---

## 15. 兼容、迁移与放量顺序

### 15.1 三种运行模式

| 能力 | 前端模式 |
|---|---|
| `character_profiles=false` | Legacy：隐藏角色 CRUD/选角；会话按旧接口创建；固定身份 UI 改用中性兼容值或产品配置 |
| profiles=true, state_stream=false | 角色目录/编辑/绑定可用；状态在激活和 generation 完成后 REST 刷新 |
| profiles=true, state_stream=true | 完整角色状态 snapshot + WS 变化时的完整公开视图 |

### 15.2 strict schema 的正确放量顺序

1. 前端先加入 optional character 字段、feature schema 和 mapper；
2. 前端 fixture/mock/IPC 全链通过；
3. 后端生成产物/golden 已包含 optional 字段/新事件，但运行时 feature=false 时仍发送 legacy 形状；双端先离线对拍；
4. 双端契约测试确认旧会话与新字段；
5. 后端完成 Prompt、runtime、memory 隔离后才置 `character_profiles=true`；
6. 状态事件完成后再置 `character_state_stream=true`；
7. 真实联调通过后才把 UI 入口视为正式能力。

若后端必须先部署到仍有旧前端的环境，必须增加客户端能力协商或版本化响应；不能假设 `.strict()` 会忽略新字段。

### 15.3 旧会话

- `character` 缺失即 legacy；
- 不从 title、消息自称或当前 Live2D 猜角色；
- 在线时后端迁移完成后，以新 SessionSummary 覆盖；
- 离线时继续中性展示；
- 不因缺角色字段删除缓存消息。

### 15.4 旧硬编码 UI

需要区分两类：

- **产品品牌**：窗口标题、应用名、日志命名空间 `Cyrene` 可保留；
- **对话身份**：`CyMessageBubble` 中的 `Cyrene/Cy`、会话头像、角色栏名称必须动态化。

不要进行全仓库机械替换“Cyrene”。

### 15.5 旧 Live2D 设置

按 §11.2 显式迁移 selectionMode，保证用户已有固定模型不被角色默认悄悄替换。

---

## 16. 建议文件与模块布局

```text
apps/desktop/src/shared/
├─ contracts/
│  ├─ character.ts
│  ├─ conversation.ts          # binding 扩展
│  ├─ message.ts               # generation ref 扩展
│  ├─ events.ts                # state/catalog/generation identity
│  ├─ backend.ts               # query/result re-export
│  ├─ ipc.ts                   # 具名通道
│  └─ persistence.ts           # 角色快照随会话/消息
└─ schemas/
   ├─ character.ts
   ├─ events.ts
   ├─ ipc-response.ts
   └─ persistence.ts

apps/desktop/src/main/
├─ characters/
│  ├─ character-service.ts
│  ├─ character-handlers.ts
│  ├─ character-draft-store.ts
│  └─ character-errors.ts
├─ transport/protocol-v2/
│  ├─ character-rest-types.ts
│  ├─ character-rest-schemas.ts
│  ├─ character-rest-mapper.ts
│  ├─ raw-types.ts
│  ├─ raw-schemas.ts
│  ├─ frame-mapper.ts
│  ├─ rest-types.ts
│  ├─ rest-schemas.ts
│  └─ rest-mapper.ts
├─ chat/
│  └─ chat-service.ts           # create/activate binding 协调
└─ persistence/
   └─ session-store.ts          # 会话/消息角色快照

apps/desktop/src/preload/
├─ desktop-api.ts
└─ index.d.ts

apps/desktop/src/renderer/src/
├─ stores/
│  ├─ identity.store.ts
│  ├─ character-catalog.store.ts
│  ├─ character-editor.store.ts
│  ├─ character-runtime.store.ts
│  ├─ conversation.store.ts
│  ├─ message.store.ts
│  ├─ live2d.store.ts
│  └─ voice.store.ts
├─ components/characters/
│  ├─ CyIdentityPane.vue
│  ├─ CyIdentityWizard.vue
│  ├─ CyCharacterPane.vue
│  ├─ CyCharacterCatalog.vue
│  ├─ CyCharacterCard.vue
│  ├─ CyCharacterDetail.vue
│  ├─ CyCharacterEditor.vue
│  ├─ CyCharacterPromptFields.vue
│  ├─ CyCharacterExamplesEditor.vue
│  ├─ CyCharacterPresentationFields.vue
│  ├─ CyCharacterValidation.vue
│  ├─ CyCharacterPreview.vue
│  ├─ CyCharacterRevisionList.vue
│  ├─ CyCharacterPicker.vue
│  └─ CyCharacterStateSummary.vue
├─ components/
│  ├─ CySettingsView.vue
│  ├─ CyConversationList.vue
│  ├─ CyMessageBubble.vue
│  ├─ CyLive2DPane.vue
│  └─ CyLive2DPanel.vue
└─ bootstrap.ts
```

命名可以在 plan 阶段微调，但四个 Store 和 Main/Preload 信任边界不得重新压成一个巨型组件。

---

## 17. 分阶段实施计划与后端依赖

### 前端 A：契约、schema 与兼容门

内容：

- character shared types/schemas；
- Conversation/Message optional snapshot；
- raw REST/WS schema 和 mapper；
- typed features；
- BackendEvent 联合扩展；
- persistence schema optional 扩展；
- fixture 与 contract test；
- UI 仍保持 legacy。

依赖：后端 DTO 草案稳定；不要求后端功能可用。

退出条件：前端能严格接纳新 optional 字段，也能读取旧 fixture；旧 UI 不回归。

### 前端 B：Main/Preload 只读角色域

- CharacterBackendPort；
- CharacterService；
- getMe/list/get/revisions/getState；
- 具名 IPC/Preload；
- Mock 两个内置角色；
- identity/catalog/runtime Store 只读骨架；
- capability gate。

依赖：后端阶段 C（领域模型、内置 catalog、UserIdentity）。

退出条件：真实或契约 fake 可列 Elysia/Cyrene，Renderer 无 raw DTO。

### 前端 C：“我的档案”与角色目录 UI

- 初始化向导；
- profile revision 更新；
- 默认角色；
- 角色目录/详情；
- 内置/自定义区分；
- loading/error/stale/empty；
- 设置导航拆分。

依赖：后端 `/api/me`、角色 list/get。

退出条件：用户可确认“我”，可查看角色目录，但尚不能自定义。

### 前端 D：自定义角色、版本与 Preview

- create/update/clone/archive；
- validate/preview；
- revision list/rollback；
- statePolicy；
- local draft store；
- conflict UX；
- dangerous action confirmation。

依赖：后端阶段 D。

退出条件：完整 CRUD/版本/冲突/Preview 可用，尚不允许 custom 参与真实聊天也可以。

### 前端 E：会话绑定与动态身份

- 新建会话角色 picker；
- SessionSummary/Message snapshot；
- conversation/message dynamic name/avatar；
- generation identity map；
- legacy 会话中性兼容；
- offline cache 扩展；
- 已有会话不换角色。

依赖：后端阶段 E；多角色 memory 未就绪时后端 feature 仍须 false，联调只走隔离环境。

退出条件：两个角色在不同会话中名称、版本和消息身份不串。

### 前端 F：公开状态、Live2D 与 TTS

- CharacterPublicState REST/WS；
- public state 与 presentation state 分离；
- Live2D selectionMode 迁移；
- 角色模型自动绑定；
- expression/directive identity；
- audio identity 与 autoplay guard；
- 切会话竞态和回退。

依赖：后端阶段 G，且后端阶段 F 记忆隔离已通过。

退出条件：快速切换、迟到事件和 TTS 都不串角色。

### 前端 G：迁移、真机联调与文档

- 旧会话/旧缓存/旧 Live2D 设置迁移；
- mock/real contract 对拍；
- Windows Electron 真机；
- 断线/重连；
- 更新 doc 01/02/03/05/06/07/08/10/11/12/16；
- 形成 review 验收记录。

依赖：后端阶段 H。

退出条件：完整验收清单通过后才视为角色系统可发布。

### 17.1 前后端阶段对应

| 前端批次 | 后端最小依赖 |
|---|---|
| FE-A 契约 | 后端 DTO/事件草案 |
| FE-B 只读角色域 | BE-C |
| FE-C 档案与目录 | BE-C |
| FE-D 自定义与版本 | BE-D |
| FE-E 会话绑定 | BE-E；feature 暂不放量 |
| FE-F 状态/Live2D/TTS | BE-F + BE-G |
| FE-G 迁移联调 | BE-H |

并行开工口径：后端可同时推进 BE-A/BE-B 和 BE-C0（只做 `frontend_contract` DTO/事件/golden，feature 恒 false）；前端 FE-A 可立即按本文建立领域/strict schema/Mock 骨架，但只有拿到 BE-C0 同一 backend commit/schemaHash 的 handoff bundle 并通过交叉门禁后才能退出。后续批次严格按上表，不以“接口能 200”替代 runtime/memory 隔离门禁。

---

## 18. 测试策略

### 18.1 shared schema 与 mapper

- UserIdentityProfile 全字段/缺省/非法 revision；
- CharacterSummary/Detail/Draft/Revision；
- raw `{items,has_more,cursor?}` → `Page{items,hasMore,nextCursor?}`；
- create/clone、update/rollback、archive、reset 的不同响应 DTO；
- `preserve/reset_evolution` 接受，缩写 `reset` 拒绝；
- aliases/examples 数量和长度；
- Presentation 拒绝绝对路径和危险颜色；
- SessionSummary optional character；
- Message optional character；
- generation identity；
- character.state.changed；
- 绑定/public state 中的模糊 `revision` 拒绝，只接受 `characterRevision`；
- expression/directive/audio identity；
- unknown 字段、未知枚举、坏时间、越界 intensity 拒绝；
- raw null → domain undefined 规则一致；
- 旧 fixture 继续通过。

### 18.2 Main service 与 IPC

- feature 缺省 false；
- profiles=false 拒绝角色写命令；
- profile/catalog GET in-flight 去重；
- 连接 epoch 变化丢弃旧响应；
- 写成功精确失效缓存；
- backendCode 穿透；
- 409 不自动覆盖；
- Preview 不进入 SessionStore；
- character draft 原子写、配额、损坏隔离；
- handler/preload 双端 schema；
- Renderer 无任意 fetch/channel；
- authored 内容不进日志。

### 18.3 Store 单元测试

`identityStore`：

- initialized=false；
- 更新成功 revision 前进；
- profile conflict 保留表单；
- default character archived 后调和。

`characterCatalogStore`：

- 分页、搜索、去重；
- list/detail 独立 loading；
- catalog.changed revision 单向；
- builtin 禁编辑；
- archive 不删除既有会话快照。

`characterEditorStore`：

- detail 深拷贝；
- dirty；
- debounce draft；
- validation path；
- Preview 独立；
- save conflict；
- save 后清 draft。

`characterRuntimeStore`：

- active binding；
- instance cache；
- conversation/instance/epoch 守卫；
- stream false REST fallback；
- disconnect stale。

### 18.4 组件测试

- 我的档案字段与键盘操作；
- 角色目录空态/错误/stale；
- 内置角色只显示克隆；
- 编辑器长内容滚动和脏状态确认；
- examples 添加/删除/排序；
- validation issue 聚焦字段；
- Preview 明确 ephemeral；
- 新建会话 picker 默认选择；
- archived 不可选；
- 动态消息名称/头像；
- legacy 中性占位；
- 角色栏 public state；
- Live2D 跟随/固定模式。

### 18.5 集成测试

- profiles=false 的旧后端路径完全可用；
- profiles=true 时 getMe/catalog/conversation 并行初始化；
- 新建 Elysia 会话；
- 新建 Cyrene 会话；
- 两会话快速切换；
- A generation delta 迟到不进入 B；
- A expression/directive 不驱动 B；
- A TTS ready 不在 B 自动播放；
- 角色编辑期间当前 generation 保持旧 revision；
- 下一轮使用新 revision；
- 重连 replay 恢复 binding/state；
- 离线缓存显示角色摘要；
- 旧缓存无 character 不崩溃。

### 18.6 真实联调矩阵

至少准备：

- 内置 Elysia；
- 内置 Cyrene；
- 一个行为明显不同的 custom 角色；
- 一个 archived custom；
- 一个未初始化 profile；
- 一个 legacy session；
- 两个不同角色的并发/快速切换会话。

联调必须覆盖：

1. 档案初始化和更新；
2. default character；
3. catalog/详情/克隆；
4. create/update/validate/preview；
5. revision conflict；
6. archive/rollback；
7. 新建会话选角；
8. generation/message identity；
9. state snapshot/stream；
10. Live2D model follow/fixed；
11. TTS 身份；
12. 断线/重连；
13. 应用重启/离线缓存；
14. reset evolution busy/success；
15. Prompt 内容不出现在日志/诊断包。

---

## 19. `character-contract-v1` 开工冻结核对表

下列项目已经与后端设计 §11～§12 对齐，不再是待讨论项。后端 Pydantic/Schema/TS/golden 与前端 raw schema/mapper 必须据此实现；如需变更，先同时修改两份设计文档和契约 fixture，再改业务代码。

| ID | 契约点 | 冻结结论 |
|---|---|---|
| CHAR-FE-01 | `/api/me` | GET/PUT 直接返回 `UserIdentityProfile`；PUT 带完整最小身份 + `expectedRevision`；unknown optional 省略 |
| CHAR-FE-02 | list/detail | raw 分页 `{items,has_more,cursor?}`；默认不列 archived；详情固定 `{summary,current}` |
| CHAR-FE-03 | mutation | create/clone → `CharacterDetail`；update/rollback → `CharacterMutationResult`；archive → `CharacterArchiveResult` |
| CHAR-FE-04 | validation | 200 `{valid,issues,estimatedPromptChars?}`；`path` 为 JSON Pointer；保存无效时 400 + 同形 issues |
| CHAR-FE-05 | preview | `{draft,userMessage}` → `{ephemeral:true,reply,model?,usage?}`；HTTP abort/best-effort cancel；零持久化副作用 |
| CHAR-FE-06 | session summary | `character={characterId,characterInstanceId,characterRevision,displayName,presentation}`；flag=true 后非 legacy 必填 |
| CHAR-FE-07 | session message | assistant item 使用与 summary 同形的实际生成快照；user/tool 可省略 |
| CHAR-FE-08 | generation | 三条 started/completed/failed 均带 characterId/instanceId/revision；flag=true 后必填且一致 |
| CHAR-FE-09 | state | REST 完整 public state；WS 带 conversation + identity + stateVersion，`state` 为完整 view；按 stateVersion 排序 |
| CHAR-FE-10 | expression/directive | conversationId/generationId?/characterId/instanceId/revision；flag=true 后无身份则丢弃 |
| CHAR-FE-11 | TTS | `audio_start` 带 stream + conversation/generation?/character/instance/characterRevision；Main 保留到 ready/cancel |
| CHAR-FE-12 | errors | `ProtocolError{code,message,retryable,requestId,error,details,retryAfterMs?}`；Main 映射 `code→backendCode` |
| CHAR-FE-13 | rollout | 前端 optional schema 先发布 → 后端 schema/golden 离线对拍且运行时仍 legacy → 隔离门禁通过后开 profiles → 最后开 state stream |
| CHAR-FE-14 | assets | V1 不新增资产解析端点；没有受管解析能力时 `avatarAssetId/live2dModelId` 为空，前端使用安全占位，不阻塞角色域 |
| CHAR-FE-15 | state reset | `{expectedStateVersion}` → `{state,resetFields}`；busy=409；不删除会话、消息、LTM 或关系数据 |

另有两条实现边界已经冻结：

- `CharacterStatePolicy` 只取 `preserve | reset_evolution`；
- 后端 raw 使用 `characterRevision`，不再用含义模糊的顶层 `revision` 表示绑定或公开状态。

本表解决的是开工接口口径，不代表对应实现已完成。Renderer 仍只能消费 Main 映射后的领域对象，不能直接使用 raw wire。

---

## 20. 验收标准

### 20.1 身份与角色目录

- [ ] 未初始化用户可以看到并完成最小档案；
- [ ] 档案更新从下一轮生效，不改写历史；
- [ ] 内置与自定义角色可区分；
- [ ] 默认角色来自后端 profile；
- [ ] 内置角色不能编辑/归档，只能克隆；
- [ ] archived 不能用于新会话，既有会话仍可读。

### 20.2 编辑与版本

- [ ] 完整 authored 字段可编辑；
- [ ] validation error 可定位；
- [ ] Preview 明确无状态，不进入聊天/记忆/TTS；
- [ ] 保存产生新 revision；
- [ ] revision conflict 不丢草稿、不静默覆盖；
- [ ] rollback 创建新 revision；
- [ ] 本地草稿可恢复且不写日志。

### 20.3 会话与消息

- [ ] 新建会话显式选角色；
- [ ] 已有会话没有换角色入口；
- [ ] 会话列表、消息和角色栏显示正确角色；
- [ ] app 品牌与角色身份不混用；
- [ ] legacy 会话中性兼容；
- [ ] offline cache 保留角色摘要；
- [ ] generation 身份与 revision 可审计。

### 20.4 状态、Live2D 与 TTS

- [ ] CharacterPublicState 与本地 presentation state 分离；
- [ ] 不展示内部人格/记忆；
- [ ] Live2D 支持 follow character/fixed；
- [ ] 角色切换不改写固定设置；
- [ ] 模型缺失安全回退；
- [ ] expression/directive 经过身份守卫；
- [ ] 迟到 TTS 不在错误角色会话播放；
- [ ] Live2D/TTS 失败不阻塞聊天。

### 20.5 架构与安全

- [ ] raw REST/WS 只在 Main；
- [ ] Preload 只有具名 API；
- [ ] Renderer 无任意后端 fetch；
- [ ] 所有 IPC 双端 schema 校验；
- [ ] feature 缺省 false；
- [ ] authored 内容、profile 自由文本和 Prompt 不进日志；
- [ ] 绝对路径、密钥、数据库信息不进 Renderer；
- [ ] strict schema 放量顺序有契约测试。

---

## 21. 实施时禁止的捷径

1. 用角色名作为主键。
2. 把 Live2D `modelId` 当 `characterId`。
3. 在 `CyMessageBubble` 用当前全局角色名覆盖历史消息。
4. 在已有会话增加一个本地角色下拉，但不改变后端 binding。
5. 把 Character CRUD 直接放进 Renderer fetch。
6. 暴露通用 IPC `request(path, body)`。
7. 把完整 compiled prompt 返回前端做“高级预览”。
8. 把 L2/L3/L4 当角色状态卡片展示。
9. 由前端生成 revision 或 checksum。
10. 409 后自动用新 revision 重发旧草稿。
11. 角色切换时调用现有持久化 `switchModel()` 覆写用户固定 Live2D 设置。
12. TTS 缺身份时在多角色模式继续自动播放。
13. 用 feature flag 掩盖 strict schema 未升级的问题。
14. 离线排队归档、回滚、重置或身份更新。
15. 把完整角色编辑草稿塞进会话消息缓存。
16. 为角色 UI 复制一套模型 Provider 凭据配置。
17. 把“当前心情强度”包装成亲密度或关系等级。
18. 机械替换全仓库的 `Cyrene`，破坏产品品牌和路径命名。

---

## 22. 与现有文档的后续同步关系

本文先作为专项目标设计。真正实施时按职责同步：

| 文档 | 需要同步的内容 |
|---|---|
| doc 01 | CharacterService、进程边界、启动流程 |
| doc 02 | REST/WS、领域事件、角色审计字段和错误 |
| doc 03 | 档案、目录、编辑、新建会话、角色状态交互 |
| doc 05 | follow character/fixed、身份守卫、状态分离 |
| doc 06 | 四个 Store、缓存、角色草稿和迁移 |
| doc 07 | authored 内容、IPC、资产与日志安全 |
| doc 08 | schema/store/集成/真机验收矩阵 |
| doc 10 | 实施任务和 DoD |
| doc 11 | 设置中心新导航和各子页 |
| doc 12 | 新功能批次进入/退出条件 |
| doc 16 | 仅在实际启动批次后写当前状态 |

后端权威设计仍是：

```text
elysia-agent/docs/2026-08-30-character-prompt-customization-backend-architecture-design.md
```

若前后端设计冲突：

- Prompt、角色状态、记忆、存储与后端 REST/WS 业务语义以后端设计为准；
- Electron 进程边界、IPC、Renderer 状态与本地资源安全以本文和前端 doc 01/07 为准；
- 精确字段最终以后端生成 contract + 前端 Main schema/mapper 的契约测试为准；
- 当前进度永远以 doc 16 为准。

---

## 23. 最终实现判断

只有同时满足以下条件，前端才算真正接入多角色系统：

- 用户已能定义最小“我”；
- 角色目录和自定义角色由后端持久化、版本化；
- 新会话绑定角色实例，已有会话不可静默换角色；
- 会话、消息、generation、状态、Live2D 和 TTS 使用同一组角色身份；
- 迟到事件不会串角色；
- 内部人格、记忆和框架 Prompt 没有越过产品边界；
- legacy/离线/重连都不会靠名字猜身份；
- strict schema、feature rollout、迁移和真实 Electron 联调全部通过。

如果只实现“一个角色编辑页面”，而会话、消息、Live2D、TTS 和缓存仍然共享全局角色，那么它仍然是单角色应用外加一个配置表单，不是本设计要求的多角色前端。
