# 阶段 6（工具、权限与 Desktop P0）批次 A 实施计划——工具契约与领域层

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地批次 A 代码——工具双轨 wire 四件套（`tool.request`/`tool.started`/`tool.completed` + 过渡期 `action` 兼容帧 + client `tool.status`）、领域事件三件套 + schema 镜像、`ToolCallRecord`（权威键 `sourceCallId`）契约、归档配对（REST + 回放 → `Message.toolCalls`）、mock 双场景 + `submitToolResult` 实装，全部门禁绿（三态=已开发、未联调）。

**Architecture:** 在既有 protocol-v2 四件套模式上扩展：raw types/schemas（`.strict()`）→ FrameMapper 三分支（`tool.request` 经 `redactToolArguments` 脱敏，原始 arguments 永不进 Renderer）→ 领域事件进 `BackendEvent` + `BackendEventSchema` 镜像；`contracts/tool.ts` 重写为 `ToolCallRecord`（id=sourceCallId），`backend.ts` 旧 `ToolResult` 收敛为 `ToolStatusCommand`；rest-mapper 解析 assistant `tool_calls` 骨架 + `pairToolCalls` 纯函数配对（REST 历史页 + real-backend 会话回放两条路径）；mock 发射领域事件（mock 是 adapter 直发 BackendEvent，不经 raw 层）+ `submitToolResult` 实装 + `CYRENE_MOCK_TOOL_HISTORY` seed。

**Tech Stack:** Vue 3 + TypeScript + Vite（renderer）、Electron（Main/Preload）、Pinia、zod（v4，`_def` 判别 API）、Vitest、Node 22.23.0（`source ~/.nvm/nvm.sh && nvm use 22.23.0` 前缀所有 pnpm 命令）。

**Spec:** `docs/superpowers/specs/2026-08-20-phase6-tools-batcha-contract-domain-design.md`（binding authority，本 plan 从 spec 论证；spec §0 D6A-01~09 决策与 §3 详细设计是唯一依据）

## Global Constraints

- **三态纪律**：Mock 驱动工作标「已开发、未联调」；真实 Windows Electron 联调归批次 C/开发者事后。
- **信任边界**（spec §4）：原始 `arguments` 永不进 Renderer（只存 Main：schema 校验输入 + redactor 输入）；事件层只带脱敏 `inputSummary`；安全元数据（arguments/riskLevel/permissionRequired/approvalAuthority/paramHash）不进 `ToolRequestEvent`；`toolVersion`/`expiresAt` 必填直映（review C1/C2）。
- **契约纪律**：wire 变更四件套缺一不可——① `protocol-v2/raw-types.ts` ② `raw-schemas.ts`（`.strict()` 未知字段整帧拒）③ `FrameMapper.mapFrame` ④ `shared/contracts/events.ts` + `shared/schemas/events.ts` 镜像；`generation.completed` 不加 `tool_calls`、`finishReason` 不承载工具语义（D6-04/05，本批不触碰）。
- **`action` 兼容帧**：已知忽略（FrameMapper 返回 null、不告警、不透传 params、不作工具状态源）。
- **领域/协议态分离**（D6A-05）：展示态 `ToolCallStatus` 8 值（requested/awaiting_permission/running/completed/failed/rejected/cancelled/timeout）；协议态 `ToolWireStatus` 6 值（accepted/rejected/running/result/error/cancelled）。本批只用展示态；归档配对 runtime 恒 `'backend'`（D6A-06，缺配对 → completed + 无摘要降级）。
- **mock 是 adapter**：mock 模式 client→server = adapter 方法调用（`submitToolResult` 即「发送 tool.status」），server→client = `emit(BackendEvent)` 领域事件（**不经 raw 层**）；`CYRENE_MOCK_TOOL_FLOW`/`CYRENE_MOCK_TOOL_HISTORY` env 钩子；固定串 `tc_mock_*`/`call_mock_1`/`tc_seed_1`。
- **测试 API 约定**（本仓库实测）：`parseRawFrame`/`parseBackendEvent` 返回 `{success:true,data}|{success:false,error}`，断言 `.success` + `.data`；事件 envelope 字段 `eventId/sequence`；mock `stamp()` 在 emit 时刻打信封。
- 所有 doc 编辑用中文；`apps/desktop/scripts/check-backend-contract.mjs` 的 `WS_V2_FRAME_TYPES` 28→32（未纳 12→8 warn）；13 组 `src/main/fixtures/wire-v2/*.manifest.json` `schemaHash` 全量刷新（新脚本 `apps/desktop/scripts/refresh-wire-manifests.mjs`）。
- 本机 `frontend_contract` 已含新帧（后端本地 HEAD `03a6e882` 未 push）；**永不代 push**；check:contract 以本机为准。
- 全部 pnpm 命令在 `apps/desktop/` 目录或以 `pnpm -F @cyrene/desktop` 运行。

---

### Task 1: 领域模型——`contracts/tool.ts` 重写 + `ToolStatusCommand` 收敛（F-6-05/06）

**Files:**
- Modify: `apps/desktop/src/shared/contracts/tool.ts`（重写：`ToolRuntime`/`ToolCallStatus`/`ToolCallRecord`/`ToolAttachment`，删旧 `ToolCall`/`ToolStatus`）
- Modify: `apps/desktop/src/shared/contracts/backend.ts`（`ToolResult` → `ToolWireStatus` + `ToolStatusCommand`）
- Modify: `apps/desktop/src/main/transport/backend-adapter.ts`（`submitToolResult(input: ToolResult)` → `ToolStatusCommand`）
- Modify: `apps/desktop/src/main/transport/real-backend.ts`（同上签名）
- Modify: `apps/desktop/src/main/transport/mock-backend.ts`（同上签名；body 仍 no-op，Task 6 实装）
- Test: `apps/desktop/tests/unit/contracts-tool.spec.ts`（新，形状断言）

**Interfaces:**
- Consumes: 现有 `shared/contracts/index.ts` `export * from './tool'`（无 importers，已验证旧 `ToolCall`/`ToolStatus` 零引用）。
- Produces:
  - `ToolRuntime = 'backend' | 'desktop' | 'local_worker'`（保留现名）
  - `ToolCallStatus = 'requested'|'awaiting_permission'|'running'|'completed'|'failed'|'rejected'|'cancelled'|'timeout'`（8 态展示）
  - `interface ToolCallRecord { id: string; toolName: string; runtime: ToolRuntime; status: ToolCallStatus; desktopCallId?: string; generationId?: string; conversationId?: string; reason?: string; inputSummary?: string; outputSummary?: string; error?: { code?: string; message?: string }; errorType?: string; truncated?: boolean; durationMs?: number; startedAt?: string; finishedAt?: string }`
  - `interface ToolAttachment { url: string; mimeType: string; label?: string }`
  - `ToolWireStatus`（6 态）+ `interface ToolStatusCommand { callId: string; status: ToolWireStatus; toolName: string; toolVersion: string; runtime: string; paramHash: string; output?: string; error?: { code?: string; message?: string }; attachments?: ToolAttachment[]; executionSummary?: string }`（backend.ts）
  - `BackendAdapter.submitToolResult(input: ToolStatusCommand): Promise<void>`（三实现签名同步）

- [ ] **Step 1: 写失败测试——`tests/unit/contracts-tool.spec.ts`**（纯形状断言；Task 1 是纯契约类型任务，红循环信号用 typecheck——review P-7 修正：不引用任何 Task 3 才有的 schema）

```ts
import { describe, expect, it } from 'vitest'
import type { ToolCallRecord, ToolCallStatus, ToolWireStatus } from '@shared/contracts'

describe('阶段 6 批次 A 领域模型（Task 1）', () => {
  it('ToolCallRecord 权威键 = id（sourceCallId），8 态展示状态闭合', () => {
    const record: ToolCallRecord = { id: 'tc_1', toolName: 'get_time', runtime: 'backend', status: 'completed' }
    expect(record.id).toBe('tc_1')
    const statuses: ToolCallStatus[] = ['requested', 'awaiting_permission', 'running', 'completed', 'failed', 'rejected', 'cancelled', 'timeout']
    expect(statuses).toHaveLength(8)
  })
  it('ToolWireStatus 六态协议态闭合（展示/协议态分离，D6A-05）', () => {
    const statuses: ToolWireStatus[] = ['accepted', 'rejected', 'running', 'result', 'error', 'cancelled']
    expect(statuses).toHaveLength(6)
  })
})
```

- [ ] **Step 2: 运行 typecheck 确认失败（红循环 = 类型缺失，非运行时）**

Run: `cd apps/desktop && source ~/.nvm/nvm.sh && nvm use 22.23.0 >/dev/null && pnpm typecheck`
Expected: FAIL——`ToolCallRecord`/`ToolWireStatus` 尚未定义（tsconfig.node.json include 含 tests/**；`@shared/contracts` 无该导出）。

- [ ] **Step 3: 重写 `shared/contracts/tool.ts`**

```ts
/** 工具 Runtime（与 wire ToolRuntime 对齐；ModelExecutionLocation 是另一概念，勿混用） */
export type ToolRuntime = 'backend' | 'desktop' | 'local_worker'

/** 前端展示状态（doc 04 §4 单向前进；终态不重回执行态；wire tool.status 六态协议态映射见 spec D6A-05） */
export type ToolCallStatus =
  | 'requested' | 'awaiting_permission' | 'running'
  | 'completed' | 'failed' | 'rejected' | 'cancelled' | 'timeout'

