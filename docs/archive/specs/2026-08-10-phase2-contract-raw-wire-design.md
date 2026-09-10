# 阶段 2 块 A：领域契约修复 + raw wire 层 —— 设计

**日期：** 2026-08-10
**状态：** 已 code-review（第 1 轮干净；P0 `channel/completeness` + P1 `status` 过滤/领域 fixture 形状已修，2 处 P2 决策定死：`channel` 必填 literal、`completeness` 用 `string` 保留 mapper 告警）
**关联：** [docs/18 契约差异清单](../18-Cyrene-Electron-真实后端契约差异与前端修复清单-2026-08-09.md)（§3 两层类型 / §4 P0 回复为空 / §5 fixture 分离 / §6 握手 / §8 generation 映射 / §9 Token）、[doc 16 §5 阶段 2](../16-Cyrene-前端实施任务清单与进度跟踪.md#L228)、[doc 02 通信协议](../02-Cyrene-前后端通信协议与前端数据结构-v0.2.md)
**后端契约基线：** `/home/yomu/elysia-agent` @ `beeba5776413dde9761375c2fd9541d6636f180d`（比 docs/18 审计基线 `911bbe00` 更新，见 §1.1）

---

## 1. 背景与目标

阶段 1 三块（安全加载 / 凭据·日志 / IPC 集成测试）已落地，但 transport 与领域层仍是阶段 0 的骨架：只有 `BackendAdapter` 接口 + `MockBackend`，Mock 夹具是**前端理想领域事件**，不是后端真实 wire。docs/18 审计确认四类契约缺口，其中 **P0「回复为空」** 直接阻断阶段 2 的「真实文本聊天不丢内容」：

1. `SegmentCompletedEvent` 无 `kind/content` → 后端 `content` 权威文本被丢弃（`SegmentCompletedEventSchema` 会丢字段，Accumulator 把 `kind` 硬编码 `text`）；
2. 后端 delta 帧**不携带** `channel/kind`（只有 `generation.segment.started` 带）→ 真实 Adapter 无法仅凭 delta 构造 `GenerationDeltaEvent`；
3. `StreamAccumulator` 无「权威 content 覆盖缺口」规则 → inner voice / TTS 场景（零 delta）回复为空，或缺口永久卡 `completing`；
4. `TokenUsage`/`conversationUsage` 形状与后端不符 → 无法诚实映射（docs/18 §9 禁止虚构 input/output）。

**本块（2A）目标：** 在**纯逻辑层**把领域契约、`StreamAccumulator`、raw wire schema 与 frame mapper 修到与后端契约一致，用**raw wire fixture**（来自当前后端契约构造，非领域 Mock）驱动全量单测。**不实现真实网络连接、不碰 UI/Store** —— 那些属于 2B/2C。

### 1.1 后端契约已更新（相对 docs/18 审计基线）

写 spec 前对照后端当前 `frontend_contract/`（`beeba577`）复核，docs/18 指出的三处「后端应补强 / 临时兼容」已由后端落地，2A 据此**不做过度设计**：

| 项 | docs/18 审计时 | 当前后端 `beeba577` | 2A 影响 |
|---|---|---|---|
| `SessionMessage.conversationId` | 无（§7 建议后端补强） | **已有** `conversationId: str`（[ws_message.py:258](ws_message.py:258)） | raw schema 建 `conversationId` 字段，容忍可缺省（旧后端兼容）；**不需要** §7.1 的「分页查找 active 会话」绕路设计 |
| `MessagesPageResponse.cursor` | 无显式 cursor（§10） | **已有** `cursor`（不透明 `_id` 形式，[rest.py:331](rest.py:331)） | 属 2B REST；2A 不实现 |
| `GenerationCompletedMessage.finishReason` | 建议保留 | **已有** `finishReason: FinishReason`（限 `stop`/`tool_calls`，[rest.py:27](rest.py:27)）+ `completeness`（恒 `complete`） | 领域事件加 `finishReason?`；`completeness` 恒值不入领域 |
| 握手帧顺序 | session → server_info → expression（§6.2） | 同（[ws_handler.py:198-231](ws_handler.py:198)） | raw schema 覆盖三帧 |

## 2. 范围

| 项 | 内容 |
|---|---|
| 领域契约 | `shared/contracts/events.ts`、`message.ts`、`schemas/events.ts`：新增 `GenerationSegmentStartedEvent`；`SegmentCompletedEvent` 加 `kind`+`content?`；`GenerationCompletedEvent` 加 `messageId?`/`finishReason?`、`conversationUsage` 改 `ConversationTokenUsage`；`GenerationFailedEvent` 加 `messageId?`、`error` 加 `retryable/details`；`TokenUsage` 加 `rounds?`；新增 `ConversationTokenUsage` |
| raw wire 层 | `src/main/transport/protocol-v2/raw-types.ts`、`raw-schemas.ts`、`frame-mapper.ts`：握手帧（session/server_info/expression）+ generation 文本聊天帧（started/segment.started/delta/segment.completed/completed/failed）；raw zod schema（判别 `type`）→ frame mapper → 领域 `BackendEvent` |
| StreamAccumulator | `generation.segment.started` 分支；权威 content 规则（§4.3 八条）；completed 后迟到 delta 忽略+告警；`conversationUsage` 类型更新；`onProtocolWarning` 上报机制 |
| fixture 分离 | `fixtures/domain/streaming-reply.jsonl`（现有迁移）；新增 `fixtures/wire-v2/{handshake,chat-no-delta-inner-voice,chat-tts-public-completed-only,chat-failed}.jsonl` + 各自 `.manifest.json`（`backendCommit=beeba577`） |
| 测试 | raw schema 合法/非法；frame mapper 全映射+补全+告警+错误；Accumulator 权威规则（docs/18 §4.4 八场景 + started + 告警）；wire fixture 两层校验（过 raw schema + 经 mapper 过领域 schema） |
| 文档 | doc 16 阶段 2 勾选本块已完成项（标注「已开发、未联调」）；docs/18 标记 2A 已实施部分 |

**非目标（后续块/阶段）：** 真实 WS/REST 连接与握手请求头（2B）；`BackendSession` 结构改造（2B，后端已补 `conversationId`，见 §1.1）；REST snake_case mapper 与 `_id` 分页游标（2B）；session 回放消息的领域归一化（2B）；Pinia Store / IPC 事件推送 / 聊天 UI（2C）；`tool.*`/`audio*`/`dictation.*`/`voice.*` 帧（阶段 4/6）。

## 3. 决策记录

| # | 决策 | 结论 |
|---|---|---|
| A-1 | raw wire 层位置 | `src/main/transport/protocol-v2/{raw-types,raw-schemas,frame-mapper}.ts`（docs/18 §3/§17）——raw wire 与领域契约彻底分文件，禁止混用 |
| A-2 | `generation.segment.started` 处理 | **方案 A（docs/18 §8.2 推荐）**：新增领域事件 `GenerationSegmentStartedEvent` + zod schema + Accumulator 分支；不采用「Adapter 内缓存不向领域层发 started」方案 B——领域层需要 segment 元数据完成权威 content/排序 |
| A-3 | `TokenUsage` 结构 | 保留 `{input, output, total, source}`（现有消费方不变）+ 新增 `rounds?: TokenUsageRound[]` 保留模型/缓存/推理拆分（docs/18 §9.1）；映射 `input=Σinput_tokens`、`output=Σoutput_tokens`、`total=turn_total`、`source='provider_reported'` |
| A-4 | 会话累计 usage | 新增 `ConversationTokenUsage{total, byModel, source:'server_aggregate'}`（docs/18 §9.2），替换 `GenerationCompletedEvent.conversationUsage` 的 `{input,output,total}`；**禁止**把 total 拆 input/output |
| A-5 | 协议告警机制 | 纯逻辑层（mapper/accumulator）统一 `onProtocolWarning?: (w: ProtocolWarning) => void` 构造注入；`ProtocolWarning = {code, message}`；缺省静默但测试必注入并断言 |
| A-6 | fixture 布局 | 领域 fixture 移 `fixtures/domain/`；wire fixture 放 `fixtures/wire-v2/` + 同目录 `.manifest.json`（`backendCommit`/`protocol`/`serverProtocolVersion`）；Mock 继续消费领域事件，**不**把 Mock 升级为 wire（2B 再议） |
| A-7 | `status` channel | raw 层 `RawSegmentChannel` 含 `status`（后端 `MessageChannel` 全集）；mapper 对 `status` 段**过滤不输出领域事件**（docs/18 §8.7）；领域 `SegmentChannel` 保持 `inner_voice/public_reply` |
| A-8 | generation 完成元数据 | 领域 `GenerationCompletedEvent` 加 `finishReason?: string`（映射 `finishReason`）；`completeness` 恒 `complete` 不入领域（无信息量）；`GENERATION_CANCELLED` 走 failed 终态 |
| A-9 | conversationId 补齐 | mapper 实例持有 `activeConversationId?`（setter）；generation 帧缺 `conversationId` 时用它补齐；**无法补齐 → 抛 `CyreneError(PROTOCOL_MISMATCH)`**，不填空串（docs/18 §8.1） |
| A-10 | fixture 数据来源 | 依据当前后端 `frontend_contract`（`ws_message.py`/`rest.py`）+ 后端测试构造（`test_v2_generation.py` 断言序列），**不用**归档 traces（docs/18 §2 归档仅参考） |

**实施中新增决策：** 按目标指令追加到 §10 与最终报告。

## 4. 目标结构

```text
apps/desktop/src/
├── main/transport/
│   ├── protocol-v2/                 # 新增：raw wire 层（本块）
│   │   ├── raw-types.ts             # 后端 wire 类型（保留原始命名）
│   │   ├── raw-schemas.ts           # raw zod schema（判别 type）
│   │   └── frame-mapper.ts          # raw frame → 领域 BackendEvent
│   ├── backend-adapter.ts           # 不变（接口）
│   └── mock-backend.ts              # 改 import 路径（fixtures/domain/…）
├── main/fixtures/
│   ├── domain/streaming-reply.jsonl # 迁移现有领域夹具
│   └── wire-v2/                     # 新增：raw wire 夹具 + manifest
│       ├── handshake.jsonl
│       ├── chat-no-delta-inner-voice.jsonl
│       ├── chat-tts-public-completed-only.jsonl
│       ├── chat-failed.jsonl
│       └── (各自) .manifest.json
└── shared/
    ├── contracts/events.ts          # 修改：加 segment.started / completed content / token 结构
    ├── contracts/message.ts         # 修改：TokenUsage.rounds?、ConversationTokenUsage
    ├── contracts/protocol.ts        # 新增：ProtocolWarning + 告警 code 常量（shared 放这里避免反向依赖）
    └── schemas/events.ts            # 修改：同步 schema
tests/unit/
├── raw-schemas.spec.ts              # 新增
├── frame-mapper.spec.ts             # 新增
├── stream-accumulator.spec.ts       # 扩展（权威 content 场景）
└── wire-fixtures.spec.ts            # 新增（两层校验）
```

## 5. 关键实现

### 5.1 raw-types.ts —— 后端 wire 类型（权威字段见 `frontend_contract/ws_message.py` @ `beeba577`）

```typescript
/** 后端 WS v2 raw wire 类型（保留后端原始命名；与领域层禁止混用） */

export type RawSegmentChannel = 'inner_voice' | 'public_reply' | 'status'
export type RawSegmentKind = 'text' | 'markdown' | 'image' | 'video' | 'audio' | 'file' | 'sticker' | 'link'

export interface RawTokenRound {
  model?: string
  session_id?: string
  input_tokens: number
  output_tokens: number
  total_tokens: number
  cached_tokens?: number
  reasoning_tokens?: number
  round_num: number
  timestamp?: string
}
export interface RawTokenUsage { rounds: RawTokenRound[]; turn_total: number }
export interface RawTokenStats { total: number; byModel: Record<string, number> }
export interface RawConversationUsage { total: number; byModel: Record<string, number> }

/** 建连帧（ws_handler：session → server_info → expression） */
export interface RawSessionMessage {
  type: 'session'
  conversationId?: string   // 后端已有；容忍缺省（旧后端）
  messages: RawSessionMessageItem[]
  token_stats?: RawTokenStats
}
export interface RawSessionMessageItem {
  // 2A 只做结构校验；parts/content/tool_calls 用 unknown 是有意放宽（精确类型在 2B 回放归一化时建）
  role: string
  message_id?: string
  timestamp?: string
  parts?: unknown[]
  content?: unknown
  content_type?: Record<string, number[]>
  mood?: string
  tool_calls?: unknown[]
  inner_voice?: string
  tool_call_id?: string
  name?: string
  success?: boolean
  error?: string
  error_type?: string
  duration_ms?: number
  truncated?: boolean
  token_usage?: RawTokenUsage
}
export interface RawServerInfo {
  type: 'server_info'
  protocol_version: string
  server_version: string
  features: Record<string, unknown>
  services: Record<string, unknown>
  connectionId?: string
  build_sha?: string
}
export interface RawExpression {
  type: 'expression'
  expression: string
  intensity?: number
}

/** generation 文本聊天帧 */
export interface RawGenerationStarted {
  type: 'generation.started'
  generationId: string
  messageId: string
  conversationId?: string
  requestId?: string
  model?: string
}
export interface RawGenerationSegmentStarted {
  type: 'generation.segment.started'
  generationId: string
  segmentId: string
  segmentIndex: number
  channel: RawSegmentChannel
  kind: RawSegmentKind
  conversationId?: string
}
export interface RawGenerationDelta {
  type: 'generation.delta'
  generationId: string
  segmentId: string
  segmentIndex: number
  deltaSequence: number
  delta: string
  conversationId?: string
}
export interface RawGenerationSegmentCompleted {
  type: 'generation.segment.completed'
  generationId: string
  segmentId: string
  segmentIndex: number
  channel: RawSegmentChannel
  kind: RawSegmentKind
  content?: string
  conversationId?: string
}
export interface RawGenerationCompleted {
  type: 'generation.completed'
  generationId: string
  messageId: string
  channel: 'public_reply'       // 后端恒发（默认值，wire_dict 只省略 None → 恒上 wire）；literal 必填
  finishReason: 'stop' | 'tool_calls'
  usage: RawTokenUsage          // 后端必填
  model: string                 // 后端必填
  mood?: string
  completeness?: string         // 后端恒 'complete'；string（非 literal）保留 mapper 告警路径（docs/18 §8.5）
  conversationId?: string
  conversationUsage?: RawConversationUsage
}
export interface RawGenerationFailed {
  type: 'generation.failed'
  generationId: string
  messageId?: string
  model?: string
  code: string
  message: string
  retryable: boolean
  details: Record<string, unknown>
  conversationId?: string
}

export type RawFrame =
  | RawSessionMessage | RawServerInfo | RawExpression
  | RawGenerationStarted | RawGenerationSegmentStarted | RawGenerationDelta
  | RawGenerationSegmentCompleted | RawGenerationCompleted | RawGenerationFailed
```

### 5.2 raw-schemas.ts —— zod 判别联合

- `RawFrameSchema = z.discriminatedUnion('type', [session, server_info, expression, generation.started, generation.segment.started, generation.delta, generation.segment.completed, generation.completed, generation.failed])`。
- 每个子 schema 精确字段 + `.strict()`（docs/18 §18：禁用宽松 `.passthrough()` 掩盖已知 wire 字段错误）；未知 `type` 自然 safeParse fail。
- **可缺省字段清单**（与 §5.1 精确对齐）：`conversationId`/`content`/`mood`/`completeness`/`token_stats`/`connectionId`/`build_sha`/`intensity`/`requestId`/`model`（started/failed）/`messageId`（failed）等按后端 Optional 字段设为 `.optional()`；**`usage`、`details`、`retryable`、`finishReason`、`channel`（completed literal）保持必填**（后端非 Optional，见 §5.1 注释）。
- `finishReason` 用 `z.enum(['stop','tool_calls'])`；`channel` 用 `z.enum(['inner_voice','public_reply','status'])`；`kind` 用 8 值枚举。
- 导出 `parseRawFrame(input: unknown): { success: true; data: RawFrame } | { success: false; error: z.ZodError }`。

### 5.3 frame-mapper.ts —— raw frame → 领域事件

```typescript
import type { BackendEvent } from '@shared/contracts/events'
import type { ProtocolWarning } from '@shared/contracts/protocol'
import type { SegmentChannel, SegmentKind, TokenUsage, ConversationTokenUsage } from '@shared/contracts/message'
import type { RawFrame, RawSegmentChannel, RawSegmentKind, RawTokenUsage, RawConversationUsage } from './raw-types'
import { CyreneError, CyreneErrorCode } from '@shared/errors'

export interface FrameMapperOptions {
  connectionId?: string
  activeConversationId?: string
  onProtocolWarning?: (warning: ProtocolWarning) => void
}

export class FrameMapper {
  private nextSequence = 0
  // segmentId → 元数据（从 segment.started 缓存；delta/completed 用它补 channel/kind）。
  // channel 用 RawSegmentChannel：status 段也缓存（供 delta/completed 识别过滤），
  // 但只在 channel 非 status 时才构造领域事件。
  private segmentMeta = new Map<string, { segmentIndex: number; channel: RawSegmentChannel; kind: RawSegmentKind }>()
  private activeConversationId?: string
  private readonly onProtocolWarning: (warning: ProtocolWarning) => void

  constructor(options: FrameMapperOptions = {}) { /* connectionId 默认 'local'；缺省告警静默 */ }
  setActiveConversationId(id: string | undefined): void

  /** 生成一帧领域事件；非 generation 帧（握手/工具/音频等）与 status 段返回 null（不告警） */
  mapFrame(frame: RawFrame): BackendEvent | null
}
```

映射规则（docs/18 §8）：

| raw frame | 领域事件 | 规则 |
|---|---|---|
| `generation.started` | `GenerationStartedEvent` | `responseId = generationId`；`messageId` 保留；`model` 映射；`requestId` **不落领域**（2B 连接层记录日志关联）；`conversationId` 缺省用活动会话补齐（无法补齐抛 `PROTOCOL_MISMATCH`）；`eventId = ${connectionId}:${sequence++}` |
| `generation.segment.started` | `GenerationSegmentStartedEvent` | 缓存 `segmentId → {segmentIndex, channel, kind}`（channel 存 raw 三值）；`channel === 'status'` → **不输出事件、不告警**，仍缓存 meta 供其 delta/completed 过滤 |
| `generation.delta` | `GenerationDeltaEvent` 或 `null` | `segmentId` 无 meta → 抛 `PROTOCOL_MISMATCH`（不默认 `public_reply/text`）；meta.channel === `'status'` → **返回 `null`**（过滤，不告警）；否则 `text = delta`、`channel/kind` 取 meta（已判非 status）；`segmentIndex` 与缓存不一致 → 告警 `MAPPER_SEGMENT_INDEX_MISMATCH` 且以 meta 为准 |
| `generation.segment.completed` | `SegmentCompletedEvent` 或 `null` | meta.channel === `'status'` → **返回 `null`** 且**保留 status meta**（供其迟到 delta 过滤返回 null，不抛 `PROTOCOL_MISMATCH`）；否则保留 `channel/kind/content`；**普通段映射结束后清理**对应 segment meta（docs/18 §8.4） |
| `generation.completed` | `GenerationCompletedEvent` | `responseId = generationId`；`messageId` 保留；`emotion = mood`；`finishReason` 保留；`completeness !== 'complete'` → 告警 `MAPPER_UNEXPECTED_COMPLETENESS`（docs/18 §8.5 不静默丢弃）；`channel` 恒 `public_reply` 不落领域（无信息量）；`usage` 用 `mapUsage`；`conversationUsage` 用 `mapConversationUsage` |
| `generation.failed` | `GenerationFailedEvent` | `error.code = code`、`error.message = message`、`error.retryable`、`error.details`；`messageId` 保留；`model` 不落领域（已由 started 提供，2B 连接层可选记录） |
| 其余（session/server_info/expression/tool.*/audio*…） | `null` | 调用方（2B 连接层）分流；mapper 不映射、不告警 |

`mapUsage(raw: RawTokenUsage): TokenUsage`：
```typescript
{
  input: raw.rounds.reduce((s, r) => s + r.input_tokens, 0),
  output: raw.rounds.reduce((s, r) => s + r.output_tokens, 0),
  total: raw.turn_total,
  source: 'provider_reported',
  rounds: raw.rounds.map((r) => ({
    model: r.model, inputTokens: r.input_tokens, outputTokens: r.output_tokens,
    totalTokens: r.total_tokens, cachedTokens: r.cached_tokens, reasoningTokens: r.reasoning_tokens, roundNum: r.round_num
  }))  // session_id/timestamp 有意丢弃（docs/18 §9.1 只要求模型/缓存/推理拆分）
}
```
`Σ total_tokens !== turn_total` → 告警 `MAPPER_TOKEN_SUM_MISMATCH` 但**保留服务端 `turn_total`**（docs/18 §9.1）。

`mapConversationUsage(raw: RawConversationUsage): ConversationTokenUsage` → `{ total, byModel, source: 'server_aggregate' }`。

### 5.4 领域契约修改（`shared/contracts/events.ts` + `message.ts` + `schemas/events.ts`）

`events.ts` 修改：
```typescript
/** 分段开始：领域层创建 segment 元数据（方案 A） */
export interface GenerationSegmentStartedEvent extends BackendEventEnvelope {
  event: 'generation.segment.started'
  generationId: string
  segmentId: string
  segmentIndex: number
  channel: SegmentChannel
  kind: SegmentKind
}

export interface SegmentCompletedEvent extends BackendEventEnvelope {
  event: 'generation.segment.completed'
  generationId: string
  segmentId: string
  segmentIndex: number
  channel: SegmentChannel
  kind: SegmentKind        // 新增：用事件真实 kind，不硬编码 text
  content?: string         // 新增：权威完整文本
}

export interface GenerationCompletedEvent extends BackendEventEnvelope {
  event: 'generation.completed'
  generationId: string
  messageId?: string       // 新增：保留后端 messageId
  responseId: string
  usage?: TokenUsage
  conversationUsage?: ConversationTokenUsage   // 改类型
  model?: string
  emotion?: string
  finishReason?: string    // 新增：stop / tool_calls
}

export interface GenerationFailedEvent extends BackendEventEnvelope {
  event: 'generation.failed'
  generationId: string
  messageId?: string       // 新增
  error: { code: string; message: string; retryable?: boolean; details?: unknown }
}

export type BackendEvent = ... | GenerationSegmentStartedEvent | ...   // 加入判别联合
```

`message.ts` 修改：
```typescript
export interface TokenUsageRound {
  model?: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedTokens?: number
  reasoningTokens?: number
  roundNum: number
}
export interface TokenUsage {
  input: number
  output: number
  total: number
  source: 'provider_reported' | 'server_aggregate' | 'client_sum'
  rounds?: TokenUsageRound[]   // 新增：保留拆分（设置页/诊断页后续需要）
}
/** 会话累计 token（docs/18 §9.2：后端只提供 total+byModel，禁止虚构 input/output） */
export interface ConversationTokenUsage {
  total: number
  byModel: Record<string, number>
  source: 'server_aggregate'
}
```

`schemas/events.ts` 同步：`GenerationSegmentStartedEventSchema` 新增；`SegmentCompletedEventSchema` 加 `kind`（必填）+ `content`（optional）；`TokenUsageSchema` 加 `rounds?`；`ConversationUsageSchema` 改为 `{total, byModel, source: literal('server_aggregate')}`；`GenerationCompletedEventSchema` 加 `messageId?`/`finishReason?`；`GenerationFailedEventSchema` 的 `error` 加 `retryable?/details?`；`BackendEventSchema` 判别联合加新事件。

### 5.5 StreamAccumulator 修改（docs/18 §4.3 八条规则）

```typescript
export interface SegmentAccumulatorState {
  // …现有…
  authoritative?: boolean   // 新增：权威 content 已落地
}
```

- `apply()` 新增 `case 'generation.segment.started'` → `applySegmentStarted`（`ensureSegment(event.segmentId, event.segmentIndex, event.channel, event.kind)`）。
- `applySegmentCompleted`：
  1. `ensureSegment(..., event.kind)`（不再硬编码 `'text'`）；
  2. `segment.completed = true`；
  3. `event.content !== undefined`（**不 truthy 判断**）→ `committedText = renderText = content`、`pendingChunks = {}`、`expectedSequence` 停更、`authoritative = true`；
  4. `content` 缺省 → 保留已累计 delta（含缺口，父消息仍可能 `completing`）；
  5. 只完成一个 segment，不结束父回复。
- `applyDelta`：
  1. 若 segment 已 `authoritative` → 忽略 + 告警 `ACCUMULATOR_LATE_DELTA_AFTER_AUTHORITATIVE`（completed 后迟到 delta 不污染权威文本）；
  2. 其余逻辑不变（重复序号忽略、缺口进 pending）。
- `applyCompleted`：`conversationUsage` 类型改 `ConversationTokenUsage`；status 逻辑不变（权威 content 已清缺口 → `completed`；有缺口 → `completing`）。
- 构造注入 `onProtocolWarning?: (w: ProtocolWarning) => void`（缺省静默）；**`ProtocolWarning` 定死放 `shared/contracts/protocol.ts`**（`StreamAccumulator` 在 `shared/domain/` 与 `FrameMapper` 在 `main/` 都依赖它，放 shared 避免 shared→main 反向依赖；`MAPPER_*`/`ACCUMULATOR_*` 告警 code 常量同放该文件）。
- `toAssistantSegments()` 不变（`kind` 用真实值、`filter(committedText.length > 0)` 隐藏空段）。

### 5.6 fixture 分离

- 现有 `src/main/fixtures/streaming-reply.jsonl`（11 行领域事件）移到 `src/main/fixtures/domain/streaming-reply.jsonl`；`mock-backend.ts` import 改 `../fixtures/domain/streaming-reply.jsonl?raw`。**迁移时同步改形状**（`MockBackend` 构造期对每行跑 `parseBackendEvent`，新 schema 下原夹具两处必 fail）：① 每条 `generation.segment.completed` 补真实 `kind`（新 schema 必填）；② `generation.completed` 的 `conversationUsage` 从 `{input,output,total}` 改为 `{total, byModel, source:'server_aggregate'}`（docs/18 §9.2 禁止虚构）。迁移后 `mock-replay.spec.ts` 必须仍通过（见 §8 验收 #6）。
- 新增 `wire-v2/` 四组 fixture，每行是后端真实 wire 帧（判别 `type`，**无** `event/eventId/sequence/responseId`），manifest 同目录：

```json
// wire-v2/handshake.manifest.json
{ "backendCommit": "beeba5776413dde9761375c2fd9541d6636f180d", "protocol": "2", "serverProtocolVersion": "2.0" }
```

| fixture | 内容（依据当前契约构造；各帧带全必填键） |
|---|---|
| `handshake.jsonl` | `session{conversationId, messages:[], token_stats:{total,byModel}}` → `server_info{protocol_version:"2.0", server_version, features, services, connectionId, build_sha}` → `expression{expression, intensity}` |
| `chat-no-delta-inner-voice.jsonl` | `generation.started{generationId, messageId, conversationId, requestId, model}` → `segment.started(inner_voice,text)` → `segment.completed(content:"…")`（**零 delta**）→ `generation.completed{generationId, messageId, channel:"public_reply", finishReason, completeness:"complete", usage{rounds,turn_total}, model, mood, conversationUsage}` |
| `chat-tts-public-completed-only.jsonl` | TTS 开启：`generation.started` → `segment.started(public_reply,markdown)` → `segment.completed(content)` 零 delta 交付完整文本 → `generation.completed`（同上必填键） |
| `chat-failed.jsonl` | `generation.started{generationId, messageId, conversationId, requestId, model}` → `segment.started(public_reply,text)` → `delta`（部分内容）→ `generation.failed{generationId, messageId, code:"GENERATION_TIMEOUT", message, retryable:true, details, conversationId}` |

- **CI 两层验证**（docs/18 §5）：① 每行过 `parseRawFrame`；② 经 `FrameMapper` 后每个领域事件过 `parseBackendEvent`，并推进 `StreamAccumulator` 得到正确 `AssistantSegment[]`。

### 5.7 测试计划

| 文件 | 覆盖 |
|---|---|
| `raw-schemas.spec.ts` | 每类帧合法构造通过；未知 `type` fail；`channel:'status'` 接受；`finishReason` 非法值 fail；缺必填字段 fail（含 `usage`/`retryable`/`finishReason` 必填性、**缺 `channel` 的完成帧 → fail**——后端恒发）；`.strict()` 拒绝未知键；`completeness` 缺失/非 `'complete'` 字符串 → **通过**（raw 层不拒，由 mapper 对非 `'complete'` 告警）；**含 ≥1 条 `messages` 条目的 session 帧结构校验**（`SessionMessageItem` 全字段：role/message_id/parts/content/inner_voice/tool_calls/token_usage 等） |
| `frame-mapper.spec.ts` | §5.3 映射表全分支：started 补 conversationId、delta 用缓存 meta、`status` 段三类帧（started/delta/completed）均返回 null、无 meta 的 delta 抛 `PROTOCOL_MISMATCH`、segmentIndex 不一致告警、completed 普通段清理 meta（status 段保留，供迟到 delta 过滤）、failed 平铺→`error{}`、`completeness !== 'complete'` 告警、`eventId/sequence` 单调唯一、`Σtotal≠turn_total` 告警、非 generation 帧返回 null |
| `stream-accumulator.spec.ts`（扩展） | docs/18 §4.4 **八场景**：① inner voice 零 delta 有文字；② public reply 仅 completed(content) 零 delta 有文字；③ delta 一半 completed 覆盖完整；④ delta 乱序/缺口 completed 清缺口可完成父；⑤ completed 缺 content 保留 delta 拼接；⑥ content 空串正确覆盖；⑦ completed 后迟到 delta 忽略+告警；⑧ `kind:'markdown'` 不被改 text。加：segment.started 建段、generation.completed 是唯一终态 |
| `wire-fixtures.spec.ts` | 四组 fixture 两层校验（raw schema → mapper → 领域 schema → accumulator 推进）；**handshake 三帧断言 `mapFrame()===null`**（把「握手帧不产生领域事件」变成可执行断言，避免两层校验空转） |

## 6. 错误处理与安全

- **协议错误 fail closed**：mapper 对「delta 无 segment meta」「conversationId 无法补齐」抛 `CyreneError(PROTOCOL_MISMATCH)`，绝不填空串或默认 `public_reply/text`（docs/18 §8.2/§18）。
- **告警不静默**：`MAPPER_SEGMENT_INDEX_MISMATCH`/`MAPPER_TOKEN_SUM_MISMATCH`/`ACCUMULATOR_LATE_DELTA_AFTER_AUTHORITATIVE` 经 `onProtocolWarning` 上报；测试断言告警触发（缺省注入收集数组）。
- **不污染领域层**：`status` channel、`generation.completed` 的 `channel`（恒 `public_reply`）、`tool.*`/`audio*`/`voice.*` 帧不进入领域事件；`completeness` 正常值（恒 `complete`）不入领域、异常值 mapper 告警（docs/18 §8.5 不静默丢弃）；raw schema 拒绝未知键。
- **纯逻辑零副作用**：本块不触文件系统/网络/Electron API；`onProtocolWarning` 是唯一侧通道。

## 7. 测试策略

| 层 | 工具 | 覆盖 |
|---|---|---|
| 单测（本块新增/扩展） | vitest node env | raw schema 校验、frame mapper 全映射、Accumulator 权威规则、wire fixture 两层校验 |
| 单测（既有） | vitest | 阶段 1 182 项不回归（`pnpm test`）——尤其既有 accumulator/mock 测试（fixture 路径迁移后） |

**验证命令**：`pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm build`。

## 8. 验收标准

1. §5.4 领域契约与 §5.5 Accumulator 按精确形状落地；`pnpm typecheck` 通过（含 `BackendEvent` 判别联合扩展）。
2. **Accumulator 八场景 + started + 告警单测全绿**（docs/18 §4.4 逐一对应）。
3. **mapper 全映射单测全绿**：映射表每行一个用例 + 补全/告警/错误分支。
4. **raw schema 合法/非法单测全绿**（含 `.strict()` 拒绝未知键）。
5. **wire fixture 两层校验通过**；manifest 记录 `backendCommit=beeba577`。
6. 既有 182 单测不回归（mock fixture 迁移后）；`typecheck`/`lint`/`build` 过。
7. 本块标记「已开发、未联调」；doc 16 阶段 2 清单勾选；docs/18 相应条目标注已实施。

## 9. 风险与预案

| 风险 | 预案 |
|---|---|
| wire fixture 基于契约构造（非真实抓包）→ 与真实后端可能漂移 | manifest 记录 `backendCommit`；2B 真实联调时以实际后端 SHA 更新 fixture + 断言；docs/18 §19 要求 fixture 标注后端 commit |
| 领域契约扩展（`BackendEvent` 加事件）波及既有消费方（Mock/Accumulator/测试） | 一并同步修改；`pnpm typecheck` 兜底；既有 182 单测回归门 |
| 后端契约 `beeba577` 非部署版本 | 2A 以契约文件为准（契约权威顺序 #1）；联调时记录实际部署 SHA |
| 移除 `SegmentChannel.status` 到领域 → 未来要显示状态段 | 2A 过滤 + 记录；后续阶段按需映射独立状态事件 |

## 10. 已知限制与接受项

| # | 限制 | 影响/处理 |
|---|---|---|
| A-G1 | `session/server_info/expression` 帧本块只定义 raw schema 与 fixture，不实现映射（mapper 返回 null） | 属 2B 连接层；2A 保证 raw schema 能解析握手帧（含 `.strict()` 字段校验） |
| A-G2 | `session.messages` 回放消息（`SessionMessageItem`）只做结构校验，不归一化为领域 `Message`；`session-replay.jsonl`（带回放消息的完整序列）整体留 2B | raw schema 对 `SessionMessageItem` 的结构校验已在 `raw-schemas.spec.ts` 覆盖（含全字段条目）；归一化与回放归属测试属 2B |
| A-G3 | fixture 覆盖文本聊天四种场景，不含多 segment 交错/迟到 delta 的完整 wire 序列 | 单测（`stream-accumulator.spec.ts`）直接构造领域事件覆盖这些规则；wire fixture 专注「零 delta 权威 content」核心场景 |
| A-G4 | 领域 `SegmentChannel` 不含 `status`（后端 `MessageChannel` 三值） | 按 docs/18 §8.7 决策：raw 层接受全集、mapper 对 status 段三类帧均过滤不输出；**status 段 meta 保留至连接结束**（供其迟到 delta 过滤返回 null，不抛错；无领域事件/无清理点），普通段 completed 后清理；2B 连接层在 `generation.completed`/断连时清理 status meta 防长连接积累；记录接受 |
| A-G5 | `onProtocolWarning` 缺省静默（无全局日志接线） | 2B 连接层接线到日志（diagnostics.logger.warn）；本块只保证机制与测试 |
| A-G6 | **实施中新增决策**：预留追加 | 按目标指令追加 |
| A-G7 | `session.conversationId` 标记可选（后端 `beeba577` 为必填） | 兼容旧后端（docs/18 §7 审计时无此字段）；2B 连接层对缺省场景按 docs/18 §7.1 兼容策略处理；与 A-9 的 fail-closed 姿态差异是**故意的**（generation 帧缺 conversationId 影响流事件归属必须 fail；session 帧缺 conversationId 只影响回放归属，可降级缓冲） |
