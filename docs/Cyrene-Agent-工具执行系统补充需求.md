# Cyrene Agent 工具执行系统补充需求

**文档版本：** v0.2  
**文档状态：** Review 修订 / 待与现有 Tool Registry 对齐  
**适用范围：** Agent Tool Registry、Backend Runtime、Desktop Runtime、Local Worker Runtime  
**文档日期：** 2026-08-03  
**最后复核日期：** 2026-08-04

> 本文细化《Cyrene Desktop Demo 产品需求文档》的工具执行模型。主需求决定产品范围，本文决定工具语义与 Runtime 边界；本文不得自行把可选能力升级为 P0。安全与本地权限约束在任何 Runtime 下都不可绕过。

---

## 1. 修订目标

Cyrene 的工具不只在桌面客户端执行。Agent 使用统一 Tool Registry，工具定义明确绑定执行位置，任务可以在服务器、用户电脑或可选本地 Worker 中完成。

本模型需要同时满足：

- Agent 使用统一的工具名称、参数 Schema、结果和状态语义；
- 工具实际执行位置明确，不由模型在调用时任意伪造；
- Backend Runtime 不经过客户端执行；
- Desktop Runtime 只能执行客户端已注册能力，并受本地策略、授权和审计控制；
- Local Worker 由 Electron Main 管理，不能绕过 Desktop 安全边界；
- 后端不能直接访问客户端文件系统、截图、凭据或操作系统 API；
- 前端能够用一致方式展示不同 Runtime 的公开状态。

## 2. Runtime 定义

```text
Tool Runtime
├── Backend Runtime
│   ├── 数据库、服务端文件和日志
│   ├── 外部 API 与网络请求
│   ├── 后端计算、模型及服务端程序
│   └── 由后端自身权限系统管理
├── Desktop Runtime
│   ├── 用户选择或授权的文件
│   ├── 屏幕或窗口截图
│   ├── 受控系统能力
│   └── 由 Electron Main 校验、授权和执行
└── Local Worker Runtime（Demo 可选）
    ├── 本地 OCR、音频和模型推理
    ├── 受信 Worker 提供的固定工具
    └── 由 Electron Main 发现、认证、路由和审计
```

约束：

- Demo 必须支持 Backend 与 Desktop 两种 Runtime 的协议及 UI 区分；
- Local Worker 的领域枚举和降级状态保留，但 Worker 实现是否进入 Demo 需单独确认；
- Runtime 是工具注册属性。后端事件中的 Runtime 必须与服务端 Registry、客户端能力声明及本地注册表一致；
- 模型服务的执行位置是另一套概念，不使用 `ToolRuntime` 冒充。LLM/STT/TTS 可以位于后端、本机或 Local Worker，但只有产生工具调用时才进入本文状态机。

## 3. 统一工具注册模型

后端的 Agent Tool Registry 至少提供以下语义：

```typescript
type ToolRuntime = "backend" | "desktop" | "local_worker";
type ToolRisk = "safe" | "medium" | "high" | "prohibited";

interface ToolDefinition {
  name: string;
  version: string;
  title: string;
  description: string;
  runtime: ToolRuntime;
  riskLevel: ToolRisk;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  timeoutMs: number;
  cancellable: boolean;
}
```

Desktop 和 Local Worker 工具还需要本地权限元数据：

```typescript
interface LocalToolPolicy {
  permissionMode:
    | "automatic"
    | "scoped_or_prompt"
    | "always_prompt"
    | "prohibited";
  grantKinds?: Array<"directory" | "command_template" | "domain">;
  supportedPlatforms: Array<"windows" | "linux">;
}
```

`automatic` 只允许无敏感数据、无外部副作用的本地能力；截图、文件上传、文件写入等不得仅因后端标记为 `safe` 而自动执行。

## 4. 命名和能力声明

工具名称使用带 Runtime/领域前缀的稳定 ID，例如：

```text
backend.log.read
backend.database.query
desktop.file.select
desktop.file.read
desktop.file.write
desktop.screen.capture
local.audio.transcribe
```

规则：

- 名称、版本和 Runtime 组合必须唯一；
- 客户端只声明实际可用的 Desktop/Local Worker 能力；
- 服务端不得调用客户端未声明、已禁用或版本不兼容的能力；
- UI 使用本地化标题，不直接把内部工具 ID 当作权限文案；
- 后端不能传入本地可执行文件、动作资源或实现代码来临时注册工具。

Demo 默认 Desktop P0 工具 ID 为：

1. `desktop.file.select`；
2. `desktop.file.read`；
3. `desktop.file.write`；
4. `desktop.screen.capture`。

`desktop.command.run` 不属于默认 P0。设置页仍需支持查看和撤销已授权命令模板；只有项目明确把命令执行纳入 Demo 后，客户端才注册该工具，且只能执行本地预登记模板，不能接收任意 Shell、PowerShell 或 Bash 字符串。