/** 统一工具调用记录（权威键 id = sourceCallId = LLM tool_call_id，D6-03；实时易失 / 归档持久共型）。
 * toolVersion 有意不进记录（归档 wire 无版本源；批次 B tool.status 回传一致性由 Main 自 raw 缓存取值，D6-07）。 */
export interface ToolCallRecord {
  id: string
  toolName: string
  runtime: ToolRuntime
  status: ToolCallStatus
  desktopCallId?: string
  generationId?: string
  conversationId?: string
  reason?: string
  inputSummary?: string
  outputSummary?: string
  error?: { code?: string; message?: string }
  errorType?: string
  truncated?: boolean
  durationMs?: number
  startedAt?: string
  finishedAt?: string
}

/** 工具结果附件引用（wire ToolAttachment 直映） */
export interface ToolAttachment {
  url: string
  mimeType: string
  label?: string
}
```

- [ ] **Step 4: `shared/contracts/backend.ts` 收敛旧占位**

删除尾部 `export interface ToolResult { callId: string; status: 'completed'|'failed'|'rejected'|'cancelled'|'timeout'; summary?: string }`，替换为：

```ts
import type { ToolAttachment } from './tool'
// —— 阶段 6 批次 A（F-6-06）：桌面工具状态回传命令（Main 组装、Renderer 不可见，D6-07）——
/** wire tool.status 六态协议态（与展示态 ToolCallStatus 分离，D6A-05） */
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
  attachments?: ToolAttachment[]
  executionSummary?: string
}
```

- [ ] **Step 5: 三处 `submitToolResult` 签名同步**

`backend-adapter.ts` 接口与 `real-backend.ts`/`mock-backend.ts` 实现：`ToolResult` 导入改 `ToolStatusCommand`，参数类型改 `input: ToolStatusCommand`；mock body 保持 `{}` no-op（Task 6 实装）；real body 保持 `throw this.notImplemented('submitToolResult')`。`grep -rn "ToolResult" apps/desktop/src` 应仅剩 tool.ts 无、backend.ts 新定义、其余零残留。

- [ ] **Step 6: 运行测试 + typecheck**

Run: `cd apps/desktop && source ~/.nvm/nvm.sh && nvm use 22.23.0 >/dev/null && pnpm test -- tests/unit/contracts-tool.spec.ts && pnpm typecheck`
Expected: PASS + typecheck 无错（TS2353/2305 零；`ToolResult` 全仓零残留——`grep -rn "ToolResult" apps/desktop/src` 仅剩 backend.ts 无、新 `ToolStatusCommand` 定义）。

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/shared/contracts/tool.ts apps/desktop/src/shared/contracts/backend.ts apps/desktop/src/main/transport/backend-adapter.ts apps/desktop/src/main/transport/real-backend.ts apps/desktop/src/main/transport/mock-backend.ts apps/desktop/tests/unit/contracts-tool.spec.ts
git commit -m "feat(阶段6批次A Task1): 领域模型——ToolCallRecord 权威键 sourceCallId 契约 + ToolResult 收敛 ToolStatusCommand（D6A-05 展示/协议态分离）"
```

---

### Task 2: raw wire 四件套 + fixture manifest 刷新 + check:contract（F-6-01/02）

**Files:**
- Modify: `apps/desktop/src/main/transport/protocol-v2/raw-types.ts`（`RawToolRuntime`/`RawToolRequest`/`RawToolStarted`/`RawToolCompleted`/`RawAction`/`RawToolAttachment`/`RawToolStatus` + `RawFrame`/`RawClientFrame` 联合增员）
- Modify: `apps/desktop/src/main/transport/protocol-v2/raw-schemas.ts`（六 schema + `RawFrameSchema`/`RawClientFrameSchema` 增员）
- Create: `apps/desktop/scripts/refresh-wire-manifests.mjs`（schemaHash 全量刷新工具）
- Modify: `apps/desktop/scripts/check-backend-contract.mjs`（`WS_V2_FRAME_TYPES` 28→32）
- Modify: `apps/desktop/src/main/fixtures/wire-v2/*.manifest.json`（13 组 schemaHash，经脚本刷新）
- Test: `apps/desktop/tests/unit/raw-schemas.spec.ts`、`apps/desktop/tests/unit/wire-fixtures.spec.ts`

**Interfaces:**
- Consumes: `parseRawFrame`（raw-schemas.ts:343-351，返回 `{success,data}|{success:false,error}`）、`RAW_FRAME_TYPES`（自动推导）、`rawSchemasFingerprint()`（manifest 门禁）、`RawClientFrameSchema`。
- Produces: 六 raw 类型 + 四 Server 帧 schema（进 `RawFrameSchema`）+ `RawToolStatusSchema`（进 `RawClientFrameSchema`）；`WS_V2_FRAME_TYPES` 32 型；13 组 manifest schemaHash = 新指纹。

- [ ] **Step 1: 写失败测试——raw-schemas.spec.ts 增「阶段 6 批次 A（F-6-01/02）」describe 块**

```ts
describe('阶段 6 批次 A 工具帧（Task 2）', () => {
  const validRequest = {
    type: 'tool.request', callId: 'call_1', toolName: 'desktop.file.read', toolVersion: '1.0',
    runtime: 'desktop', sourceCallId: 'tc_1', arguments: { resource_handle: 'h' },
    reason: '读取用户选中的文件', riskLevel: 'medium', permissionRequired: true,
    approvalAuthority: 'client', paramHash: 'abc123', expiresAt: '2026-08-20T12:00:00Z', requestId: 'req_1'
  }
  it('tool.request 合法帧全字段通过；sourceCallId 缺省拒；runtime 非法拒；未知字段整帧拒', () => {
    expect(parseRawFrame(validRequest).success).toBe(true)
    const noSource = { ...validRequest }
    delete (noSource as { sourceCallId?: string }).sourceCallId
    expect(parseRawFrame(noSource).success).toBe(false)
    expect(parseRawFrame({ ...validRequest, runtime: 'cloud' }).success).toBe(false)
    expect(parseRawFrame({ ...validRequest, unknown_field: 1 }).success).toBe(false)
  })
  it('tool.started/tool.completed 合法 + strict 拒未知字段；success 必填', () => {
    expect(parseRawFrame({ type: 'tool.started', callId: 'tc_1', toolName: 'get_time', runtime: 'backend', inputSummary: 'query=<redacted>' }).success).toBe(true)
    expect(parseRawFrame({ type: 'tool.completed', callId: 'tc_1', toolName: 'get_time', runtime: 'backend', success: true, outputSummary: '2026-08-20', durationMs: 12.5 }).success).toBe(true)
    expect(parseRawFrame({ type: 'tool.completed', callId: 'tc_1', toolName: 'get_time', runtime: 'backend' }).success).toBe(false) // success 必填
    expect(parseRawFrame({ type: 'tool.started', callId: 'tc_1', toolName: 'get_time', runtime: 'backend', extra: 1 }).success).toBe(false)
  })
  it('action 兼容帧（旧 trace 形状）通过；tool.status client 帧六态 + runtime str 放行', () => {
    expect(parseRawFrame({ type: 'action', action: 'tool_executing', params: { tool: 'save_memory', call_id: 'call_1' } }).success).toBe(true)
    expect(parseRawClientFrame({ type: 'tool.status', callId: 'call_1', status: 'result', toolName: 'desktop.file.read', toolVersion: '1.0', runtime: 'desktop', paramHash: 'h', output: 'ok' }).success).toBe(true)
    expect(parseRawClientFrame({ type: 'tool.status', callId: 'call_1', status: 'accepted', toolName: 'x', toolVersion: '1', runtime: 'desktop', paramHash: 'h' }).success).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/desktop && source ~/.nvm/nvm.sh && nvm use 22.23.0 >/dev/null && pnpm test -- tests/unit/raw-schemas.spec.ts`
Expected: FAIL（tool.request 未入 RawFrameSchema → discriminatedUnion 不收 → parse 失败）。

- [ ] **Step 3: raw-types.ts 新增类型 + 联合增员**

按 spec §3.1 原文逐字落 `RawToolRuntime`/`RawToolRequest`/`RawToolStarted`/`RawToolCompleted`/`RawAction`/`RawToolAttachment`/`RawToolStatus`（含中文注释标注「阶段 6 批次 A（F-6-01）」）；`RawClientFrame` 联合末尾增 `| RawToolStatus`；`RawFrame` 联合末尾增 `| RawToolRequest | RawToolStarted | RawToolCompleted | RawAction`。

- [ ] **Step 4: raw-schemas.ts 新增六 schema + 联合增员 + 既有计数断言更新**

按 spec §3.2 原文逐字落 `RawToolRuntimeSchema`/`RawToolRequestSchema`（`.strict()`，sourceCallId min(1) 必填、riskLevel str、permissionRequired/approvalAuthority/paramHash/expiresAt 必填）/`RawToolStartedSchema`/`RawToolCompletedSchema`（success 必填、error `z.record(z.string(), z.unknown()).optional()`、durationMs `z.number().optional()`）/`RawActionSchema`/`RawToolAttachmentSchema`/`RawToolStatusSchema`（status 六态枚举、runtime `z.string()`）；`RawFrameSchema` discriminatedUnion 增 4 成员、`RawClientFrameSchema` 增 1 成员。

**同时更新 `tests/unit/raw-schemas.spec.ts` 既有 `RAW_FRAME_TYPES` 计数断言**（review P-12：29 → **33**，新增 'action'/'tool.completed'/'tool.request'/'tool.started' 四项；排序数组在 'state'/'switch_model_result' 之后、'typing' 之前插入 'tool.completed'/'tool.request'/'tool.started'，'action' 在 'audio' 之前）——标题注释同步「29(阶段5 批次C) → 33(阶段6 批次A 工具帧+action)」。

