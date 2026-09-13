// tests/unit/contracts-tool.spec.ts
// 阶段 6 批次 A/B：工具领域模型与 IPC 工具 schema 的一致性契约。
//
// 2026-09-10 陈旧性审查重写：原文件是**自证式**的——全部断言都落在测试自己构造的字面量上
// （`const statuses: ToolCallStatus[] = [...]; expect(statuses).toHaveLength(8)`、
//  `JSON.stringify(MINIMAL_EVENT)` 里不含 `arguments`、`expect(rec.attachmentCount).toBe(2)`），
// 源码怎么改都不会失败。现改为：① 真 schema 解析（含 .strict() 拒未知键的正/负方向）；
// ② 类型级穷尽映射把「字面量条数」换成「两侧一一对应」的编译期闭环（任一新增状态漏改即 tsc 报错）。
import { describe, expect, it } from 'vitest'
import type { ToolCallRecord, ToolCallStatus, ToolWireStatus } from '@shared/contracts'
import type { PublicToolEvent } from '@shared/contracts/tool'
import { PublicToolEventSchema, ToolCallRecordSchema } from '@shared/schemas'

/** 编译期相等断言（仓库先例：`stores/desktop-api.types.ts` 的 AssertAssignable） */
type AssertAssignable<A extends B, B> = A extends B ? true : never

/** 「声明表覆盖联合的全部成员」——漏一个成员，下面的赋值就会因缺键让 tsc 失败。
 *  原实现的 `expect(statuses).toHaveLength(8)` 只是把字面量长度和写死的数字对了一遍，做不到这件事。 */
const TOOL_CALL_STATUS: Record<ToolCallStatus, true> = {
  requested: true, awaiting_permission: true, running: true, completed: true,
  failed: true, rejected: true, cancelled: true, timeout: true
}
const TOOL_WIRE_STATUS: Record<ToolWireStatus, true> = {
  accepted: true, rejected: true, running: true, result: true, error: true, cancelled: true
}
/** 与上面声明表同源顺序的显式序列（供运行时等序断言使用） */
const TOOL_WIRE_ORDER = ['accepted', 'rejected', 'running', 'result', 'error', 'cancelled'] as const

/** 收集 union 全部字面量（分配条件类型） */
type UnionOf<T> = T extends string ? T : never

/** 双向相等：`ToolCallStatus` 与 schema 枚举必须**完全一致**（多一个、少一个、改一个都编译失败）。
 *  schema 侧因此不再需要运行时字面量列表——它本身就是权威，这里只是把它与类型闭合。
 *  导出仅为满足 noUnusedLocals（与仓库先例 `stores/desktop-api.types.ts` 的导出式编译期断言一致）。 */
export type _StatusUnionMatchesSchema = AssertAssignable<ToolCallStatus, UnionOf<(typeof ToolCallRecordSchema)['shape']['status']['options'][number]>>
export type _StatusSchemaMatchesUnion = AssertAssignable<UnionOf<(typeof ToolCallRecordSchema)['shape']['status']['options'][number]>, ToolCallStatus>
export type _WireUnionMatchesDeclared = AssertAssignable<ToolWireStatus, UnionOf<(typeof TOOL_WIRE_ORDER)[number]>>
export type _WireDeclaredMatchesUnion = AssertAssignable<UnionOf<(typeof TOOL_WIRE_ORDER)[number]>, ToolWireStatus>

const MINIMAL_EVENT: PublicToolEvent = {
  id: 'tc_1', toolName: 'desktop.file.read', title: '读取文件', runtime: 'desktop',
  status: 'awaiting_permission', occurredAt: '2026-08-20T00:00:00.000Z',
}
const MINIMAL_RECORD: ToolCallRecord = {
  id: 'tc_1', toolName: 'desktop.file.read', runtime: 'desktop', status: 'completed',
}

describe('阶段 6 批次 A 领域模型（Task 1）', () => {
  it('ToolCallRecord 权威键 = id（sourceCallId），展示态与 schema 枚举逐项等序', () => {
    const r = ToolCallRecordSchema.safeParse(MINIMAL_RECORD)
    expect(r.success).toBe(true)
    // 顺序相等 → 声明表既无遗漏也无多余（遗漏/多余由上面的编译期断言兜住，此处兜「顺序」）
    expect(Object.keys(TOOL_CALL_STATUS)).toEqual(ToolCallRecordSchema.shape.status.options)
    expect(ToolCallRecordSchema.shape.status.options).toHaveLength(8)
  })

  it('ToolWireStatus 六态协议态闭合（展示/协议态分离，D6A-05）', () => {
    // 协议态是 wire 契约（Main adapter 解析）：此处锁「声明顺序 = 联合成员全集」，
    // 任一侧新增状态而另一侧没跟上，上面的 _Wire* 编译期断言即让 pnpm typecheck 失败
    expect(Object.keys(TOOL_WIRE_STATUS)).toEqual([...TOOL_WIRE_ORDER])
    expect(TOOL_WIRE_ORDER).toHaveLength(6)
  })
})

