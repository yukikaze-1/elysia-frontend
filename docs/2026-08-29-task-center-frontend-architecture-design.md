# Cyrene 任务中心前端架构设计

> **文档状态：** 架构讨论稿（目标设计，未实现）  
> **日期：** 2026-08-29  
> **事实基线：** `elysia-frontend@7712d3e`  
> **权威范围：** Electron Main/Preload/Renderer 中任务中心、执行记录、状态同步和交互设计  
> **上位设计：** [任务系统与任务中心总体架构设计](./2026-08-29-task-system-overall-architecture-design.md)  
> **后端配套：** `elysia-agent/docs/2026-08-29-task-system-backend-architecture-design.md`

---

## 0. 结论

前端不需要实现第二套任务调度器。它需要实现的是一个安全、可恢复的任务客户端：

- Renderer 展示 Task、TaskStep 和 ToolExecution；
- Main 连接正式 Task REST/WS API、校验原始协议并执行 Desktop 工具；
- Preload 只暴露具名、窄化、运行时校验的任务查询与控制方法；
- Task 历史以 Backend 为权威；
- Desktop 正在执行、等待权限等即时现实以 Main 本地状态覆盖 Backend 的滞后摘要；
- 聊天内工具卡继续存在，任务中心不是对聊天卡片的替代，而是跨会话历史、后台生命周期和控制入口；
- 任务页采用“任务 / 执行记录”双页签；
- 现有 `toolStore`、`ToolCallRecord`、`ToolService` 和审批组件复用，但不直接扩成一个同时承担任务、历史分页、权限和聊天卡片的巨型 Store。

---

## 1. 范围与非目标

### 1.1 本设计范围

- 任务中心顶层信息架构；
- Task/TaskStep/ToolExecution 前端领域模型；
- Main BackendAdapter、IPC、Preload 和 Renderer 的边界；
- REST 快照、WS 增量、重连与 revision 合并；
- 任务列表、详情、步骤、控制和来源跳转；
- 执行记录查询与 Runtime 筛选；
- Desktop 权限等待、Main 本地 overlay 与审计入口；
- 缓存、离线、性能、无障碍和安全要求；
- 分阶段改造现有代码的建议路径。

### 1.2 非目标

- 在 Renderer 中执行工具；
- 在 Electron 中实现本地 WorkflowEngine；
- 第一版实现 Local Worker 进程；
- 第一版实现任务模板市场、批量任务或跨设备管理；
- 直接渲染后端内部 Workflow DAG/checkpoint；
- 把设置页安全审计搬进任务中心；
- 删除聊天内的实时与归档工具卡；
- 在任务中心中展示原始工具参数、完整本地路径或后端内部 prompt。

---

## 2. 当前前端实现基线

### 2.1 页面与导航

| 位置 | 当前事实 | 可复用/缺口 |
|---|---|---|
| `renderer/src/components/CyNavRail.vue` | 已有 `tasks` 导航项 | 保留入口 |
| `renderer/src/stores/app.store.ts` | `AppView = chat | tasks | settings` | 保留视图状态 |
| `renderer/src/App.vue` | tasks 分支只渲染“任务中心 · 阶段 6 落地” | 必须替换为正式视图 |
| `renderer/src/layout/effective-layout.ts` | 网格只针对聊天四区推导 | tasks 当前只占 `chat` grid-area，其他列可能仍占位 |

当前问题不是“缺一个列表组件”，而是缺少完整数据与进程边界。仅在占位页读取 Debug SSE 会绕开 Main、契约和权限边界，不可采用。

### 2.2 工具领域模型

`shared/contracts/tool.ts` 当前已有：

- `ToolRuntime = backend | desktop | local_worker`；
- 八态 `ToolCallStatus`；
- `ToolCallRecord`；
- Desktop 公开事件 `PublicToolEvent`；
- PermissionGrant、审批历史和 Diff 数据结构。

`ToolCallRecord` 当前主键语义为：

```text
id = sourceCallId = LLM tool_call_id
desktopCallId = Desktop Bridge callId
```

这对阶段 6 的聊天工具卡是正确的，但完整执行记录还缺：

- 独立 `executionId`；
- `taskId/stepId/attempt`；
- 公共 `revision`；
- `waiting_for_runtime`；
- 来源消息和稳定客户端实例；
- 分页历史需要的 `createdAt/updatedAt` 完整定义。

### 2.3 Renderer toolStore

`renderer/src/stores/tool.store.ts` 当前职责：

- Main `tool:event` 的 Desktop 本地状态；
- Backend `tool.started/tool.completed` 的只读记录；
- 实时区最多展示 3 条终态记录，非终态不驱逐；
- 终态单向；
- 当前会话隔离；
- 权限窗口需要的 pathSummary/Diff/dataFlowNote 侧信道；
- Desktop 授权、取消、截图选择和上传确认命令。

