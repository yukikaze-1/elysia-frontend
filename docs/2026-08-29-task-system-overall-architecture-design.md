# Cyrene 任务系统与任务中心总体架构设计

> **文档状态：** 架构讨论稿（用于继续拍板与拆分实施计划，不代表代码已经落地）  
> **日期：** 2026-08-29  
> **前端事实基线：** `elysia-frontend@7712d3e`  
> **后端事实基线：** `192.168.1.18:~/elysia-agent@9548d100`  
> **权威范围：** 任务系统的产品语义、跨端边界、目标架构、公共领域模型和前后端协作契约  
> **不负责：** 当前项目阶段与完成状态；该信息仍以 `docs/16-Cyrene-前端实施任务清单与进度跟踪.md` 为准  
> **镜像规则：** 本文同时存放于 `elysia-frontend` 与 `elysia-agent`；架构结论变更时必须在同一次跨仓文档变更中同步两份

配套文档：

- 前端架构设计：`elysia-frontend/docs/2026-08-29-task-center-frontend-architecture-design.md`
- 后端架构设计：`elysia-agent/docs/2026-08-29-task-system-backend-architecture-design.md`

---

## 0. 结论

Cyrene 当前已经具备后台任务引擎、短工具调用调度器、Backend/Desktop 双 Runtime 工具链和前端工具卡，但这些能力仍是四套相邻机制，尚未形成一个可供产品使用的完整任务系统：

1. `WorkflowEngine` 能执行异步多步骤任务，却只有 Python 内部接口和 Debug HTTP/SSE 接口；
2. 普通工具调用有成熟的实时状态与聊天归档，却没有独立、可分页的执行历史；
3. Desktop 工具有权限、幂等、审计和结果回传，但 Workflow 节点当前不能可靠携带同一套调用上下文；
4. 前端“任务”页仍是空占位，没有任务查询、详情、控制和断线恢复；
5. 任务终态、工作流 checkpoint 和 artifact 会被清理，无法支撑长期历史与重启恢复。

目标架构采用三个相互关联但不合并的领域实体：

```text
Task（有独立生命周期的目标）
 └─ TaskStep（目标中的计划步骤）
     └─ ToolExecution（某一步的一次真实工具执行）

普通聊天工具调用
 └─ ToolExecution（没有 taskId / stepId）
```

关键设计结论：

- 不把普通工具调用包装成单节点 Workflow；
- 不把 `ToolExecution` 的所有权塞进 `WorkflowEngine`；
- 引入共享 `ToolExecutionCoordinator`，让普通调用、Workflow 步骤和未来定时任务通过同一执行管线；
- 引入 `TaskService`，作为 WorkflowEngine 之上的产品任务门面和唯一对外任务接口；
- 前端任务中心分为“任务”和“执行记录”两个页签；
- Backend 是任务编排和公共历史的权威来源，Electron Main 仍是 Desktop 权限、本地执行和本地敏感审计的权威来源；
- 正式产品接口采用 REST 快照/分页 + 现有 v2 WebSocket 增量事件，不复用 Debug SSE 作为产品协议。

---

## 1. 文档目的与使用方式

### 1.1 目的

本文把以下三类信息放在同一张架构图中：

- **当前事实：** 当前前后端到底已经有什么、实际怎样运行；
- **目标设计：** 完整任务系统应当如何分层、谁拥有哪类状态；
- **待决策项：** 仍需产品或架构拍板的保留期限、Local Worker、定时任务、设备绑定等问题。

后续实施计划不得直接把本文中的“目标设计”写成“已实现”。每个批次完成后，应通过代码、契约测试和真实联调记录把对应条目从目标变成事实，并同步维护中的核心文档。

### 1.2 三种标记

| 标记 | 含义 |
|---|---|
| **已确认** | 本轮讨论已经明确接受，可作为后续设计约束 |
| **建议基线** | 本文给出的推荐方案，可先用于估算和拆批，但实现前仍可调整 |
| **待决策** | 选择会改变数据、接口或产品体验，不能由实现者自行猜测 |

### 1.3 与历史文档的关系

本设计不静默改写历史 spec、plan 或验收记录。它对以下旧口径构成后续设计上的取代或补充：

- 产品需求中“任务中心和后台任务进度”为 P1，但“任务与工具记录”入口已经存在；本轮明确推进完整任务中心；
- `docs/2026-08-29-UI真机走查问题记录.md` 问题 12 中“后端没有任务系统 API、建议删除入口”的结论只反映当时未核对完整后端的判断；真实情况是后端有 WorkflowEngine 和 Debug API，但缺少正式产品 API；
- 阶段 6 的 `ToolCallRecord` 仍是可复用基础，但它不是完整任务模型；
- WorkflowEngine 自带文档中的“checkpoint 持久化”目前指接口与内存快照能力，进程重启后仍会丢失，不能当作产品级持久化。

---

## 2. 已确认基线与待决策清单

### 2.1 已确认的架构基线

| ID | 结论 | 影响 |
|---|---|---|
| TSA-01 | 保留并完善完整任务中心 | 不删除导航入口，任务页从占位升级为正式功能 |
| TSA-02 | “任务”与“工具执行”是不同实体 | 页面、状态机、API 和持久化不能混成一张无类型活动表 |
| TSA-03 | 简单工具直调，复杂/异步/多步骤目标走 WorkflowEngine | 保留低延迟聊天体验，不强迫所有调用规划成 DAG |
| TSA-04 | `ToolExecution` 不合并进 WorkflowEngine | WorkflowEngine 只关联执行记录，不拥有全部执行历史 |
| TSA-05 | 普通调用与 Workflow 节点统一经过共享执行协调层 | 统一上下文、ID、事件、脱敏、持久化和 Runtime 路由 |
| TSA-06 | WorkflowEngine 不直接向 Desktop 暴露内部模型 | 新增 TaskService 和稳定公共任务模型，屏蔽内部 DAG 变化 |
| TSA-07 | 产品任务接口不能复用 `/debug/api/tasks*` | Debug API 保留诊断用途；正式接口独立建模并受契约门禁保护 |