## 5. 工具选择和路由

```text
用户请求
   ↓
Agent Planner
   ↓
查询 Tool Registry
   ↓
选择已注册工具（Runtime 已绑定）
   ↓
┌────────────────┬──────────────────┬────────────────────┐
│ Backend        │ Desktop          │ Local Worker       │
│ 后端直接执行    │ 发送客户端调用    │ 发送客户端并由 Main 路由 │
└────────────────┴──────────────────┴────────────────────┘
   ↓
统一状态、结果或公开摘要
   ↓
Agent 继续规划；前端按可见性策略更新工具卡片
```

Agent 可以选择工具，但不能在调用时自由改变该工具的 Runtime。若同一业务能力存在多个执行位置，应注册为不同工具或由 Registry 中经过验证的路由策略选择，不能只改事件字段。

## 6. 统一调用协议

传输层可以使用后端现有字段；以下是前端标准语义。Wire 示例使用 `snake_case`，进入前端领域层后由 `BackendAdapter` 转为 `camelCase`。

> **⚠️ 与现行 v2 wire 不符（2026-09-14 复核，实施前必读）：** 上句描述的"wire 是 `snake_case`、由 BackendAdapter 转 camelCase"**不成立**——现行 v2 `tool.request`／`tool.started`／`tool.completed` 帧在 wire 层**就是 camelCase**，
> raw schema 为 `.strict()`（未知键**整帧拒**），并不存在一个把 snake_case 转 camelCase 的适配步骤。
> 字段对照（代码为准）：`call_id`→`callId`、`conversation_id`→`conversationId`、`parent_message_id`→（无此字段）、`tool`→`toolName`、`tool_version`→`toolVersion`、`approval_authority`→`approvalAuthority`、`duration_ms`→`durationMs`；
> 示例里缺的**必填** `sourceCallId`（LLM `tool_call_id`，前端统一领域键）与 `paramHash` 同样必填。实测 `risk_level`／`expires_at` 在 `apps/desktop/src` **0 命中**。
> 权威来源：[doc 02](02-Cyrene-前后端通信协议与前端数据结构-v0.2.md) §17 与 `apps/desktop/src/main/transport/protocol-v2/raw-schemas.ts`／`raw-types.ts`（`RawToolRequest`）。下文示例原文保留作语义草案。

```json
{
  "type": "tool.call",
  "call_id": "call_123",
  "conversation_id": "conv_123",
  "parent_message_id": "msg_456",
  "tool": "desktop.file.read",
  "tool_version": "1.0",
  "runtime": "desktop",
  "arguments": {
    "resource_handle": "local_ref_789"
  },
  "reason": "读取用户选中的项目说明",
  "permission_required": true,
  "approval_authority": "client",
  "expires_at": "2026-08-04T12:00:00Z"
}
```

成功结果：

```json
{
  "type": "tool.result",
  "call_id": "call_123",
  "runtime": "desktop",
  "success": true,
  "result": {
    "content_ref": "attachment_123",
    "size": 1024
  },
  "started_at": "2026-08-04T11:59:10Z",
  "finished_at": "2026-08-04T11:59:11Z"
}
```

失败、拒绝、取消和超时使用同一个终态结果语义，并携带公开错误码。大文件、截图和长结果通过附件引用传输，不直接放入事件 JSON。

协议约束：

- `call_id` 标识一次工具调用，与聊天生成的 `request_id` 分开；
- 相同 `call_id` 的工具名、Runtime、版本或参数摘要发生变化时视为协议错误；
- `permission_required: false` 只是后端提示，不能覆盖客户端本地策略；
- Desktop/Local Worker 输出必须通过工具专属 Schema，再进行大小限制和脱敏；
- 未知工具、Runtime、版本或状态默认安全失败。

## 7. Runtime 处理规则

### 7.1 Backend Runtime

- 后端自行认证、授权和执行；
- 前端只消费后端主动公开的开始、进度、结果摘要和错误；
- 后端如需要用户审批，可以发送明确的“服务器操作审批”事件并接收用户决定；该决定由后端权限系统执行，不能创建或复用客户端本地 Grant；
- 后端未公开过程时，前端不伪造内部步骤；
- 不弹出 Desktop 权限窗口；
- 若执行前需要用户上传本地数据，上传动作仍必须由客户端明确展示并确认；
- 客户端审计只记录收到的公开事件。

### 7.2 Desktop Runtime

Electron Main 按以下顺序处理：

1. 校验事件外壳、大小、协议版本和 `call_id`；
2. 核对客户端本地注册表中的名称、版本、Runtime 和平台；
3. 使用工具专属 Schema 校验参数；
4. 规范化路径、域名或资源句柄；
5. 根据本地工具定义和具体参数重新计算风险；
6. 应用禁止规则、黑名单、范围授权和逐次确认；
7. 执行、取消、超时或拒绝；
8. 校验并过滤输出；
9. 回传结果并写入脱敏审计。