它明确不是历史 Store：

- live records 易失；
- 归档工具卡直接读取 `Message.toolCalls`；
- Main 水合只回最近内存记录；
- 没有 cursor、query key、分页、任务分组或 revision。

因此不应直接把 Task 列表、Task 详情和全部执行历史继续塞进现有 `toolStore`。

### 2.4 Main ToolService

`main/tools/tool-service.ts` 当前拥有 Desktop 调用的可信状态机：

- 注册表与平台校验；
- strict 参数校验；
- `sourceCallId` 幂等；
- `paramHash`；
- realpath、黑名单和目录 Grant；
- 权限队列；
- 文件 Diff；
- Desktop 执行器；
- `tool.status` 回传；
- 200 条内存上限；
- 重连时重发未确认终态；
- Renderer 脱敏公开事件。

它继续作为 Desktop 执行权威，不应被 Renderer Task Store 替代。

### 2.5 当前历史来源

| 历史类型 | 当前来源 | 局限 |
|---|---|---|
| 聊天内 Backend/Desktop 工具卡 | `Message.toolCalls` | 依赖会话消息；不便跨会话过滤；缺 Task 关联 |
| Desktop 实时记录 | Main ToolService 内存 | 最多 200 条；应用重启丢失 |
| Desktop 审批历史 | Main audit JSONL | 是安全审计摘要，不是产品 ToolExecution 历史 |
| Backend 工具搜索 | 后端消息搜索可有 tool 分类 | 前端 HistoryCategory 尚不包含 tool；结果也不是完整执行实体 |
| Workflow Task | 无正式前端来源 | Debug API 不可作为产品依赖 |

---

## 3. 前端目标分层

```text
Renderer
├─ CyTaskCenterView
│  ├─ taskStore（Task 列表/详情/控制/事件）
│  └─ executionHistoryStore（分页执行记录；只存公开摘要）
├─ existing toolStore（聊天实时工具 + Desktop 审批交互）
└─ messageStore（聊天消息与 Message.toolCalls）

Preload
└─ named task/execution query + command + event methods

Main
├─ TaskBackendAdapter（正式 REST/WS）
├─ TaskClientService（快照、事件、重连协调、Main overlay）
├─ existing ToolService（Desktop 执行权威）
└─ typed IPC handlers
```

### 3.1 Renderer 的职责

- 展示经过 Main 验证的公共 Task DTO；
- 管理筛选、选择项、分页、加载态和 UI 未读状态；
- 发出暂停、继续、取消意图；
- 按后端返回的 `controls` 决定按钮可用性；
- 将等待权限的任务链接到现有 Desktop 审批交互；
- 从任务或执行记录跳回来源会话；
- 不自行推导跨 Runtime 调度结果；
- 不持久化原始 Task prompt、Desktop 参数或完整 artifact。

### 3.2 Main 的职责

- 解析、校验后端 Task/Execution raw schema；
- 完成 snake/camel、错误和日期归一化；
- 通过 REST 查询任务/执行历史；
- 通过 WS 接收 task/execution 增量；
- 维护连接恢复和快照对账；
- 将 Desktop ToolService 的非终态现实作为 overlay；
- 校验控制命令形状和目标 ID；
- 保证 Renderer 不能构造任意后端请求；
- 输出脱敏日志和公开错误。

### 3.3 Preload 的职责

- 只暴露具名 API；
- 对入参和出参做运行时 schema 验证；
- 事件订阅返回 unsubscribe；
- 不暴露 `ipcRenderer`、任意 channel、任意 URL 或原始 fetch；
- 不允许 Renderer 提交 task 状态或伪造 execution 结果。

---

## 4. 前端领域契约

### 4.1 文件归属

建议新增：

```text
apps/desktop/src/shared/contracts/task.ts
apps/desktop/src/shared/schemas/task.ts
```

并修改：

```text
shared/contracts/tool.ts       # ToolExecution 目标模型/兼容别名
shared/contracts/events.ts     # task.* / tool.execution.updated
shared/contracts/backend.ts    # Task/Execution query/command DTO
shared/contracts/ipc.ts        # 具名 IPC channels
shared/contracts/index.ts      # re-export
shared/schemas/events.ts       # 事件判别联合镜像
shared/schemas/index.ts        # re-export
```

### 4.2 Task 类型