### 2.2 建议作为第一版基线

| ID | 建议 | 原因 |
|---|---|---|
| TSA-R01 | Backend 是 Task 与公共 ToolExecution 摘要的权威来源 | 后台任务可在 Electron 关闭时继续；避免前后端双调度器分叉 |
| TSA-R02 | Electron Main 是 Desktop 权限、本地操作和本地敏感审计的权威来源 | 维持现有信任边界，Renderer 与后端不能越权裁决本地授权 |
| TSA-R03 | 第一版从聊天创建任务，任务中心只负责查看和控制 | 先闭合已有 `submit_task` 链路，避免同时引入表单式任务创建协议 |
| TSA-R04 | 任务详情默认展示线性时间线，DAG 作为高级视图 | 普通用户先看“正在做什么”，不直接暴露内部编排结构 |
| TSA-R05 | Local Worker 只保留协议扩展点，本轮不实现进程 | 当前没有 Worker 实现，不能让空 Runtime 阻塞任务中心落地 |
| TSA-R06 | Backend-only 步骤在 Electron 离线时继续；Desktop 步骤进入 `waiting_for_runtime` | 符合 Runtime 所有权，也避免把可恢复掉线误判为任务失败 |
| TSA-R07 | 完成任务仍通过对话生成一条结果消息，同时更新任务中心 | 对话负责自然语言呈现，任务中心负责生命周期事实，两者互相链接 |

### 2.3 必须继续拍板的问题

| ID | 问题 | 推荐起点 | 不拍板的后果 |
|---|---|---|---|
| TSA-P01 | 是否在任务中心提供“新建任务” | 第一版不提供 | 影响 `POST /api/tasks`、表单模型和入口信息架构 |
| TSA-P02 | `set_reminder` 是否本轮并入定时任务 | 并入后续小批次，不与第一批强绑 | 继续使用内存 `ensure_future` 会在重启后丢提醒 |
| TSA-P03 | Local Worker 何时实现 | 任务中心第一版后另立项目 | 影响能力发现、安装、凭据、更新和离线模型 |
| TSA-P04 | 任务与执行记录保留期限 | 活跃任务不清；终态摘要先建议 90 天，执行详情建议 30 天 | 无法确定 Mongo TTL 和用户删除能力 |
| TSA-P05 | 删除会话是否级联删除任务 | 建议不级联，只令来源链接失效；另提供显式删除 | 涉及隐私、审计和历史可追溯性 |
| TSA-P06 | Desktop 等待重连多久 | 建议 24 小时后失败或进入“需要处理” | 影响队列占用、状态机和提醒策略 |
| TSA-P07 | 第一版控制范围 | 取消、暂停、继续；整体重试后置 | 影响 REST 命令、幂等键和 UI 按钮 |
| TSA-P08 | 多 Desktop 客户端/多设备是否进入第一版 | 不进入；任务绑定创建时客户端实例 | 当前桥只有一个活动连接，直接支持多端风险较高 |
| TSA-P09 | 任务结果、参数和 artifact 可见范围 | 只存脱敏摘要与受控 artifact 元数据 | 影响隐私、磁盘占用和后端数据库结构 |
| TSA-P10 | 用户能否删除单条执行记录 | 第一版不提供；随任务/保留策略管理 | 影响审计完整性与删除一致性 |

---

## 3. 统一术语

### 3.1 Task

一个具有独立生命周期、可在当前聊天轮结束后继续运行的用户目标。典型特征：

- 可能包含多个步骤；
- 可能需要等待 Runtime、权限或外部资源；
- 可以暂停、继续或取消；
- 有独立进度、结果和历史；
- 任务完成不等于提交它的 `submit_task` 工具调用完成。

### 3.2 TaskStep

Task 的公开步骤视图。它不等于 WorkflowEngine 的所有内部对象，只表达用户可理解的计划单元及其状态。内部 Replan 可以更新步骤，但必须通过稳定 `stepId`、`revision` 和替换关系向外公开。

### 3.3 ToolExecution

某个已注册工具的一次实际执行尝试。它可能来自：

- 普通聊天 ReAct 工具调用；
- WorkflowEngine 某个 TaskStep；
- 未来的 Scheduled Task；
- 未来显式创建的任务。

一次重试应产生新的 `executionId`，并增加 `attempt`，不能覆盖前一次失败记录。

### 3.4 Runtime

工具实际执行的位置：

- `backend`：远程 Elysia Agent 进程；
- `desktop`：Electron Main 中的受控工具服务；
- `local_worker`：未来独立的本机 Worker 进程，目前没有实现。

Runtime 不是任务类型。一个 Task 可以依次调用多个 Runtime。

### 3.5 短调用调度器

当前 `core/task.TaskScheduler` 的产品真实职责：将一个聊天轮里的工具调用封装成短生命周期 worker 任务并发执行、取消和回收。它不应被任务中心当作 Task 数据源。后续可考虑重命名为 `ToolCallScheduler` 或迁入统一执行协调层。

### 3.6 WorkflowEngine

复杂后台任务的 Plan-Execute-Evaluate-Replan 内部引擎。它是 Task 的一种执行实现，不是前端任务契约本身。

---

## 4. 当前系统事实

### 4.1 普通工具调用链

生产主链为：

```text
用户消息
  → CognitiveLoop / ReAct
  → LLM tool_call
  → core/task.TaskScheduler.dispatch_tool_calls()
  → ToolAdapter.execute()
  → ToolManager
  → Backend 插件或 Desktop 插件
  → ToolResult
  → tool.started / tool.completed
  → 聊天消息归档
```

已有能力：

- 一个聊天轮内并发执行多个工具；
- call ID、取消、超时和有限重试；
- Backend 工具公开 `tool.started/tool.completed`；
- Desktop 工具经 `tool.request/tool.status` 完成权限、执行和回传；
- 前端以 `sourceCallId` 归一化成 `ToolCallRecord`；
- 聊天归档可从 assistant `tool_calls` 与 role=tool 消息重建工具卡。

当前限制：