- [ ] **Step 5: 运行测试——fingerprint 变化使 wire-fixtures.spec.ts 红（预期）**

Run: `cd apps/desktop && source ~/.nvm/nvm.sh && nvm use 22.23.0 >/dev/null && pnpm test -- tests/unit/raw-schemas.spec.ts tests/unit/wire-fixtures.spec.ts`
Expected: raw-schemas.spec PASS；wire-fixtures.spec FAIL（manifest schemaHash ≠ 新指纹——门禁如预期拦截）。

- [ ] **Step 6: 新建 `scripts/refresh-wire-manifests.mjs` 并刷新 13 组 manifest**

```javascript
#!/usr/bin/env node
// 刷新全部 wire fixture manifest 的 schemaHash 为当前 rawSchemasFingerprint()（阶段 6 批次 A Task 2 起；schema 变更后运行）
import { readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { rawSchemasFingerprint } from '../src/main/transport/protocol-v2/raw-schemas.ts'

const dir = join(import.meta.dirname, '../src/main/fixtures/wire-v2')
const fp = rawSchemasFingerprint()
let n = 0
for (const f of readdirSync(dir).filter((f) => f.endsWith('.manifest.json'))) {
  const p = join(dir, f)
  const m = JSON.parse(readFileSync(p, 'utf8'))
  m.schemaHash = fp
  writeFileSync(p, JSON.stringify(m) + '\n', 'utf8')
  n += 1
}
console.log(`[refresh-wire-manifests] ${n} manifests → ${fp}`)
```

Run: `cd apps/desktop && source ~/.nvm/nvm.sh && nvm use 22.23.0 >/dev/null && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/refresh-wire-manifests.mjs`
Expected: `[refresh-wire-manifests] 13 manifests → <新指纹>`；`git diff` 确认 13 组 manifest 仅 schemaHash 变化。

- [ ] **Step 7: check:contract `WS_V2_FRAME_TYPES` 28→32**

`scripts/check-backend-contract.mjs` 的 `WS_V2_FRAME_TYPES` 数组末尾（`'audio_cancelled'` 后）增：

```javascript
  // 阶段6 批次A（F-6-02）：工具双轨帧 + 过渡期 action 兼容帧，28 型 → 32 型
  'tool.request', 'tool.started', 'tool.completed', 'action'
```

- [ ] **Step 8: 全量运行门禁**

