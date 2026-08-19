# 阶段 6（工具、权限与 Desktop P0）批次 A：工具契约与领域层（raw/领域四件套 + ToolCallRecord + 归档配对 + mock/测试）

**设计 spec（binding authority）**
**日期：** 2026-08-20
**批次：** 阶段 6 · 批次 A（共 A/B/C 三批次；A = 契约与领域层【本 spec】，B = Main 工具服务/权限/执行器/UI【待 F-06/F-07/F-09/F-10 拍板】，C = 真实联调收口；本批只做代码批次，三态=已开发、未联调）
**依据：** [2026-08-19-阶段6-工具双轨统筹决策记录.md](../../review/2026-08-19-阶段6-工具双轨统筹决策记录.md)（binding，§1 事实核对 / §2 方案定案 D6-01~08 / §3 F-6 任务清单 / §5 依赖与顺序 / §7 后端落地同步）+ [02-Cyrene-前后端通信协议与前端数据结构-v0.2.md](../../02-Cyrene-前后端通信协议与前端数据结构-v0.2.md) §10（工具调用数据结构）/§19（对齐表）+ [04-Cyrene-Desktop工具与权限交互设计-v0.2.md](../../04-Cyrene-Desktop工具与权限交互设计-v0.2.md) §4（工具生命周期状态机）/§6（IPC 面）+ 后端冻结契约 `elysia-agent/frontend_contract/contract.raw.ts`（ToolRequestMessage/ToolStartedMessage/ToolCompletedMessage/ToolStatusMessage/ToolAttachment/ToolRuntime/ToolStatusEnum，本地 HEAD `03a6e882`）+ 本批预检决策集合（见 §0）

**批次边界裁定（D6A-01，主会话裁定，最终报告汇报）：** 目标指令文本写「阶段5 批次A」，结合上下文实为**阶段 6 批次 A**（阶段 5 三批次均已真实联调完毕）。批次 A 范围 = 决策记录 §5「可立即开」集合（F-6-01~06 契约/领域 + F-6-19~23 归档配对/mock/测试），**不含 UI/权限流**（F-6-07~18 归批次 B，待 F-06/F-07/F-09/F-10 拍板）——理由：这是开发者落进 doc 12/16 的批次划分（commit `8c1440b`），且 UI 批次明确被 F 组未决产品项阻塞。预检四项拍板决策的落点见 D6A-02。

---

## 0. 决策集合（本批定案，预检已确认「按推荐拍板」；最终报告汇报）