- `TaskScheduler` 的 `TaskType.BACKGROUND` 和 `dispatch_background()`没有生产调用方；
- 短调用 Task 是内部 worker 数据，完成后会清理，不是产品历史；
- 工具生命周期事件由 CognitiveLoop 外层发射，Workflow 内部调用不会自动经过同一发射点；
- `ToolCallRecord` 缺少 `taskId`、`stepId`、`executionId`、`attempt` 等任务关联字段。

### 4.2 Workflow 后台任务链

```text
LLM 调用 submit_task
  → DelegationPreparer.prepare()
  → WorkflowEngine.submit()
  → 创建 WorkflowId + WorkflowMailbox
  → Planner
  → PlanValidator
  → Orchestrator / DAG
  → Executor
  → ToolAdapter.execute()
  → Evaluator / Replan
  → WorkflowMailbox
  → Agent 每 500ms 轮询
  → TaskResultData
  → 再唤醒 CognitiveLoop 生成自然语言结果
```

已有能力：

- 非阻塞有界队列；
- 规划、静态校验、DAG 执行、评估和重规划；
- 12 态内部 Workflow 状态机；
- pause、resume、cancel、submit_approval；
- 任务进度、DAG、摘要和 token 查询的 Python 方法；
- WorkflowMailbox 回传；
- Debug 快照和 SSE；
- 每个任务的内存 checkpoint、artifact 和 token ledger。

当前限制：

- 终态后立即从 `_tasks/_mailboxes/_contexts` 清除；
- checkpoint 和 artifact 为内存实现，终态还会主动删除；
- 查询方法只看活跃任务；
- 后端重启后任务、checkpoint 和 mailbox 都丢失；
- Workflow 与来源消息、提交工具调用的关联信息不完整；
- Mailbox 的 `WorkflowEvent.data` 仍是弱类型 dict；
- Agent 注册后台任务只保存 intent、dispatch time 和 mailbox，没有会话/消息/客户端绑定；
- 完成唤醒没有可靠绑定回原始 conversation，存在结果落入当前会话的风险；
- Workflow Executor 新建的 `ToolContext` 缺少共享 services 和稳定 call ID。

### 4.3 WorkflowEngine 当前接口

#### Python 内部接口

当前已有：

```text
submit
pause
resume
cancel
submit_approval
get_task_status
get_task_mailbox
get_task_summary
list_active_tasks
get_progress
get_task_dag
get_token_usage
```

这些接口可以作为 `WorkflowTaskAdapter` 的基础，但不能直接成为前端契约。

#### HTTP 调试接口

当前只有：

```text
GET /debug/api/tasks
GET /debug/api/tasks/stream
```

其特点：

- 500ms 轮询私有 `_get_debug_snapshot()`；
- 只包含当前内存任务；
- 终态任务清理后消失；
- 没有分页、历史、来源、稳定 revision；
- 没有产品控制命令；
- 暴露内部节点和边；
- 由 Debug 页面消费。

因此它们不能升级为正式产品接口，只应继续保留为工程诊断面。

### 4.4 Desktop Runtime 链

当前 Backend 通过 `DesktopToolBridge` 定向投递 `tool.request`，Electron Main 的 `ToolService` 完成本地注册表校验、参数校验、路径黑名单、权限、执行、审计和 `tool.status` 回传。

已有能力：

- Desktop 四个工具：文件选择、文本读取、文本写入、屏幕截图；
- 服务端 `desktop_calls` Mongo 记录，30 天 TTL；
- 后端进程内 future、幂等去重、篡改拒绝和终态守卫；
- Electron Main 200 条内存记录、应用内实时水合；
- 本机审计 JSONL、设置页最近 7 天审批历史；
- 断线后未接手调用及时失败，已接手调用等待晚到结果/重传；
- 结果附件上传与目标连接校验。

当前限制：

- Backend Bridge 只有一个 `_connection_id`，实质是单活动 Electron 目标；
- `tool.request` 没有显式携带 task/step/conversation 的完整来源；
- Electron 当前用“收到请求时的活动会话”推断 `conversationId`，后台任务跨会话运行时可能归属错误；
- Workflow Executor 的临时 `ToolContext` 没有 `desktop_bridge` service，实际无法可靠执行 Desktop 步骤；
- Workflow 生成的空 call ID 会破坏 Desktop 幂等和调用关联；
- Desktop 的权限等待还没有映射成产品 Task 的 `waiting_for_permission`。

### 4.5 前端任务与工具状态

已有：

- 导航栏“任务”入口；
- `App.vue` 中任务视图分支；
- `ToolCallRecord`、`ToolRuntime` 和八态工具状态；
- Renderer `toolStore`：实时三来路归一、终态单向、会话隔离、权限侧信道；
- Main `ToolService`：Desktop 调用状态与最近记录；
- `Message.toolCalls`：聊天历史工具卡权威数据；
- 设置页本机权限与审批历史。

缺少：

- 任务列表、详情、步骤和控制；
- 正式任务 REST/WS adapter；
- 任务/执行历史分页；
- 跨会话任务归属与来源跳转；
- 断线重连后的 revision 合并；
- 任务完成通知和未读状态；
- 任务中心空态、错误态和离线态。

### 4.6 Reminder 与 Local Worker

- `set_reminder` 当前通过 `asyncio.ensure_future(asyncio.sleep())` 在进程内等待；重启丢失、不可查询、不可取消，也不属于 WorkflowEngine 或 TaskScheduler 的产品历史。
- `local_worker` 目前只有契约枚举和文档设想，没有 Worker 进程、安装、握手、能力发现、凭据或升级机制。

---

## 5. 核心问题归纳