```typescript
export type TaskKind = 'workflow' | 'scheduled'

export type TaskStatus =
  | 'queued'
  | 'planning'
  | 'running'
  | 'waiting_for_runtime'
  | 'waiting_for_permission'
  | 'pausing'
  | 'paused'
  | 'resuming'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface PublicTaskError {
  code: string
  message: string
  retryable?: boolean
}

export interface TaskProgress {
  completed: number
  total: number
  percent?: number
}

export interface TaskSummary {
  taskId: string
  kind: TaskKind
  title: string
  intentSummary: string
  status: TaskStatus
  progress?: TaskProgress
  currentStepSummary?: string
  requiredRuntime?: ToolRuntime
  sourceConversationId?: string
  sourceMessageId?: string
  submitExecutionId?: string
  resultSummary?: string
  error?: PublicTaskError
  createdAt: string
  startedAt?: string
  updatedAt: string
  finishedAt?: string
  revision: number
}
```

### 4.3 TaskStep 与详情

```typescript
export type TaskStepStatus =
  | 'pending'
  | 'running'
  | 'waiting_for_runtime'
  | 'waiting_for_permission'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled'

export interface TaskStep {
  stepId: string
  taskId: string
  ordinal: number
  title: string
  description?: string
  status: TaskStepStatus
  runtime?: ToolRuntime
  executionIds: string[]
  attemptCount: number
  dependsOn: string[]
  outputSummary?: string
  error?: PublicTaskError
  createdAt: string
  startedAt?: string
  finishedAt?: string
  revision: number
}

export interface TaskControls {
  canPause: boolean
  canResume: boolean
  canCancel: boolean
  canRetry: boolean
}

export interface TaskDetail extends TaskSummary {
  steps: TaskStep[]
  controls: TaskControls
  artifacts: PublicTaskArtifact[]
  runtimeBinding?: PublicRuntimeBinding
}
```

### 4.4 ToolExecution 演进

建议保留 `ToolCallRecord` 作为迁移期聊天兼容类型，新增明确的历史实体 `ToolExecutionRecord`：

```typescript
export type ToolExecutionStatus =
  | ToolCallStatus
  | 'waiting_for_runtime'

export interface ToolExecutionRecord {
  executionId: string
  sourceCallId?: string
  desktopCallId?: string
  toolName: string
  runtime: ToolRuntime
  status: ToolExecutionStatus
  taskId?: string
  stepId?: string
  attempt?: number
  conversationId?: string
  messageId?: string
  generationId?: string
  inputSummary?: string
  outputSummary?: string
  error?: { code?: string; message?: string }
  errorType?: string
  truncated?: boolean
  durationMs?: number
  attachmentCount?: number
  createdAt: string
  startedAt?: string
  finishedAt?: string
  revision: number
}
```

迁移期适配函数应集中在 shared/domain 或 Main mapper：

```text
ToolCallRecord → ToolExecutionRecord
tool.started/completed → ToolExecutionRecord
PublicToolEvent → local execution overlay
```

组件中禁止散落 `id ?? sourceCallId ?? desktopCallId` 之类兼容逻辑。

### 4.5 分页类型

```typescript
interface CursorPage<T> {
  items: T[]
  nextCursor?: string
  hasMore: boolean
}

interface TaskListQuery {
  statuses?: TaskStatus[]
  kinds?: TaskKind[]
  conversationId?: string
  cursor?: string
  limit: number
}

interface ToolExecutionListQuery {
  taskId?: string
  stepId?: string
  conversationId?: string
  runtimes?: ToolRuntime[]
  statuses?: ToolExecutionStatus[]
  cursor?: string
  limit: number
}
```

所有查询对象必须有上限和 strict schema；Renderer 不能透传任意 query string。

---

## 5. Main BackendAdapter 设计

### 5.1 BackendAdapter 方法

在 `main/transport/backend-adapter.ts` 增加：

```typescript
listTasks(query: TaskListQuery): Promise<CursorPage<TaskSummary>>
getTask(taskId: string): Promise<TaskDetail>
pauseTask(input: TaskCommandInput): Promise<TaskSummary>
resumeTask(input: TaskCommandInput): Promise<TaskSummary>
cancelTask(input: TaskCommandInput): Promise<TaskSummary>

listToolExecutions(query: ToolExecutionListQuery): Promise<CursorPage<ToolExecutionRecord>>
getToolExecution(executionId: string): Promise<ToolExecutionRecord>
```

```typescript
interface TaskCommandInput {
  taskId: string
  commandId: string
}
```

不增加以下接口：

- `setTaskStatus()`；
- `executeTaskStep()`；
- `approveTask()`；
- 任意 `request(method, path, body)`。

### 5.2 RealBackend

`main/transport/real-backend.ts` 负责：

- 调用 `/api/tasks` 与 `/api/tool-executions`；
- 解析任务 REST contract；
- 映射后端错误为 `CyreneError`；
- 在 `handleFrame()` 中显式处理 `task.created/task.updated/task.step.updated/tool.execution.updated`；
- 通过 FrameMapper 或独立 TaskMapper 转为前端领域事件；
- 不把 raw 内部字段送 Renderer；
- 保留当前 `tool.request` 路由到 Main ToolService 的特殊处理。