| # | 决策 | 理由 |
|---|---|---|
| **D6A-01** | **批次边界裁定**：批次 A = F-6-01~06 + F-6-19~23（决策记录 §5 可立即开集合）；F-6-07~18（Main 工具服务/权限/执行器/UI）归批次 B。`desktop.command.run` 全阶段不注册 | 决策记录 §5 明确批次 A 不依赖未决产品项；F-06/F-07/F-09/F-10 仍开放，UI 批需等拍板 |
| **D6A-02** | **预检四项拍板决策落点**：① **完成即出卡片**（backend 工具）→ 本批验收口径：`generation.completed.tool_calls` 不承载工具（D6-04/05），backend 卡片数据源 = live `tool.started/tool.completed`（本批映射为可消费事件）+ 归档 `tool_calls` 配对（本批产出 `Message.toolCalls` 可重建卡片）；② **先做拒绝按钮**（desktop 请求在无执行器时的收尾）→ 批次 B 桌面流程终点（F-6-24 集成验收），本批只交付 tool.request 脱敏公开事件 + ToolStatusCommand 契约；③ **独立 toolStore** → 本批 F-6-05 `ToolCallRecord` 独立领域模型（不挂消息生命周期），按 `sourceCallId` 索引；④ **Live2D waiting_permission 接线** → 批次 B（与权限流一起） | 四项均为预检 AskUserQuestion 拍板；本批按决策记录批次划分落实可落部分 |
| **D6A-03** | **`action` 兼容帧建模为「已知忽略」**（F-6-02）：raw 类型 + `.strict()` schema 收录（`{type:'action', action:string, params?:Record}`），FrameMapper 显式返回 null（不告警）；**不作为工具状态源**（决策记录 §5 口径）。后端 v2 已停发、v1 逐字节不变 | 对齐 FE-INT-P1-01 state/typing 先例（契约识别 + 有意忽略）；真机旧后端过渡期不再 RAW_FRAME_INVALID |
| **D6A-04** | **tool.request 批次 A 的脱敏 emit = 纯函数 redactor**：`redactToolArguments(arguments) → inputSummary`（镜像后端 `_safe_arg_summary`：敏感键恒 `<redacted>`、deny-by-default 字符串 `<str:N>`、非字符串按类型、截断 60 字符），FrameMapper 映射为 `ToolRequestEvent`（**原始 arguments 永不进 Renderer**，D6-07）。批次 B 的 F-6-08 以完整工具服务替换入口（幂等/风险/决策），本批是纯映射路径 | F-6-04 口径「tool.request 经 Main 工具服务生成脱敏公开事件」在本批的最小实现；脱敏纯函数可单测、可复用（F-6-12 审计批次 B） |
| **D6A-05** | **领域 `ToolCallStatus`（8 态展示）与 wire `ToolStatusEnum`（6 态协议）分离**：展示态 = doc 04 §4 单向前进（requested/awaiting_permission/running/completed/failed/rejected/cancelled/timeout）；协议态 = 契约冻结六态（accepted/rejected/running/result/error/cancelled）。映射表：wire accepted/running→展示 running；result→completed；error→failed；rejected/cancelled 同名；requested/awaiting_permission/timeout 为本地态无 wire 对应。**本批只用展示态**（ToolStarted→running、ToolCompleted success→completed / !success→failed、归档配对→completed/failed）；六态协议映射归批次 B（tool-status-sender） | doc 04 §4 与契约六态是两套语义；批次 B 组装 `tool.status` 时用协议态 |
| **D6A-06** | **归档配对降级语义**（F-6-21）：assistant `tool_calls` 骨架与 role=tool 结果按 `tool_call_id` 配对成 `ToolCallRecord[]`；**缺配对结果 → status='completed' + 无 outputSummary**（「执行完成但摘要缺失」安全降级，不伪造结果）。归档记录 runtime 恒 `'backend'`（归档 wire 无 runtime 字段；desktop 调用的真实 runtime 走 live `tool.request`，批次 C 联调可复核） | 决策记录 F-6-21 口径；诚实降级不伪造 |
| **D6A-07** | **mock 工具测试面 = `CYRENE_MOCK_TOOL_FLOW`（live 帧）+ `CYRENE_MOCK_TOOL_HISTORY`（归档配对 seed）**：`TOOL_FLOW`（JSON，两 kind）：`{"kind":"backend","started":{...},"completed":{...}}` → 下一次 `generation.completed` 后按序发射 `tool.started`/`tool.completed`（确定性 `sourceCallId`）；`{"kind":"desktop","request":{...}}` → 发射脱敏 `ToolRequestEvent`（callId `call_mock_1`、sourceCallId `tc_mock_desktop_1`、toolVersion '1.0'、inputSummary=redactToolArguments、expiresAt now+30s；arguments/安全元数据只存配置不携带，review 批次最终 F-1）。`TOOL_HISTORY=1` → 默认会话 seed 一条带 `tool_calls` 骨架的 assistant 消息 + 一条 role=tool 结果消息（确定性 id `tc_seed_1`），供 REST 历史经配对端到端断言（**不改 scheduleReplay 归档语义**——replay 不落 assistant 消息的既有行为保持，review F1 修正）。**MockBackend.submitToolResult 实装**（当前 no-op）：记录回传 + 终态（result/error/rejected/cancelled）追加 role=tool 归档消息（独立消息，配对以同页骨架为准）；非终态（accepted/running）仅记录 | 对齐 CYRENE_MOCK_DIRECTIVE 先例（单 env、generation.completed 后发射、确定性）；mock 模式 client→server = adapter 方法调用（非 WS 帧），submitToolResult 即「发送 tool.status」；review F1：集成断言不可达修正——backend kind 不写归档，配对端到端改走 seed |
| **D6A-08** | **check:contract 计数与 manifest 更新**：`WS_V2_FRAME_TYPES` 增 4 帧（tool.request/tool.started/tool.completed/action）→ 28→**32** adopted；未纳帧 12→**8**（capabilities/delta/message/token_usage/transcription/command/wake/service_mode_result 等仍滞后）。13 组 wire fixture `.manifest.json` 的 `schemaHash` 全量刷新（`rawSchemasFingerprint()` 变化） | F-6-02「更新 RAW_FRAME_TYPES 与全部 manifest schemaHash」；本地 `frontend_contract` 已含新帧（后端 HEAD `03a6e882` 未 push，不阻塞本机）；push/pull 纪律见 §7 前置动作（review R2-1 修正章节引用） |
| **D6A-09** | **`generation.completed` 保持不加 `tool_calls`、`finishReason` 不承载工具语义**（D6-04/05 冻结）：本批**不**扩展 `RawGenerationCompletedSchema`/`GenerationCompletedEvent`；backend 工具的实时数据源只用 `tool.started/tool.completed` | 决策记录 D6-04/D6-05 定案；事实核对「一个回合一个 generation、completed 无 tool_calls」 |

**范围外（本批不做）**：Main 工具服务/幂等记录/权限决策/执行器/审计（F-6-07~12，批次 B）；Preload/IPC 工具面（F-6-13/14，批次 B——本批 Renderer 无消费点，`tool.request` 事件经既有事件管线送达后由 bootstrap 忽略）；toolStore/CyToolCard/权限窗/UI 接线（F-6-15~18，批次 B）；真实 Windows Electron 联调（批次 C/最终验收方）；`desktop.command.run`（确认不注册）。

---

## 1. 目标

批次 A（契约与领域层）目标（一个验收句）：**后端工具双轨 wire 帧（`tool.request`/`tool.started`/`tool.completed` + 过渡期 `action`）经冻结 raw schema 校验 → FrameMapper 脱敏映射为领域事件（原始 arguments 不进 Renderer）；统一 `ToolCallRecord`（权威键 `sourceCallId`）契约落地；归档（REST 历史 + WS 回放）的 assistant `tool_calls` 与 role=tool 结果按 `tool_call_id` 配对成 `Message.toolCalls`（缺配对安全降级）；mock 双场景（backend/desktop）可重复驱动；全部门禁（单测/集成/typecheck/lint/build/check:contract WS 32/32）绿。**

拆解为可验证子目标：

1. raw wire 四件套（`RawToolRequest`/`RawToolStarted`/`RawToolCompleted`/`RawAction` + `RawToolStatus` 入 client union）types + `.strict()` schemas 落地，未知字段整帧拒、`sourceCallId` 必填、runtime 三值枚举；`action` 已知忽略不告警；
2. 领域事件三件套（`ToolRequestEvent`/`ToolStartedEvent`/`ToolCompletedEvent`）进 `BackendEvent` 判别联合 + `BackendEventSchema` zod 镜像（缺镜像 → preload `parseBackendEvent` 丢帧，P4-B 先例）；FrameMapper 三分支映射，`tool.request` 经 `redactToolArguments` 脱敏（纯函数单测）；
3. 领域模型 `ToolCallRecord`（`id=sourceCallId` 权威键）契约落地；`contracts/backend.ts` 旧占位 `ToolResult` 收敛为 `ToolStatusCommand`（Main 组装用、Renderer 不可见），`BackendAdapter.submitToolResult` 签名同步；
4. 归档配对：rest-mapper 解析 assistant `tool_calls` 骨架 + role=tool 结果按 `tool_call_id` 配对 → assistant `Message.toolCalls?: ToolCallRecord[]`；缺配对降级「completed + 摘要缺失」；REST 历史页 + WS 会话回放两条路径同款（共用 assemble + 配对纯函数）；
5. mock 双场景（`CYRENE_MOCK_TOOL_FLOW` env：backend 发射 started/completed、desktop 发射 tool.request）+ `submitToolResult` 实装（终态推进归档）；
6. 门禁全绿：单测（raw schema 四帧/mapper/redactor/配对/mock env 解析）+ 集成（可选 1 例归档配对经 REST 重建）+ typecheck/lint/build + check:contract（WS 32/32 + 8 未纳 warn）+ 13 组 fixture manifest schemaHash 刷新；
7. 三态 = **已开发、未联调**（真实 Windows Electron 联调归批次 C/开发者事后）。