| 类别 | 当前问题 | 设计回应 |
|---|---|---|
| 产品语义 | Task、短调度 Task、ToolCall、Workflow 混用“任务”一词 | 建立 Task / TaskStep / ToolExecution 三实体；短调度器内部化 |
| 对外接口 | Workflow 只有内部方法和 Debug API | TaskService 提供正式 REST/WS 契约 |
| 执行一致性 | 普通调用和 Workflow 调用构造不同 ToolContext | ToolExecutionCoordinator 统一执行入口 |
| 历史 | 终态 Workflow 被清理，执行记录分散 | TaskRepository、TaskStepRepository、ToolExecutionRepository |
| 跨 Runtime | Workflow 看得到 Desktop 工具但上下文不完整 | 注入执行网关；显式携带 client/task/step/conversation 来源 |
| 掉线 | Desktop 暂时不可用被当成普通工具失败 | 增加 `waiting_for_runtime` 和恢复信号 |
| 权限 | 工具等待授权没有提升为 Task 状态 | Task 聚合为 `waiting_for_permission`，审批仍由 Main 裁决 |
| 会话关联 | 后台结果可能跟随当前活动会话 | Task 创建时固定 sourceConversationId/sourceMessageId |
| 重启 | active Workflow 无持久恢复 | 持久任务摘要；安全 checkpoint 恢复或明确中断终态 |
| UI | 任务页为空，工具卡只在聊天内 | 双页签任务中心 + 任务详情 + 执行历史 |
| 隐私 | 原始参数、路径、artifact 可能被误用于展示 | 公共摘要与操作数据分仓；Renderer 只收脱敏数据 |

---

## 6. 目标分层架构

### 6.1 总体结构

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Electron Renderer                                                    │
│  Task Center UI ─ taskStore / execution view                         │
│  Chat UI ─ messageStore / existing tool cards                        │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ narrow typed preload API
┌───────────────────────────────▼──────────────────────────────────────┐
│ Electron Main                                                        │
│  TaskBackendAdapter ─ REST snapshot/history + WS task events         │
│  Desktop ToolService ─ local policy/approval/execution/audit         │
│  Local execution overlay/outbox                                      │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ HTTPS / WebSocket v2
┌───────────────────────────────▼──────────────────────────────────────┐
│ Backend application layer                                            │
│                                                                      │
│  TaskService ─ command/query/event facade ─ Task repositories        │
│       │                                                              │
│       ├─ WorkflowTaskAdapter ─ WorkflowEngine                        │
│       ├─ ScheduledTaskAdapter（未来）                                 │
│       └─ ToolExecutionCoordinator ─ ToolExecutionRepository          │
│                                      │                               │
│                                      ▼                               │
│                                  ToolAdapter                         │
│                          ┌───────────┼────────────┐                   │
│                          ▼           ▼            ▼                   │
│                       Backend     Desktop      Local Worker           │
└──────────────────────────────────────────────────────────────────────┘
```

### 6.2 为什么增加 TaskService

`TaskService` 是产品任务的门面，职责包括：

- 分配产品级 `taskId`；
- 保存来源会话、消息、提交 execution 和目标客户端；
- 建立 Task 与 WorkflowEngine 内部 workflow 的映射；
- 把内部 12 态映射为稳定公共状态；
- 接收 Workflow 事件并持久化 Task/TaskStep；
- 提供暂停、继续、取消等幂等命令；
- 查询活跃与历史任务；
- 在持久化成功后发布前端事件；
- 任务终态后继续保留摘要；
- 隔离 WorkflowEngine 的内部 DAG、mailbox 和替换风险。

### 6.3 为什么增加 ToolExecutionCoordinator

共享执行协调层负责所有真实工具执行的公共前后置逻辑：

```text
prepare identity/context
  → persist requested/running
  → emit public execution event
  → ToolAdapter.execute
  → normalize result/error
  → persist terminal result
  → emit terminal event
```

其职责至少包括：

- 分配或接收稳定 `executionId`；
- 构造完整、逐调用隔离的 `ToolContext`；
- 保留 `services`，避免 Workflow 路径丢 DesktopBridge、EventBus、session、config；
- 绑定 `taskId/stepId/attempt/conversationId/generationId/sourceCallId`；
- Runtime 判断和能力可用性检查；
- 统一 started/completed/failed/cancelled/timeout 事件；
- 公共摘要脱敏；
- 记录执行耗时和错误类别；
- 将“可等待的 Runtime 不可用”与“不可恢复工具失败”区分；
- 保证 Desktop `sourceCallId`/`desktopCallId` 幂等链完整。

### 6.4 WorkflowEngine 的新边界

WorkflowEngine 继续负责：

- Planner；
- PlanValidator；
- DAG/Orchestrator；
- Evaluator/Replan；
- 内部 checkpoint；
- 内部执行控制点。

WorkflowEngine 不负责：

- HTTP 路由；
- 前端 Task DTO；
- 公共任务历史；
- 所有 ToolExecution 的全局查询；
- Electron 权限；
- Renderer 展示字段；
- 保留期限和用户删除策略。

为了维持 `workflow_engine` 对 `core` 的零依赖，应在 `Module/workflow_contract` 中定义执行网关 Protocol 和跨边请求类型，由 `core` 中的 ToolExecutionCoordinator 实现并注入，而不是让 WorkflowEngine import `core.*`。

---

## 7. 领域模型

### 7.1 TaskSummary

任务列表使用稳定摘要，不携带内部 checkpoint 或完整 DAG：

```typescript
interface TaskSummary {
  taskId: string
  kind: 'workflow' | 'scheduled'
  title: string
  intentSummary: string
  status: TaskStatus
  progress?: { completed: number; total: number; percent?: number }
  currentStepSummary?: string
  requiredRuntime?: ToolRuntime
  sourceConversationId?: string
  sourceMessageId?: string
  submitExecutionId?: string
  createdAt: string
  startedAt?: string
  updatedAt: string
  finishedAt?: string
  resultSummary?: string
  error?: PublicTaskError
  revision: number
}
```

约束：

- `title` 与 `intentSummary` 是可展示摘要，不是原始 prompt 的无限复制；
- `revision` 对单 Task 单调递增；
- 终态任务仍可查询；
- `resultSummary` 有长度上限，完整 artifact 走独立受控引用；
- 无来源会话的未来系统任务允许不填来源字段。

### 7.2 TaskDetail

```typescript
interface TaskDetail extends TaskSummary {
  steps: TaskStep[]
  controls: {
    canPause: boolean
    canResume: boolean
    canCancel: boolean
    canRetry: boolean
  }
  artifacts: PublicTaskArtifact[]
  runtimeBinding?: PublicRuntimeBinding
  replacedStepIds?: string[]
}
```

`controls` 由后端按当前真实状态计算，Renderer 不自行推断危险命令是否可用。

### 7.3 TaskStep

```typescript
interface TaskStep {
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
  createdAt: string
  startedAt?: string
  finishedAt?: string
  outputSummary?: string
  error?: PublicTaskError
  revision: number
}
```

步骤公开规则：

- 默认详情可按 `ordinal` 显示时间线；
- `dependsOn` 支持高级 DAG 视图；
- Replan 删除的步骤不物理消失，应标记 skipped/replaced 或保留替换关系；
- 同一步骤的重试通过多个 `executionIds` 表达，不覆盖历史尝试。

### 7.4 ToolExecution

目标模型在现有 `ToolCallRecord` 基础上演进：

```typescript
interface ToolExecution {
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
  clientInstanceId?: string