### 5.3 MockBackend

任务中心开发需要确定性 Mock，但 Mock 不能成为契约事实源。建议提供：

- 纯 Backend Workflow：queued → planning → running → completed；
- Desktop 等待 Runtime；
- Desktop 等待权限；
- paused/resuming/cancelled；
- failed + retryable/error code；
- 至少一条普通 direct ToolExecution；
- 至少一条带 taskId/stepId 的 ToolExecution；
- cursor 分页；
- revision 重复、乱序和跳号场景。

Mock 控制方式沿用显式环境变量或测试 fixture，不在产品 UI 增加开发按钮。

---

## 6. IPC 与 Preload

### 6.1 具名 IPC

建议新增：

```text
task:list
task:get
task:pause
task:resume
task:cancel
task:event

execution:list
execution:get
execution:event
```

也可以将两个事件通道合并为 `task-center:event`，但 payload 必须是严格判别联合；不能暴露通用事件名订阅。

### 6.2 Preload API

建议在 `DesktopApi` 中使用明确方法，而不是任意 channel：

```typescript
taskList(query): Promise<CursorPage<TaskSummary>>
taskGet(taskId): Promise<TaskDetail>
taskPause(input): Promise<TaskSummary>
taskResume(input): Promise<TaskSummary>
taskCancel(input): Promise<TaskSummary>
onTaskEvent(handler): () => void

executionList(query): Promise<CursorPage<ToolExecutionRecord>>
executionGet(executionId): Promise<ToolExecutionRecord>
onExecutionEvent(handler): () => void
```

每个 invoke 和 push 都需要：

- 输入 Zod schema；
- 输出 Zod schema；
- sender origin 校验；
- 错误信封归一；
- 事件订阅卸载；
- 测试 mock 完整镜像，不能使用可选链隐藏漏实现。

### 6.3 控制命令

Renderer 每次点击控制按钮生成 `commandId = crypto.randomUUID()`；在请求完成前：

- 只设置本地 `pendingCommand`；
- 不乐观修改 Task 权威状态；
- 可即时禁用相同按钮防重复点击；
- 响应或 WS 事件到达后按 revision 合并；
- 超时后允许同 commandId 重试，不能换新 ID 导致后端重复执行。

---

## 7. Main TaskClientService

### 7.1 为什么需要 Main service

若 Renderer 直接分别消费 REST、WS 和 ToolService 事件，会重复实现：

- revision 去重；
- reconnect snapshot；
- Desktop 本地状态覆盖；
- 事件缓冲与首屏水合竞态；
- 错误归一化；
- 审批关联。

建议在 Main 增加轻量 `TaskClientService`，不做任务调度，只做客户端同步协调。

### 7.2 职责

- 保存最近一次连接 epoch；
- REST 首屏水合；
- WS 事件按 revision 去重；
- 断线期间标记数据 stale，但不把 Task 擅自改成 failed；
- 重连后先拉 REST，再开放增量事件；
- 缓冲水合期间到达的新事件，水合后重放；
- 将 ToolService 的 Desktop 本地事件关联到 execution；
- 对同 execution，Main 本地 Desktop 非终态优先于后端滞后状态；
- 终态以后以后端持久结果与 Main 终态对账；
- 向 Renderer 只发送公共事件。

### 7.3 本地 overlay 规则

| 情况 | 显示来源 |
|---|---|
| 纯 Backend execution | Backend |
| Desktop requested/awaiting_permission/running，Main 已有记录 | Main 状态优先 |
| Backend 回 completed，但 Main 仍 awaiting/running | Main 暂时优先并记录不一致；查询桥状态对账 |
| Main 终态、Backend 尚未确认 | Main 终态展示“同步中”；继续重传 |
| 双方终态一致 | Backend 持久记录为历史权威，Main 可释放 overlay |
| 双方终态冲突 | 不静默覆盖；显示安全错误并记录诊断计数 |

### 7.4 是否持久化 Main Task 缓存

第一版可以不新增长期 Task 缓存，以 Backend REST 为权威；但应满足：

- 断线时保留本次进程已经加载的只读数据；
- 明确展示“离线，状态可能已变化”；
- 不允许离线发暂停/继续/取消；
- 应用重启且 Backend 不可用时可先显示诚实空态，而不是伪造任务已清空。

如果后续需要离线历史浏览，再新增经过脱敏、有限容量、可损坏隔离的 Main cache，并单独设计保留策略。

---

## 8. Renderer Store 设计

### 8.1 taskStore

建议新增 `renderer/src/stores/task.store.ts`，拥有：