Renderer 只展示公开摘要并提交权限决定，不拥有执行器、凭据、原始路径访问或通用 IPC。

### 7.3 Local Worker Runtime

- 由 Main 启动或发现 Worker；
- 使用本机受限通道和临时会话凭据；
- 验证 Worker 来源、版本和工具清单；
- 只传递最少必要输入；
- Worker 失败时不得未经用户同意自动把本地数据上传到后端；
- 结果仍经过 Main Schema 校验、权限状态机和审计。

## 8. 权限与安全策略

风险级别用于默认策略，不替代具体参数判断：

| 风险 | 示例 | 默认处理 |
|---|---|---|
| safe | 获取应用版本、读取无敏感内容的客户端能力摘要 | 可自动或弱提示 |
| medium | 读取已选择文本、上传文件、截图 | 范围授权或逐次确认；截图始终逐次确认 |
| high | 覆盖文件、敏感范围访问、非只读受控命令 | 强确认或拒绝 |
| prohibited | 任意代码、密钥读取、静默截图、大量删除 | 禁止 |

本地决策顺序：

```text
未注册/禁止工具或非法参数
  > 内置敏感规则
  > 用户路径/域名黑名单
  > 工具强制逐次确认
  > 有效范围授权
  > 沙盒默认策略
  > 请求用户审批
```

范围授权必须绑定工具、后端身份、规范化资源范围、参数约束和有效期，并可在设置页查看和撤销。授权后参数发生变化必须重新审批。

## 9. 状态、幂等和恢复

统一状态：

```text
requested
awaiting_permission
running
completed | failed | rejected | cancelled | timeout
```

规则：

- 终态不可回到执行态；
- 相同 `call_id` 不重复弹窗、不重复写文件、不重复截图；
- 已完成调用可返回之前的结果引用或公开摘要；
- 回传失败时保留本地终态，重连后只重发结果；
- 待审批调用重连后先查询状态，不自动执行；
- 应用重启后不恢复未经用户重新确认的高风险操作；
- 后端取消、用户取消、超时和策略拒绝在审计中使用不同来源。

## 10. 统一审计

```typescript
interface ToolExecutionRecord {
  callId: string;
  toolName: string;
  runtime: ToolRuntime;
  conversationId?: string;
  backendIdentity?: string;
  argumentsSummary: string;
  permissionDecision?: "automatic" | "allow_once" | "allow_scoped" | "deny";
  permissionGrantId?: string;
  status:
    | "running"
    | "completed"
    | "failed"
    | "rejected"
    | "cancelled"
    | "timeout";
  startedAt?: string;
  finishedAt: string;
  errorCode?: string;
}
```

审计不得保存完整文件、截图、录音、聊天正文、Inner Voice/Public Reply、认证 Token、模型密钥或未脱敏参数。Backend Runtime 的记录只反映客户端实际收到的公开状态，不宣称等同于服务端完整审计。

## 11. Demo 范围

P0：

- 前端可以区分并展示 Backend 与 Desktop Runtime；
- 统一 `tool.call/tool.result` 领域语义；
- Desktop 静态能力注册、Schema、权限、幂等和审计；
- 四个 Desktop P0 工具 ID；
- 沙盒目录、路径/域名黑名单、审批历史、范围授权和撤销；
- 已授权命令模板和目录的管理界面及空状态。

需单独确认后才进入 P0：

- `desktop.command.run` 实际执行；
- Local Worker 的安装、生命周期和真实工具执行；
- 剪贴板、程序启动、浏览器自动化、终端或批量文件操作。

明确禁止：

- 后端直接访问客户端文件系统；
- 远程下发任意代码或命令字符串给客户端解释执行；
- 用历史授权覆盖黑名单；
- 未经确认静默截图、持续截图或敏感数据上传；
- Runtime 不匹配时自动改到另一个位置执行。

## 12. 验收标准

- [ ] Tool Registry 中名称、版本、Runtime 和 Schema 唯一且可校验；
- [ ] Backend 工具只在前端显示公开状态，不会进入 Desktop 执行器；
- [ ] Desktop 工具只由 Main 中的本地注册表执行；
- [ ] 未注册、未知 Runtime、版本不兼容和非法参数均安全失败；
- [ ] 后端风险和权限标记不能覆盖本地策略；
- [ ] 四个 Desktop P0 工具使用规范化名称；
- [ ] 同一 `call_id` 不重复产生副作用；
- [ ] 黑名单优先于沙盒和范围授权；
- [ ] 用户可查看审批历史并撤销范围授权；
- [ ] 命令执行未确认时不注册 `desktop.command.run`；启用时也不能执行任意 Shell；
- [ ] Local Worker 失败不会静默上传本地数据作为回退；
- [ ] 工具卡片明确显示执行位置、状态和可公开结果；
- [ ] 客户端审计与日志不包含完整敏感内容。