  inputSummary?: string
  outputSummary?: string
  error?: PublicExecutionError
  truncated?: boolean
  durationMs?: number
  attachmentCount?: number

  createdAt: string
  startedAt?: string
  finishedAt?: string
  revision: number
}
```

兼容策略：

- 当前 `ToolCallRecord.id` 等于 `sourceCallId`；目标模型引入独立 `executionId`；
- 迁移期可令普通 LLM 调用的 `executionId === sourceCallId`，但新代码不得继续假设二者永远相等；
- Workflow 重试每次生成新 `executionId`；
- Desktop Bridge 的 `callId` 继续保留为 `desktopCallId`，只用于桥协议和本地动作；
- `submit_task` 本身是一条 ToolExecution，其成功结果必须保存新任务的 `taskId` 链接。

### 7.5 ID 与关联不变式

| ID | 产生方 | 稳定性 | 用途 |
|---|---|---|---|
| `taskId` | TaskService | 跨重启、跨查询稳定 | 产品任务主键 |
| `stepId` | TaskService/Workflow adapter | 在一个 Task 中稳定 | 公开步骤主键 |
| `executionId` | ToolExecutionCoordinator | 每次真实尝试唯一 | 执行记录主键 |
| `sourceCallId` | LLM/tool-calling 层 | 当前对话调用稳定 | 与 assistant tool_call 归档配对 |
| `desktopCallId` | DesktopToolBridge | 单次桥请求稳定 | `tool.request/tool.status` 关联 |
| `generationId` | CognitiveLoop | 单次回复稳定 | 聊天流式回复关联 |
| `conversationId` | 会话服务 | 会话生命周期稳定 | 来源和结果回写 |
| `clientInstanceId` | Electron Main（目标） | 应用安装实例稳定 | Desktop 任务重连绑定 |
| `connectionId` | WebSocket 握手 | 每次连接临时 | 当前传输目标，不作长期任务归属 |

---

## 8. 公共状态机

### 8.1 TaskStatus

建议公共状态：

```typescript
type TaskStatus =
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
```

状态组：

| 组 | 状态 | UI 含义 |
|---|---|---|
| 活跃 | queued/planning/running/pausing/resuming/cancelling | 系统仍在推进或处理命令 |
| 等待用户/环境 | waiting_for_runtime/waiting_for_permission | 需要连接 Desktop 或用户授权 |
| 暂停 | paused | 已保存可继续状态 |
| 终态 | completed/failed/cancelled | 不再自动回到活跃态 |

内部 Workflow 映射：

| WorkflowStatus | TaskStatus |
|---|---|
| QUEUED / PENDING | queued |
| PLANNING | planning |
| RUNNING | running |
| PAUSE_REQUESTED | pausing |
| PAUSED | paused |
| WAITING_APPROVAL | waiting_for_permission |
| RESUMING | resuming |
| CANCEL_REQUESTED | cancelling |
| COMPLETED | completed |
| FAILED | failed |
| CANCELLED | cancelled |

`waiting_for_runtime` 是产品级新增状态，当前 WorkflowEngine 尚无等价内部状态，需要由 TaskService 与执行网关协调实现。

### 8.2 TaskStepStatus

```typescript
type TaskStepStatus =
  | 'pending'
  | 'running'
  | 'waiting_for_runtime'
  | 'waiting_for_permission'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled'
```

### 8.3 ToolExecutionStatus

```typescript
type ToolExecutionStatus =
  | 'requested'
  | 'waiting_for_runtime'
  | 'awaiting_permission'
  | 'running'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'timeout'
```

### 8.4 聚合规则

Task 状态不是简单取最后一个 ToolExecution 状态，应按以下优先级聚合：

1. Task 已进入终态时，终态不可逆；
2. 已接受取消命令但尚未确认，显示 `cancelling`；
3. 已接受暂停命令但尚未到安全点，显示 `pausing`；
4. 任一当前阻塞步骤等待本地权限，Task 显示 `waiting_for_permission`；
5. 任一当前阻塞步骤缺 Runtime，Task 显示 `waiting_for_runtime`；
6. 引擎处于规划阶段，显示 `planning`；
7. 已有步骤运行，显示 `running`；
8. 尚未取得执行槽，显示 `queued`。

---

## 9. 对外接口设计

### 9.1 REST 查询接口

```text
GET /api/tasks
  ?status=&kind=&conversationId=&cursor=&limit=

GET /api/tasks/{taskId}

GET /api/tool-executions
  ?taskId=&stepId=&conversationId=&runtime=&status=&cursor=&limit=