```text
summariesById
orderedTaskIds
detailsById
selectedTaskId
query
nextCursor / hasMore
loading / loadingMore
detailLoading
pendingCommandsByTaskId
stale
lastError
```

方法：

```text
init / refresh / loadMore
selectTask / loadDetail
applyTaskEvent / applyStepEvent
pause / resume / cancel
clearError / markStale
```

不拥有：

- Desktop 权限决定；
- 原始工具参数；
- Workflow checkpoint；
- 聊天 Message；
- 安全 Grant。

### 8.2 executionHistoryStore

建议新增 `renderer/src/stores/execution-history.store.ts`，专门处理任务中心的分页执行历史：

```text
recordsById
orderedExecutionIds
query
nextCursor / hasMore
selectedExecutionId
loading / stale / lastError
```

它与现有 `toolStore` 的关系：

- `toolStore`：聊天实时区和 Desktop 审批交互；
- `executionHistoryStore`：任务中心跨会话分页历史；
- 两者复用 `ToolExecutionRecord` 映射，但不共享 `liveOrder`；
- 新 execution 事件可以同时喂给两者；
- 审批侧信道仍只在 `toolStore`，不得复制到历史 Store。

未来若稳定后确有价值，再考虑将两者收敛成更通用的 execution domain store；第一批不为重命名制造额外风险。

### 8.3 状态合并规则

- 相同 ID 的较小/相同 revision 事件忽略；
- REST snapshot 可以补齐本地缺失实体；
- REST snapshot 中较小 revision 不覆盖已收到的新事件；
- 终态不回退；
- TaskStep 事件更新详情，同时刷新对应 TaskSummary 的 progress/revision；
- 当前列表筛选不匹配的新记录不插入当前顺序，但仍可缓存详情；
- changed filter 触发新 query key，清页码，不必清所有 normalized cache；
- 删除/过期由后端返回显式 tombstone 或下一次全量 refresh 处理，不能从一次分页缺席推断删除。

### 8.4 未读与通知状态

未读是前端 UI 状态，不是 Task 生命周期。建议单独保存：

```text
lastViewedRevisionByTaskId
taskCenterLastOpenedAt
```

初版可只在内存中维护；如需跨重启红点，再放入有限的 Renderer UI 偏好存储，不写入 Task DTO。

---

## 9. 页面与组件设计

### 9.1 根视图

新增：

```text
renderer/src/views/CyTaskCenterView.vue
```

替换 `App.vue` 的 `.cy-tasks-placeholder`。任务中心不是 overlay，应作为主工作区视图存在，NavRail 和 TitleBar 常驻。

### 9.2 网格布局修正

当前 `gridTemplateFor()`始终按聊天偏好生成 conversation/live2d 列，而 tasks 分支只渲染 `grid-area: chat`。目标形态需要非聊天工作区铺满 NavRail 右侧：

```text
chat view:     nav | conversation | chat | live2d
tasks view:    nav | workspace
settings view: existing full-window settings behavior
```

建议让布局纯函数接收 view，或增加独立 `gridTemplateForWorkspace()`；禁止通过绝对定位把任务中心盖在空白聊天列之上。

### 9.3 顶层结构

```text
CyTaskCenterView
├─ CyTaskCenterHeader
│  ├─ 标题
│  ├─ 连接/刷新状态
│  └─ 任务 / 执行记录 tabs
├─ Tasks tab
│  ├─ CyTaskFilters
│  ├─ CyTaskList
│  └─ CyTaskDetail
└─ Executions tab
   ├─ CyExecutionFilters
   ├─ CyExecutionList
   └─ CyExecutionDetail
```

### 9.4 宽屏与窄屏

建议：

- 宽屏：列表 320～380px + 详情自适应；
- 中等宽度：列表 300px + 详情；
- 窄宽度：列表/详情钻取式切换，详情提供返回按钮；
- 任务中心不显示聊天会话栏和 Live2D 栏；
- 不复用聊天区 `CHAT_MIN_WIDTH` 强迫任务列表出现水平滚动。

宽度常量应进入 layout constants 或 task-center layout 模块，不散落多个组件硬编码。

### 9.5 Tasks 页签

筛选：

- 全部；
- 进行中；
- 等待处理；
- 已完成；
- 来源会话；
- 日期/关键词后置到 Backend 支持后开放。

列表项字段：

- 标题；
- 状态 badge；
- 当前步骤/进度；
- Runtime 等待提示；
- 来源会话简名；
- 更新时间；
- 未读点。

### 9.6 Task 详情

信息顺序：

1. 标题、状态和控制；
2. 来源会话与创建时间；
3. 当前进度/等待说明；
4. 步骤时间线；
5. 结果或错误；
6. artifact；
7. 高级 DAG/诊断入口（可后置）。

控制按钮必须根据后端 `controls` 渲染：

