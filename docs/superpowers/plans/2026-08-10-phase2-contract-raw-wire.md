# 阶段 2 块 A：领域契约修复 + raw wire 层 —— 实施计划

**日期：** 2026-08-10
**执行方式：** TDD，subagent 逐任务执行，每任务独立 commit。
**依据：** [spec](specs/2026-08-10-phase2-contract-raw-wire-design.md)（已 code-review 干净，commit `ec50060`）、[docs/18 §3-10](18-Cyrene-Electron-真实后端契约差异与前端修复清单-2026-08-09.md)、后端契约 `beeba577`（`/home/yomu/elysia-agent/frontend_contract/`）

## Goal

在纯逻辑层把领域契约、`StreamAccumulator`、raw wire schema 与 frame mapper 修到与后端契约一致，用 raw wire fixture 驱动全量单测。本块不实现真实网络连接、不碰 UI/Store（2B/2C）。

## Architecture

`shared/contracts`（领域契约 + `ProtocolWarning`）→ `shared/schemas`（领域 zod，非 strict）→ `main/transport/protocol-v2`（raw-types/raw-schemas 判别 `type` + `.strict()`、frame-mapper 转领域事件）→ `shared/domain`（StreamAccumulator 权威 content 规则）。fixture 分 `domain/`（领域事件，Mock 消费）与 `wire-v2/`（raw wire + manifest）。

## Tech Stack

TypeScript + zod + vitest（既有）。`@shared` 别名 → `src/shared`。

## Global Constraints（subagent 必须遵守，逐条绑定）

1. **raw 层位置**：raw wire 只放 `src/main/transport/protocol-v2/`，与领域契约分文件，禁止混用（spec A-1）。
2. **schema strict 差异**：raw schema（`raw-schemas.ts`）判别 `type` + `.strict()`（拒绝未知键）；**领域 schema（`shared/schemas/events.ts`）保持非 strict**（现有「未知可选字段被兼容」行为，`schemas.spec.ts` 有测试断言）。
3. **Accumulator 七条规则 + 八测试场景**：docs/18 §4.3/§4.4 逐条对应（plan Task 5 列出全部）。
4. **fail-closed**：delta 无 segment meta / generation 帧 conversationId 无法补齐 → 抛 `CyreneError(PROTOCOL_MISMATCH)`；绝不默认 `public_reply/text`、不填空串。
5. **status channel**：raw 层接受三值；mapper 对 status 段三类帧（started/delta/completed）一律返回 `null` 不告警；status 段 completed **保留 meta**（供其迟到 delta 过滤返回 null，不抛 `PROTOCOL_MISMATCH`），普通段 completed 才清理 meta；领域 `SegmentChannel` 保持两值。
6. **Token**：`TokenUsage` 保留 `{input,output,total,source}` + `rounds?`；`ConversationTokenUsage{total,byModel,source:'server_aggregate'}`；**禁止虚构 input/output**（docs/18 §9.2）。
7. **`ProtocolWarning` + 告警 code 常量**放 `shared/contracts/protocol.ts`（shared 层，避免 shared→main 反向依赖）。
8. **fixture manifest**：`wire-v2/*.manifest.json` 记录 `backendCommit: "beeba5776413dde9761375c2fd9541d6636f180d"`、`protocol: "2"`、`serverProtocolVersion: "2.0"`。
9. **领域 fixture 迁移**：`streaming-reply.jsonl` 移到 `fixtures/domain/` 并同步改形状（completed 补 `kind`、conversationUsage 改新类型），迁移后 `mock-replay.spec.ts` 必须仍通过。
10. 既有 182 单测不回归；`pnpm typecheck`、`pnpm lint`、`pnpm build` 全过；本块所有交付标「已开发、未联调」。
11. **zod 版本约束**：仓库 zod 为 **4.4.3**——`z.record` 必须用双参 `z.record(keySchema, valueSchema)`（单参 `z.record(valueSchema)` 推断 `Record<number, unknown>` 且 4.x 已废弃）。Task 2 的 `ConversationUsageSchema.byModel` 已按双参实现；**Task 3 raw-schemas 的 `features`/`services`/`byModel`/`content_type` 一律双参**（`z.record(z.string(), …)`），否则 typecheck 红。

---

### Task 1: 领域契约类型扩展（纯类型）

**Files:**
- Create: `src/shared/contracts/protocol.ts`
- Modify: `src/shared/contracts/message.ts`
- Modify: `src/shared/contracts/events.ts`
- Test: 无（类型由 `pnpm typecheck` 验证；schema 行为 Task 2 测）

**Interfaces:**
- Produces（后续任务依赖）：`ProtocolWarning`、告警 code 常量；`TokenUsageRound`、`ConversationTokenUsage`、`TokenUsage.rounds?`；`GenerationSegmentStartedEvent`；`SegmentCompletedEvent.kind/content?`；`GenerationCompletedEvent.messageId?/finishReason?/conversationUsage: ConversationTokenUsage`；`GenerationFailedEvent.messageId?/error{retryable?/details?}`。

- [ ] **Step 1: 新增 `src/shared/contracts/protocol.ts`**（完整内容）

```typescript
/**
 * 协议告警（纯逻辑层上报，不打断事件流）。
 * mapper/accumulator 通过 onProtocolWarning 注入上报；code 常量供测试/日志稳定引用。
 */
export interface ProtocolWarning {
  code: ProtocolWarningCode
  message: string
}

export const ProtocolWarningCode = {
  // mapper
  MAPPER_SEGMENT_INDEX_MISMATCH: 'MAPPER_SEGMENT_INDEX_MISMATCH',
  MAPPER_TOKEN_SUM_MISMATCH: 'MAPPER_TOKEN_SUM_MISMATCH',
  MAPPER_UNEXPECTED_COMPLETENESS: 'MAPPER_UNEXPECTED_COMPLETENESS',
  // accumulator
  ACCUMULATOR_LATE_DELTA_AFTER_AUTHORITATIVE: 'ACCUMULATOR_LATE_DELTA_AFTER_AUTHORITATIVE'
} as const

export type ProtocolWarningCode = typeof ProtocolWarningCode[keyof typeof ProtocolWarningCode]
```

- [ ] **Step 2: 修改 `src/shared/contracts/message.ts`** —— `TokenUsage` 加 `rounds?`，新增 `TokenUsageRound`、`ConversationTokenUsage`（完整替换该文件相关块）

```typescript
/** 单轮 token 消耗（映射自后端 raw TokenRound；session_id/timestamp 有意丢弃） */
export interface TokenUsageRound {
  model?: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedTokens?: number
  reasoningTokens?: number
  roundNum: number
}

/** Token 用量(区分单次回复 vs 服务端累计;禁止用字符数冒充) */
export interface TokenUsage {
  input: number
  output: number
  total: number
  source: 'provider_reported' | 'server_aggregate' | 'client_sum'
  /** 保留模型/缓存/推理拆分(设置页/诊断页后续需要) */
  rounds?: TokenUsageRound[]
}

/** 会话累计 token(后端只提供 total+byModel,禁止虚构 input/output) */
export interface ConversationTokenUsage {
  total: number
  byModel: Record<string, number>
  source: 'server_aggregate'
}
```

（`AssistantSegment`/`Message` 等其余不变；`TokenUsage` 的 `input/output/total/source` 保持原样以兼容现有消费方。）

- [ ] **Step 3: 修改 `src/shared/contracts/events.ts`**（完整替换）

```typescript
import type { SegmentChannel, SegmentKind, TokenUsage, ConversationTokenUsage } from './message'

/** 事件外壳:所有后端事件共有的标识字段 */
export interface BackendEventEnvelope {
  eventId: string
  sequence: number
  timestamp?: string
}

/** 一次 AI 回复开始 */
export interface GenerationStartedEvent extends BackendEventEnvelope {
  event: 'generation.started'
  generationId: string
  messageId: string
  responseId: string
  conversationId: string
  model?: string
}

/** 分段开始:领域层创建 segment 元数据(方案 A,docs/18 §8.2) */
export interface GenerationSegmentStartedEvent extends BackendEventEnvelope {
  event: 'generation.segment.started'
  generationId: string
  segmentId: string
  segmentIndex: number
  channel: SegmentChannel
  kind: SegmentKind
}

/** 分段增量:仅在 segment 内累计,乱序/重复由 StreamAccumulator 处理 */
export interface GenerationDeltaEvent extends BackendEventEnvelope {
  event: 'generation.delta'
  generationId: string
  segmentId: string
  segmentIndex: number
  channel: SegmentChannel
  kind: SegmentKind
  deltaSequence: number
  text: string
}

/** 一个分段完成(不结束父回复);content 为权威完整文本(可缺省,缺省保留 delta 拼接) */
export interface SegmentCompletedEvent extends BackendEventEnvelope {
  event: 'generation.segment.completed'
  generationId: string
  segmentId: string
  segmentIndex: number
  channel: SegmentChannel
  kind: SegmentKind
  content?: string
}

/** 父回复完成:唯一结束父回复的事件,统一写入 Token/模型/心情 */
export interface GenerationCompletedEvent extends BackendEventEnvelope {
  event: 'generation.completed'
  generationId: string
  messageId?: string
  responseId: string
  usage?: TokenUsage
  conversationUsage?: ConversationTokenUsage
  model?: string
  emotion?: string
  finishReason?: string
}

export interface GenerationFailedEvent extends BackendEventEnvelope {
  event: 'generation.failed'
  generationId: string
  messageId?: string
  error: { code: string; message: string; retryable?: boolean; details?: unknown }
}

/** 后端事件判别联合 */
export type BackendEvent =
  | GenerationStartedEvent
  | GenerationSegmentStartedEvent
  | GenerationDeltaEvent
  | SegmentCompletedEvent
  | GenerationCompletedEvent
  | GenerationFailedEvent
```

- [ ] **Step 4: 验证 `pnpm typecheck`**