## 2. 分层架构

```text
后端 v2 WS（ServerMessage）
   ├── tool.request   ──► RawToolRequest  ──► FrameMapper.mapToolRequest ──► redactToolArguments
   │                        (Main 校验)                                       │
   │                                                                         ▼
   │                                                   ToolRequestEvent（脱敏，无 arguments）──► Renderer 事件管线
   ├── tool.started  ──► RawToolStarted ──► FrameMapper.mapToolStarted ──► ToolStartedEvent ──► 同上
   ├── tool.completed─► RawToolCompleted─► FrameMapper.mapToolCompleted─► ToolCompletedEvent─► 同上
   ├── action（v2 已停发）──► RawAction ──► FrameMapper → null（已知忽略，不告警）
REST/回放（持久权威，D6-04）
   assistant tool_calls + role=tool 结果 ──► RestMapper.assemble（骨架）──► pairToolCalls（配对纯函数）
                                           ──► Message.toolCalls?: ToolCallRecord[]（history/replay 重建卡片的数据源）
Mock（CYRENE_MOCK_TOOL_FLOW）
   backend kind ──► 发射 tool.started/tool.completed（generation.completed 后）
   desktop kind ──► 发射 tool.request；submitToolResult（=mock 模式 client→server 发送面）记录 + 终态追加归档
```

## 3. 详细设计（按 F-6 编号）

### 3.1 F-6-01 raw wire 类型（`apps/desktop/src/main/transport/protocol-v2/raw-types.ts`）

新增（全部镜像 `frontend_contract/contract.raw.ts`，保留后端原始命名）：

```typescript
/** 工具 Runtime（对齐契约 ToolRuntime StrEnum；raw 层自包含，不与领域层混用） */
export type RawToolRuntime = 'backend' | 'desktop' | 'local_worker'

/** 桌面工具执行请求（Server→Client 定向投递；sourceCallId 必填 = LLM tool_call_id 权威键，D6-03/D6-07） */
export interface RawToolRequest {
  type: 'tool.request'
  callId: string                    // 桥 callId（call_ 前缀；执行协议关联）
  toolName: string
  toolVersion: string
  runtime: RawToolRuntime
  sourceCallId: string              // LLM tool_call_id（必填，缺省即整帧拒）
  arguments: Record<string, unknown>
  reason?: string
  riskLevel: string                 // 契约为 str（safe/medium/high）；本地风险重算归批次 B
  permissionRequired: boolean
  approvalAuthority: string         // desktop → client
  paramHash: string                 // 规范化 arguments SHA-256（篡改拒绝权威依据，批次 B 消费）
  expiresAt: string                 // UTC ISO（桥 request_timeout 绝对过期）
  requestId?: string
}

/** Backend 工具开始（v2 展示生命周期；callId = LLM tool_call_id，与 started/completed/归档同值） */
export interface RawToolStarted {
  type: 'tool.started'
  callId: string
  toolName: string
  runtime: RawToolRuntime
  inputSummary?: string             // 服务端 _safe_arg_summary
  generationId?: string
  conversationId?: string
}

/** Backend 工具完成（v2 展示生命周期；outputSummary ≤2000 截断带 truncated） */
export interface RawToolCompleted {
  type: 'tool.completed'
  callId: string
  toolName: string
  runtime: RawToolRuntime
  success: boolean
  outputSummary?: string
  error?: Record<string, unknown>   // {code,message}；契约未冻结内层 → 按 record 收，mapper 提取已知键
  errorType?: string
  durationMs?: number               // 可为小数（契约 float）
  truncated?: boolean
  generationId?: string
  conversationId?: string
}

/** 旧后端泛型动作帧（v2 已停发、v1 不变；契约识别 + 有意忽略，不告警不作工具状态源，D6A-03） */
export interface RawAction {
  type: 'action'
  action: string                    // 'tool_executing' | 'tool_done' | 其它（契约 Literal|str）
  params?: Record<string, unknown>
}

/** 桌面工具状态回传（Client→Server 六态；runtime 保持 str——D-status-runtime 不扩大回传契约 churn） */
export interface RawToolStatus {
  type: 'tool.status'
  callId: string
  status: 'accepted' | 'rejected' | 'running' | 'result' | 'error' | 'cancelled'
  toolName: string
  toolVersion: string
  runtime: string
  paramHash: string
  output?: string
  error?: Record<string, unknown>   // {code,message} 同 tool.completed 收法
  attachments?: RawToolAttachment[]
  executionSummary?: string
}

/** 桌面工具结果附件引用（后端托管 URL；批次 B 上传后回填） */
export interface RawToolAttachment {
  url: string
  mimeType: string
  label?: string
}
```

联合更新：

```typescript
export type RawClientFrame =
  | /* 既有 11 型语音控制帧 */
  | RawToolStatus                       // 新增（客户端→服务器，不进 RawFrameSchema/RAW_FRAME_TYPES 计数）

export type RawFrame =
  | /* 既有各帧 */
  | RawToolRequest | RawToolStarted | RawToolCompleted | RawAction   // 新增 4 型（action 兼容帧进 RawFrameSchema）
```

