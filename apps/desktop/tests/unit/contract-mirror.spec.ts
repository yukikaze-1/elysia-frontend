// tests/unit/contract-mirror.spec.ts
// H-05（2026-09-11）：契约镜像门禁。
//
// 评审判定「契约镜像大面积失守；唯一跨仓门禁不在 CI」——三向手抄（contracts 类型 / zod schema /
// 后端 wire）且无生成器，于是**字段级漂移是默认结果**。评审建议的修法是补 `z.ZodType<T>` 锚点。
//
// **本文件用的是比它更强、且成本更低的机制**，理由如下（已由编译器实证，见"为什么不用 z.ZodType"）：
//
//   `z.ZodType<T>` 是**协变**的：它只要求 `schema 的输出类型 <: T`。因此 schema **漏掉 T 的某个可选成员**
//   时依然满足约束——而"漏掉可选成员"恰是本仓库已发生的那个缺陷（`ToolCallRecord.diff`）。
//   本机实测：`const x: z.ZodType<Contract> = 少了可选成员的schema` **可以编译通过**。
//
//   改用**键集合相等**（keyof 双向包含）即可同时抓住「漏成员」与「多成员」，且完全在类型层完成：
//   不需要改运行时、不擦除 `.shape`（`z.ZodType<T>` 注解会擦掉 `.shape`，本仓库已有 4 处测试依赖它），
//   也不需要新增生成器。
//
// 门禁的判别力由变异验证保证：从任一被检查的 schema 删掉一个成员 → typecheck 立刻红（见 doc 16 §3.1）。
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  BackendEventSchema,
  GenerationDeltaEventSchema,
  GenerationStartedEventSchema,
  BackendEventEnvelopeSchema
} from '@shared/schemas'
import {
  MessageSchema,
  ToolCallRecordSchema,
  PublicToolEventSchema,
  ConversationSchema
} from '@shared/schemas'
import type { Message, ToolCallRecord, PublicToolEvent, Conversation } from '@shared/contracts'

/**
 * 键集合相等（双向包含）。
 *
 * 用 `[A] extends [B]` 的元组包裹以避免联合类型被分配律拆开；`keyof` 含可选成员，
 * 故「漏掉可选成员」也会被判为不等——这正是 `z.ZodType<T>` 做不到的那一半。
 */
type SameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : false) : false

/** 断言辅助：T 必须为 true，否则该处编译失败 */
type AssertTrue<T extends true> = T

// 断言以**导出的类型别名**形式给出（沿用 contracts-tool.spec.ts 的 `export type _Xxx = ...` 先例）：
// 这样既能在编译期生效，又不会触发 no-unused-vars。
// 删掉任一被镜像 schema 的成员（例如 ToolCallRecordSchema 的 diff）→ 对应别名变成 false → 编译失败。
export type _ToolCallRecordMirrorsContract = AssertTrue<SameKeys<z.infer<typeof ToolCallRecordSchema>, ToolCallRecord>>
export type _PublicToolEventMirrorsContract = AssertTrue<SameKeys<z.infer<typeof PublicToolEventSchema>, PublicToolEvent>>
export type _MessageMirrorsContract = AssertTrue<SameKeys<z.infer<typeof MessageSchema>, Message>>
export type _ConversationMirrorsContract = AssertTrue<SameKeys<z.infer<typeof ConversationSchema>, Conversation>>