Run: `pnpm typecheck`
Expected: **FAIL（预期中间态，3 处已知破坏点，Task 2 同步后恢复全绿）**：
1. `shared/schemas/events.ts`：`parseBackendEvent` 显式返回 `{data: BackendEvent}`，Task 1 后 `SegmentCompletedEvent` 要求必填 `kind`、`conversationUsage` 改 `ConversationTokenUsage`，而 `ConversationUsageSchema` 旧形状缺 `byModel/source` → 返回类型不可赋 → TS 报错（Task 2 同步 schema 后恢复）；
2. `shared/domain/stream-accumulator.ts`：`this.state.conversationUsage = event.conversationUsage`，state 类型旧 `{input,output,total}` ≠ 新 `ConversationTokenUsage` → TS2322（Task 2 修一行类型后恢复）；
3. `tests/unit/stream-accumulator.spec.ts`：既有 `segmentCompleted()` 辅助函数缺 `kind`（Task 1 后必填）→ 字面量不可赋 `BackendEvent`（Task 2 修辅助函数后恢复）。

此步不追求 PASS——本任务只改类型声明，配套 schema/accumulator/测试的同步在 Task 2（TDD 的 red 阶段先写测试）。执行 subagent 记录这 3 处已知红，继续 Task 2。

- [ ] **Step 5: Commit**

```bash
git add src/shared/contracts/protocol.ts src/shared/contracts/message.ts src/shared/contracts/events.ts
git commit -m "feat(阶段2块A): 领域契约类型扩展——ProtocolWarning/Token 结构/新事件"
```

---

### Task 2: 领域 schema 同步 + 领域 fixture 迁移 + 契约测试

**Files:**
- Modify: `src/shared/schemas/events.ts`
- Modify: `tests/unit/schemas.spec.ts`
- Modify: `src/shared/domain/stream-accumulator.ts`（仅一行类型对齐：`StreamAccumulatorState.conversationUsage` → `ConversationTokenUsage`；其余逻辑 Task 5 完整替换）
- Move + Modify: `src/main/fixtures/streaming-reply.jsonl` → `src/main/fixtures/domain/streaming-reply.jsonl`
- Modify: `src/main/transport/mock-backend.ts`
- Modify: `tests/unit/stream-accumulator.spec.ts`（仅辅助函数 `segmentCompleted()` 补 `kind`，不扩展场景——Task 5 扩展）

**Interfaces:**
- Consumes: Task 1 的类型。
- Produces: `GenerationSegmentStartedEventSchema`、`SegmentCompletedEventSchema`（+kind/content?）、`GenerationCompletedEventSchema`（+messageId?/finishReason?/conversationUsage 新形状）、`GenerationFailedEventSchema`（error+retryable?/details?）、`TokenUsageRoundSchema`、`ConversationUsageSchema`（新形状）；迁移后的 `domain/streaming-reply.jsonl`。

**重要：** 领域 schema **保持非 strict**（现有「未知字段兼容」行为，`schemas.spec.ts`「未知可选字段被兼容」测试必须继续通过）。

- [ ] **Step 1: 写失败测试** —— 扩展 `tests/unit/schemas.spec.ts`（追加 describe 或用例；先跑确认 fail，因 schema 尚未同步）

```typescript
// 追加到 schemas.spec.ts（在现有 describe 内或新增 describe）

describe('扩展后的事件 Schema', () => {
  it('segment.started 合法事件通过', () => {
    const ok = {
      eventId: 'e9',
      sequence: 9,
      event: 'generation.segment.started',
      generationId: 'gen-1',
      segmentId: 'seg-1',
      segmentIndex: 0,
      channel: 'inner_voice',
      kind: 'text'
    }
    expect(parseBackendEvent(ok).success).toBe(true)
  })

  it('segment.completed 必填 kind,可选 content', () => {
    const withContent = {
      eventId: 'e10', sequence: 10, event: 'generation.segment.completed',
      generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 0,
      channel: 'inner_voice', kind: 'text', content: '权威文本'
    }
    expect(parseBackendEvent(withContent).success).toBe(true)
    const noContent = { ...withContent }
    delete (noContent as Record<string, unknown>).content
    expect(parseBackendEvent(noContent).success).toBe(true)
    const noKind = { ...withContent }
    delete (noKind as Record<string, unknown>).kind
    expect(parseBackendEvent(noKind).success).toBe(false)
  })

  it('segment.completed 的 content 空串合法', () => {
    const ok = {
      eventId: 'e11', sequence: 11, event: 'generation.segment.completed',
      generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 0,
      channel: 'public_reply', kind: 'markdown', content: ''
    }
    expect(parseBackendEvent(ok).success).toBe(true)
  })

  it('completed 事件带新 conversationUsage 形状通过', () => {
    const ok = {
      eventId: 'e12', sequence: 12, event: 'generation.completed',
      generationId: 'gen-1', responseId: 'rsp-1',
      conversationUsage: { total: 2100, byModel: { 'm1': 2100 }, source: 'server_aggregate' }
    }
    expect(parseBackendEvent(ok).success).toBe(true)
  })

  it('completed 事件拒绝旧虚构 conversationUsage 形状', () => {
    const bad = {
      eventId: 'e13', sequence: 13, event: 'generation.completed',
      generationId: 'gen-1', responseId: 'rsp-1',
      conversationUsage: { input: 1200, output: 900, total: 2100 }
    }
    expect(parseBackendEvent(bad).success).toBe(false)
  })

  it('failed 事件 error 带 retryable/details 通过', () => {
    const ok = {
      eventId: 'e14', sequence: 14, event: 'generation.failed',
      generationId: 'gen-1', messageId: 'msg-1',
      error: { code: 'GENERATION_TIMEOUT', message: '超时', retryable: true, details: { elapsed_ms: 30000 } }
    }
    expect(parseBackendEvent(ok).success).toBe(true)
  })

  it('completed 事件 usage.rounds 形状通过,非法 round 被拒', () => {
    const ok = {
      eventId: 'e16', sequence: 16, event: 'generation.completed',
      generationId: 'gen-1', responseId: 'rsp-1',
      usage: { input: 100, output: 20, total: 120, source: 'provider_reported', rounds: [{ model: 'm1', inputTokens: 100, outputTokens: 20, totalTokens: 120, roundNum: 0 }] }
    }
    expect(parseBackendEvent(ok).success).toBe(true) // roundNum 0 合法(后端 int 无下限)
    const bad = {
      ...ok,
      usage: { input: 100, output: 20, total: 120, source: 'provider_reported', rounds: [{ model: 'm1', inputTokens: 100, outputTokens: 20, totalTokens: -1, roundNum: 0 }] }
    }
    expect(parseBackendEvent(bad).success).toBe(false)
  })

  it('completed 事件 messageId/finishReason 可选', () => {
    const ok = {
      eventId: 'e15', sequence: 15, event: 'generation.completed',
      generationId: 'gen-1', responseId: 'rsp-1',
      messageId: 'msg-1', finishReason: 'stop'
    }
    expect(parseBackendEvent(ok).success).toBe(true)
  })
})
```

Run: `pnpm test -- tests/unit/schemas.spec.ts`
Expected: FAIL（schema 未同步，新事件/字段被拒）

- [ ] **Step 2: 实现 schema** —— 完整替换 `src/shared/schemas/events.ts`

```typescript
import { z } from 'zod'
import type { BackendEvent } from '../contracts'

export const SegmentChannelSchema = z.enum(['inner_voice', 'public_reply'])
export const SegmentKindSchema = z.enum([
  'text', 'markdown', 'image', 'video', 'audio', 'file', 'sticker', 'link'
])

export const BackendEventEnvelopeSchema = z.object({
  eventId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string().optional()
})

export const GenerationStartedEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('generation.started'),
  generationId: z.string().min(1),
  messageId: z.string().min(1),
  responseId: z.string().min(1),
  conversationId: z.string().min(1),
  model: z.string().optional()
})

export const GenerationSegmentStartedEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('generation.segment.started'),
  generationId: z.string().min(1),
  segmentId: z.string().min(1),
  segmentIndex: z.number().int().nonnegative(),
  channel: SegmentChannelSchema,
  kind: SegmentKindSchema
})

export const GenerationDeltaEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('generation.delta'),
  generationId: z.string().min(1),
  segmentId: z.string().min(1),
  segmentIndex: z.number().int().nonnegative(),
  channel: SegmentChannelSchema,
  kind: SegmentKindSchema,
  deltaSequence: z.number().int().nonnegative(),
  text: z.string()
})

export const SegmentCompletedEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('generation.segment.completed'),
  generationId: z.string().min(1),
  segmentId: z.string().min(1),
  segmentIndex: z.number().int().nonnegative(),
  channel: SegmentChannelSchema,
  kind: SegmentKindSchema,
  content: z.string().optional()
})

export const TokenUsageRoundSchema = z.object({
  model: z.string().optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  roundNum: z.number().int().nonnegative()   // 后端 TokenRound.round_num 为 int(无下限,测试用 0);契约对齐
})

export const TokenUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  source: z.enum(['provider_reported', 'server_aggregate', 'client_sum']),
  rounds: z.array(TokenUsageRoundSchema).optional()
})

export const ConversationUsageSchema = z.object({
  total: z.number().int().nonnegative(),
  byModel: z.record(z.string(), z.number().int().nonnegative()),   // zod 4.4.3 双参 record(单参推断 Record<number,unknown>)
  source: z.literal('server_aggregate')
})

export const GenerationCompletedEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('generation.completed'),
  generationId: z.string().min(1),
  messageId: z.string().optional(),
  responseId: z.string().min(1),
  usage: TokenUsageSchema.optional(),
  conversationUsage: ConversationUsageSchema.optional(),
  model: z.string().optional(),
  emotion: z.string().optional(),
  finishReason: z.string().optional()
})

export const GenerationFailedEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('generation.failed'),
  generationId: z.string().min(1),
  messageId: z.string().optional(),
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean().optional(),
    details: z.unknown().optional()
  })
})

export const BackendEventSchema = z.discriminatedUnion('event', [
  GenerationStartedEventSchema,
  GenerationSegmentStartedEventSchema,
  GenerationDeltaEventSchema,
  SegmentCompletedEventSchema,
  GenerationCompletedEventSchema,
  GenerationFailedEventSchema
])

export function parseBackendEvent(input: unknown): {
  success: true
  data: BackendEvent
} | {
  success: false
  error: z.ZodError
} {
  return BackendEventSchema.safeParse(input)
}
```

**同步两处最小修复（Task 1 已知破坏点 #2/#3，恢复 typecheck 全绿）：**
- `src/shared/domain/stream-accumulator.ts`：`StreamAccumulatorState.conversationUsage` 类型改 `ConversationTokenUsage`，并在文件顶部 import 加 `type { ConversationTokenUsage } from '../contracts/message'`（本文件其余逻辑 Task 5 完整替换，此处仅一行类型对齐）。
- `tests/unit/stream-accumulator.spec.ts`：`segmentCompleted()` 辅助函数加 `kind: 'text'`（新 schema 必填）。