- `canPause` → 暂停；
- `canResume` → 继续；
- `canCancel` → 取消；
- `canRetry` 第一版通常 false，不先渲染空功能。

取消应有确认，但确认文案必须说明“已开始的本地操作不保证回滚”。

### 9.7 步骤时间线

每个步骤显示：

- ordinal/标题；
- 状态；
- Runtime badge；
- 尝试次数；
- 开始/结束时间；
- 输出或错误摘要；
- 关联 execution 展开列表。

等待状态需要直接说明下一步：

- `waiting_for_runtime`：“等待绑定的 Desktop 客户端连接”；
- `waiting_for_permission`：“需要你在本机确认操作”；
- 点击等待权限步骤时，若 Main 仍持有相应审批，打开/聚焦现有 `CyToolApproval`；
- 如果审批已经过期，显示过期，不伪造可审批按钮。

### 9.8 执行记录页签

筛选至少包括：

- Runtime：Backend/Desktop；Local Worker 仅在能力或记录真实存在时出现；
- 状态；
- 是否属于 Task；
- 来源会话；
- 时间范围（Backend API 支持后开放）。

列表中明确区分：

- “对话直接调用”；
- “任务步骤调用”；
- 点击任务关联跳到 Task 详情；
- 点击来源会话跳回聊天。

### 9.9 空态与错误态

| 场景 | 文案/动作 |
|---|---|
| 从未创建任务 | 解释“复杂后台工作会显示在这里”，不显示“阶段 N” |
| 有执行记录但无 Task | Tasks 空态；Executions 正常展示 |
| Backend 离线 | 保留已加载数据并标“离线，状态可能已变化”；提供重连/返回设置 |
| 首次加载失败 | 错误卡 + 重试；不把错误当空列表 |
| Task 已因保留策略过期 | 详情返回 not found，列表移除并提示 |
| 来源会话已删除 | 显示“来源会话不可用”，保留任务本身 |
| Desktop 未连接 | 等待 Runtime 提示 + 连接说明；不能显示审批按钮 |

---

## 10. 与聊天的关系

### 10.1 submit_task 卡片

当前 `submit_task` 的 ToolCallRecord 只表示提交调用。目标展示：

- 提交中：普通工具卡 running；
- 提交成功：卡片 completed，显示“后台任务已创建”；
- 卡片包含 `taskId` 链接；
- 点击进入 Task 详情；
- 后续 Task 完成不把提交卡片状态再次从 completed 改写；
- 可以在卡片旁显示独立 Task 状态摘要，但数据源是 taskStore。

### 10.2 Task 完成消息

保留后端完成后唤醒 Agent 生成自然语言结果的体验，但必须：

- 写入 Task 的 `sourceConversationId`；
- 带 taskId 关联；
- 用户正在其他会话时不强制切换；
- 可增加任务中心红点或系统通知（待产品拍板）；
- 聊天消息负责呈现结果，Task 详情负责事实与步骤。

### 10.3 来源跳转

从 Task/Execution 跳回聊天：

1. 检查 `sourceConversationId/sourceMessageId`；
2. 激活对应会话；
3. 使用既有 message context REST 加载窗口；
4. 设置 messageStore highlight；
5. 若消息不存在，降级打开会话顶部/最新位置并提示。

不要在 Task Store 中复制完整 Message。

---

## 11. 事件、重连与竞态

### 11.1 启动顺序

建议：

```text
Main connection established
  → TaskClientService starts buffering WS task events
  → REST hydrate active/recent tasks and executions
  → merge buffered events by revision
  → push hydrated snapshot to Renderer
  → switch to live event mode
```

这避免“先订阅后被旧快照覆盖”和“先拉快照漏掉期间事件”两类竞态。

### 11.2 重连顺序

```text
WS disconnected
  → mark task data stale
  → keep current UI
  → disable server commands
WS reconnected
  → fetch REST snapshot
  → reconcile revision
  → replay buffered new events
  → clear stale
```

### 11.3 事件断档

若收到 sequence 跳号：

- 记录脱敏诊断计数；
- 不直接清空列表；
- 将 store 标记 stale；
- 触发节流后的 REST refresh；
- refresh 前仍可展示已有数据，但控制命令按连接状态决定。

### 11.4 终态守卫

Task、TaskStep 和 ToolExecution 都执行终态单向：

- 较旧 running 不覆盖 completed；
- cancel 响应和 completed 竞态时，以后端更高 revision 为准；
- Desktop 本地终态与 Backend 终态冲突进入显式对账错误，不静默“选一个看起来更好”的状态；
- 重试产生新 execution，不复活旧 execution。

---

## 12. Desktop 权限与本地执行关联

### 12.1 显式来源字段

目标 `tool.request` 必须由 Backend 显式携带：