GET /api/tool-executions/{executionId}
```

列表统一采用不透明 cursor；默认按 `updatedAt DESC, id DESC` 稳定排序。响应应包含 `nextCursor` 和 `hasMore`，不能让前端依赖 Mongo `_id` 结构。

### 9.2 REST 控制接口

第一版建议：

```text
POST /api/tasks/{taskId}/pause
POST /api/tasks/{taskId}/resume
POST /api/tasks/{taskId}/cancel
```

请求体包含客户端生成的 `commandId`，用于幂等：

```json
{
  "commandId": "cmd_..."
}
```

响应返回更新后的 `TaskSummary`。重复命令返回相同或更新后的当前状态，不重复触发副作用。

整体 retry、单步骤 retry、删除任务和 UI 创建任务暂不进入第一版契约，待 TSA-P01/P07/P10 拍板。

### 9.3 WebSocket 事件

正式事件复用现有 v2 连接。后端 raw wire 继续由 `frontend_contract` 定义，Electron Main 校验并映射成现有 Renderer 公共事件外壳：

```text
task.created
task.updated
task.step.updated
tool.execution.updated
```

建议发送完整公共实体，而不是不稳定的字段 patch。后端 wire 至少携带 `type`、`timestamp`、实体和实体 `revision`；进入 Main 领域层后，事件至少具有：

```text
eventId
sequence
timestamp
revision
taskId / executionId
```

其中 `eventId/sequence` 属于当前 Main 公共事件外壳，`revision` 才是跨重连判断实体新旧的权威。若后端后续实现 outbox 回放，应在 raw wire 另加不透明 `eventCursor`，不能把 Main 单连接 sequence 当成服务端回放游标。

客户端合并规则：

- 相同实体只接受更大的 `revision`；
- sequence 断档或重连后通过 REST 重新拉快照；
- 终态事件迟到时可补摘要，但不能把终态改回非终态；
- 当前 `tool.started/tool.completed` 在迁移期继续服务聊天工具卡，新 `tool.execution.updated` 作为任务中心完整执行记录；
- 最终可让旧事件由统一执行事件派生，避免两套独立发射逻辑。

### 9.4 Debug API

`/debug/api/tasks` 和 `/debug/api/tasks/stream` 保留，但定位不变：

- 可展示内部 phase、DAG、slot、mailbox；
- 不作为 Desktop 任务中心数据源；
- 不承诺历史保留和公共字段兼容；
- 不承担用户控制命令。

---

## 10. 关键流程

### 10.1 普通 Backend 工具

```text
CognitiveLoop
  → ToolExecutionCoordinator.create(executionId, sourceCallId, conversationId)
  → persist requested/running
  → emit tool.execution.updated
  → ToolAdapter → Backend Plugin
  → persist terminal
  → emit tool.execution.updated
  → ToolResult 回 CognitiveLoop
```

结果：只有 ToolExecution，没有 Task/TaskStep。

### 10.2 提交 Workflow Task

```text
submit_task ToolExecution started
  → DelegationPreparer
  → TaskService.createTask(sourceConversation/sourceMessage/submitExecution)
  → WorkflowTaskAdapter.submit(taskId, context)
  → Task persisted queued
  → submit_task ToolExecution completed(result.taskId)
  → task.created event
```

关键点：`submit_task` 完成只表示“已接收并建档”，不是 Task 完成。

### 10.3 Workflow 中执行 Backend 工具

```text
WorkflowEngine node
  → injected ExecutionGateway
  → ToolExecutionCoordinator(taskId, stepId, attempt)
  → ToolAdapter → Backend Plugin
  → ToolExecution terminal
  → NodeResult
  → TaskStep/Task progress updated
```

### 10.4 Workflow 中执行 Desktop 工具

```text
WorkflowEngine node
  → ExecutionGateway creates full ToolContext
  → ToolExecution requested
  → DesktopToolBridge(target clientInstance/connection)
  → Electron Main ToolService
  → local policy / permission
  → waiting_for_permission reflected to Task
  → execute and tool.status
  → Backend persists ToolExecution terminal
  → Workflow node continues
```

必须显式传输：

```text
taskId
stepId
executionId
sourceCallId
conversationId
clientInstanceId（目标形态）
```

Electron 不再用“当前活动会话”猜后台调用归属。

### 10.5 Desktop 离线

```text
Backend-only step → 正常继续
Desktop step not started → Task/Step waiting_for_runtime
Desktop step already accepted/running → 不自动重投；等待结果 outbox/超时
matching client reconnects → capability event → resume waiting step
超过等待期限 → failed 或 needs-attention（待 TSA-P06 定案）
```

### 10.6 Task 完成

```text
Workflow terminal event
  → TaskService transactionally persists terminal summary
  → publish task.updated(completed/failed/cancelled)
  → release engine runtime objects/checkpoint according to policy
  → post TaskResultData with sourceConversationId
  → CognitiveLoop writes natural-language result to original conversation
```

持久化必须先于事件与运行时清理，避免“前端看到完成但刷新后没有记录”。

---

## 11. 数据所有权与持久化

### 11.1 权威来源

| 数据 | 权威来源 | 前端角色 |
|---|---|---|
| Task 摘要、状态、步骤、结果 | Backend TaskService/Repository | 查询、缓存、展示、发控制命令 |
| Backend ToolExecution 摘要 | Backend ToolExecutionRepository | 展示 |
| Desktop ToolExecution 公共状态 | Backend 持久摘要；执行中的即时现实由 Main overlay 优先 | Main 推实时状态，Renderer 合并 |
| Desktop 原始参数/本地路径/授权决定 | Electron Main + Backend 既有操作记录按安全需要保存 | Renderer 只收摘要 |
| 本机授权 Grant 与审批审计 | Electron Main | 设置页和任务详情只读公开摘要 |
| Workflow 内部 checkpoint/DAG | WorkflowEngine/Backend storage | 不直接暴露 |
| 用户可见 artifact 元数据 | Backend TaskService | 展示受控链接或摘要 |

### 11.2 建议集合

```text
tasks
task_steps
tool_executions
workflow_checkpoints（若做重启恢复）
desktop_calls（现有，继续承担桥操作记录）
```

`desktop_calls` 与 `tool_executions` 不重复：

- `desktop_calls` 保存桥协议、幂等校验和结果接收所需操作字段；
- `tool_executions` 保存统一公共执行摘要与任务关联；
- 两者通过 `desktopCallId/executionId` 关联；
- 任务中心只读取 `tool_executions` 公共 DTO。

### 11.3 终态写入顺序

建议每次变更遵守：

```text
validate transition
  → persist entity + increment revision
  → append/outbox event
  → publish WebSocket event
  → acknowledge command/caller