- [ ] **Step 3: 迁移领域 fixture + mock import**

a) `mkdir src/main/fixtures/domain`，移动 `streaming-reply.jsonl` 到 `src/main/fixtures/domain/streaming-reply.jsonl`，并**改形状**：
- 第 6 行（seg-iv-1 completed）加 `"kind":"text"`；
- 第 9 行（seg-pr-1 completed）加 `"kind":"markdown"`；
- 第 10 行（seg-pr-2 completed）加 `"kind":"markdown"`；
- 第 11 行 `conversationUsage` 改为 `{"total":2100,"byModel":{"cyrene-llm-v1":2100},"source":"server_aggregate"}`（删除虚构 `input/output`）。

b) `src/main/transport/mock-backend.ts`：import 改 `import fixtureRaw from '../fixtures/domain/streaming-reply.jsonl?raw'`。

- [ ] **Step 4: 验证 typecheck + 全量单测**

Run: `pnpm typecheck` 与 `pnpm test`
Expected: 全绿（typecheck 恢复；schemas.spec.ts 扩展用例 + 既有 182 项；`mock-replay.spec.ts` 迁移后通过——`MockBackend` 构造期 parseBackendEvent 对新形状合法）

- [ ] **Step 5: Commit**

```bash
git add src/shared/schemas/events.ts tests/unit/schemas.spec.ts src/shared/domain/stream-accumulator.ts src/main/fixtures src/main/transport/mock-backend.ts tests/unit/stream-accumulator.spec.ts
git commit -m "feat(阶段2块A): 领域 schema 同步新事件 + 领域 fixture 迁移改形状"
```

---

### Task 3: raw wire 层 —— raw-types + raw-schemas

**Files:**
- Create: `src/main/transport/protocol-v2/raw-types.ts`
- Create: `src/main/transport/protocol-v2/raw-schemas.ts`
- Create: `tests/unit/raw-schemas.spec.ts`

**Interfaces:**
- Consumes: 无（raw 层独立；不依赖领域层）。
- Produces: `RawFrame` 判别联合、`parseRawFrame(input): {success:true; data:RawFrame}|{success:false; error:z.ZodError}`。

**约束：** raw schema 判别 `type` + `.strict()`；字段精确对齐后端契约（见下方完整代码）；`completeness` 为 `z.string().optional()`（保留 mapper 告警路径）。

- [ ] **Step 1: 写失败测试** —— `tests/unit/raw-schemas.spec.ts`（完整内容）

```typescript
import { describe, expect, it } from 'vitest'
import { parseRawFrame } from '../../src/main/transport/protocol-v2/raw-schemas'

const validCompleted = {
  type: 'generation.completed',
  generationId: 'gen-1',
  messageId: 'msg-1',
  channel: 'public_reply',
  finishReason: 'stop',
  usage: { rounds: [{ model: 'm1', input_tokens: 100, output_tokens: 20, total_tokens: 120, round_num: 1 }], turn_total: 120 },
  model: 'm1',
  mood: 'happy',
  completeness: 'complete'
}

describe('raw wire schema', () => {
  it('handshake 三帧合法构造通过', () => {
    expect(parseRawFrame({ type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 0, byModel: {} } }).success).toBe(true)
    expect(parseRawFrame({ type: 'server_info', protocol_version: '2.0', server_version: '0.4.0', features: {}, services: {} }).success).toBe(true)
    expect(parseRawFrame({ type: 'expression', expression: 'idle', intensity: 0.5 }).success).toBe(true)
  })

  it('session 帧带 messages 条目(全字段)通过', () => {
    const session = {
      type: 'session',
      conversationId: 'conv-1',
      messages: [{
        role: 'user', message_id: 'msg-1', timestamp: '2026-08-10T00:00:00.000Z',
        parts: [{ content: 'hi' }], content: 'hi', mood: 'calm',
        inner_voice: '…', tool_calls: [], tool_call_id: 'tc-1', name: 'tool',
        success: true, error: '', error_type: '', duration_ms: 10, truncated: false,
        token_usage: { rounds: [], turn_total: 0 }
      }],
      token_stats: { total: 0, byModel: {} }
    }
    expect(parseRawFrame(session).success).toBe(true)
  })

  it('generation 各帧合法构造通过', () => {
    expect(parseRawFrame({ type: 'generation.started', generationId: 'g', messageId: 'm', conversationId: 'c', requestId: 'r', model: 'm1' }).success).toBe(true)
    expect(parseRawFrame({ type: 'generation.segment.started', generationId: 'g', segmentId: 's', segmentIndex: 0, channel: 'inner_voice', kind: 'text' }).success).toBe(true)
    expect(parseRawFrame({ type: 'generation.delta', generationId: 'g', segmentId: 's', segmentIndex: 0, deltaSequence: 0, delta: 'x' }).success).toBe(true)
    expect(parseRawFrame({ type: 'generation.segment.completed', generationId: 'g', segmentId: 's', segmentIndex: 0, channel: 'inner_voice', kind: 'text', content: '完整' }).success).toBe(true)
    expect(parseRawFrame(validCompleted).success).toBe(true)
    expect(parseRawFrame({ type: 'generation.failed', generationId: 'g', messageId: 'm', code: 'GENERATION_TIMEOUT', message: '超时', retryable: true, details: {} }).success).toBe(true)
  })

  it('channel status 被接受(raw 层三值)', () => {
    expect(parseRawFrame({ type: 'generation.segment.started', generationId: 'g', segmentId: 's', segmentIndex: 0, channel: 'status', kind: 'text' }).success).toBe(true)
  })

  it('未知 type 被拒绝', () => {
    expect(parseRawFrame({ type: 'generation.unknown', generationId: 'g' }).success).toBe(false)
  })

  it('strict:未知键被拒绝', () => {
    expect(parseRawFrame({ ...validCompleted, bogus: 1 }).success).toBe(false)
  })

  it('strict:缺 channel 的完成帧被拒绝(后端恒发)', () => {
    const noChannel = { ...validCompleted }
    delete (noChannel as Record<string, unknown>).channel
    expect(parseRawFrame(noChannel).success).toBe(false)
  })

  it('completeness 缺失/非 complete 字符串均通过(raw 层不拒,由 mapper 告警)', () => {
    const noCompleteness = { ...validCompleted }
    delete (noCompleteness as Record<string, unknown>).completeness
    expect(parseRawFrame(noCompleteness).success).toBe(true)
    expect(parseRawFrame({ ...validCompleted, completeness: 'partial' }).success).toBe(true)
  })

  it('finishReason 非法值被拒绝', () => {
    expect(parseRawFrame({ ...validCompleted, finishReason: 'error' }).success).toBe(false)
  })

  it('缺必填字段被拒绝(usage/model/finishReason/retryable)', () => {
    const noUsage = { ...validCompleted }
    delete (noUsage as Record<string, unknown>).usage
    expect(parseRawFrame(noUsage).success).toBe(false)
    const noModel = { ...validCompleted }
    delete (noModel as Record<string, unknown>).model
    expect(parseRawFrame(noModel).success).toBe(false)
    const noFinish = { ...validCompleted }
    delete (noFinish as Record<string, unknown>).finishReason
    expect(parseRawFrame(noFinish).success).toBe(false)
    const failedNoRetryable = { type: 'generation.failed', generationId: 'g', code: 'X', message: 'm', details: {} }
    expect(parseRawFrame(failedNoRetryable).success).toBe(false)
  })

  it('round_num 为 0 合法(后端 int 无下限)', () => {
    const r0 = { ...validCompleted, usage: { rounds: [{ model: 'm1', input_tokens: 0, output_tokens: 0, total_tokens: 0, round_num: 0 }], turn_total: 0 } }
    expect(parseRawFrame(r0).success).toBe(true)
  })
})
```

Run: `pnpm test -- tests/unit/raw-schemas.spec.ts`
Expected: FAIL（raw-schemas 不存在）

- [ ] **Step 2: 实现 `src/main/transport/protocol-v2/raw-types.ts`**（完整内容，权威字段见 spec §5.1）

```typescript
/** 后端 WS v2 raw wire 类型(保留后端原始命名;与领域层禁止混用) */

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

/** 建连帧(ws_handler:session → server_info → expression) */
export interface RawSessionMessage {
  type: 'session'
  conversationId?: string
  messages: RawSessionMessageItem[]
  token_stats?: RawTokenStats
}
export interface RawSessionMessageItem {
  // 2A 只做结构校验;parts/content/tool_calls 用 unknown 是有意放宽(精确类型在 2B 回放归一化时建)
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
  channel: 'public_reply'
  finishReason: 'stop' | 'tool_calls'
  usage: RawTokenUsage
  model: string
  mood?: string
  completeness?: string
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

- [ ] **Step 3: 实现 `src/main/transport/protocol-v2/raw-schemas.ts`**（完整内容）

```typescript
import { z } from 'zod'
import type { RawFrame } from './raw-types'

/** 后端 WS v2 raw frame zod schema(判别 type + .strict();字段精确对齐后端契约) */

export const RawSegmentChannelSchema = z.enum(['inner_voice', 'public_reply', 'status'])
export const RawSegmentKindSchema = z.enum([
  'text', 'markdown', 'image', 'video', 'audio', 'file', 'sticker', 'link'
])