```text
executionId
sourceCallId
taskId?
stepId?
conversationId?
clientInstanceId?
```

`real-backend.ts` 当前使用 `this.state.activeConversationId` 填充 DesktopToolRequest 的做法，只能作为旧协议兼容回退；新任务事件路径不得继续依赖它。

### 12.2 Main ToolRecord 扩展

Main 内部 `DesktopToolRequest/ToolRecord/PublicToolEvent` 目标增加可选关联字段：

```text
executionId
taskId
stepId
conversationId（由 wire 明确给出）
clientInstanceId
```

这些字段是关联信息，不授予任何额外权限。Main 仍按本地注册表和策略重新裁决。

### 12.3 审批复用

不新增 Task 专用审批状态机：

- ToolService 仍管理 awaiting queue、timeout、Grant 和决策；
- toolStore 仍持有当前审批侧信道；
- taskStore 只显示后端聚合的 waiting_for_permission；
- Task 详情通过 executionId/sourceCallId 查找当前本地审批；
- 后端 Task 控制不能绕过 Main 批准本地操作。

---

## 13. 安全设计

### 13.1 Renderer 禁止字段

Task/Execution schema 必须拒绝或在 Main 丢弃：

- raw arguments；
- `paramHash`；
- Desktop 绝对 realpath；
- Authorization/API key/Cookie；
- Workflow summarized_context 原文；
- 内部 checkpoint；
- Python stack；
- artifact 磁盘路径；
- 后端完整工具审计记录。

### 13.2 日志

- Task 标题/intent 默认不进入普通日志；
- 日志只记 taskId/executionId/status/errorCode/字段名；
- 不打印 outputSummary、文件内容或审批原因原文；
- 协议校验错误记录事件类型和错误码，不打印 raw payload；
- 诊断导出是否包含任务公共摘要需单独列清单并接受敏感检查。

### 13.3 外部链接与 artifact

- artifact URL 仍通过 Main 受信协议/签名 URL；
- Renderer Markdown 不直接信任任务结果中的链接；
- 本地文件结果只提供安全摘要或 Main 受控操作；
- “打开文件位置”等能力如果未来增加，必须新增具名 IPC 和路径 containment，不能复用普通 URL。

---

## 14. 性能与容量

### 14.1 列表

- REST page 默认建议 50，上限 100；
- normalized map + ordered IDs；
- 不一次加载全部历史；
- 列表项只用 TaskSummary，不携带 steps/artifacts；
- 详情按需加载并可做有限 LRU；
- 长列表达到现有虚拟列表阈值后再复用通用 virtual-window，不复制另一套估高补偿算法。

### 14.2 实时事件

- 同 Task 的高频 progress 事件在 Main 或 Renderer 按 animation frame/短窗口合并；
- waiting/terminal/permission 等语义事件不得被纯进度节流丢失；
- 不因每个节点 token 变化重渲染整个任务列表；
- 列表订阅 summary，详情订阅 selected task 的 steps。

### 14.3 内存

- 任务分页 Store 只保留有限页或 LRU；
- 完整 output/artifact 不进入全局 Store；
- 离开任务详情可以释放大详情对象；
- Execution 历史和现有 chat tool liveOrder 不相互复制无限增长。

---

## 15. 无障碍与交互

- tabs 使用正确 tablist/tab/tabpanel 语义；
- 状态不能只靠颜色；
- 进度使用 `role=progressbar` 和 aria-valuenow；
- 列表选择与详情标题建立可感知关系；
- 窄屏详情返回按钮可键盘操作；
- 控制命令请求期间提供 `aria-busy`；
- 取消确认弹窗遵守焦点陷阱、Esc 和回焦；
- waiting permission 提示必须能通过键盘打开已有审批窗；
- 自动到达的任务事件用非打断式 live region，不能每次 progress 都朗读；
- 时间、Runtime 和错误码均有可读文案。

---

## 16. 建议文件布局

```text
apps/desktop/src/shared/
├─ contracts/task.ts
├─ contracts/tool.ts                  # 扩展 execution 目标类型
├─ schemas/task.ts
└─ schemas/events.ts                  # task/execution events

apps/desktop/src/main/
├─ tasks/task-client-service.ts
├─ tasks/task-mapper.ts
├─ tasks/task-handlers.ts
└─ transport/backend-adapter.ts       # 增正式方法

apps/desktop/src/preload/
├─ desktop-api.ts
└─ index.d.ts

apps/desktop/src/renderer/src/
├─ views/CyTaskCenterView.vue
├─ components/tasks/
│  ├─ CyTaskCenterHeader.vue
│  ├─ CyTaskFilters.vue
│  ├─ CyTaskList.vue
│  ├─ CyTaskListItem.vue
│  ├─ CyTaskDetail.vue
│  ├─ CyTaskTimeline.vue
│  ├─ CyTaskStepItem.vue
│  ├─ CyExecutionFilters.vue
│  ├─ CyExecutionList.vue
│  └─ CyExecutionDetail.vue
└─ stores/
   ├─ task.store.ts
   └─ execution-history.store.ts
```