```

最小实现可以先采用“数据库写成功后同步发布”；如果后续要求进程崩溃后事件必达，再引入 transactional outbox。

### 11.4 保留与删除

具体天数仍待 TSA-P04/P05/P10 决策。无论选择什么策略，都应满足：

- 活跃、等待、暂停任务不能被 TTL 清掉；
- 终态后才设置 `ttl_expires_at`；
- 删除公共任务历史不能顺带删除仍受安全审计策略约束的本地/服务端审计；
- 会话删除与任务删除必须有显式规则；
- artifact 与任务摘要使用不同生命周期；
- 原始敏感参数不得因为任务历史保留更久而被被动延长保留期。

---

## 12. 重启、掉线与取消语义

### 12.1 Backend 重启

完整目标：

- Task/TaskStep/ToolExecution 历史不丢；
- 活跃 Task 在启动时进入 recovery；
- 对可安全恢复的只读步骤从 checkpoint 继续；
- 对“可能已产生副作用但结果未知”的步骤不自动重放，标记需要人工确认或失败；
- 恢复过程产生新的 revision 和明确事件。

分阶段允许的过渡方案：

1. 第一阶段先持久化历史；重启时把遗留活跃任务终态化为 failed/interrupted，错误码明确为 `BACKEND_RESTARTED`；
2. 第二阶段持久化 checkpoint，恢复无副作用步骤；
3. 第三阶段结合 ToolExecution 幂等键恢复可证明安全的副作用步骤。

### 12.2 Electron 重启

- Main 的本地权限和操作状态不能仅依赖 Renderer store；
- 已完成但未确认送达 Backend 的 Desktop 结果需要本地 outbox 或现有状态重传机制；
- 重启后用稳定 `clientInstanceId` 重新绑定，而不是把新 `connectionId` 当成新设备；
- 任务中心先拉 REST 快照，再叠加 Main 当前非终态执行记录。

### 12.3 取消

取消是请求，不等于回滚：

- queued/planning：可以快速取消；
- waiting_for_runtime/permission：取消等待并撤销未决审批；
- running Backend 工具：传播取消，工具是否可中断由插件声明；
- running Desktop 工具：发送取消，但已经开始的剪贴板写入、通知等副作用不能承诺回滚；
- 终态不因迟到取消回退；
- UI 在确认前显示 `cancelling`，不能立即伪装成 `cancelled`。

---

## 13. 安全与隐私

### 13.1 信任边界不变

- Renderer 不获得原始 Desktop 参数、绝对本地路径、Token、`paramHash`、通用文件系统或 shell；
- Electron Main 继续重算风险并拥有最终授权权；
- Backend 只能请求预注册 Desktop 工具；
- Local Worker 如果未来实现，必须经 Main 代理或具备等价受信边界，不能直接把通用执行能力暴露给 Renderer；
- TaskService 不得通过公共 DTO 泄漏 Workflow prompt、完整上下文或内部 stack trace。

### 13.2 公共摘要

任务中心允许展示：

- 工具友好名；
- Runtime；
- 脱敏输入摘要；
- 用户可理解的结果摘要；
- 错误码和安全文案；
- 附件数量；
- 相对范围提示或 Main 生成的 `pathSummary`。

任务中心禁止展示：

- 原始 prompt/完整文件正文；
- API key、Authorization、Cookie；
- 未脱敏 URL/query；
- Electron Main 内部真实路径；
- Desktop `paramHash` 和权限策略内部字段；
- 后端内部异常堆栈；
- 未经过签名/授权的 artifact 物理路径。

### 13.3 审计与产品历史分离

“执行记录”是用户可见产品历史，不等于完整安全审计：

- Backend Runtime 只展示后端主动公开的摘要；
- Desktop 公开记录不替代 Main 审计 JSONL；
- 审计保留策略可长于产品 UI 可见窗口；
- 用户删除产品历史是否影响审计，应由单独合规规则决定。

---

## 14. 任务中心产品信息架构

### 14.1 顶层

```text
任务中心
├─ 任务
│  ├─ 全部 / 进行中 / 等待处理 / 已完成
│  ├─ 搜索、日期、来源会话
│  └─ 列表 + 详情
└─ 执行记录
   ├─ Runtime、状态、日期、来源会话筛选
   └─ ToolExecution 列表 + 公开详情