describe('阶段 6 批次 B Task 1：PublicToolEvent / ToolCallRecord.attachmentCount', () => {
  it('PublicToolEvent .strict() 拒绝 arguments/paramHash/expiresAt/安全元数据键', () => {
    // 原实现断言的是「测试自己写的字面量 JSON 里没有这些键」——永远成立。
    // 真正的执行点在 schema 的 .strict()：给合法事件补任一被禁键都必须被拒。
    expect(PublicToolEventSchema.safeParse(MINIMAL_EVENT).success).toBe(true)
    for (const banned of ['arguments', 'paramHash', 'expiresAt', 'riskLevel', 'permissionRequired', 'approvalAuthority']) {
      const r = PublicToolEventSchema.safeParse({ ...MINIMAL_EVENT, [banned]: 'x' })
      expect(r.success, `未知键 ${banned} 应被 .strict() 拒绝`).toBe(false)
    }
  })

  it('ToolCallRecord.attachmentCount 为可选非负整数（负值/小数被拒）', () => {
    expect(ToolCallRecordSchema.safeParse({ ...MINIMAL_RECORD, attachmentCount: 2 }).success).toBe(true)
    expect(ToolCallRecordSchema.safeParse(MINIMAL_RECORD).success).toBe(true)   // 缺省合法
    expect(ToolCallRecordSchema.safeParse({ ...MINIMAL_RECORD, attachmentCount: -1 }).success).toBe(false)
    expect(ToolCallRecordSchema.safeParse({ ...MINIMAL_RECORD, attachmentCount: 1.5 }).success).toBe(false)
  })

  it('PublicToolEvent.captureSources 形状闭合：嵌套 .strict() 拒未知键、缺字段被拒', () => {
    const source = { sourceId: 's1', sourceName: '屏幕 1', thumbnailDataUrl: 'data:image/png;base64,AA==' }
    const ev: PublicToolEvent = { ...MINIMAL_EVENT, captureSources: [source] }
    const ok = PublicToolEventSchema.safeParse(ev)
    expect(ok.success).toBe(true)
    expect(ok.data?.captureSources?.[0]).toEqual(source)
    // 原实现只断言 `sourceId === 's1'`（自己刚写进去的值）。真正要锁的是嵌套结构：
    expect(PublicToolEventSchema.safeParse({ ...ev, captureSources: [{ ...source, extra: 1 }] }).success).toBe(false)
    expect(PublicToolEventSchema.safeParse({ ...ev, captureSources: [{ sourceId: 's1', sourceName: '屏幕 1' }] }).success).toBe(false)
  })

  // doc 03 §10 / PRD §12.3（2026-09-13）：「截图需要显示所选屏幕或窗口」⇒ 预览必须带 sourceName。
  // 该字段是**必需**的：缺了它渲染层就只能显示 sourceId（`screen:0:0`），等于没告诉用户截的是哪块屏。
  it('PublicToolEvent.capturePreview：sourceName 必需；width/height/bytes 可选；未知键仍被拒', () => {
    const base = { sourceId: 's1', sourceName: '屏幕 1', previewDataUrl: 'data:image/png;base64,AA==' }
    const ev: PublicToolEvent = { ...MINIMAL_EVENT, capturePreview: base }
    const ok = PublicToolEventSchema.safeParse(ev)
    expect(ok.success).toBe(true)
    // 尺寸/大小可选（mock 注入面拿不到真实缩略图）
    expect(PublicToolEventSchema.safeParse({ ...ev, capturePreview: { ...base, width: 1920, height: 1080, bytes: 2048 } }).success).toBe(true)
    // 缺 sourceName ⇒ 拒（这正是本项要防的退化：预览说不出"是哪个屏/窗"）
    const withoutName = { sourceId: base.sourceId, previewDataUrl: base.previewDataUrl }
    expect(PublicToolEventSchema.safeParse({ ...ev, capturePreview: withoutName }).success).toBe(false)
    // 未知键 ⇒ 拒（严格闭合，防悄悄扩大下发面）
    expect(PublicToolEventSchema.safeParse({ ...ev, capturePreview: { ...base, extra: 1 } }).success).toBe(false)
    // 尺寸非正整数 ⇒ 拒
    expect(PublicToolEventSchema.safeParse({ ...ev, capturePreview: { ...base, width: 0 } }).success).toBe(false)
    expect(PublicToolEventSchema.safeParse({ ...ev, capturePreview: { ...base, bytes: -1 } }).success).toBe(false)
  })
})