命名可在 plan 阶段按现有目录惯例微调，但进程边界和职责不得被压回一个组件文件。

---

## 17. 实施顺序

### 前端 A：契约与只读骨架

- shared Task/Execution types + schemas；
- mock adapter 查询；
- Main/Preload 具名查询；
- tasks 工作区布局；
- 双页签、空态、列表和详情只读 UI；
- 不接控制、不接真实 Backend。

### 前端 B：真实 REST 与来源跳转

- RealBackend list/get；
- pagination；
- source conversation jump；
- Backend 离线/错误态；
- 合同 fixture 与 mapper 测试。

### 前端 C：WS 与控制

- task/execution events；
- TaskClientService hydration/reconnect/revision；
- pause/resume/cancel；
- pending command UX；
- completion badge/notification 基础。

### 前端 D：Desktop Workflow

- request 关联字段；
- Main local overlay；
- Task waiting permission 与现有审批聚焦；
- waiting runtime；
- disconnect/reconnect/outbox 对账；
- 真实 Electron 联调。

---

## 18. 测试与验收要求

### 18.1 单元测试

- Task/Step/Execution schema 全状态；
- unknown field、非法 enum、负 revision、坏日期拒绝；
- Workflow status → frontend status mapper；
- revision 去重、终态守卫、REST/WS 竞态；
- query key/pagination；
- commandId 同 ID 重试；
- Desktop overlay 优先与冲突；
- app view/layout 在 tasks 时铺满工作区；
- filter、空态、错误态和 controls。

### 18.2 Main/Preload 集成

- Renderer 只能调用具名任务 IPC；
- 入参/出参运行时校验；
- raw Task payload 不到 Renderer；
- WS 事件在水合期间正确缓冲；
- 重连触发 REST 对账；
- source conversation 不由当前活动会话猜测；
- task cancel 不绕过 Desktop ToolService 权限。

### 18.3 Electron 集成

- 任务入口可达，页面无占位文案；
- 任务列表/详情可键盘操作；
- 跨会话任务来源跳转；
- 控制命令状态；
- Desktop 审批从任务详情可达；
- 断线保留数据并显示 stale；
- 重连恢复状态；
- 长列表没有明显滚动回归。

### 18.4 真实联调

- 纯 Backend Workflow；
- Workflow Desktop read/write/capture；
- 等待权限；
- Desktop 断线重连；
- 创建任务后切会话；
- 完成结果回原会话；
- 重复事件/重传不重复副作用；
- Backend 重启按当批承诺得到明确状态。

---

## 19. 前端待决策项

| ID | 问题 | 推荐 |
|---|---|---|
| FE-P01 | 第一版是否显示“新建任务” | 不显示，先从聊天创建 |
| FE-P02 | Task 完成是否发系统通知 | 先做应用内红点/Toast；系统通知另行授权 |
| FE-P03 | 默认打开哪个页签 | 有活跃 Task 时“任务”，否则仍默认“任务” |
| FE-P04 | Task 默认详情是时间线还是 DAG | 时间线；DAG 高级折叠 |
| FE-P05 | 是否跨重启缓存 Task 历史 | 第一版不缓存，Backend 权威；离线历史另立批次 |
| FE-P06 | Local Worker 筛选是否常驻 | 只有能力或记录存在时显示 |
| FE-P07 | 删除/清理入口 | 第一版不做，等保留与审计策略拍板 |
| FE-P08 | 任务中心是否显示 token 消耗 | 默认不显示；可作为高级详情或诊断信息 |
| FE-P09 | waiting_for_runtime 的连接操作 | 链接到现有连接设置，不在任务页复制 Token/Endpoint 表单 |

这些选择不阻塞契约基础层，但会影响最终 UI plan 和验收脚本，应在 UI 实施批次前完成决策记录。

---

## 20. 完成定义

前端任务中心不能以“页面已经画出来”作为完成。至少同时满足：

- 正式 REST/WS 契约通过 Main 和 Preload；
- 任务列表、详情、步骤和执行历史来自真实持久数据；
- 控制命令与后端状态一致；
- Desktop 权限仍由 Main 权威裁决；
- 重连可对账、终态不回退；
- 来源会话和 submit_task 链接正确；
- 占位文案和内部阶段标签全部移除；
- 安全、契约、单元、集成与真实联调记录齐全；
- 受影响的 doc 01/02/03/04/06/08/10/12/16 已按文档职责同步。