### 3.2 F-6-02 raw schemas（`apps/desktop/src/main/transport/protocol-v2/raw-schemas.ts`）

四帧 `.strict()` 镜像契约（未知字段整帧拒，fail-closed）+ `RawToolStatusSchema` 入 `RawClientFrameSchema`：

```typescript
const RawToolRuntimeSchema = z.enum(['backend', 'desktop', 'local_worker'])

const RawToolRequestSchema = z.object({
  type: z.literal('tool.request'),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  toolVersion: z.string().min(1),
  runtime: RawToolRuntimeSchema,
  sourceCallId: z.string().min(1),              // 必填（后端契约 B-6 已强制；缺省整帧拒）
  arguments: z.record(z.string(), z.unknown()),
  reason: z.string().optional(),
  riskLevel: z.string(),                        // 契约 str；后端恒发
  permissionRequired: z.boolean(),              // 契约必填
  approvalAuthority: z.string().min(1),         // 契约必填
  paramHash: z.string().min(1),                 // 契约必填
  expiresAt: z.string().min(1),                 // 契约必填
  requestId: z.string().optional()
}).strict()

const RawToolStartedSchema = z.object({
  type: z.literal('tool.started'),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  runtime: RawToolRuntimeSchema,
  inputSummary: z.string().optional(),
  generationId: z.string().optional(),
  conversationId: z.string().optional()
}).strict()

const RawToolCompletedSchema = z.object({
  type: z.literal('tool.completed'),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  runtime: RawToolRuntimeSchema,
  success: z.boolean(),                         // 契约必填
  outputSummary: z.string().optional(),
  error: z.record(z.string(), z.unknown()).optional(),   // 内层不冻结（契约 Record），mapper 提取 code/message
  errorType: z.string().optional(),
  durationMs: z.number().optional(),            // 可为小数
  truncated: z.boolean().optional(),
  generationId: z.string().optional(),
  conversationId: z.string().optional()
}).strict()

const RawActionSchema = z.object({
  type: z.literal('action'),
  action: z.string(),                           // 契约 Literal|str → str 全收
  params: z.record(z.string(), z.unknown()).optional()
}).strict()

const RawToolAttachmentSchema = z.object({ url: z.string().min(1), mimeType: z.string().min(1), label: z.string().optional() }).strict()
const RawToolStatusSchema = z.object({
  type: z.literal('tool.status'),
  callId: z.string().min(1),
  status: z.enum(['accepted', 'rejected', 'running', 'result', 'error', 'cancelled']),
  toolName: z.string().min(1),
  toolVersion: z.string().min(1),
  runtime: z.string(),                          // D-status-runtime：保持 str
  paramHash: z.string().min(1),
  output: z.string().optional(),
  error: z.record(z.string(), z.unknown()).optional(),
  attachments: z.array(RawToolAttachmentSchema).optional(),
  executionSummary: z.string().optional()
}).strict()
```

- `RawFrameSchema` discriminatedUnion 增 4 成员（tool.request/tool.started/tool.completed/action）；`RawClientFrameSchema` 增 tool.status。
- `RAW_FRAME_TYPES` 自动推导（不变更逻辑）。
- **fixture manifest 全量刷新**：13 组 `src/main/fixtures/wire-v2/*.jsonl` 的 `*.manifest.json` `schemaHash` 更新为新的 `rawSchemasFingerprint()` 值（wire-fixtures.spec.ts 门禁；提供一次性刷新脚本或等价更新步骤，plan 定）。
- **check:contract**：`apps/desktop/scripts/check-backend-contract.mjs`（review F4 修正路径）`WS_V2_FRAME_TYPES` 增 `'tool.request'/'tool.started'/'tool.completed'/'action'`（28→32）；未纳帧 12→8。REST 段不变。

### 3.3 F-6-03 领域事件 + schema 镜像（`shared/contracts/events.ts` + `shared/schemas/events.ts`）

`contracts/events.ts` 新增（进入 `BackendEvent` 判别联合；事件名与 wire 帧名一致，对齐 voice/live2d 先例）：

```typescript
// —— 阶段 6 批次 A（F-6）：工具双轨领域事件（D6-01~08）——
// wire 双轨（Desktop tool.request / Backend tool.started+completed）→ 领域单轨事件；
// 原始 arguments 永不进 Renderer（D6-07，tool.request 事件只含脱敏 inputSummary）。

/** 桌面工具执行请求（脱敏公开事件；原始 arguments 不含，权限/幂等/执行归批次 B） */
export interface ToolRequestEvent extends BackendEventEnvelope {
  event: 'tool.request'
  callId: string            // 桥 callId（call_ 前缀；执行协议关联，D6-03）
  sourceCallId: string      // 权威键（LLM tool_call_id）
  toolName: string
  toolVersion: string       // wire 必填直映（非安全元数据，review C1 修正）
  runtime: ToolRuntime
  reason?: string
  inputSummary?: string     // 本地脱敏摘要（redactToolArguments；原始 arguments 永不进 Renderer）
  expiresAt: string         // wire 必填（桥 request_timeout 绝对过期；批次 B 权限窗超时兜底，review C2 修正）
  requestId?: string
}

/** Backend 工具开始（展示生命周期；callId = sourceCallId 同值） */
export interface ToolStartedEvent extends BackendEventEnvelope {
  event: 'tool.started'
  callId: string
  toolName: string
  runtime: ToolRuntime
  inputSummary?: string
  generationId?: string
  conversationId?: string
}

/** Backend 工具完成（success 区分 completed/failed；outputSummary ≤2000 + truncated 直映） */
export interface ToolCompletedEvent extends BackendEventEnvelope {
  event: 'tool.completed'
  callId: string
  toolName: string
  runtime: ToolRuntime
  success: boolean
  outputSummary?: string
  error?: { code?: string; message?: string }   // 从 wire record 提取已知键；缺省 undefined
  errorType?: string
  durationMs?: number
  truncated?: boolean
  generationId?: string
  conversationId?: string
}
```