const RawTokenRoundSchema = z.object({
  model: z.string().optional(),
  session_id: z.string().optional(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  cached_tokens: z.number().int().nonnegative().optional(),
  reasoning_tokens: z.number().int().nonnegative().optional(),
  round_num: z.number().int().nonnegative(),   // 后端 TokenRound.round_num 为 int(无下限,测试用 0);契约对齐
  timestamp: z.string().optional()
})
const RawTokenUsageSchema = z.object({ rounds: z.array(RawTokenRoundSchema), turn_total: z.number().int().nonnegative() })
const RawTokenStatsSchema = z.object({ total: z.number().int().nonnegative(), byModel: z.record(z.string(), z.number().int().nonnegative()) })
const RawConversationUsageSchema = z.object({ total: z.number().int().nonnegative(), byModel: z.record(z.string(), z.number().int().nonnegative()) })

const RawSessionMessageItemSchema = z.object({
  role: z.string().min(1),
  message_id: z.string().optional(),
  timestamp: z.string().optional(),
  parts: z.array(z.unknown()).optional(),
  content: z.unknown().optional(),
  content_type: z.record(z.string(), z.array(z.number().int().nonnegative())).optional(),
  mood: z.string().optional(),
  tool_calls: z.array(z.unknown()).optional(),
  inner_voice: z.string().optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
  success: z.boolean().optional(),
  error: z.string().optional(),
  error_type: z.string().optional(),
  duration_ms: z.number().optional(),
  truncated: z.boolean().optional(),
  token_usage: RawTokenUsageSchema.optional()
}).strict()

const RawSessionMessageSchema = z.object({
  type: z.literal('session'),
  conversationId: z.string().optional(),
  messages: z.array(RawSessionMessageItemSchema),
  token_stats: RawTokenStatsSchema.optional()
}).strict()

const RawServerInfoSchema = z.object({
  type: z.literal('server_info'),
  protocol_version: z.string().min(1),
  server_version: z.string().min(1),
  features: z.record(z.string(), z.unknown()),
  services: z.record(z.string(), z.unknown()),
  connectionId: z.string().optional(),
  build_sha: z.string().optional()
}).strict()

const RawExpressionSchema = z.object({
  type: z.literal('expression'),
  expression: z.string().min(1),
  intensity: z.number().optional()
}).strict()

const RawGenerationStartedSchema = z.object({
  type: z.literal('generation.started'),
  generationId: z.string().min(1),
  messageId: z.string().min(1),
  conversationId: z.string().optional(),
  requestId: z.string().optional(),
  model: z.string().optional()
}).strict()

const RawGenerationSegmentStartedSchema = z.object({
  type: z.literal('generation.segment.started'),
  generationId: z.string().min(1),
  segmentId: z.string().min(1),
  segmentIndex: z.number().int().nonnegative(),
  channel: RawSegmentChannelSchema,
  kind: RawSegmentKindSchema,
  conversationId: z.string().optional()
}).strict()

const RawGenerationDeltaSchema = z.object({
  type: z.literal('generation.delta'),
  generationId: z.string().min(1),
  segmentId: z.string().min(1),
  segmentIndex: z.number().int().nonnegative(),
  deltaSequence: z.number().int().nonnegative(),
  delta: z.string(),
  conversationId: z.string().optional()
}).strict()

const RawGenerationSegmentCompletedSchema = z.object({
  type: z.literal('generation.segment.completed'),
  generationId: z.string().min(1),
  segmentId: z.string().min(1),
  segmentIndex: z.number().int().nonnegative(),
  channel: RawSegmentChannelSchema,
  kind: RawSegmentKindSchema,
  content: z.string().optional(),
  conversationId: z.string().optional()
}).strict()

const RawGenerationCompletedSchema = z.object({
  type: z.literal('generation.completed'),
  generationId: z.string().min(1),
  messageId: z.string().min(1),
  channel: z.literal('public_reply'),
  finishReason: z.enum(['stop', 'tool_calls']),
  usage: RawTokenUsageSchema,
  model: z.string().min(1),
  mood: z.string().optional(),
  completeness: z.string().optional(),
  conversationId: z.string().optional(),
  conversationUsage: RawConversationUsageSchema.optional()
}).strict()

const RawGenerationFailedSchema = z.object({
  type: z.literal('generation.failed'),
  generationId: z.string().min(1),
  messageId: z.string().optional(),
  model: z.string().optional(),
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()),   // zod 4.4.3 双参 record
  conversationId: z.string().optional()
}).strict()

export const RawFrameSchema = z.discriminatedUnion('type', [
  RawSessionMessageSchema,
  RawServerInfoSchema,
  RawExpressionSchema,
  RawGenerationStartedSchema,
  RawGenerationSegmentStartedSchema,
  RawGenerationDeltaSchema,
  RawGenerationSegmentCompletedSchema,
  RawGenerationCompletedSchema,
  RawGenerationFailedSchema
])

export function parseRawFrame(input: unknown): {
  success: true
  data: RawFrame
} | {
  success: false
  error: z.ZodError
} {
  return RawFrameSchema.safeParse(input)
}
```

- [ ] **Step 4: 验证**

Run: `pnpm test -- tests/unit/raw-schemas.spec.ts` 与 `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/transport/protocol-v2/raw-types.ts src/main/transport/protocol-v2/raw-schemas.ts tests/unit/raw-schemas.spec.ts
git commit -m "feat(阶段2块A): raw wire 层——raw-types/raw-schemas(判别 type + strict)"
```

---

### Task 4: frame-mapper —— raw frame → 领域事件

**Files:**
- Create: `src/main/transport/protocol-v2/frame-mapper.ts`
- Create: `tests/unit/frame-mapper.spec.ts`

**Interfaces:**
- Consumes: `RawFrame`/`parseRawFrame`（Task 3）、领域事件类型 + `ProtocolWarning`（Task 1）。
- Produces: `FrameMapper`（`mapFrame(frame): BackendEvent | null`、`setActiveConversationId(id)`）；`ProtocolWarningCode` 的 mapper 告警。

**约束：** 见 spec §5.3 映射表（7 行）——status 三类帧返回 null、fail-closed 抛 `PROTOCOL_MISMATCH`、`eventId = ${connectionId}:${sequence++}`、segment.completed 后清理 meta。

- [ ] **Step 1: 写失败测试** —— `tests/unit/frame-mapper.spec.ts`（完整内容）

```typescript
import { describe, expect, it } from 'vitest'
import { FrameMapper } from '../../src/main/transport/protocol-v2/frame-mapper'
import { ProtocolWarningCode } from '@shared/contracts/protocol'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import type { RawFrame } from '../../src/main/transport/protocol-v2/raw-types'

function collectWarnings(): { warnings: { code: string; message: string }[]; onWarning: (w: { code: string; message: string }) => void } {
  const warnings: { code: string; message: string }[] = []
  return { warnings, onWarning: (w) => warnings.push(w) }
}