describe('契约镜像：schema 与契约类型键集合必须完全一致（H-05）', () => {
  it('类型层断言（编译期生效，见文件头的 export type 断言；本用例只确认运行时面可用）', () => {
    // 真正的断言在文件头的 `export type _XxxMirrorsContract = AssertTrue<SameKeys<...>>`：
    // 任一被镜像 schema 漏/多成员 → 编译失败（已做变异验证）。此处仅确认相关 schema 可正常解析。
    expect(ToolCallRecordSchema.safeParse({ id: 'x', toolName: 't', runtime: 'desktop', status: 'completed' }).success).toBe(true)
    expect(MessageSchema).toBeDefined()
    expect(ConversationSchema).toBeDefined()
    expect(PublicToolEventSchema).toBeDefined()
  })

  it('ToolCallRecordSchema 真的接受 diff（补齐契约成员，而非只改类型）', () => {
    // 运行期对照：schema 必须实际解析带 diff 的记录——否则上面的类型断言可能靠改类型而非改 schema 通过
    const withDiff = {
      id: 'tc_1', toolName: 'desktop.file.write', runtime: 'desktop', status: 'completed',
      diff: { lines: [{ kind: 'added', text: 'x\n' }], added: 1, removed: 0, truncated: false, totalLines: 1, formatNote: 'LF', isNewFile: false }
    }
    const parsed = ToolCallRecordSchema.safeParse(withDiff)
    expect(parsed.success, `schema 拒绝了带 diff 的记录：${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true)
  })

  it('ToolCallRecordSchema 仍然 fail-closed：未声明字段被拒（不得为兼容而放松为 strip）', () => {
    const r = ToolCallRecordSchema.safeParse({ id: 'x', toolName: 't', runtime: 'desktop', status: 'completed', 未声明字段: 1 })
    expect(r.success).toBe(false)
  })
})

describe('事件 schema 严格性门禁（H-05 的第二半）', () => {
  it('BackendEventSchema 的**每个**联合成品都必须拒绝未知键（新增成员不得悄悄放松）', () => {
    // 为什么用「联合成品」而不是逐个 schema：`.extend()` 会继承基座的 strictness，故成员通常自动严格；
    // 但若有人**不走** BackendEventEnvelopeSchema 而自建事件 schema，就会重新引入漂移。
    // 本用例逐个品尝试验：喂一个含未声明字段的合法事件，必须被拒。
    const samples = BackendEventSchema.options.map((schema, index) => ({ schema, index }))
    expect(samples.length, '联合成员数异常——解析器可能已失效').toBeGreaterThan(20)
    const notStrict: string[] = []
    for (const { schema, index } of samples) {
      // 用最小可辨识字段构造样本：event 判别式 + 该 schema 必填字段难以通用枚举，
      // 故改为直接检视 schema 的 catchall 形态（zod 4：strict 为 ZodNever catchall）
      const def = schema._def as { catchall?: { _zod?: { def?: { type?: string } } } }
      const catchallType = def.catchall?._zod?.def?.type
      if (catchallType !== 'never') notStrict.push(`#${index}（catchall=${String(catchallType)}）`)
    }
    expect(notStrict, `以下事件联合成品不是 strict（未知字段会被静默剥离而非拒绝）：\n${notStrict.join('\n')}`).toEqual([])
  })

  it('基座与派生：strictness 确实通过 .extend() 继承（否则上面的门禁会被绕过）', () => {
    const derived = BackendEventEnvelopeSchema.extend({ event: z.literal('probe'), extra: z.string() })
    expect(derived.safeParse({ eventId: 'e', sequence: 1, event: 'probe', extra: 'x' }).success).toBe(true)
    expect(derived.safeParse({ eventId: 'e', sequence: 1, event: 'probe', extra: 'x', 未声明: 1 }).success,
      '派生 schema 未继承 strict —— 事件严格化只靠基座的前提不成立').toBe(false)
  })

  it('已严格化的成员在运行期确实拒绝未知字段（抽样 GenerationStarted / GenerationDelta）', () => {
    const started = { eventId: 'e', sequence: 1, event: 'generation.started', generationId: 'g', messageId: 'm', responseId: 'r', conversationId: 'c' }
    expect(GenerationStartedEventSchema.safeParse(started).success).toBe(true)
    expect(GenerationStartedEventSchema.safeParse({ ...started, 未声明: 1 }).success).toBe(false)

    const delta = { eventId: 'e', sequence: 2, event: 'generation.delta', generationId: 'g', segmentId: 's', segmentIndex: 0, channel: 'public_reply', kind: 'markdown', deltaSequence: 1, text: 'hi' }
    expect(GenerationDeltaEventSchema.safeParse(delta).success).toBe(true)
    expect(GenerationDeltaEventSchema.safeParse({ ...delta, 未声明: 1 }).success).toBe(false)
  })
})