`schemas/events.ts` 镜像三件套（`BackendEventSchema` discriminatedUnion 增成员；缺镜像 → preload `parseBackendEvent` 丢帧，P4-B 先例）：字段与事件契约逐字对齐（event 字面量、sourceCallId 必填 min(1)、runtime 三值枚举、error `{code?,message?}` 可选、durationMs number 可选等）。

### 3.4 F-6-04 FrameMapper + 脱敏 emit（`frame-mapper.ts` + 新建 `main/tools/input-summary.ts`）

`mapFrame` switch 增 3 分支 + action：

```typescript
case 'tool.request':
  return this.mapToolRequest(frame)      // 脱敏 emit（D6A-04）
case 'tool.started':
  return this.mapToolStarted(frame)
case 'tool.completed':
  return this.mapToolCompleted(frame)
case 'action':
  return null                            // 已知忽略（D6A-03：不告警、不作工具状态源）
```

- `mapToolRequest`：`envelope()` + 直映 + `inputSummary: redactToolArguments(frame.arguments)`（arguments 非空才填；空对象 → undefined）。**字段不进事件**：arguments/riskLevel/permissionRequired/approvalAuthority/paramHash（安全元数据，D6-07）；`toolVersion`/`expiresAt` 为 wire 必填**直映**（非安全元数据，review C1/C2）。
- `mapToolStarted` / `mapToolCompleted`：直映；`error` 从 record 提取 `{code?, message?}`（已知键，缺失不写键）。
- 新建 `apps/desktop/src/main/tools/input-summary.ts`：

```typescript
/** 工具参数安全摘要（镜像后端 Module/tool/safety.py `_safe_arg_summary`，D6A-04）。
 * 敏感键恒 <redacted>；deny-by-default：所有字符串值只记 <str:N>；非字符串按类型名。max_len=60。 */
export function redactToolArguments(raw: Record<string, unknown>): string | undefined
```

实现语义（逐条对齐后端 safety.py §_safe_arg_summary）：`_REDACTED_KEYS` = {token,key,password,secret,authorization,cookie,content,prompt,path,base_url,url,query,api_key}（key 小写比对）→ `<redacted>`；字符串 → `<str:长度>`（白名单恒空，deny-by-default）；其余 → `<类型名>`；空 dict → undefined；输出 `"k1=v1, k2=v2"` 拼接。

### 3.5 F-6-05 / F-6-06 领域模型（`shared/contracts/tool.ts` 重写 + `shared/contracts/backend.ts` 收敛）

`contracts/tool.ts` 重写（现 `ToolCall`/`ToolStatus` 占位无引用方，直接替换；保留 `ToolRuntime` 名）：

```typescript
/** 工具 Runtime（与 wire ToolRuntime 对齐；ModelExecutionLocation 是另一概念，勿混用） */
export type ToolRuntime = 'backend' | 'desktop' | 'local_worker'

/** 前端展示状态（doc 04 §4 单向前进；wire tool.status 六态映射见 D6A-05；终态不重回执行态） */
export type ToolCallStatus =
  | 'requested' | 'awaiting_permission' | 'running'
  | 'completed' | 'failed' | 'rejected' | 'cancelled' | 'timeout'

/** 统一工具调用记录（权威键 id = sourceCallId = LLM tool_call_id，D6-03；实时易失 / 归档持久共型） */
export interface ToolCallRecord {
  id: string                        // sourceCallId（LLM tool_call_id）
  toolName: string
  runtime: ToolRuntime
  status: ToolCallStatus
  desktopCallId?: string            // 桥 callId（tool.request/tool.status 执行协议关联）
  generationId?: string
  conversationId?: string
  reason?: string                   // tool.request.reason
  inputSummary?: string             // 服务端 _safe_arg_summary / 本地脱敏摘要
  outputSummary?: string
  error?: { code?: string; message?: string }
  errorType?: string
  truncated?: boolean
  durationMs?: number
  startedAt?: string
  finishedAt?: string
}

/** 工具结果附件引用（wire ToolAttachment 直映） */
export interface ToolAttachment { url: string; mimeType: string; label?: string }
```

**注（review C1 承接）**：`toolVersion` **有意不进 `ToolCallRecord`**——归档 wire 无版本源（配对路径填不了），且批次 B `tool.status` 回传一致性由 Main 自 raw 帧缓存取值（D6-07），不依赖领域记录；事件层（`ToolRequestEvent.toolVersion` 必填）直映不受影响。

`contracts/backend.ts`：移除旧占位 `ToolResult{callId,status,summary}`（F-6-06），替换为（Main 组装用、Renderer 不可见；`BackendAdapter.submitToolResult` 签名同步）：

```typescript
/** 桌面工具状态回传命令（Main 组装、Renderer 不可见，D6-07；wire tool.status 六态协议态，D6A-05） */
export type ToolWireStatus = 'accepted' | 'rejected' | 'running' | 'result' | 'error' | 'cancelled'
export interface ToolStatusCommand {
  callId: string
  status: ToolWireStatus
  toolName: string
  toolVersion: string
  runtime: string                   // D-status-runtime：wire 保持 str
  paramHash: string
  output?: string
  error?: { code?: string; message?: string }
  attachments?: ToolAttachment[]    // 批次 B 上传后回填
  executionSummary?: string
}
```

`backend-adapter.ts`/`real-backend.ts`/`mock-backend.ts` 的 `submitToolResult` 签名同步（real 仍 NOT_IMPLEMENTED；mock 实装见 3.7）。`shared/contracts/index.ts` 导出同步（tool.ts 新成员 + backend.ts ToolStatusCommand）。

### 3.6 F-6-19 / F-6-20 / F-6-21 归档配对（`rest-mapper.ts` + `contracts/message.ts`）