describe('FrameMapper raw → 领域', () => {
  it('generation.started 映射 responseId=generationId,保留 conversationId/model', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1' })
    const ev = mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1', conversationId: 'conv-1', model: 'm1' })
    expect(ev).not.toBeNull()
    expect(ev!.event).toBe('generation.started')
    expect(ev!.responseId).toBe('gen-1')
    expect(ev!.messageId).toBe('msg-1')
    expect(ev!.conversationId).toBe('conv-1')
    expect(ev!.model).toBe('m1')
  })

  it('generation.started 无法补齐 conversationId 抛 PROTOCOL_MISMATCH', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1' })
    expect(() => mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' })).toThrow(CyreneError)
    try {
      mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' })
    } catch (e) {
      expect((e as CyreneError).code).toBe(CyreneErrorCode.PROTOCOL_MISMATCH)
    }
  })

  it('setActiveConversationId 后缺 conversationId 的帧被补齐', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1' })
    mapper.setActiveConversationId('conv-9')
    const ev = mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' })
    expect(ev!.conversationId).toBe('conv-9')
  })

  it('segment.started 建立 meta,delta 用缓存 channel/kind 补全', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1' })
    mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' })
    mapper.mapFrame({ type: 'generation.segment.started', generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 0, channel: 'inner_voice', kind: 'text' })
    const delta = mapper.mapFrame({ type: 'generation.delta', generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 0, deltaSequence: 0, delta: '第一句' })
    expect(delta!.event).toBe('generation.delta')
    expect(delta!.channel).toBe('inner_voice')
    expect(delta!.kind).toBe('text')
    expect(delta!.text).toBe('第一句')
  })

  it('delta 无 segment meta 抛 PROTOCOL_MISMATCH(不默认 public_reply/text)', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1' })
    mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' })
    expect(() => mapper.mapFrame({ type: 'generation.delta', generationId: 'gen-1', segmentId: 'seg-x', segmentIndex: 0, deltaSequence: 0, delta: 'x' })).toThrow(CyreneError)
  })

  it('segmentIndex 与缓存不一致告警且以 meta 为准', () => {
    const { warnings, onWarning } = collectWarnings()
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1', onProtocolWarning: onWarning })
    mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' })
    mapper.mapFrame({ type: 'generation.segment.started', generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 0, channel: 'public_reply', kind: 'text' })
    const delta = mapper.mapFrame({ type: 'generation.delta', generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 9, deltaSequence: 0, delta: 'x' })
    expect(delta!.segmentIndex).toBe(0) // meta 为准
    expect(warnings.some((w) => w.code === ProtocolWarningCode.MAPPER_SEGMENT_INDEX_MISMATCH)).toBe(true)
  })

  it('status 段三类帧均返回 null 不告警', () => {
    const { warnings, onWarning } = collectWarnings()
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1', onProtocolWarning: onWarning })
    mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' })
    const started = mapper.mapFrame({ type: 'generation.segment.started', generationId: 'gen-1', segmentId: 'seg-s', segmentIndex: 0, channel: 'status', kind: 'text' })
    const delta = mapper.mapFrame({ type: 'generation.delta', generationId: 'gen-1', segmentId: 'seg-s', segmentIndex: 0, deltaSequence: 0, delta: 'x' })
    const completed = mapper.mapFrame({ type: 'generation.segment.completed', generationId: 'gen-1', segmentId: 'seg-s', segmentIndex: 0, channel: 'status', kind: 'text' })
    expect(started).toBeNull()
    expect(delta).toBeNull()
    expect(completed).toBeNull()
    expect(warnings).toHaveLength(0)
  })

  it('segment.completed 保留 kind/content,完成后清理 meta', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1' })
    mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' })
    mapper.mapFrame({ type: 'generation.segment.started', generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 0, channel: 'inner_voice', kind: 'text' })
    const ev = mapper.mapFrame({ type: 'generation.segment.completed', generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 0, channel: 'inner_voice', kind: 'text', content: '权威文本' })
    expect(ev!.content).toBe('权威文本')
    expect(ev!.kind).toBe('text')
    // meta 已清理 → 同一 segment 的迟到 delta 无 meta → 抛 PROTOCOL_MISMATCH(证明已清理)
    expect(() => mapper.mapFrame({ type: 'generation.delta', generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 0, deltaSequence: 1, delta: '迟到' })).toThrow(CyreneError)
  })

  it('segment.completed 无 content 时 kind/channel 来自 meta,content 为 undefined', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1' })
    mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' })
    mapper.mapFrame({ type: 'generation.segment.started', generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 0, channel: 'inner_voice', kind: 'text' })
    const ev = mapper.mapFrame({ type: 'generation.segment.completed', generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 0, channel: 'inner_voice', kind: 'text' })
    expect(ev!.content).toBeUndefined()
    expect(ev!.channel).toBe('inner_voice')
    expect(ev!.kind).toBe('text')
  })

  it('status 段 completed 后保留 meta:迟到 delta 返回 null 而非抛错', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1' })
    mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' })
    mapper.mapFrame({ type: 'generation.segment.started', generationId: 'gen-1', segmentId: 'seg-s', segmentIndex: 0, channel: 'status', kind: 'text' })
    expect(mapper.mapFrame({ type: 'generation.segment.completed', generationId: 'gen-1', segmentId: 'seg-s', segmentIndex: 0, channel: 'status', kind: 'text' })).toBeNull()
    // status meta 保留 → 迟到 delta 走 status 过滤返回 null,不抛 PROTOCOL_MISMATCH
    expect(mapper.mapFrame({ type: 'generation.delta', generationId: 'gen-1', segmentId: 'seg-s', segmentIndex: 0, deltaSequence: 1, delta: 'x' })).toBeNull()
  })

  it('generation.completed 映射 emotion=mood/finishReason/messageId/usage/conversationUsage', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1' })
    const raw: RawFrame = {
      type: 'generation.completed',
      generationId: 'gen-1',
      messageId: 'msg-1',
      channel: 'public_reply',
      finishReason: 'stop',
      usage: { rounds: [{ model: 'm1', input_tokens: 100, output_tokens: 20, total_tokens: 120, round_num: 1 }], turn_total: 120 },
      model: 'm1',
      mood: 'happy',
      completeness: 'complete',
      conversationUsage: { total: 2100, byModel: { 'm1': 2100 } }
    }
    const ev = mapper.mapFrame(raw)
    expect(ev!.event).toBe('generation.completed')
    expect(ev!.responseId).toBe('gen-1')
    expect(ev!.messageId).toBe('msg-1')
    expect(ev!.emotion).toBe('happy')
    expect(ev!.finishReason).toBe('stop')
    expect(ev!.usage).toEqual({ input: 100, output: 20, total: 120, source: 'provider_reported', rounds: [{ model: 'm1', inputTokens: 100, outputTokens: 20, totalTokens: 120, roundNum: 1 }] })
    expect(ev!.conversationUsage).toEqual({ total: 2100, byModel: { 'm1': 2100 }, source: 'server_aggregate' })
  })

  it('Σtotal_tokens !== turn_total 告警但保留服务端 turn_total', () => {
    const { warnings, onWarning } = collectWarnings()
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1', onProtocolWarning: onWarning })
    const raw: RawFrame = {
      type: 'generation.completed', generationId: 'gen-1', messageId: 'msg-1', channel: 'public_reply',
      finishReason: 'stop',
      usage: { rounds: [{ model: 'm1', input_tokens: 1, output_tokens: 1, total_tokens: 2, round_num: 1 }], turn_total: 100 },
      model: 'm1'
    }
    const ev = mapper.mapFrame(raw)
    expect(ev!.usage!.total).toBe(100) // 服务端权威
    expect(warnings.some((w) => w.code === ProtocolWarningCode.MAPPER_TOKEN_SUM_MISMATCH)).toBe(true)
  })

  it('completeness 非 complete 告警(不静默丢弃)', () => {
    const { warnings, onWarning } = collectWarnings()
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1', onProtocolWarning: onWarning })
    const raw: RawFrame = {
      type: 'generation.completed', generationId: 'gen-1', messageId: 'msg-1', channel: 'public_reply',
      finishReason: 'stop',
      usage: { rounds: [], turn_total: 0 }, model: 'm1', completeness: 'partial'
    }
    mapper.mapFrame(raw)
    expect(warnings.some((w) => w.code === ProtocolWarningCode.MAPPER_UNEXPECTED_COMPLETENESS)).toBe(true)
  })

  it('generation.failed 平铺 → error 结构', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1' })
    const ev = mapper.mapFrame({
      type: 'generation.failed', generationId: 'gen-1', messageId: 'msg-1',
      code: 'GENERATION_TIMEOUT', message: '超时', retryable: true, details: { elapsed_ms: 30000 }
    })
    expect(ev!.event).toBe('generation.failed')
    expect(ev!.error).toEqual({ code: 'GENERATION_TIMEOUT', message: '超时', retryable: true, details: { elapsed_ms: 30000 } })
    expect(ev!.messageId).toBe('msg-1')
  })

  it('eventId/sequence 按收帧顺序单调唯一', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1' })
    const a = mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' })
    const b = mapper.mapFrame({ type: 'generation.failed', generationId: 'gen-1', code: 'X', message: 'm', retryable: false, details: {} })
    expect(a!.eventId).toBe('conn-1:1')
    expect(b!.eventId).toBe('conn-1:2')
    expect(a!.sequence).toBe(1)
    expect(b!.sequence).toBe(2)
  })

  it('非 generation 帧(握手/工具)返回 null', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1' })
    expect(mapper.mapFrame({ type: 'session', messages: [] })).toBeNull()
    expect(mapper.mapFrame({ type: 'server_info', protocol_version: '2.0', server_version: 'v', features: {}, services: {} })).toBeNull()
    expect(mapper.mapFrame({ type: 'expression', expression: 'idle' })).toBeNull()
  })
})
```

Run: `pnpm test -- tests/unit/frame-mapper.spec.ts`
Expected: FAIL（frame-mapper 不存在）

- [ ] **Step 2: 实现 `src/main/transport/protocol-v2/frame-mapper.ts`**（完整内容，映射表见 spec §5.3）

```typescript
import type { BackendEvent } from '@shared/contracts/events'
import type { ConversationTokenUsage, SegmentChannel, SegmentKind, TokenUsage } from '@shared/contracts/message'
import type { ProtocolWarning } from '@shared/contracts/protocol'
import { ProtocolWarningCode } from '@shared/contracts/protocol'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import type {
  RawFrame, RawGenerationCompleted, RawGenerationFailed,
  RawSegmentChannel, RawSegmentKind, RawTokenUsage, RawConversationUsage
} from './raw-types'

export interface FrameMapperOptions {
  connectionId?: string
  activeConversationId?: string
  onProtocolWarning?: (warning: ProtocolWarning) => void
}

/** segment 元数据缓存(从 segment.started 建立;channel 用 raw 三值以便 status 过滤) */
interface SegmentMeta {
  segmentIndex: number
  channel: RawSegmentChannel
  kind: RawSegmentKind
}

export class FrameMapper {
  private nextSequence = 1
  private segmentMeta = new Map<string, SegmentMeta>()
  private activeConversationId?: string
  private readonly connectionId: string
  private readonly onProtocolWarning: (warning: ProtocolWarning) => void

  constructor(options: FrameMapperOptions = {}) {
    this.connectionId = options.connectionId ?? 'local'
    this.activeConversationId = options.activeConversationId
    this.onProtocolWarning = options.onProtocolWarning ?? (() => {})
  }

  setActiveConversationId(id: string | undefined): void {
    this.activeConversationId = id
  }

  /** 生成一帧领域事件;非 generation 帧与 status 段返回 null(不告警) */
  mapFrame(frame: RawFrame): BackendEvent | null {
    switch (frame.type) {
      case 'generation.started':
        return this.mapStarted(frame)
      case 'generation.segment.started':
        return this.mapSegmentStarted(frame)
      case 'generation.delta':
        return this.mapDelta(frame)
      case 'generation.segment.completed':
        return this.mapSegmentCompleted(frame)
      case 'generation.completed':
        return this.mapCompleted(frame)
      case 'generation.failed':
        return this.mapFailed(frame)
      default:
        return null // 握手/工具/音频等帧由连接层分流
    }
  }

  private envelope(): { eventId: string; sequence: number } {
    const sequence = this.nextSequence++
    return { eventId: `${this.connectionId}:${sequence}`, sequence }
  }

  /** conversationId 补齐:帧值优先,否则活动会话;都无法 → PROTOCOL_MISMATCH */
  private resolveConversationId(frameConversationId?: string): string {
    const id = frameConversationId ?? this.activeConversationId
    if (!id) {
      throw new CyreneError(CyreneErrorCode.PROTOCOL_MISMATCH, 'generation 帧缺 conversationId 且无活动会话可补齐')
    }
    return id
  }

  private mapStarted(frame: Extract<RawFrame, { type: 'generation.started' }>): BackendEvent {
    return {
      ...this.envelope(),
      event: 'generation.started',
      generationId: frame.generationId,
      messageId: frame.messageId,
      responseId: frame.generationId,
      conversationId: this.resolveConversationId(frame.conversationId),
      ...(frame.model ? { model: frame.model } : {})
    }
  }

  private mapSegmentStarted(frame: Extract<RawFrame, { type: 'generation.segment.started' }>): BackendEvent | null {
    this.segmentMeta.set(frame.segmentId, { segmentIndex: frame.segmentIndex, channel: frame.channel, kind: frame.kind })
    if (frame.channel === 'status') return null
    return {
      ...this.envelope(),
      event: 'generation.segment.started',
      generationId: frame.generationId,
      segmentId: frame.segmentId,
      segmentIndex: frame.segmentIndex,
      channel: frame.channel as SegmentChannel,
      kind: frame.kind as SegmentKind
    }
  }

  private mapDelta(frame: Extract<RawFrame, { type: 'generation.delta' }>): BackendEvent | null {
    const meta = this.segmentMeta.get(frame.segmentId)
    if (!meta) {
      throw new CyreneError(CyreneErrorCode.PROTOCOL_MISMATCH, `delta 帧找不到 segment meta: ${frame.segmentId}`)
    }
    if (meta.channel === 'status') return null
    if (meta.segmentIndex !== frame.segmentIndex) {
      this.onProtocolWarning({
        code: ProtocolWarningCode.MAPPER_SEGMENT_INDEX_MISMATCH,
        message: `segment ${frame.segmentId} delta 的 segmentIndex ${frame.segmentIndex} 与 started 元数据 ${meta.segmentIndex} 不一致,以 started 为准`
      })
    }
    return {
      ...this.envelope(),
      event: 'generation.delta',
      generationId: frame.generationId,
      segmentId: frame.segmentId,
      segmentIndex: meta.segmentIndex,
      channel: meta.channel as SegmentChannel,
      kind: meta.kind as SegmentKind,
      deltaSequence: frame.deltaSequence,
      text: frame.delta
    }
  }