```

### 14.2 任务列表

每项至少显示：

- 标题/意图摘要；
- 状态；
- 当前步骤或进度；
- 创建/更新时间；
- 来源会话；
- 等待 Runtime/权限提示；
- 终态结果或错误摘要。

### 14.3 任务详情

至少包含：

- 任务摘要和来源；
- 当前状态、进度和可用控制；
- 步骤时间线；
- 每步 Runtime 和执行记录；
- 等待 Desktop/权限时的明确操作引导；
- 结果、错误和公开 artifact；
- 跳回来源对话。

高级 DAG 视图可以后置，但数据模型从第一版保留 `dependsOn`。

### 14.4 执行记录

它回答的是“系统实际调用过什么”，不是“有哪些后台目标”。普通直调和 Workflow 步骤都出现在这里，通过可选 `taskId` 区分。

### 14.5 审批入口

- Task 详情可显示当前步骤“等待授权”；
- 点击后复用现有 `CyToolApproval`/Desktop 权限流；
- 审批动作仍通过 Main 的窄 IPC；
- 设置页继续管理 Grant 和本机审计；
- Task API 不新增一个可以绕过 Main 的 `approve` 命令。

---

## 15. 分批实施建议

### 批次 A：公共契约与持久读模型

- 冻结 Task/TaskStep/ToolExecution 公共模型；
- 新增前后端 contract/schema；
- TaskRepository、TaskStepRepository、ToolExecutionRepository；
- TaskService 查询门面；
- 正式任务/执行 REST 查询；
- Workflow 终态摘要在清理前持久化；
- 前端任务中心静态壳、列表、详情、执行记录只读页；
- 保留现有执行路径，不先做 Desktop Workflow。

### 批次 B：统一工具执行管线

- 引入 ToolExecutionCoordinator；
- 普通 TaskScheduler 路径接入；
- Workflow 注入 ExecutionGateway；
- 统一 ToolContext 构造、execution ID、事件和持久记录；
- `submit_task` ToolExecution 与 Task 建立链接；
- 现有 `tool.started/completed` 从统一事件派生。

### 批次 C：任务控制与实时同步

- pause/resume/cancel 正式 REST；
- commandId 幂等；
- task.* / tool.execution.updated WebSocket；
- 前端 revision 合并、重连快照和控制按钮；
- 来源会话跳转和任务完成结果绑定。

### 批次 D：Desktop Workflow 闭环

- 显式 task/step/execution/conversation/client 关联；
- 稳定 clientInstanceId；
- `waiting_for_runtime`；
- Desktop 权限等待映射；
- 本地结果 outbox/重传；
- 真正的 Workflow → DesktopToolBridge → Electron Main 集成测试与真机联调。

### 批次 E：重启恢复和定时任务

- 持久 checkpoint；
- 后端重启 recovery；
- 有副作用步骤的幂等恢复策略；
- `set_reminder` 迁入 Scheduled Task；
- Local Worker 仍单独立项，除非 TSA-P03 改变。

每批次都必须保持简单直调路径可用，不允许为了任务中心让普通聊天工具调用退化为 Workflow。

---

## 16. 验收标准

### 16.1 领域与接口

- Task、TaskStep、ToolExecution 三实体在前后端契约中含义一致；
- `submit_task` 完成与 Task 完成明确分离；
- 任务和执行历史可分页查询；
- 终态刷新后仍存在；
- Debug API 不被产品前端调用；
- 事件有 revision，重连可用 REST 对账。

### 16.2 普通工具调用

- 普通 Backend/Desktop 调用继续低延迟执行；
- 每次调用产生一条 ToolExecution；
- 普通调用没有伪造的 Task；
- 聊天工具卡和执行记录指向同一 execution；
- 终态和幂等规则不回退。

### 16.3 Workflow

- 创建后立即可在任务中心看到 queued/planning 状态；
- 步骤、进度和结果可查询；
- pause/resume/cancel 与真实引擎状态一致；
- 终态摘要先持久化再清理引擎对象；
- 结果回到原始会话，不受用户后来切换会话影响。

### 16.4 Desktop

- Workflow 步骤可以真实触发 Electron Main 工具；
- 请求携带稳定 execution/task/step/conversation 关联；
- 权限仍由 Main 裁决；
- Desktop 离线进入 waiting_for_runtime；
- 已接手副作用调用掉线后不自动重复执行；
- 重连结果可对账且不重复产生副作用。

### 16.5 安全

- Renderer 看不到原始 Desktop 参数、绝对路径和凭据；
- 产品执行历史不宣称是完整安全审计；
- 错误和结果有长度、类型和脱敏限制；
- 任务控制命令幂等；
- 终态不能被迟到事件复活。

---

## 17. 风险与反模式

### 17.1 把所有工具调用变成 Workflow

后果：普通问时间、读一次文件也要规划、建 DAG、存 Task，增加延迟和失败点，并破坏“任务”的产品语义。明确禁止。

### 17.2 让 WorkflowEngine 直接成为前端 API

后果：前端绑定内部 12 态、DAG、mailbox 和私有快照；引擎重构会变成协议破坏。明确禁止。

### 17.3 前端再建一套本地任务调度器

后果：Backend Task 与 Desktop Task 无法统一暂停、恢复、历史和来源。除非未来明确做离线自治任务，否则不采用。

### 17.4 继续用当前活动会话推断后台请求来源

后果：用户切会话后，后台任务的 Desktop 权限窗和执行记录会归错会话。必须改为后端显式传递。

### 17.5 把 Debug SSE 包装一下就用于产品

后果：终态消失、无历史、无权限边界、字段不稳定、轮询开销和隐式私有依赖。明确禁止。

### 17.6 同时重写 WorkflowEngine

当前更稳妥的路线是先用 TaskService 和 ExecutionGateway 隔离它，再通过真实场景评估内部 Planner/Evaluator/Replan 是否值得保留。第一批不做无验证的整体重写。

---

## 18. 设计验证场景

后续架构审计和集成测试至少覆盖：

1. **直接 Backend 调用：** “现在几点”只产生 ToolExecution；
2. **直接 Desktop 调用：** 聊天中读取剪贴板，经历授权并形成执行记录；
3. **纯 Backend Workflow：** 多次搜索后生成报告，Electron 关闭仍可完成；
4. **跨 Runtime Workflow：** 搜索资料 → 生成摘要 → 写入 Desktop 剪贴板并通知；
5. **权限等待：** Desktop 写入剪贴板步骤令 Task 进入 waiting_for_permission；
6. **Runtime 掉线：** Desktop 步骤进入 waiting_for_runtime，重连后继续；
7. **取消竞态：** Desktop 已开始写入时取消，不重复执行、不宣称回滚；
8. **会话切换：** 创建任务后切到另一个会话，审批、记录和最终结果仍归原会话；
9. **后端重启：** 历史不丢，活跃任务按当前恢复阶段得到明确状态；
10. **重复事件：** WS 重放、迟到终态、重复命令不造成状态回退或副作用重复。

---

## 19. 后续文档动作

本架构讨论完成并拍板待决策项后，应继续产出：

1. 带日期的正式决策记录，记录 TSA-P01～P10 的选择；
2. 前后端契约变更说明和字段级 schema；
3. 分批实施 plan，明确每批修改文件、测试和联调门槛；
4. WorkflowEngine 真实场景审计报告；
5. 任务系统联调清单和最终验收记录；
6. 实现落地时同步 doc 01/02/03/04/06/08/10/12/16 中受影响的维护内容。

在代码尚未落地前，不应在 doc 16 中把任务中心标记为已实现，也不应修改历史验收记录来制造已完成状态。