**`contracts/message.ts`（F-6-20）**：assistant `Message` 增 `toolCalls?: ToolCallRecord[]`（tool 角色消息本体不变——消息保留 + MessageToolInfo 继续归一化；「不再作为普通气泡渲染」是批次 B UI 职责）。

**`rest-mapper.ts`（F-6-19）**：
1. `MessageSource` 增 `tool_calls?: unknown[]`（RestMessage/RawSessionMessageItem 已有该字段，仅补中间类型）；
2. `assemble()` 对 **assistant** 消息解析 `tool_calls`（形状 `{id, type?, function:{name, arguments}}`，`ToolCallData` 契约；`arguments` 为 JSON 字符串**不解析**）→ `ToolCallRecord[]` 骨架（`{id, toolName: function.name, runtime:'backend'（D6A-06 缺省）, status:'completed'（占位，配对后修正）}`）；骨架挂到 `base.toolCalls`；
3. 新建导出纯函数：

```typescript
/** 归档配对（F-6-19/21）：assistant tool_calls 骨架与 role=tool 结果按 tool_call_id 配对修正状态与结果摘要。
 * 缺配对结果 → 保持 completed + 无 outputSummary（「执行完成但摘要缺失」降级，D6A-06）。
 * 同一消息内按 id 幂等（后见同 id 骨架忽略）。跨页配对不支持（翻页上下文由批次 B 查看器再配对）。 */
export function pairToolCalls(messages: Message[]): Message[]
```

   - 结果消息 `Message.tool.callId`（即 `tool_call_id`）匹配骨架 `id`；命中 → 按 `tool.success` 设 `completed/failed`，填 `outputSummary`（`tool.error` 非空时以错误为准：status failed + error/errorType + 省略 outputSummary）、`durationMs`、`finishedAt`（结果消息 timestamp）；
   - 未被消费的 role=tool 消息保持原样（其 `MessageToolInfo` 继续保留）；
   - 骨架占位 status：配对命中按结果修正；未命中保持 `completed`（D6A-06）。
4. 调用点（REST + 回放两条路径同款）：`toMessagePage`（history/context）、会话详情、**`real-backend.handleSession` 会话回放数组组装后**（`toDomainMessageFromReplay` 映射数组 → `pairToolCalls`）——**本批必做接线**（review F3 修正：非 plan 待定）；原则：任何一次批量消息归一化之后、进入 store 之前配对。回放路径断言由单测覆盖：`toDomainMessageFromReplay` → 组装数组 → `pairToolCalls`（§3.8）。

**F-6-21（本批数据层）**：`Message.toolCalls` 即历史/回放重建卡片的数据源；降级语义 = D6A-06（缺配对 → completed + 无摘要，不伪造）。卡片渲染本体归批次 B。

### 3.7 F-6-22 mock 工具场景（`mock-backend.ts`）

1. env 解析：`parseMockToolFlowEnv(env) → MockToolFlow | undefined`（对齐 `parseMockDirectiveEnv` 先例；JSON 解析失败 → undefined + 不抛）：

```typescript
export type MockToolFlow =
  | { kind: 'backend'; started: { toolName: string; inputSummary?: string; runtime?: RawToolRuntime };
      completed: { success: boolean; outputSummary?: string; errorType?: string; durationMs?: number } }
  | { kind: 'desktop'; request: { toolName: string; arguments?: Record<string, unknown>; reason?: string;
      riskLevel?: string; permissionRequired?: boolean } }
```

2. 发射（对齐 CYRENE_MOCK_DIRECTIVE 触发点：下一次 `generation.completed` 后）：
   - backend kind：`tool.started`（callId `tc_mock_backend_1`、toolName、inputSummary、runtime 缺省 backend、conversationId 当前活动会话）→ 紧接着 `tool.completed`（同 callId、success、outputSummary、errorType、durationMs）；
   - desktop kind：`tool.request` 领域事件（callId `call_mock_1`、toolName、runtime 'desktop'、sourceCallId `tc_mock_desktop_1`、toolVersion '1.0'、reason 透传、inputSummary = `redactToolArguments(arguments)`、expiresAt now+30s）——**mock 是 adapter，发射脱敏 `ToolRequestEvent`（不经 raw 层）**，arguments/riskLevel/permissionRequired/approvalAuthority/paramHash 只存在于 `MockToolFlow` 配置（解析但事件不携带——安全元数据留 raw 层，批次 B raw 路径复用；review 批次最终 F-1 修正）；
3. `submitToolResult(input: ToolStatusCommand)` 实装（当前 no-op）：按 callId 记录最近回传（暴露 getter 供单测断言）；**终态**（result/error/rejected/cancelled）→ 追加一条 role=tool 归档消息（`tool_call_id` 取对应 `sourceCallId`、`success/error/error_type/duration_ms/truncated`、`content` 取 output/error.message）到 `messageRecords`（当前活动会话）——独立消息，配对以同页 assistant 骨架为准（scheduleReplay 不落 assistant 消息，**不补骨架**，review F1 修正）；非终态（accepted/running）仅记录。
4. 归档配对 seed：`CYRENE_MOCK_TOOL_HISTORY=1` env（parseMockToolHistoryEnv，对齐 `parseMockHistoryCountEnv` 先例）→ 默认会话 seed 一条带 `tool_calls` 骨架的 assistant 消息（`tc_seed_1`/`seed.tool.read`/arguments JSON 串）+ 一条 role=tool 结果消息（同 id、success:true、content 摘要、duration_ms）——REST 历史经 `pairToolCalls` 端到端可断言（不改 scheduleReplay 归档语义）。
5. 确定性：`tc_mock_*`/`call_mock_*`/`tc_seed_*` 固定串（与 idFactory 无关，测试可精确断言）。

### 3.8 F-6-23 / F-6-25 测试与门禁