  private mapSegmentCompleted(frame: Extract<RawFrame, { type: 'generation.segment.completed' }>): BackendEvent | null {
    const meta = this.segmentMeta.get(frame.segmentId)
    const channel = meta?.channel ?? frame.channel
    if (channel === 'status') {
      return null // 保留 status meta(供其迟到 delta 过滤返回 null,不抛 PROTOCOL_MISMATCH)
    }
    const kind = meta?.kind ?? frame.kind
    const segmentIndex = meta?.segmentIndex ?? frame.segmentIndex
    const event: BackendEvent = {
      ...this.envelope(),
      event: 'generation.segment.completed',
      generationId: frame.generationId,
      segmentId: frame.segmentId,
      segmentIndex,
      channel: channel as SegmentChannel,
      kind: kind as SegmentKind,
      ...(frame.content !== undefined ? { content: frame.content } : {})
    }
    this.segmentMeta.delete(frame.segmentId) // 普通段映射结束后清理(docs/18 §8.4)
    return event
  }

  private mapCompleted(frame: RawGenerationCompleted): BackendEvent {
    if (frame.completeness !== undefined && frame.completeness !== 'complete') {
      this.onProtocolWarning({
        code: ProtocolWarningCode.MAPPER_UNEXPECTED_COMPLETENESS,
        message: `generation ${frame.generationId} completeness 异常: ${frame.completeness}`
      })
    }
    return {
      ...this.envelope(),
      event: 'generation.completed',
      generationId: frame.generationId,
      messageId: frame.messageId,
      responseId: frame.generationId,
      usage: this.mapUsage(frame.usage),
      ...(frame.conversationUsage ? { conversationUsage: this.mapConversationUsage(frame.conversationUsage) } : {}),
      model: frame.model,
      ...(frame.mood ? { emotion: frame.mood } : {}),
      ...(frame.finishReason ? { finishReason: frame.finishReason } : {})
    }
  }

  private mapFailed(frame: RawGenerationFailed): BackendEvent {
    return {
      ...this.envelope(),
      event: 'generation.failed',
      generationId: frame.generationId,
      ...(frame.messageId ? { messageId: frame.messageId } : {}),
      error: {
        code: frame.code,
        message: frame.message,
        ...(frame.retryable !== undefined ? { retryable: frame.retryable } : {}),
        ...(frame.details !== undefined ? { details: frame.details } : {}) // 空 dict 也保留(details 恒上 wire)
      }
    }
  }

  private mapUsage(raw: RawTokenUsage): TokenUsage {
    const sumTotal = raw.rounds.reduce((s, r) => s + r.total_tokens, 0)
    const mapped: TokenUsage = {
      input: raw.rounds.reduce((s, r) => s + r.input_tokens, 0),
      output: raw.rounds.reduce((s, r) => s + r.output_tokens, 0),
      total: raw.turn_total,
      source: 'provider_reported',
      rounds: raw.rounds.map((r) => ({
        ...(r.model ? { model: r.model } : {}),
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        totalTokens: r.total_tokens,
        ...(r.cached_tokens !== undefined ? { cachedTokens: r.cached_tokens } : {}),
        ...(r.reasoning_tokens !== undefined ? { reasoningTokens: r.reasoning_tokens } : {}),
        roundNum: r.round_num
      }))
    }
    if (sumTotal !== raw.turn_total) {
      this.onProtocolWarning({
        code: ProtocolWarningCode.MAPPER_TOKEN_SUM_MISMATCH,
        message: `usage Σtotal_tokens(${sumTotal}) !== turn_total(${raw.turn_total}),保留服务端 turn_total`
      })
    }
    return mapped
  }

  private mapConversationUsage(raw: RawConversationUsage): ConversationTokenUsage {
    return { total: raw.total, byModel: raw.byModel, source: 'server_aggregate' }
  }
}
```

- [ ] **Step 3: 验证**

Run: `pnpm test -- tests/unit/frame-mapper.spec.ts`、`pnpm typecheck`、`pnpm lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/transport/protocol-v2/frame-mapper.ts tests/unit/frame-mapper.spec.ts
git commit -m "feat(阶段2块A): frame mapper——raw generation 帧 → 领域事件(status 过滤/fail-closed/告警)"
```

---

### Task 5: StreamAccumulator 权威 content 规则

**Files:**
- Modify: `src/shared/domain/stream-accumulator.ts`
- Modify: `tests/unit/stream-accumulator.spec.ts`（扩展）

**Interfaces:**
- Consumes: `BackendEvent`（含 `GenerationSegmentStartedEvent`、`SegmentCompletedEvent.kind/content?`）、`ConversationTokenUsage`（Task 1）。
- Produces: `StreamAccumulator` 支持新事件；`onProtocolWarning` 构造注入。

**约束（docs/18 §4.3 七条，逐条实现）：**
1. `content !== undefined` 时覆盖 `committedText`/`renderText`（**不 truthy 判断**）；
2. 权威后清 `pendingChunks`、`expectedSequence` 停更、`authoritative = true`；
3. 使用事件真实 `kind`（不硬编码 text）；
4. `content` 缺省保留已累计 delta（含缺口）；
5. completed 后迟到 delta 忽略 + 告警 `ACCUMULATOR_LATE_DELTA_AFTER_AUTHORITATIVE`；
6. `generation.segment.completed` 只完成一个 segment；
7. 只有 `generation.completed` 结束父消息。

- [ ] **Step 1: 写失败测试** —— 扩展 `tests/unit/stream-accumulator.spec.ts`（追加 describe；先跑确认 fail）

```typescript
// 追加到 stream-accumulator.spec.ts(import { ProtocolWarningCode } 合并到文件顶部现有 import 区,勿放中间)
import { ProtocolWarningCode } from '@shared/contracts/protocol'

function segmentStarted(segmentId: string, index: number, channel: 'inner_voice' | 'public_reply' = 'public_reply', kind: 'text' | 'markdown' = 'text'): BackendEvent {
  return {
    eventId: `es-${segmentId}`,
    sequence: 0,
    event: 'generation.segment.started',
    generationId: 'gen-1',
    segmentId,
    segmentIndex: index,
    channel,
    kind
  }
}

function segmentCompletedWithContent(segmentId: string, index: number, content: string, channel: 'inner_voice' | 'public_reply' = 'public_reply', kind: 'text' | 'markdown' = 'text'): BackendEvent {
  return {
    eventId: `ec-${segmentId}`,
    sequence: 0,
    event: 'generation.segment.completed',
    generationId: 'gen-1',
    segmentId,
    segmentIndex: index,
    channel,
    kind,
    content
  }
}

function completedWithConversationUsage(): BackendEvent {
  return {
    eventId: 'e-done2',
    sequence: 100,
    event: 'generation.completed',
    generationId: 'gen-1',
    responseId: 'rsp-1',
    conversationUsage: { total: 2100, byModel: { 'm1': 2100 }, source: 'server_aggregate' }
  }
}

describe('StreamAccumulator 权威 content 规则(docs/18 §4.4)', () => {
  it('① inner voice 只有 started+completed(content),零 delta,最终有文字', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(segmentStarted('seg-iv', 0, 'inner_voice'))
    acc.apply(segmentCompletedWithContent('seg-iv', 0, '内心独白', 'inner_voice'))
    acc.apply(completed())
    expect(acc.getState().status).toBe('completed')
    const [seg] = acc.toAssistantSegments()
    expect(seg?.text).toBe('内心独白')
    expect(seg?.channel).toBe('inner_voice')
  })

  it('② public reply 仅 completed(content),零 delta,最终有文字', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(segmentStarted('seg-pr', 0, 'public_reply', 'markdown'))
    acc.apply(segmentCompletedWithContent('seg-pr', 0, '完整回复', 'public_reply', 'markdown'))
    acc.apply(completed())
    const [seg] = acc.toAssistantSegments()
    expect(seg?.text).toBe('完整回复')
  })

  it('③ delta 只到一半,completed(content) 覆盖为完整文本', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(segmentStarted('seg-1', 0))
    acc.apply(delta('seg-1', 0, 0, '前'))
    acc.apply(segmentCompletedWithContent('seg-1', 0, '完整文本'))
    acc.apply(completed())
    const [seg] = acc.toAssistantSegments()
    expect(seg?.text).toBe('完整文本')
  })

  it('④ delta 乱序/有缺口,completed(content) 清除缺口并完成父', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(segmentStarted('seg-1', 0))
    acc.apply(delta('seg-1', 0, 2, '后')) // 序号 0/1 缺失
    acc.apply(segmentCompletedWithContent('seg-1', 0, '权威完整'))
    acc.apply(completed())
    expect(acc.getState().status).toBe('completed') // 缺口被权威 content 清除
    const [seg] = acc.toAssistantSegments()
    expect(seg?.text).toBe('权威完整')
  })

  it('⑤ completed 不带 content 保留 delta 拼接结果', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(segmentStarted('seg-1', 0))
    acc.apply(delta('seg-1', 0, 0, '你好，'))
    acc.apply(delta('seg-1', 0, 1, '世界。'))
    acc.apply(segmentCompleted('seg-1', 0))
    acc.apply(completed())
    const [seg] = acc.toAssistantSegments()
    expect(seg?.text).toBe('你好，世界。')
  })

  it('⑥ content 空串正确覆盖(不 truthy 判断)', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(segmentStarted('seg-1', 0))
    acc.apply(delta('seg-1', 0, 0, '将被覆盖'))
    acc.apply(segmentCompletedWithContent('seg-1', 0, ''))
    acc.apply(completed())
    expect(acc.getState().status).toBe('completed')
    // 空段不出现在可见分段(空内容不显示)
    expect(acc.toAssistantSegments()).toHaveLength(0)
  })

  it('⑦ completed 后迟到 delta 忽略并告警', () => {
    const warnings: { code: string }[] = []
    const acc = new StreamAccumulator({ onProtocolWarning: (w) => warnings.push(w) })
    acc.apply(started())
    acc.apply(segmentStarted('seg-1', 0))
    acc.apply(segmentCompletedWithContent('seg-1', 0, '权威'))
    acc.apply(delta('seg-1', 0, 1, '迟到'))
    acc.apply(completed())
    const [seg] = acc.toAssistantSegments()
    expect(seg?.text).toBe('权威') // 不被迟到 delta 污染
    expect(warnings.some((w) => w.code === ProtocolWarningCode.ACCUMULATOR_LATE_DELTA_AFTER_AUTHORITATIVE)).toBe(true)
  })

  it('⑧ kind=markdown 不被改成 text', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(segmentStarted('seg-1', 0, 'public_reply', 'markdown'))
    acc.apply(segmentCompletedWithContent('seg-1', 0, '**加粗**', 'public_reply', 'markdown'))
    acc.apply(completed())
    const [seg] = acc.toAssistantSegments()
    expect(seg?.kind).toBe('markdown')
  })

  it('权威 content 落地后父回复仍未完成,generation.completed 才完成', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(segmentStarted('seg-1', 0))
    acc.apply(segmentCompletedWithContent('seg-1', 0, '段'))
    expect(acc.getState().status).toBe('streaming') // segment.completed 不结束父回复
    acc.apply(completed())
    expect(acc.getState().status).toBe('completed')
  })

  it('conversationUsage 新形状写入', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(segmentStarted('seg-1', 0))
    acc.apply(delta('seg-1', 0, 0, '正文'))
    acc.apply(completedWithConversationUsage())
    expect(acc.getState().conversationUsage).toEqual({ total: 2100, byModel: { 'm1': 2100 }, source: 'server_aggregate' })
  })
})
```

Run: `pnpm test -- tests/unit/stream-accumulator.spec.ts`
Expected: FAIL（新事件未处理 / 权威规则未实现）

- [ ] **Step 2: 实现 `src/shared/domain/stream-accumulator.ts`**（完整替换；关键改动）

```typescript
import type {
  AssistantSegment,
  BackendEvent,
  ConversationTokenUsage,
  SegmentChannel,
  SegmentKind,
  TokenUsage
} from '../contracts'
import type { ProtocolWarning } from '../contracts/protocol'
import { ProtocolWarningCode } from '../contracts/protocol'