Run: `cd apps/desktop && source ~/.nvm/nvm.sh && nvm use 22.23.0 >/dev/null && pnpm test -- tests/unit/raw-schemas.spec.ts tests/unit/wire-fixtures.spec.ts && pnpm typecheck && pnpm -F @cyrene/desktop check:contract`
Expected: 全 PASS；check:contract 输出格式为 `[check-contract] WS v2 type 覆盖: 32/32 通过;字段级帧 … 条完整保留;未纳帧 8 个有意滞后(warn)` + `REST 段 15/15 模型通过`（review P-11：按实际格式核对，勿按 32/32 单串判断）。

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/main/transport/protocol-v2/raw-types.ts apps/desktop/src/main/transport/protocol-v2/raw-schemas.ts apps/desktop/scripts/refresh-wire-manifests.mjs apps/desktop/scripts/check-backend-contract.mjs apps/desktop/src/main/fixtures/wire-v2 apps/desktop/tests/unit/raw-schemas.spec.ts
git commit -m "feat(阶段6批次A Task2): raw wire 四件套——tool.request/started/completed + action 兼容帧 + client tool.status（.strict 镜像契约，WS 28→32）+ fixture manifest 刷新脚本"
```

---

### Task 3: 领域事件三件套 + BackendEventSchema 镜像（F-6-03）

**Files:**
- Modify: `apps/desktop/src/shared/contracts/events.ts`（`ToolRequestEvent`/`ToolStartedEvent`/`ToolCompletedEvent` + `BackendEvent` 联合增员；import `ToolRuntime`）
- Modify: `apps/desktop/src/shared/schemas/events.ts`（三 schema + `BackendEventSchema` 增员）
- Test: `apps/desktop/tests/unit/schemas.spec.ts`

**Interfaces:**
- Consumes: `BackendEventEnvelope`（events.ts:4-8）、`BackendEventSchema`（schemas/events.ts:184-207，`z.discriminatedUnion('event',...)`）、`parseBackendEvent`（schemas/events.ts:209-217）、Task 1 的 `ToolRuntime`。
- Produces: 三事件（spec §3.3 逐字形状——`ToolRequestEvent` 含 `toolVersion: string`/`expiresAt: string` 必填直映、无 arguments/安全元数据）+ `BackendEventSchema` 三镜像成员（`.strict()`）。

- [ ] **Step 1: 写失败测试——schemas.spec.ts 增「阶段 6 批次 A（F-6-03）」describe 块**

```ts
describe('阶段 6 批次 A 工具事件 schema 镜像（Task 3）', () => {
  it('三新事件合法样例经 parseBackendEvent 通过（envelope 必填）', () => {
    const req = { eventId: 'c:1', sequence: 1, event: 'tool.request', callId: 'call_1', sourceCallId: 'tc_1', toolName: 'desktop.file.read', toolVersion: '1.0', runtime: 'desktop', expiresAt: '2026-08-20T12:00:00Z' }
    const started = { eventId: 'c:2', sequence: 2, event: 'tool.started', callId: 'tc_1', toolName: 'get_time', runtime: 'backend' }
    const completed = { eventId: 'c:3', sequence: 3, event: 'tool.completed', callId: 'tc_1', toolName: 'get_time', runtime: 'backend', success: true, outputSummary: '2026-08-20', durationMs: 12.5 }
    for (const e of [req, started, completed]) {
      const r = parseBackendEvent(e)
      expect(r.success, JSON.stringify(e)).toBe(true)
    }
  })
  it('必填字段缺失拒绝（sourceCallId/expiresAt/toolVersion/success）', () => {
    expect(parseBackendEvent({ eventId: 'c:1', sequence: 1, event: 'tool.request', callId: 'call_1', toolName: 'x', toolVersion: '1.0', runtime: 'desktop', expiresAt: 't' }).success).toBe(false) // sourceCallId 缺
    expect(parseBackendEvent({ eventId: 'c:1', sequence: 1, event: 'tool.request', callId: 'call_1', sourceCallId: 'tc_1', toolName: 'x', toolVersion: '1.0', runtime: 'desktop' }).success).toBe(false) // expiresAt 缺
    expect(parseBackendEvent({ eventId: 'c:3', sequence: 3, event: 'tool.completed', callId: 'tc_1', toolName: 'get_time', runtime: 'backend' }).success).toBe(false) // success 缺
  })
  it('tool.request 事件不含安全元数据字段（D6-07）', () => {
    const r = parseBackendEvent({ eventId: 'c:1', sequence: 1, event: 'tool.request', callId: 'call_1', sourceCallId: 'tc_1', toolName: 'desktop.file.read', toolVersion: '1.0', runtime: 'desktop', expiresAt: 't', arguments: { path: '/etc/passwd' } })
    expect(r.success).toBe(false) // strict：arguments 未知字段整帧拒——事件模型无该字段
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/desktop && source ~/.nvm/nvm.sh && nvm use 22.23.0 >/dev/null && pnpm test -- tests/unit/schemas.spec.ts`
Expected: FAIL（判别联合无 tool.request 成员）。

- [ ] **Step 3: events.ts 新增三事件 + 联合增员**

按 spec §3.3 逐字（`ToolRequestEvent` 含 `callId`/`sourceCallId`/`toolName`/`toolVersion: string`/`runtime: ToolRuntime`/`reason?`/`inputSummary?`/`expiresAt: string`/`requestId?`；`ToolStartedEvent`/`ToolCompletedEvent` 按 spec）；`import type { ToolRuntime } from './tool'`；`BackendEvent` 联合末尾增三成员（注释「—— 阶段 6 批次 A（F-6-03）」）。

- [ ] **Step 4: schemas/events.ts 镜像三 schema + 联合增员**

按 spec §3.3 镜像形状（`ToolRequestEventSchema` `.strict()` 含 toolVersion/expiresAt `z.string().min(1)`；`ToolCompletedEventSchema` error `z.object({code: z.string().optional(), message: z.string().optional()}).optional()`、durationMs `z.number().optional()`）；`BackendEventSchema` discriminatedUnion 增三成员。

- [ ] **Step 5: 运行测试 + typecheck**

Run: `cd apps/desktop && source ~/.nvm/nvm.sh && nvm use 22.23.0 >/dev/null && pnpm test -- tests/unit/schemas.spec.ts && pnpm typecheck`
Expected: PASS + typecheck 无错。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/shared/contracts/events.ts apps/desktop/src/shared/schemas/events.ts apps/desktop/tests/unit/schemas.spec.ts
git commit -m "feat(阶段6批次A Task3): 工具领域事件三件套 + BackendEventSchema 镜像（缺镜像 preload 丢帧，P4-B 先例；tool.request 无安全元数据字段）"
```

---

### Task 4: FrameMapper 三分支 + `redactToolArguments` 脱敏（F-6-04）

**Files:**
- Create: `apps/desktop/src/main/tools/input-summary.ts`（`redactToolArguments` 纯函数）
- Modify: `apps/desktop/src/main/transport/protocol-v2/frame-mapper.ts`（`mapFrame` 增 tool.request/started/completed + action null；`mapToolRequest`/`mapToolStarted`/`mapToolCompleted`）
- Test: `apps/desktop/tests/unit/tool-input-summary.spec.ts`（新）、`apps/desktop/tests/unit/frame-mapper.spec.ts`

**Interfaces:**
- Consumes: `FrameMapper.mapFrame(frame): BackendEvent | null`（frame-mapper.ts:42）、`this.envelope()`（frame-mapper.ts:105-108）、Task 1 `ToolRuntime`、Task 2 raw 类型。
- Produces:
  - `redactToolArguments(raw: Record<string, unknown>): string | undefined`（敏感 13 键 `<redacted>`/deny-by-default `<str:N>`/类型名/空 dict → undefined）
  - `mapToolRequest` → `ToolRequestEvent`（arguments/riskLevel/permissionRequired/approvalAuthority/paramHash 不进事件；toolVersion/expiresAt 直映）
  - `mapToolStarted`/`mapToolCompleted` → 直映（error record → `{code?, message?}` 提取已知键）
  - `action` → `null`（不告警）

- [ ] **Step 1: 写失败测试——tool-input-summary.spec.ts（新）**

```ts
import { describe, expect, it } from 'vitest'
import { redactToolArguments } from '../../src/main/tools/input-summary'

describe('redactToolArguments（Task 4 / F-6-04，镜像后端 _safe_arg_summary）', () => {
  it('敏感 13 键（含大小写）恒 <redacted>', () => {
    const keys = ['token', 'Key', 'password', 'secret', 'authorization', 'cookie', 'content', 'prompt', 'path', 'base_url', 'URL', 'query', 'api_key']
    const input = Object.fromEntries(keys.map((k) => [k, 'secret-value']))
    const out = redactToolArguments(input)
    expect(out).toBe(keys.map((k) => `${k}=<redacted>`).join(', '))
  })
  it('deny-by-default：普通字符串只记 <str:N>；数字/布尔/对象/数组/null 按类型', () => {
    expect(redactToolArguments({ message: '你好世界' })).toBe('message=<str:4>')
    expect(redactToolArguments({ n: 42, ok: true, o: { a: 1 }, arr: [1], nil: null })).toBe('n=<number>, ok=<boolean>, o=<dict>, arr=<list>, nil=<NoneType>')
  })
  it('空 dict → undefined；多字段拼接用 ", "', () => {
    expect(redactToolArguments({})).toBeUndefined()
    expect(redactToolArguments({ a: 'x', b: 1 })).toBe('a=<str:1>, b=<number>')
  })
})
```

- [ ] **Step 2: 写失败测试——frame-mapper.spec.ts 增 describe 块**

```ts
describe('阶段 6 批次 A 工具帧映射（Task 4）', () => {
  it('tool.started → ToolStartedEvent（直映）', () => {
    const ev = new FrameMapper({ connectionId: 'conn-1' }).mapFrame({ type: 'tool.started', callId: 'tc_1', toolName: 'get_time', runtime: 'backend', inputSummary: 'q=<redacted>', generationId: 'gen-1' }) as ToolStartedEvent
    expect(ev.event).toBe('tool.started')
    expect(ev.callId).toBe('tc_1')
    expect(ev.inputSummary).toBe('q=<redacted>')
    expect(ev.generationId).toBe('gen-1')
  })
  it('tool.completed success/失败 → ToolCompletedEvent（error record 提取 code/message）', () => {
    const ok = new FrameMapper({ connectionId: 'c' }).mapFrame({ type: 'tool.completed', callId: 'tc_1', toolName: 'get_time', runtime: 'backend', success: true, outputSummary: '2026-08-20', durationMs: 12.5 }) as ToolCompletedEvent
    expect(ok.success).toBe(true)
    expect(ok.outputSummary).toBe('2026-08-20')
    const fail = new FrameMapper({ connectionId: 'c' }).mapFrame({ type: 'tool.completed', callId: 'tc_1', toolName: 'web_search', runtime: 'backend', success: false, error: { code: 'NETWORK', message: '超时', extra: 1 } }) as ToolCompletedEvent
    expect(fail.success).toBe(false)
    expect(fail.error).toEqual({ code: 'NETWORK', message: '超时' }) // 未知键不透传
  })
  it('tool.request → ToolRequestEvent 脱敏 emit（arguments/安全元数据不在事件内；toolVersion/expiresAt 必填直映）', () => {
    const ev = new FrameMapper({ connectionId: 'c' }).mapFrame({ type: 'tool.request', callId: 'call_1', toolName: 'desktop.file.read', toolVersion: '1.0', runtime: 'desktop', sourceCallId: 'tc_1', arguments: { path: '/etc/passwd', resource_handle: 'h' }, reason: '读取文件', riskLevel: 'medium', permissionRequired: true, approvalAuthority: 'client', paramHash: 'h', expiresAt: '2026-08-20T12:00:00Z', requestId: 'req_1' }) as ToolRequestEvent
    expect(ev.event).toBe('tool.request')
    expect(ev.sourceCallId).toBe('tc_1')
    expect(ev.toolVersion).toBe('1.0')
    expect(ev.expiresAt).toBe('2026-08-20T12:00:00Z')
    expect(ev.inputSummary).toBe('path=<redacted>, resource_handle=<str:1>')
    expect('arguments' in ev).toBe(false)
    expect('riskLevel' in ev).toBe(false)
    expect('paramHash' in ev).toBe(false)
  })
  it('action → null 且不告警（onProtocolWarning 未被调用）', () => {
    const warnings: string[] = []
    const mapper = new FrameMapper({ connectionId: 'c', onProtocolWarning: (w) => warnings.push(w.code) })
    expect(mapper.mapFrame({ type: 'action', action: 'tool_executing', params: { tool: 'save_memory' } })).toBeNull()
    expect(warnings).toHaveLength(0)
  })
})
```

- [ ] **Step 3: 运行两个测试确认失败**

Run: `cd apps/desktop && source ~/.nvm/nvm.sh && nvm use 22.23.0 >/dev/null && pnpm test -- tests/unit/tool-input-summary.spec.ts tests/unit/frame-mapper.spec.ts`
Expected: FAIL（模块不存在 / mapFrame 无分支）。

- [ ] **Step 4: 新建 `main/tools/input-summary.ts`**

```ts
/** 工具参数安全摘要（镜像后端 Module/tool/safety.py `_safe_arg_summary`，D6A-04/spec §3.4）。
 * 敏感键恒 <redacted>；deny-by-default：所有字符串值只记 <str:N>（白名单恒空）；非字符串按类型名；
 * 输出 "k=v, k=v" 拼接；空 dict → undefined。 */
const REDACTED_KEYS = new Set([
  'token', 'key', 'password', 'secret', 'authorization', 'cookie',
  'content', 'prompt', 'path', 'base_url', 'url', 'query', 'api_key'
])

function typeName(v: unknown): string {
  if (v === null) return 'NoneType'
  if (Array.isArray(v)) return 'list'
  if (typeof v === 'object') return 'dict'
  return typeof v
}

export function redactToolArguments(raw: Record<string, unknown>): string | undefined {
  const keys = Object.keys(raw)
  if (keys.length === 0) return undefined
  return keys.map((k) => {
    const v = raw[k]
    if (REDACTED_KEYS.has(k.toLowerCase())) return `${k}=<redacted>`
    if (typeof v === 'string') return `${k}=<str:${v.length}>`
    return `${k}=<${typeName(v)}>`
  }).join(', ')
}
```

- [ ] **Step 5: frame-mapper.ts 三分支 + action null + 三个 map 方法**

`mapFrame` switch 增（置于 `live2d.directive` 分支后）：

```ts
      // —— 阶段 6 批次 A（F-6-04）：工具双轨（D6-01~08）——
      case 'tool.request':
        return this.mapToolRequest(frame)
      case 'tool.started':
        return this.mapToolStarted(frame)
      case 'tool.completed':
        return this.mapToolCompleted(frame)
      case 'action':
        return null // 已知忽略（D6A-03：v2 已停发，不告警、不作工具状态源）
```

私有方法（imports：`ToolRequestEvent`/`ToolStartedEvent`/`ToolCompletedEvent` from '@shared/contracts/events'、`redactToolArguments` from '../../tools/input-summary'）：

```ts
  /** tool.request raw 帧 → 脱敏公开事件（原始 arguments/安全元数据永不进 Renderer，D6-07；toolVersion/expiresAt 必填直映） */
  private mapToolRequest(frame: Extract<RawFrame, { type: 'tool.request' }>): ToolRequestEvent {
    const inputSummary = redactToolArguments(frame.arguments)
    return {
      ...this.envelope(),
      event: 'tool.request',
      callId: frame.callId,
      sourceCallId: frame.sourceCallId,
      toolName: frame.toolName,
      toolVersion: frame.toolVersion,
      runtime: frame.runtime,
      ...(frame.reason !== undefined ? { reason: frame.reason } : {}),
      ...(inputSummary !== undefined ? { inputSummary } : {}),
      expiresAt: frame.expiresAt,
      ...(frame.requestId !== undefined ? { requestId: frame.requestId } : {})
    }
  }

  /** tool.started → ToolStartedEvent（直映） */
  private mapToolStarted(frame: Extract<RawFrame, { type: 'tool.started' }>): ToolStartedEvent {
    return {
      ...this.envelope(),
      event: 'tool.started',
      callId: frame.callId,
      toolName: frame.toolName,
      runtime: frame.runtime,
      ...(frame.inputSummary !== undefined ? { inputSummary: frame.inputSummary } : {}),
      ...(frame.generationId !== undefined ? { generationId: frame.generationId } : {}),
      ...(frame.conversationId !== undefined ? { conversationId: frame.conversationId } : {})
    }
  }

  /** tool.completed → ToolCompletedEvent（error record 只提取已知键 code/message） */
  private mapToolCompleted(frame: Extract<RawFrame, { type: 'tool.completed' }>): ToolCompletedEvent {
    const err = frame.error
    return {
      ...this.envelope(),
      event: 'tool.completed',
      callId: frame.callId,
      toolName: frame.toolName,
      runtime: frame.runtime,
      success: frame.success,
      ...(frame.outputSummary !== undefined ? { outputSummary: frame.outputSummary } : {}),
      ...(err !== undefined ? { error: { ...(typeof err.code === 'string' ? { code: err.code } : {}), ...(typeof err.message === 'string' ? { message: err.message } : {}) } } : {}),
      ...(frame.errorType !== undefined ? { errorType: frame.errorType } : {}),
      ...(frame.durationMs !== undefined ? { durationMs: frame.durationMs } : {}),
      ...(frame.truncated !== undefined ? { truncated: frame.truncated } : {}),
      ...(frame.generationId !== undefined ? { generationId: frame.generationId } : {}),
      ...(frame.conversationId !== undefined ? { conversationId: frame.conversationId } : {})
    }
  }
```

- [ ] **Step 6: 运行两个测试 + typecheck**

Run: `cd apps/desktop && source ~/.nvm/nvm.sh && nvm use 22.23.0 >/dev/null && pnpm test -- tests/unit/tool-input-summary.spec.ts tests/unit/frame-mapper.spec.ts && pnpm typecheck`
Expected: 全 PASS + typecheck 无错。

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/tools/input-summary.ts apps/desktop/src/main/transport/protocol-v2/frame-mapper.ts apps/desktop/tests/unit/tool-input-summary.spec.ts apps/desktop/tests/unit/frame-mapper.spec.ts
git commit -m "feat(阶段6批次A Task4): FrameMapper 工具三分支 + redactToolArguments 脱敏（原始 arguments/安全元数据不进 Renderer，D6-07）+ action 已知忽略"
```

---

### Task 5: 归档配对——`Message.toolCalls` + `pairToolCalls` + 双路径接线（F-6-19/20/21）

**Files:**
- Modify: `apps/desktop/src/shared/contracts/message.ts`（assistant `Message` 增 `toolCalls?: ToolCallRecord[]`）
- Modify: `apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts`（`MessageSource.tool_calls` + `parseToolCallSkeletons` + `pairToolCalls` + 三调用点）
- Modify: `apps/desktop/src/main/transport/real-backend.ts`（`handleSession` 回放数组组装后接 `pairToolCalls`）
- Test: `apps/desktop/tests/unit/rest-mapper-tools.spec.ts`（新）

**Interfaces:**
- Consumes: `Message`（message.ts）、`MessageToolInfo`（message.ts:95-105）、`RawSessionMessageItem.tool_calls`/`RestMessage.tool_calls`（`unknown[]`）、`RestMapper.toDomainMessage`/`toDomainMessageFromReplay`/`toMessagePage`/`toMessagePageFromContext`（rest-mapper.ts）。
- Produces:
  - `Message.toolCalls?: ToolCallRecord[]`（assistant 消息）
  - `parseToolCallSkeletons(raw: unknown[] | undefined): ToolCallRecord[]`（内部；`{id, function:{name, arguments}}` 契约形状，arguments JSON 串不解析；非结构条目跳过）
  - `pairToolCalls(messages: Message[]): Message[]`（导出纯函数：role=tool 结果按 `tool.callId` 配对骨架；success 缺省视为 true；缺配对保持 completed + 无摘要降级；同 id 幂等）
  - 调用点：`toMessagePage`/`toMessagePageFromContext` 映射数组后 + `real-backend.handleSession` 回放数组后（**本批必做接线**，review F3）

- [ ] **Step 1: 写失败测试——rest-mapper-tools.spec.ts（新）**

```ts
import { describe, expect, it } from 'vitest'
import { RestMapper, pairToolCalls } from '../../src/main/transport/protocol-v2/rest-mapper'
import type { Message } from '@shared/contracts/message'
import type { RestMessage } from '../../src/main/transport/protocol-v2/rest-types'
import type { RawSessionMessageItem } from '../../src/main/transport/protocol-v2/raw-types'

const mapper = new RestMapper()
const asRest = (raw: unknown): RestMessage => raw as unknown as RestMessage // review P-10：显式类型，不用 as never

describe('归档 tool_calls 骨架解析（Task 5 / F-6-19）', () => {
  it('assistant tool_calls 骨架解析（ToolCallData 形状；arguments JSON 串不解析）；tool 角色消息保留 MessageToolInfo 不进 toolCalls', () => {
    const raw = {
      role: 'assistant', message_id: 'msg-1', timestamp: '2026-08-19T00:00:00.000Z',
      content: '正在调用工具',
      tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'get_time', arguments: '{}' } }]
    }
    const m = mapper.toDomainMessage(asRest(raw), 'conv-1')
    expect(m.toolCalls).toEqual([{ id: 'tc_1', toolName: 'get_time', runtime: 'backend', status: 'completed' }])
    const toolRaw = { role: 'tool', message_id: 'msg-2', timestamp: '2026-08-19T00:00:01.000Z', content: 'ok', tool_call_id: 'tc_1', name: 'get_time', success: true }
    const t = mapper.toDomainMessage(asRest(toolRaw), 'conv-1')
    expect(t.tool).toEqual({ callId: 'tc_1', name: 'get_time', success: true })
    expect(t.toolCalls).toBeUndefined()
  })
  it('非结构 tool_calls 条目静默跳过（不整段拒）；同 id 幂等去重（后见忽略，review P-17）', () => {
    const m = mapper.toDomainMessage(asRest({ role: 'assistant', message_id: 'm', timestamp: 't', tool_calls: [{ bad: 1 }, 'x', { id: 'tc_2', function: { name: 'ok', arguments: '{}' } }, { id: 'tc_2', function: { name: 'dup', arguments: '{}' } }] }), 'c')
    expect(m.toolCalls).toEqual([{ id: 'tc_2', toolName: 'ok', runtime: 'backend', status: 'completed' }])
  })
})

describe('pairToolCalls 配对（Task 5 / F-6-19/21）', () => {
  const mkSkeleton = (): Message => ({ messageId: 'm1', conversationId: 'c', role: 'assistant', createdAt: 't0', status: 'completed', toolCalls: [{ id: 'tc_1', toolName: 'get_time', runtime: 'backend', status: 'completed' }] })
  // review R2-2：pairToolCalls 原地修改 assistant 消息 → skeleton 每用例 mkSkeleton() 重建（resultOk 只读不共享变异）
  const resultOk: Message = { messageId: 'm2', conversationId: 'c', role: 'tool', createdAt: 't1', status: 'completed', content: '2026-08-20', tool: { callId: 'tc_1', name: 'get_time', success: true, durationMs: 5 } }
  it('配对成功 → completed + outputSummary + durationMs + finishedAt', () => {
    const out = pairToolCalls([mkSkeleton(), resultOk])
    expect(out[0].toolCalls?.[0]).toMatchObject({ status: 'completed', outputSummary: '2026-08-20', durationMs: 5, finishedAt: 't1' })
  })
  it('配对失败（success:false）→ failed + error/errorType', () => {
    const fail = pairToolCalls([mkSkeleton(), { ...resultOk, content: undefined, tool: { callId: 'tc_1', name: 'get_time', success: false, error: '超时', errorType: 'TIMEOUT' } }])
    expect(fail[0].toolCalls?.[0]).toMatchObject({ status: 'failed', error: { code: 'TIMEOUT', message: '超时' }, errorType: 'TIMEOUT' })
  })
  it('success:true 但 error 非空 → 以错误为准 failed（review P-17 对齐 spec §3.6）', () => {
    const fail = pairToolCalls([mkSkeleton(), { ...resultOk, tool: { callId: 'tc_1', name: 'get_time', success: true, error: '部分失败', errorType: 'PARTIAL' } }])
    expect(fail[0].toolCalls?.[0]).toMatchObject({ status: 'failed', error: { code: 'PARTIAL', message: '部分失败' } })
  })
  it('缺配对结果 → completed + 无 outputSummary（「执行完成但摘要缺失」降级，D6A-06）', () => {
    const out = pairToolCalls([mkSkeleton()])
    expect(out[0].toolCalls?.[0]).toEqual({ id: 'tc_1', toolName: 'get_time', runtime: 'backend', status: 'completed' })
  })
  it('回放路径：toDomainMessageFromReplay 组装数组 → pairToolCalls 配对（review F3）', () => {
    const msgs = [
      mapper.toDomainMessageFromReplay({ role: 'assistant', message_id: 'm1', timestamp: 't0', tool_calls: [{ id: 'tc_1', function: { name: 'get_time', arguments: '{}' } }] } as unknown as RawSessionMessageItem, 'c'),
      mapper.toDomainMessageFromReplay({ role: 'tool', message_id: 'm2', timestamp: 't1', content: 'ok', tool_call_id: 'tc_1', name: 'get_time', success: true } as unknown as RawSessionMessageItem, 'c')
    ]
    const out = pairToolCalls(msgs)
    expect(out[0].toolCalls?.[0]?.outputSummary).toBe('ok')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/desktop && source ~/.nvm/nvm.sh && nvm use 22.23.0 >/dev/null && pnpm test -- tests/unit/rest-mapper-tools.spec.ts`
Expected: FAIL（`Message.toolCalls`/`pairToolCalls` 不存在）。

- [ ] **Step 3: `contracts/message.ts` 增 `toolCalls?`**

`Message` 接口 tool 字段后增（import `ToolCallRecord` from './tool'）：

```ts
  /** 阶段 6 批次 A（F-6-20）：归档/回放重建的工具调用记录（配对产物，卡片数据源；实时 toolStore 为批次 B） */
  toolCalls?: ToolCallRecord[]
```

- [ ] **Step 4: `rest-mapper.ts` 实现骨架解析 + pairToolCalls + 三调用点**

`MessageSource` 增 `tool_calls?: unknown[]`；`assemble()` assistant 分支内（`segments` 组装后）加：

```ts
    const toolCalls = parseToolCallSkeletons(src.tool_calls)
    if (toolCalls.length) base.toolCalls = toolCalls
```

文件尾部新增：

```ts
/** 归档 tool_calls 骨架解析（F-6-19）：`{id, type?, function:{name, arguments}}` 契约形状；arguments 为 JSON 字符串不解析。
 * 非结构条目静默跳过（归档 wire 有意放宽，防整段拒）；同 id 幂等去重（后见同 id 骨架忽略，review P-17）。 */
function parseToolCallSkeletons(raw: unknown[] | undefined): ToolCallRecord[] {
  if (!raw?.length) return []
  const out: ToolCallRecord[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as { id?: unknown; function?: { name?: unknown } }
    if (typeof o.id !== 'string' || o.id === '' || typeof o.function?.name !== 'string' || o.function.name === '') continue
    if (seen.has(o.id)) continue
    seen.add(o.id)
    out.push({ id: o.id, toolName: o.function.name, runtime: 'backend', status: 'completed' }) // D6A-06：归档无 runtime 源，恒 backend 缺省
  }
  return out
}

/** 归档配对（F-6-19/21）：assistant tool_calls 骨架与 role=tool 结果按 tool.callId 配对修正状态与结果摘要。
 * 命中后 error 非空 → 以错误为准 failed（spec §3.6，review P-17）；否则按 success（缺省视为 true）→ completed/failed；
 * 填 outputSummary/error/errorType/durationMs/finishedAt。
 * 缺配对结果 → 保持 completed + 无 outputSummary（「执行完成但摘要缺失」降级，D6A-06，不伪造）。
 * 跨页配对不支持（批次 B 查看器按上下文重配对）。 */
export function pairToolCalls(messages: Message[]): Message[] {
  const results = new Map<string, Message>()
  for (const m of messages) {
    if (m.role === 'tool' && m.tool?.callId && !results.has(m.tool.callId)) results.set(m.tool.callId, m)
  }
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.toolCalls?.length) continue
    for (const tc of m.toolCalls) {
      const r = results.get(tc.id)
      const info = r?.tool
      if (!r || !info) continue // 缺配对：保持 completed + 无摘要（降级）
      const hasError = info.error !== undefined
      const ok = !hasError && info.success !== false // ToolCallResult 缺省视为 true；error 非空以错误为准
      tc.status = ok ? 'completed' : 'failed'
      if (ok) {
        if (r.content) tc.outputSummary = r.content
      } else {
        tc.error = { code: info.errorType ?? 'TOOL_ERROR', message: info.error ?? '工具执行失败' }
        tc.errorType = info.errorType
      }
      if (info.durationMs !== undefined) tc.durationMs = info.durationMs
      if (info.truncated !== undefined) tc.truncated = info.truncated
      tc.finishedAt = r.createdAt
    }
  }
  return messages
}
```

imports 增 `ToolCallRecord` from '@shared/contracts/tool'（或 message 转引）。调用点：

- `toMessagePage`：`const items = pairToolCalls(raw.messages.map((m) => this.toDomainMessage(m, opts.conversationId)))`
- `toMessagePageFromContext`：**保留既有 `.sort()`**（review P-15）：`const items = pairToolCalls([res.anchor, ...res.before, ...res.after].map((m) => this.toDomainMessage(m, res.conversationId))).sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.messageId < b.messageId ? -1 : 1)`
- `real-backend.ts handleSession`：`const messages = pairToolCalls(frame.messages.map((m) => this.restMapper.toDomainMessageFromReplay(m, frame.conversationId as string)))`（import `pairToolCalls`；sessionBuffer 装载不变）

- [ ] **Step 5: 运行测试 + typecheck + 全量单测回归**

Run: `cd apps/desktop && source ~/.nvm/nvm.sh && nvm use 22.23.0 >/dev/null && pnpm test -- tests/unit/rest-mapper-tools.spec.ts && pnpm typecheck && pnpm test`
Expected: 新 spec PASS + typecheck 无错 + 全量单测无回归（`grep -rn "pairToolCalls" apps/desktop/src` 确认三调用点接线完整）。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/shared/contracts/message.ts apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts apps/desktop/src/main/transport/real-backend.ts apps/desktop/tests/unit/rest-mapper-tools.spec.ts
git commit -m "feat(阶段6批次A Task5): 归档配对——Message.toolCalls + pairToolCalls 纯函数（缺配对降级）+ REST 历史与 WS 回放双路径接线（F-6-19/20/21）"
```

---

### Task 6: mock 工具场景——`CYRENE_MOCK_TOOL_FLOW` + `submitToolResult` 实装 + seed（F-6-22）

**Files:**
- Modify: `apps/desktop/src/main/transport/mock-backend.ts`（`MockToolFlow` 类型 + `parseMockToolFlowEnv`/`parseMockToolHistoryEnv` + options 字段 + scheduleReplay 发射 + `submitToolResult` 实装 + seed）
- Modify: `apps/desktop/src/main/index.ts`（env 解析 + MockBackend 构造接线）
- Test: `apps/desktop/tests/unit/mock-backend-tools.spec.ts`（新）

**Interfaces:**
- Consumes: `MockBackend` 构造 options（index.ts:166 现接线模式）、`scheduleReplay`（mock-backend.ts:743 起，generation.completed 后发射点——directive 注入块之后）、`this.stamp()`（emit 时刻打信封）、`this.activeConversationId`（私有字段，无 state 对象，review P-1）、`messageRecords`、Task 1 `ToolStatusCommand`、Task 4 `redactToolArguments`、Task 3 事件类型。
- Produces:
  - `export type MockToolFlow = { kind:'backend'; started:{toolName:string;inputSummary?:string}; completed:{success:boolean;outputSummary?:string;errorType?:string;durationMs?:number} } | { kind:'desktop'; request:{toolName:string;arguments?:Record<string,unknown>;reason?:string;riskLevel?:string;permissionRequired?:boolean} }`
  - `parseMockToolFlowEnv(env: string|undefined): MockToolFlow | undefined`（非法 JSON/形状 → undefined 不抛）
  - `parseMockToolHistoryEnv(env: string|undefined): boolean`（'1'/'true' → true）
  - 发射（领域事件，**不经 raw 层**）：backend kind → `ToolStartedEvent`(`tc_mock_backend_1`，含活动会话 `conversationId`) + `ToolCompletedEvent`(同 id)；desktop kind → `ToolRequestEvent`(`call_mock_1`/`tc_mock_desktop_1`/toolVersion '1.0'/runtime 'desktop'/`expiresAt` now+30s/`inputSummary`=redactToolArguments(arguments))
  - `submitToolResult` 实装：`lastToolStatus` 记录 + 终态（result/error/rejected/cancelled）追加 role=tool 归档消息（`conversationId = this.activeConversationId ?? 'conv-1001'`，独立消息**不补骨架**）；非终态仅记录
  - `CYRENE_MOCK_TOOL_HISTORY=1` → seed `tc_seed_1` 骨架 + 结果消息（**`conv-1001`** 字面量，无 CONV_MOCK_1 常量，review P-2/P-9）

- [ ] **Step 1: 写失败测试——mock-backend-tools.spec.ts（新）**（review P-3/P-4/P-5/P-6/P-8 修正：`conv-1001` 是 mock 预置会话、`activateConversation` 是字符串签名、先 `connect()`、`emitDelayMs: 0`、归档断言走 `getMessageContext`——`getConversationMessages` 是恒空 stub）

```ts
import { describe, expect, it } from 'vitest'
import { MockBackend, parseMockToolFlowEnv, parseMockToolHistoryEnv } from '../../src/main/transport/mock-backend'

describe('parseMockToolFlowEnv / parseMockToolHistoryEnv（Task 6）', () => {
  it('合法 backend/desktop JSON → 值；非法 JSON/形状 → undefined', () => {
    expect(parseMockToolFlowEnv(JSON.stringify({ kind: 'backend', started: { toolName: 'web.search' }, completed: { success: true, outputSummary: 'ok' } }))).toEqual({ kind: 'backend', started: { toolName: 'web.search' }, completed: { success: true, outputSummary: 'ok' } })
    expect(parseMockToolFlowEnv(JSON.stringify({ kind: 'desktop', request: { toolName: 'desktop.file.read', arguments: { path: '/a' } } }))).toEqual({ kind: 'desktop', request: { toolName: 'desktop.file.read', arguments: { path: '/a' } } })
    expect(parseMockToolFlowEnv('not json')).toBeUndefined()
    expect(parseMockToolFlowEnv(JSON.stringify({ kind: 'x' }))).toBeUndefined()
    expect(parseMockToolFlowEnv(undefined)).toBeUndefined()
    expect(parseMockToolHistoryEnv('1')).toBe(true)
    expect(parseMockToolHistoryEnv('true')).toBe(true)
    expect(parseMockToolHistoryEnv(undefined)).toBe(false)
  })
})

describe('MockBackend 工具场景（Task 6 / F-6-22）', () => {
  it('backend kind：generation.completed 后按序发射 tool.started → tool.completed（固定 sourceCallId/顺序/字段 + 活动会话 conversationId）', async () => {
    const events: string[] = []
    const mock = new MockBackend({ emitDelayMs: 0, toolFlow: { kind: 'backend', started: { toolName: 'web.search', inputSummary: 'q=<redacted>' }, completed: { success: true, outputSummary: '结果' } } })
    mock.subscribe((e) => { if (e.event.startsWith('tool.')) events.push(e.event) })
    await mock.connect({ serverUrl: 'mock://test' })
    await mock.activateConversation('conv-1001')
    await mock.sendMessage({ conversationId: 'conv-1001', content: 'hi', clientMessageId: 'cm-1', clientRequestId: 'cr-1' })
    await new Promise((r) => setTimeout(r, 50))
    expect(events).toEqual(['tool.started', 'tool.completed'])
  })
  it('desktop kind：发射 tool.request（call_mock_1/tc_mock_desktop_1/expiresAt 未来/inputSummary 脱敏）', async () => {
    let req: unknown
    const mock = new MockBackend({ emitDelayMs: 0, toolFlow: { kind: 'desktop', request: { toolName: 'desktop.file.read', arguments: { path: '/etc/passwd' }, reason: '读取文件' } } })
    mock.subscribe((e) => { if (e.event === 'tool.request') req = e })
    await mock.connect({ serverUrl: 'mock://test' })
    await mock.activateConversation('conv-1001')
    await mock.sendMessage({ conversationId: 'conv-1001', content: 'hi', clientMessageId: 'cm-1', clientRequestId: 'cr-1' })
    await new Promise((r) => setTimeout(r, 50))
    expect(req).toMatchObject({ callId: 'call_mock_1', sourceCallId: 'tc_mock_desktop_1', toolName: 'desktop.file.read', runtime: 'desktop', toolVersion: '1.0', inputSummary: 'path=<redacted>' })
    expect((req as { expiresAt: string }).expiresAt > new Date().toISOString()).toBe(true)
  })
  it('submitToolResult：记录回传；终态追加 role=tool 归档消息（独立消息不补骨架）；非终态仅记录', async () => {
    const mock = new MockBackend({ emitDelayMs: 0 })
    await mock.connect({ serverUrl: 'mock://test' })
    await mock.activateConversation('conv-1001')
    await mock.submitToolResult({ callId: 'call_mock_1', status: 'running', toolName: 'desktop.file.read', toolVersion: '1.0', runtime: 'desktop', paramHash: 'h' })
    expect(mock.lastToolStatus?.status).toBe('running')
    await mock.submitToolResult({ callId: 'call_mock_1', status: 'result', toolName: 'desktop.file.read', toolVersion: '1.0', runtime: 'desktop', paramHash: 'h', output: '文件内容' })
    // review R2-1：sendMessage 只返回 {clientRequestId}（无 serverMessageId）→ 锚定预置消息 msg-1002（conv-1001 最新 seed，createdAt 早于 now → tool 消息在 after 窗口）
    const page = await mock.getMessageContext({ conversationId: 'conv-1001', messageId: 'msg-1002', before: 0, after: 10 })
    const toolMsgs = page.items.filter((m) => m.role === 'tool' && m.tool?.callId === 'tc_mock_desktop_1')
    expect(toolMsgs).toHaveLength(1)
    expect(toolMsgs[0].tool).toMatchObject({ callId: 'tc_mock_desktop_1', name: 'desktop.file.read', success: true })
    expect(toolMsgs[0].content).toBe('文件内容')
  })
  it('CYRENE_MOCK_TOOL_HISTORY：seed tc_seed_1 骨架 + 结果消息（经 getMessageContext 断言）', async () => {
    const mock = new MockBackend({ emitDelayMs: 0, toolHistory: true })
    const page = await mock.getMessageContext({ conversationId: 'conv-1001', messageId: 'msg-tool-seed-assistant', before: 0, after: 5 })
    const skeleton = page.items.find((m) => m.role === 'assistant' && m.toolCalls?.some((t) => t.id === 'tc_seed_1'))
    const result = page.items.find((m) => m.role === 'tool' && m.tool?.callId === 'tc_seed_1')
    expect(skeleton?.toolCalls).toEqual([{ id: 'tc_seed_1', toolName: 'seed.tool.read', runtime: 'backend', status: 'completed' }])
    expect(result?.tool).toMatchObject({ callId: 'tc_seed_1', success: true })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/desktop && source ~/.nvm/nvm.sh && nvm use 22.23.0 >/dev/null && pnpm test -- tests/unit/mock-backend-tools.spec.ts`
Expected: FAIL（类型/方法不存在）。

- [ ] **Step 3: mock-backend.ts 实现**

1. 类型 + env 解析（文件头，跟随既有 `parseMock*Env` 先例）：

```ts
/** CYRENE_MOCK_TOOL_FLOW env → MockToolFlow（阶段 6 批次 A / F-6-22 集成）：未设/非法 JSON/形状 → undefined（不注入）。
 * backend kind：generation.completed 后按序发射 tool.started/tool.completed；desktop kind：发射 tool.request（固定串 call_mock_1/tc_mock_desktop_1）。 */
export type MockToolFlow =
  | { kind: 'backend'; started: { toolName: string; inputSummary?: string }; completed: { success: boolean; outputSummary?: string; errorType?: string; durationMs?: number } }
  | { kind: 'desktop'; request: { toolName: string; arguments?: Record<string, unknown>; reason?: string; riskLevel?: string; permissionRequired?: boolean } }

export function parseMockToolFlowEnv(env: string | undefined): MockToolFlow | undefined {
  if (env === undefined || env === '') return undefined
  try {
    const v = JSON.parse(env) as Record<string, unknown>
    if (v && typeof v === 'object' && v.kind === 'backend' && v.started && v.completed) {
      const s = v.started as Record<string, unknown>
      const c = v.completed as Record<string, unknown>
      return { kind: 'backend', started: { toolName: String(s.toolName ?? 'get_time'), ...(typeof s.inputSummary === 'string' ? { inputSummary: s.inputSummary } : {}) }, completed: { success: c.success !== false, ...(typeof c.outputSummary === 'string' ? { outputSummary: c.outputSummary } : {}), ...(typeof c.errorType === 'string' ? { errorType: c.errorType } : {}), ...(typeof c.durationMs === 'number' ? { durationMs: c.durationMs } : {}) } }
    }
    if (v && typeof v === 'object' && v.kind === 'desktop' && v.request) {
      const r = v.request as Record<string, unknown>
      return { kind: 'desktop', request: { toolName: String(r.toolName ?? 'desktop.file.read'), ...(typeof r.arguments === 'object' && r.arguments !== null ? { arguments: r.arguments as Record<string, unknown> } : {}), ...(typeof r.reason === 'string' ? { reason: r.reason } : {}), ...(typeof r.riskLevel === 'string' ? { riskLevel: r.riskLevel } : {}), ...(typeof r.permissionRequired === 'boolean' ? { permissionRequired: r.permissionRequired } : {}) } }
    }
    return undefined
  } catch { return undefined }
}

/** CYRENE_MOCK_TOOL_HISTORY env → boolean（'1'/'true' → true；归档配对 seed） */
export function parseMockToolHistoryEnv(env: string | undefined): boolean {
  return env === '1' || env === 'true'
}
```

2. options/字段/构造：`toolFlow?: MockToolFlow`、`toolHistory?: boolean` 入构造 options + `private readonly toolFlow`/`toolHistory` 字段 + `this.lastToolStatus: ToolStatusCommand | undefined` + getter `get lastToolStatus()`（或 public 字段，测试断言用）。
3. `scheduleReplay` generation.completed 分支（directive 注入块之后）增（review P-18：started/completed 带活动会话 conversationId，spec §3.7）：

```ts
        // 阶段 6 批次 A（F-6-22）：工具双轨模拟——generation.completed 之后按 kind 发射（领域事件，不经 raw 层）
        if (event.event === 'generation.completed' && this.toolFlow) {
          if (this.toolFlow.kind === 'backend') {
            const t = this.toolFlow
            this.emit({ ...this.stamp(), event: 'tool.started', callId: 'tc_mock_backend_1', toolName: t.started.toolName, runtime: 'backend', ...(t.started.inputSummary !== undefined ? { inputSummary: t.started.inputSummary } : {}), ...(this.activeConversationId !== undefined ? { conversationId: this.activeConversationId } : {}) } satisfies ToolStartedEvent)
            this.emit({ ...this.stamp(), event: 'tool.completed', callId: 'tc_mock_backend_1', toolName: t.started.toolName, runtime: 'backend', success: t.completed.success, ...(t.completed.outputSummary !== undefined ? { outputSummary: t.completed.outputSummary } : {}), ...(t.completed.errorType !== undefined ? { errorType: t.completed.errorType } : {}), ...(t.completed.durationMs !== undefined ? { durationMs: t.completed.durationMs } : {}), ...(this.activeConversationId !== undefined ? { conversationId: this.activeConversationId } : {}) } satisfies ToolCompletedEvent)
          } else {
            const r = this.toolFlow.request
            const expiresAt = new Date(Date.now() + 30_000).toISOString()
            const inputSummary = r.arguments !== undefined ? redactToolArguments(r.arguments) : undefined
            this.emit({ ...this.stamp(), event: 'tool.request', callId: 'call_mock_1', sourceCallId: 'tc_mock_desktop_1', toolName: r.toolName, toolVersion: '1.0', runtime: 'desktop', ...(r.reason !== undefined ? { reason: r.reason } : {}), ...(inputSummary !== undefined ? { inputSummary } : {}), expiresAt } satisfies ToolRequestEvent)
          }
        }
```

（imports：`ToolStartedEvent`/`ToolCompletedEvent`/`ToolRequestEvent` from '@shared/contracts/events'、`redactToolArguments` from '../tools/input-summary'）
4. `submitToolResult` 实装（替换 no-op；review P-1：活动会话字段是私有 `this.activeConversationId`，无 `state` 对象）：

```ts
  /** 阶段 6 批次 A（F-6-22）：桌面工具状态回传（mock 模式 client→server 发送面）。记录最近回传；
   *  终态（result/error/rejected/cancelled）追加 role=tool 归档消息（独立消息，配对以同页骨架为准，不补骨架）；非终态仅记录。 */
  async submitToolResult(input: ToolStatusCommand): Promise<void> {
    this.lastToolStatus = input
    const terminal = input.status === 'result' || input.status === 'error' || input.status === 'rejected' || input.status === 'cancelled'
    if (!terminal) return
    const sourceCallId = input.callId === 'call_mock_1' ? 'tc_mock_desktop_1' : input.callId // 固定串关联（D6A-07 确定性）
    const createdAt = this.now().toISOString()
    this.messageRecords.push({
      messageId: `msg-tool-${this.idFactory()}`,
      conversationId: this.activeConversationId ?? 'conv-1001',
      role: 'tool',
      createdAt,
      status: 'completed',
      ...(input.output !== undefined ? { content: input.output } : {}),
      tool: {
        callId: sourceCallId,
        name: input.toolName,
        success: input.status === 'result',
        ...(input.status === 'error' && input.error !== undefined ? { error: input.error.message ?? '工具执行失败', errorType: input.error.code ?? 'TOOL_ERROR' } : {}),
        ...(input.status === 'rejected' ? { error: '用户拒绝' } : {}),
        ...(input.status === 'cancelled' ? { error: '已取消' } : {})
      }
    })
  }
```

5. seed（构造 `seedMessages()` 后，`this.toolHistory` 时追加；默认会话 id 是字面量 `'conv-1001'`——review P-2/P-9 修正：无 CONV_MOCK_1 常量）：

```ts
    // 阶段 6 批次 A（F-6-22）：CYRENE_MOCK_TOOL_HISTORY=1 → 归档配对 seed（tc_seed_1 骨架 + 结果消息）
    if (this.toolHistory) {
      this.messageRecords.push({
        messageId: 'msg-tool-seed-assistant', conversationId: 'conv-1001', role: 'assistant', createdAt: '2026-08-19T00:00:00.000Z', status: 'completed',
        assistantSegments: [{ segmentId: 'pr-msg-tool-seed-assistant-0', segmentIndex: 0, channel: 'public_reply', kind: 'markdown', text: '已读取文件', completed: true }],
        toolCalls: [{ id: 'tc_seed_1', toolName: 'seed.tool.read', runtime: 'backend', status: 'completed' }]
      })
      this.messageRecords.push({
        messageId: 'msg-tool-seed-result', conversationId: 'conv-1001', role: 'tool', createdAt: '2026-08-19T00:00:01.000Z', status: 'completed',
        content: '文件内容摘要（模拟）',
        tool: { callId: 'tc_seed_1', name: 'seed.tool.read', success: true }
      })
    }
```

- [ ] **Step 4: `main/index.ts` 接线**

env 解析（对齐 `parseMockDirectiveEnv` 现接线）：`parseMockToolFlowEnv(process.env.CYRENE_MOCK_TOOL_FLOW)` / `parseMockToolHistoryEnv(process.env.CYRENE_MOCK_TOOL_HISTORY)` → `MockBackend` 构造 options 增 `...(mockToolFlow !== undefined ? { toolFlow: mockToolFlow } : {})`、`...(mockToolHistory ? { toolHistory: true } : {})`。

- [ ] **Step 5: 运行测试 + typecheck + 全量单测回归**

Run: `cd apps/desktop && source ~/.nvm/nvm.sh && nvm use 22.23.0 >/dev/null && pnpm test -- tests/unit/mock-backend-tools.spec.ts && pnpm typecheck && pnpm test`
Expected: 新 spec PASS + typecheck 无错 + 全量单测无回归。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/transport/mock-backend.ts apps/desktop/src/main/index.ts apps/desktop/tests/unit/mock-backend-tools.spec.ts
git commit -m "feat(阶段6批次A Task6): mock 工具场景——TOOL_FLOW 两 kind 发射 + submitToolResult 实装（终态推进归档）+ TOOL_HISTORY seed（F-6-22）"
```

---

### Task 7: 门禁收口 + 集成 + 文档 + 决策记录

**Files:**
- Test: `apps/desktop/tests/integration/electron-tools.spec.ts`（新，可选——若 SwiftShader 观察成本过高则以单测替代并记录取舍）
- Modify: `apps/desktop/src/renderer/src/main.ts`（可选——`__cyreneTest` 增 history 探针供集成断言，仅 dev/test 构建）
- Modify: 文档（spec §5 表全部落点 + 决策记录）
- Create: `docs/review/2026-08-20-阶段6批次A-决策记录.md`

**Interfaces:**
- Consumes: Task 1-6 产物 + `__cyreneTest` 探针先例（renderer main.ts:45-78）+ mock env 装配（Task 6 Step 4）。

- [ ] **Step 1: 可选 Electron 集成测试——`electron-tools.spec.ts`**

先例：`tests/integration/electron-live2d.spec.ts`（Playwright `_electron` + `CYRENE_BACKEND=mock`）。用例：`CYRENE_MOCK_TOOL_HISTORY=1` 启动 → 打开会话历史 → 断言种子 assistant 消息带 `toolCalls`（id `tc_seed_1`，经 `__cyreneTest` 历史探针——若无现成探针，在 renderer main.ts 的 dev/test 探针块增 `getHistoryToolCalls(conversationId)` 读 `useConversationStore()`/`useMessageStore()` 该会话消息的 toolCalls）。**注意（C1 先例）**：断言走持久数据（history 加载完成后一次性读），不做瞬态轮询；若 CI SwiftShader 下 history 加载不可靠，将本用例降级为 `it.skip` 并在决策记录记录取舍（单测已覆盖配对与 mock seed）。

- [ ] **Step 2: 全量门禁**

Run（顺序执行，勿并行——`test:integration` 自带 `electron-vite build --mode test` 会写 out/，与 `build` 冲突）：
1. `cd apps/desktop && source ~/.nvm/nvm.sh && nvm use 22.23.0 >/dev/null && pnpm typecheck`
2. `pnpm lint`
3. `pnpm test`
4. `xvfb-run -a pnpm test:integration`（本机先跑，若时间过长可先只跑新 spec 文件；CI 全量由 push 触发）
5. `pnpm build`
6. `pnpm -F @cyrene/desktop check:contract`（期望 `32/32 通过;未纳帧 8 个`）
Expected: 全绿。计数记录：`pnpm test` 输出新增单测数（Task1 1 文件 + Task2 增 3 用例 + Task3 增 3 用例 + Task4 2 文件 + Task5 1 文件 + Task6 1 文件）。

- [ ] **Step 3: 文档同步（spec §5 表）**

逐项：`docs/02` §10（ToolCall 领域模型补 sourceCallId + tool.started/completed 形状 + finishReason 不承载工具语义注记）/§17（事件处理规则表增 tool.request/tool.started/tool.completed/tool.status）/§19（「工具调用字段」行补 sourceCallId + 新增 tool.started/completed 两行 + action 退役注记）；`docs/04` §2（sourceCallId 权威键、ID 双轨）/§4（8 态展示与 wire 六态映射）/§11（Backend Runtime 只展示口径）；`docs/06` §3.5（toolStore 三来路归一化设计先行记录：实时易失/归档持久）；`docs/12` §9.7 与 `docs/16` §9（F-6-01~23 落地状态 + changelog 行）；`docs/13`（wire 契约变更交叉 review 结论）；`README`/`CLAUDE.md`（阶段 6 状态与测试计数，三态=已开发、未联调）。

- [ ] **Step 4: 决策记录 `docs/review/2026-08-20-阶段6批次A-决策记录.md`**

按阶段 5 批次决策记录格式：D6A-01~09 定案表 + 执行期偏离（若有）+ 集成测试取舍（SwiftShader 或跳过记录）+ 门禁计数 + 三态标注 + 最终报告必报项（批次边界裁定 D6A-01、四项预检决策落点 D6A-02、review 修复记录 C1/C2/F1~F5/N1~N3）。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/tests/integration/electron-tools.spec.ts apps/desktop/src/renderer/src/main.ts docs/02-Cyrene-前后端通信协议与前端数据结构-v0.2.md docs/04-Cyrene-Desktop工具与权限交互设计-v0.2.md docs/06-Cyrene-前端状态管理与本地存储设计-v0.2.md docs/12-Cyrene-前端开发启动清单与分阶段实施计划-v0.1.md docs/16-Cyrene-前端实施任务清单与进度跟踪.md docs/13-Cyrene-前端文档交叉Review与修订记录-v0.1.md docs/review/2026-08-20-阶段6批次A-决策记录.md README.md CLAUDE.md
git commit -m "docs(阶段6批次A Task7): 门禁收口 + 集成 + 文档同步 + 决策记录（三态=已开发、未联调）"
```

（若集成用例被降级为 skip，commit message 注明取舍。）