**单测（批次 A 子集）**：
| 文件 | 用例 |
|---|---|
| `tests/unit/raw-schemas.spec.ts` 增 | tool.request 合法帧 parse（含 sourceCallId/riskLevel/paramHash/expiresAt 全字段）；sourceCallId 缺省 → 拒；runtime 非法 → 拒；未知字段 → 拒（strict）；tool.started/completed 合法 + strict 拒；action 兼容帧 parse（含旧 trace 形状 `{type:'action',action:'tool_executing',params:{tool,call_id,args}}`）；RawToolStatusSchema client 帧 parse（六态枚举 + runtime str 放行）；fingerprint 变化断言的既有门禁随 manifest 刷新通过 |
| `tests/unit/frame-mapper.spec.ts` 增 | tool.started → ToolStartedEvent（envelope + 字段直映）；tool.completed success/失败 → ToolCompletedEvent（error record → {code,message} 提取）；tool.request → ToolRequestEvent（arguments 不在事件内、inputSummary 为脱敏串、安全元数据字段不在事件内、**toolVersion/expiresAt 必填直映**，review C1/C2）；action → null 且不告警（onProtocolWarning 未被调用） |
| `tests/unit/schemas.spec.ts` 增 | **三新事件 BackendEventSchema 镜像**（review F2）：`tool.request`/`tool.started`/`tool.completed` 各一合法样例 parse 通过（envelope eventId/sequence 必填）+ 必填字段缺失拒绝（sourceCallId/expiresAt/toolVersion/success）——对齐 P4-B 13 事件 / P5-C live2d.directive 镜像测试块先例 |
| `tests/unit/tool-input-summary.spec.ts`（新） | 敏感键全 13 键（token/key/password/secret/authorization/**cookie**/content/prompt/path/base_url/url/query/api_key，含大小写）→ `<redacted>`（review R2-2 补 cookie）；普通字符串 → `<str:N>`；数字/布尔/数组/对象 → 类型名；空 dict → undefined；多字段拼接 |
| `tests/unit/rest-mapper-tools.spec.ts`（新） | assistant tool_calls 骨架解析（ToolCallData 形状 + arguments JSON 串不解析）；配对成功（success:true → completed + outputSummary + durationMs + finishedAt）；配对失败（success:false → failed + error/errorType）；缺配对 → completed + 无摘要（降级）；同 id 幂等去重；tool 角色消息保留 MessageToolInfo 且不进 toolCalls；**回放路径**：`toDomainMessageFromReplay` 组装数组 → `pairToolCalls` 配对（review F3） |
| `tests/unit/mock-backend-tools.spec.ts`（新） | `parseMockToolFlowEnv` 合法/非法 JSON → 值/undefined；`parseMockToolHistoryEnv`（review F1）；backend kind 发射 started→completed 两帧（顺序/字段/固定 sourceCallId）；desktop kind 发射 tool.request（callId/sourceCallId/paramHash/expiresAt）；`submitToolResult` 记录 + 终态追加归档消息（独立消息不补骨架）；非终态仅记录；`TOOL_HISTORY` seed（骨架 + 结果消息） |
| `tests/unit/wire-fixtures.spec.ts` | 13 组 manifest schemaHash 门禁随刷新通过（不新增 fixture 组——本批 fixture 增量以单测内联样本为主，plan 定） |

**集成（批次 A 轻量，review F1 修正）**：1 例 Electron 集成——`CYRENE_MOCK_TOOL_HISTORY=1` → 加载会话历史 → 种子 assistant 消息带 `Message.toolCalls`（配对端到端：REST 历史 → rest-mapper → pairToolCalls → store；经 `__cyreneTest` 探针或既有 history 流程断言）。若 SwiftShader 观察成本过高（阶段 5 批次 C C1 集成 CI 失败先例，见 `docs/review/2026-08-19-阶段5批次C-C1集成测试CI失败-待办.md`），以 mock-backend-tools 单测 + rest-mapper-tools 单测覆盖替代并记录取舍。

**门禁（F-6-25）**：`pnpm typecheck` / `pnpm lint` / `pnpm test` / `xvfb-run -a pnpm test:integration` / `pnpm build` / `pnpm -F @cyrene/desktop check:contract`（WS **32/32** + 未纳 8 warn；REST 15/15 不变）。

## 4. 安全设计

- **信任边界**（doc 07 三层模型）：本批全部工具 wire 处理在 **Main 进程**（`parseRawFrame` 校验、redactor 脱敏、FrameMapper 映射、mock 解析）；**Renderer 只收脱敏公开事件**（`ToolRequestEvent` 无 arguments/riskLevel/permissionRequired/approvalAuthority/paramHash，D6-07）；**零新增 Preload/IPC 面**（F-6-13/14 归批次 B，不新增 `invoke(channel)` 式通用通道）。
- **原始 arguments 永不进 Renderer**：`RawToolRequest.arguments` 仅存在于 Main（schema 校验输入 + `redactToolArguments` 输入）；事件层只带 `inputSummary`（脱敏串）。`RawAction.params` 已知忽略不透传。
- **脱敏纪律**：`redactToolArguments` 镜像后端 `_safe_arg_summary`（13 敏感键恒 `<redacted>`、deny-by-default 字符串 `<str:N>`）；归档配对 `outputSummary` 只进 Renderer store（用户可见的工具结果），不进日志/审计——F-6-12 审计脱敏义务在批次 B（doc 07 §12 约束对象是日志/审计/诊断，不约束 store）。
- **fail-closed**：四帧 `.strict()` 未知字段整帧拒（`RAW_FRAME_INVALID` 走既有脱敏日志路径，不新增日志面）；`tool.status` 由 Main 组装（`ToolStatusCommand` 标注「Renderer 不可见」）。
- **无执行面**：本批无执行器、无命令执行、无通用 IPC、无 Renderer 入站工具面；`desktop.command.run` 不注册。