export type StreamStatus = 'streaming' | 'completing' | 'interrupted' | 'completed' | 'failed'

export interface SegmentAccumulatorState {
  segmentId: string
  segmentIndex: number
  channel: SegmentChannel
  kind: SegmentKind
  expectedSequence: number
  pendingChunks: Record<number, string>
  committedText: string
  renderText: string
  completed: boolean
  /** 权威 content 已落地(此后 delta 一律忽略+告警) */
  authoritative?: boolean
}

export interface StreamAccumulatorState {
  generationId: string
  messageId: string
  responseId: string
  conversationId: string
  orderedSegmentIds: string[]
  segments: Record<string, SegmentAccumulatorState>
  status: StreamStatus
  usage?: TokenUsage
  conversationUsage?: ConversationTokenUsage
  model?: string
  emotion?: string
}

export interface StreamAccumulatorOptions {
  onProtocolWarning?: (warning: ProtocolWarning) => void
}

function emptySegment(segmentId: string, segmentIndex: number, channel: SegmentChannel, kind: SegmentKind): SegmentAccumulatorState {
  return {
    segmentId,
    segmentIndex,
    channel,
    kind,
    expectedSequence: 0,
    pendingChunks: {},
    committedText: '',
    renderText: '',
    completed: false,
    authoritative: false
  }
}

export class StreamAccumulator {
  private state: StreamAccumulatorState
  private readonly onProtocolWarning: (warning: ProtocolWarning) => void

  constructor(init?: {
    generationId?: string
    messageId?: string
    responseId?: string
    conversationId?: string
  } & StreamAccumulatorOptions) {
    this.state = {
      generationId: init?.generationId ?? '',
      messageId: init?.messageId ?? '',
      responseId: init?.responseId ?? '',
      conversationId: init?.conversationId ?? '',
      orderedSegmentIds: [],
      segments: {},
      status: 'streaming'
    }
    this.onProtocolWarning = init?.onProtocolWarning ?? (() => {})
  }

  getState(): StreamAccumulatorState {
    return this.state
  }

  apply(event: BackendEvent): void {
    switch (event.event) {
      case 'generation.started':
        this.applyStarted(event)
        break
      case 'generation.segment.started':
        this.applySegmentStarted(event)
        break
      case 'generation.delta':
        this.applyDelta(event)
        break
      case 'generation.segment.completed':
        this.applySegmentCompleted(event)
        break
      case 'generation.completed':
        this.applyCompleted(event)
        break
      case 'generation.failed':
        this.state.status = 'failed'
        break
    }
  }

  markInterrupted(): void {
    if (this.state.status === 'streaming') {
      this.state.status = 'interrupted'
    }
  }

  private applyStarted(event: Extract<BackendEvent, { event: 'generation.started' }>): void {
    if (this.state.generationId && this.state.generationId !== event.generationId) {
      throw new Error(
        `StreamAccumulator 已归属 generation ${this.state.generationId},无法接收 ${event.generationId}`
      )
    }
    this.state.generationId = event.generationId
    this.state.messageId = event.messageId
    this.state.responseId = event.responseId
    this.state.conversationId = event.conversationId
    if (event.model) this.state.model = event.model
  }

  private applySegmentStarted(event: Extract<BackendEvent, { event: 'generation.segment.started' }>): void {
    this.ensureSegment(event.segmentId, event.segmentIndex, event.channel, event.kind)
  }

  private applyDelta(event: Extract<BackendEvent, { event: 'generation.delta' }>): void {
    const segment = this.ensureSegment(event.segmentId, event.segmentIndex, event.channel, event.kind)
    if (segment.authoritative) {
      this.onProtocolWarning({
        code: ProtocolWarningCode.ACCUMULATOR_LATE_DELTA_AFTER_AUTHORITATIVE,
        message: `segment ${event.segmentId} 权威 content 已落地后收到迟到 delta(seq ${event.deltaSequence}),忽略`
      })
      return
    }
    if (event.deltaSequence < segment.expectedSequence) return
    if (event.deltaSequence === segment.expectedSequence) {
      segment.committedText += event.text
      segment.expectedSequence += 1
      this.flushContiguous(segment)
    } else {
      if (segment.pendingChunks[event.deltaSequence] === undefined) {
        segment.pendingChunks[event.deltaSequence] = event.text
      }
    }
    segment.renderText = segment.committedText
  }

  private applySegmentCompleted(event: Extract<BackendEvent, { event: 'generation.segment.completed' }>): void {
    const segment = this.ensureSegment(event.segmentId, event.segmentIndex, event.channel, event.kind)
    segment.completed = true
    if (event.content !== undefined) {
      segment.committedText = event.content
      segment.renderText = event.content
      segment.pendingChunks = {}
      segment.authoritative = true
    }
  }

  private applyCompleted(event: Extract<BackendEvent, { event: 'generation.completed' }>): void {
    if (event.usage) this.state.usage = event.usage
    if (event.conversationUsage) this.state.conversationUsage = event.conversationUsage
    if (event.model) this.state.model = event.model
    if (event.emotion) this.state.emotion = event.emotion
    this.state.status = this.hasGap() ? 'completing' : 'completed'
  }

  private ensureSegment(segmentId: string, segmentIndex: number, channel: SegmentChannel, kind: SegmentKind): SegmentAccumulatorState {
    let segment = this.state.segments[segmentId]
    if (!segment) {
      segment = emptySegment(segmentId, segmentIndex, channel, kind)
      this.state.segments[segmentId] = segment
      this.state.orderedSegmentIds.push(segmentId)
    }
    return segment
  }

  private flushContiguous(segment: SegmentAccumulatorState): void {
    let chunk = segment.pendingChunks[segment.expectedSequence]
    while (chunk !== undefined) {
      segment.committedText += chunk
      segment.expectedSequence += 1
      delete segment.pendingChunks[segment.expectedSequence - 1]
      chunk = segment.pendingChunks[segment.expectedSequence]
    }
  }

  private hasGap(): boolean {
    return Object.values(this.state.segments).some((s) => Object.keys(s.pendingChunks).length > 0)
  }

  toAssistantSegments(): AssistantSegment[] {
    return this.state.orderedSegmentIds
      .map((id) => this.state.segments[id])
      .filter((s) => s && s.committedText.length > 0)
      .sort((a, b) => a.segmentIndex - b.segmentIndex)
      .map((s) => ({
        segmentId: s.segmentId,
        segmentIndex: s.segmentIndex,
        channel: s.channel,
        kind: s.kind,
        text: s.committedText,
        completed: s.completed
      }))
  }
}
```

- [ ] **Step 3: 验证**

Run: `pnpm test -- tests/unit/stream-accumulator.spec.ts`、`pnpm typecheck`、`pnpm lint`
Expected: PASS（既有用例 + 扩展用例）

- [ ] **Step 4: Commit**

```bash
git add src/shared/domain/stream-accumulator.ts tests/unit/stream-accumulator.spec.ts
git commit -m "feat(阶段2块A): StreamAccumulator 权威 content 规则(segment.started/覆盖/迟到 delta 告警)"
```

---

### Task 6: wire fixture + 两层校验

**Files:**
- Create: `src/main/fixtures/wire-v2/handshake.jsonl` + `.manifest.json`
- Create: `src/main/fixtures/wire-v2/chat-no-delta-inner-voice.jsonl` + `.manifest.json`
- Create: `src/main/fixtures/wire-v2/chat-tts-public-completed-only.jsonl` + `.manifest.json`
- Create: `src/main/fixtures/wire-v2/chat-failed.jsonl` + `.manifest.json`
- Create: `tests/unit/wire-fixtures.spec.ts`

**Interfaces:**
- Consumes: `parseRawFrame`（Task 3）、`FrameMapper`（Task 4）、`parseBackendEvent` + `StreamAccumulator`（Task 1/2/5）。

- [ ] **Step 1: 写失败测试** —— `tests/unit/wire-fixtures.spec.ts`（完整内容）

```typescript
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseRawFrame } from '../../src/main/transport/protocol-v2/raw-schemas'
import { FrameMapper } from '../../src/main/transport/protocol-v2/frame-mapper'
import { parseBackendEvent } from '@shared/schemas'
import { StreamAccumulator } from '@shared/domain'

const FIXTURES = join(__dirname, '../../src/main/fixtures/wire-v2')