## 5. 文档同步（代码批落地时一并更新，决策记录 §4 批次 A 子集）

| 文档 | 更新点 |
|---|---|
| `docs/02` §10 | `ToolCall` 领域模型补 `sourceCallId`（权威键）+ Backend `tool.started/completed` 形状 + `finishReason` 不承载工具语义注记（D6-04/05） |
| `docs/02` §17 | 事件处理规则表增 `tool.request` / `tool.started` / `tool.completed` / `tool.status` |
| `docs/02` §19 | 对齐表「工具调用字段」行补 `sourceCallId`；新增 `tool.started/completed` 两行；`action` 退役注记（v2 停发、前端已知忽略） |
| `docs/04` §2/§4/§11 | `sourceCallId` 权威键、ID 双轨关联（D6-03）；本地状态机 8 态与 wire 六态映射（D6A-05）；§11 Backend Runtime 只展示口径（review F5 补） |
| `docs/06` §3.5 | `toolStore` 三来路归一化设计先行记录（实时易失/归档持久分工，D6-04） |
| `docs/12` §9.7 / `docs/16` §9 | F-6-01~23 落地状态更新 + changelog 行 |
| `docs/13` | wire 契约变更（新增 3 帧 + action 建模）→ 交叉 review 结论记录 |
| `README` / `CLAUDE.md` | 阶段 6 状态与测试计数更新（三态 = 已开发、未联调） |
| `docs/review/2026-08-20-阶段6批次A-决策记录.md`（新） | 本批决策记录（D6A-01~09 + Rulings + 执行偏离） |

## 6. 范围外（明确不做）

- Main 工具服务/幂等/风险/权限决策/四执行器/审计（F-6-07~12）；Preload/IPC 工具面（F-6-13/14）；toolStore/CyToolCard/权限窗/聊天视图接线/Live2D waiting_permission（F-6-15~18）——**全部批次 B**（待 F-06/F-07/F-09/F-10 拍板后开批）；
- `tool.status` 实际发送（real-backend `submitToolResult` 仍 NOT_IMPLEMENTED；契约与 mock 发送面本批就绪，批次 B 组装发送）；
- 桌面附件上传（`POST /api/uploads/desktop/{callId}`，批次 C 或 B）；
- `desktop.command.run`（确认不注册）；
- 真实 Windows Electron 联调（批次 C/开发者事后，三态升「已真实联调」）；
- 跨页/跨会话归档配对（批次 B 历史查看器按上下文重配对）。

## 7. 前置动作与风险

- **后端 push 前置动作**（决策记录 §7.4）：后端 `03a6e882` 需 push、前端 pull 后再动 `check:contract` 相关 manifest——本机共享 `frontend_contract` 已含新帧（本地 HEAD），**不阻塞本机开发与门禁**；push 由开发者手动执行（本项目纪律：永不代 push）。远端同步后如 manifest 计数漂移以本机为准复核。
- **风险 R1（mock desktop 场景的「推进归档」范围）**：mock `submitToolResult` 追加归档仅覆盖「mock 自己发射的 desktop 场景」这一最小闭环（无真实 tool-service，批次 B 才有真实回传）；若单测发现语义不清以 D6A-07 为 binding。
- **风险 R2（归档 runtime 恒 backend）**：D6A-06 记录为已知限制；批次 C 真实联调复核 desktop 调用归档展示。
- **风险 R3（批次 B 替换入口）**：本批 mapper 的 tool.request 纯映射路径在批次 B 被 tool-service 完整入口替换，两处都要保留脱敏语义（redactor 复用）。

## 8. 验收清单与执行纪律

- [ ] raw wire 四件套（tool.request/started/completed + action）types + `.strict()` schemas 落地：`sourceCallId`/`paramHash`/`expiresAt`/`permissionRequired`/`approvalAuthority` 必填、runtime 三值、未知字段整帧拒
- [ ] `tool.status` 入 RawClientFrame + schema（runtime 保持 str）；领域事件三件套入 `BackendEvent` + `BackendEventSchema` 镜像（preload `parseBackendEvent` 可收）
- [ ] FrameMapper 三分支 + action 已知忽略；`tool.request` 脱敏 emit（原始 arguments/安全元数据不在事件内，toolVersion/expiresAt 必填直映）
- [ ] `ToolCallRecord`（id=sourceCallId 权威键）契约落地；`ToolResult` → `ToolStatusCommand` 收敛 + `submitToolResult` 签名同步（real 仍 NOT_IMPLEMENTED）
- [ ] 归档配对：REST 历史 + WS 回放两条路径均产出 `Message.toolCalls`；缺配对降级「completed + 摘要缺失」；tool 角色消息保留
- [ ] mock：`CYRENE_MOCK_TOOL_FLOW` 两 kind 发射 + `submitToolResult` 实装 + `CYRENE_MOCK_TOOL_HISTORY` seed
- [ ] 门禁：typecheck / lint / test（新增单测全绿）/ xvfb-run test:integration / build / check:contract（WS 32/32 + 8 未纳 warn；REST 15/15）；13 组 fixture manifest schemaHash 刷新
- [ ] 文档同步（§5 表）+ 决策记录 `docs/review/2026-08-20-阶段6批次A-决策记录.md` + doc13 交叉 review 结论
- [ ] 三态 = 已开发、未联调（真实 Windows Electron 联调归批次 C/开发者事后）

**执行纪律（review N3 补）**：执行中若出现对 §0 决策的偏离，按既定流程处理——按推荐执行 → 记入决策记录（`docs/review/2026-08-20-阶段6批次A-决策记录.md`）→ 最终报告汇报。**最终报告必报项**：本 spec 批次边界裁定 D6A-01（目标指令文本「阶段5 批次A」与实为阶段 6 批次 A 的命名差异）、D6A-02 四项预检决策落点、以及本 spec 全部 review 修复记录（C1/C2/F1~F5/N1~N3）。