function readLines(name: string): unknown[] {
  const raw = readFileSync(join(FIXTURES, name), 'utf8')
  return raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0).map((l) => JSON.parse(l))
}

function readManifest(name: string): { backendCommit: string; protocol: string; serverProtocolVersion: string } {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
}

describe('wire fixture 两层校验', () => {
  const fixtures = [
    'handshake.jsonl',
    'chat-no-delta-inner-voice.jsonl',
    'chat-tts-public-completed-only.jsonl',
    'chat-failed.jsonl'
  ]

  it('① 每行过 raw schema', () => {
    for (const f of fixtures) {
      for (const [i, line] of readLines(f).entries()) {
        const r = parseRawFrame(line)
        expect(r.success, `${f} 第 ${i + 1} 行: ${JSON.stringify(line)}`).toBe(true)
      }
    }
  })

  it('manifest 记录 backendCommit', () => {
    for (const f of fixtures) {
      const m = readManifest(f.replace(/\.jsonl$/, '.manifest.json'))
      expect(m.backendCommit).toBe('beeba5776413dde9761375c2fd9541d6636f180d')
      expect(m.protocol).toBe('2')
      expect(m.serverProtocolVersion).toBe('2.0')
    }
  })

  it('② 经 mapper 后每事件过领域 schema,并推进 accumulator', () => {
    for (const f of fixtures) {
      const mapper = new FrameMapper({ connectionId: 'fixture-conn', activeConversationId: 'conv-1' })
      const acc = new StreamAccumulator()
      for (const [i, line] of readLines(f).entries()) {
        const raw = parseRawFrame(line)
        if (!raw.success) throw new Error('raw 应已通过(前一用例)')
        const domain = mapper.mapFrame(raw.data)
        if (domain === null) continue // 握手帧/status 段
        const parsed = parseBackendEvent(domain)
        expect(parsed.success, `${f} 第 ${i + 1} 行映射后: ${JSON.stringify(domain)}`).toBe(true)
        if (parsed.success) acc.apply(parsed.data)
      }
      // accumulator 无异常即通过;chat 两类 final 状态断言
      if (f === 'chat-no-delta-inner-voice.jsonl') {
        const segs = acc.toAssistantSegments()
        expect(segs.length).toBeGreaterThan(0)
        expect(segs.some((s) => s.channel === 'inner_voice' && s.text.length > 0)).toBe(true)
      }
      if (f === 'chat-tts-public-completed-only.jsonl') {
        const segs = acc.toAssistantSegments()
        expect(segs.length).toBeGreaterThan(0)
        expect(segs.some((s) => s.channel === 'public_reply' && s.text.length > 0)).toBe(true)
      }
      if (f === 'chat-failed.jsonl') {
        expect(acc.getState().status).toBe('failed')
        const segs = acc.toAssistantSegments()
        expect(segs.some((s) => s.text.includes('部分内容已生成'))).toBe(true) // partial delta 保留
      }
    }
  })

  it('handshake 三帧 mapFrame()===null(握手帧不产生领域事件)', () => {
    const mapper = new FrameMapper({ connectionId: 'fixture-conn' })
    for (const line of readLines('handshake.jsonl')) {
      const raw = parseRawFrame(line)
      if (raw.success) expect(mapper.mapFrame(raw.data)).toBeNull()
    }
  })
})
```

Run: `pnpm test -- tests/unit/wire-fixtures.spec.ts`
Expected: FAIL（fixture 不存在）

- [ ] **Step 2: 创建四组 wire fixture + manifests**

`src/main/fixtures/wire-v2/handshake.manifest.json`：
```json
{ "backendCommit": "beeba5776413dde9761375c2fd9541d6636f180d", "protocol": "2", "serverProtocolVersion": "2.0" }
```

`src/main/fixtures/wire-v2/handshake.jsonl`（三行）：
```json
{"type":"session","conversationId":"conv-1","messages":[],"token_stats":{"total":0,"byModel":{}}}
{"type":"server_info","protocol_version":"2.0","server_version":"0.4.0+beeba577","features":{"structured_generation":true,"multi_conversation":true},"services":{"llm":{"available":true,"enabled":true,"model":"cyrene-llm-v1","default":"cyrene-llm-v1"}},"connectionId":"conn-fixture-1","build_sha":"beeba577"}
{"type":"expression","expression":"idle","intensity":0.0}
```

`src/main/fixtures/wire-v2/chat-no-delta-inner-voice.manifest.json`：同 `handshake.manifest.json`。

`src/main/fixtures/wire-v2/chat-no-delta-inner-voice.jsonl`（四行，inner voice 零 delta，`content` 权威）：
```json
{"type":"generation.started","generationId":"gen-fixture-iv","messageId":"msg-iv-1","conversationId":"conv-1","requestId":"req-iv-1","model":"cyrene-llm-v1"}
{"type":"generation.segment.started","generationId":"gen-fixture-iv","segmentId":"seg-iv-1","segmentIndex":0,"channel":"inner_voice","kind":"text","conversationId":"conv-1"}
{"type":"generation.segment.completed","generationId":"gen-fixture-iv","segmentId":"seg-iv-1","segmentIndex":0,"channel":"inner_voice","kind":"text","content":"让我先整理一下回答思路。","conversationId":"conv-1"}
{"type":"generation.completed","generationId":"gen-fixture-iv","messageId":"msg-iv-1","channel":"public_reply","finishReason":"stop","usage":{"rounds":[{"model":"cyrene-llm-v1","input_tokens":100,"output_tokens":20,"total_tokens":120,"cached_tokens":0,"reasoning_tokens":0,"round_num":1}],"turn_total":120},"model":"cyrene-llm-v1","mood":"thinking","completeness":"complete","conversationId":"conv-1","conversationUsage":{"total":120,"byModel":{"cyrene-llm-v1":120}}}
```

`src/main/fixtures/wire-v2/chat-tts-public-completed-only.manifest.json`：同。

`src/main/fixtures/wire-v2/chat-tts-public-completed-only.jsonl`（TTS 开启，public reply 零 delta）：
```json
{"type":"generation.started","generationId":"gen-fixture-tts","messageId":"msg-tts-1","conversationId":"conv-1","requestId":"req-tts-1","model":"cyrene-llm-v1"}
{"type":"generation.segment.started","generationId":"gen-fixture-tts","segmentId":"seg-tts-1","segmentIndex":0,"channel":"public_reply","kind":"markdown","conversationId":"conv-1"}
{"type":"generation.segment.completed","generationId":"gen-fixture-tts","segmentId":"seg-tts-1","segmentIndex":0,"channel":"public_reply","kind":"markdown","content":"好的，我来回答你关于**流式回复**的问题。","conversationId":"conv-1"}
{"type":"generation.completed","generationId":"gen-fixture-tts","messageId":"msg-tts-1","channel":"public_reply","finishReason":"stop","usage":{"rounds":[{"model":"cyrene-llm-v1","input_tokens":200,"output_tokens":40,"total_tokens":240,"cached_tokens":0,"reasoning_tokens":0,"round_num":1}],"turn_total":240},"model":"cyrene-llm-v1","mood":"happy","completeness":"complete","conversationId":"conv-1","conversationUsage":{"total":240,"byModel":{"cyrene-llm-v1":240}}}
```

`src/main/fixtures/wire-v2/chat-failed.manifest.json`：同。

`src/main/fixtures/wire-v2/chat-failed.jsonl`（failed 终态，保留 partial delta）：
```json
{"type":"generation.started","generationId":"gen-fixture-fail","messageId":"msg-fail-1","conversationId":"conv-1","requestId":"req-fail-1","model":"cyrene-llm-v1"}
{"type":"generation.segment.started","generationId":"gen-fixture-fail","segmentId":"seg-fail-1","segmentIndex":0,"channel":"public_reply","kind":"text","conversationId":"conv-1"}
{"type":"generation.delta","generationId":"gen-fixture-fail","segmentId":"seg-fail-1","segmentIndex":0,"deltaSequence":0,"delta":"部分内容已生成","conversationId":"conv-1"}
{"type":"generation.failed","generationId":"gen-fixture-fail","messageId":"msg-fail-1","model":"cyrene-llm-v1","code":"GENERATION_TIMEOUT","message":"生成超时","retryable":true,"details":{"elapsed_ms":30000},"conversationId":"conv-1"}
```

- [ ] **Step 3: 验证**

Run: `pnpm test`（全量）、`pnpm typecheck`、`pnpm lint`、`pnpm build`
Expected: PASS（wire-fixtures 两层校验 + 既有全量）

- [ ] **Step 4: Commit**

```bash
git add src/main/fixtures/wire-v2 tests/unit/wire-fixtures.spec.ts
git commit -m "test(阶段2块A): wire fixture(4 场景+manifest) + 两层校验测试"
```

---

## 完成定义（所有任务完成后验证）

Run: `pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm build`
Expected: 全绿；单测数 = 182 + 本块新增（raw-schemas ~12 + frame-mapper ~13 + accumulator 扩展 ~10 + wire-fixtures ~5 + schemas 扩展 ~7 ≈ 45+ 新增）。

对照 spec §8 验收：
1. §5.4 领域契约 + §5.5 Accumulator 精确形状落地，typecheck 过；
2. Accumulator 八场景 + started + 告警全绿；
3. mapper 全映射全绿；
4. raw schema 合法/非法全绿；
5. wire fixture 两层校验通过，manifest 记录 `beeba577`；
6. 既有 182 单测不回归，typecheck/lint/build 过；
7. 本块标「已开发、未联调」，doc 16/docs 18 同步（文档同步属收尾步骤，不在本 plan 各 task 内）。

## 风险提示（执行时注意）

- **Task 4 mapUsage 自由变量**：`mapUsage` 访问 `onProtocolWarning` 需为实例方法或传参，`pnpm typecheck` 兜底（plan Step 3 已注明）。
- **Task 2 领域 fixture 形状**：三处 completed 补 `kind` + conversationUsage 改形状；迁移后 `mock-replay.spec.ts` 必须通过（它断言 received.length ≥ 11 且顺序升序——形状改变不影响）。
- **Task 5 `completed()` 既有辅助**：现有 `completed()`（无 conversationUsage）继续合法；不要删除既有用例。
- **契约漂移**：若后端 `frontend_contract` 有更新，以 `/home/yomu/elysia-agent` 当前 SHA 为准并同步 manifest（勿改本 plan 已给的 fixture 内容除非契约变了）。
