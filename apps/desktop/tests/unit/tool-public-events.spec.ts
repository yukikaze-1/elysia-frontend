import { describe, expect, it } from 'vitest'
import { PublicToolEventSchema, ToolCallRecordSchema } from '../../src/shared/schemas/ipc-response'
import { MessageSchema } from '../../src/shared/schemas/ipc-response'

const VALID = { id: 'tc_1', toolName: 'desktop.file.read', title: '读取文件', runtime: 'desktop', status: 'awaiting_permission', occurredAt: '2026-08-20T00:00:00.000Z' }

// 合法 MessageSchema 样例取自 ipc-response-schema.spec.ts 的 assistantMsg（M8）
const assistantMsg = {
  messageId: 'm1',
  conversationId: 'c1',
  role: 'assistant',
  status: 'completed',
  createdAt: 't',
  assistantSegments: [
    { segmentId: 's1', segmentIndex: 0, channel: 'public_reply', kind: 'text', text: 'hi', completed: true }
  ]
}

describe('PublicToolEventSchema', () => {
  it('合法最小样例通过', () => { expect(PublicToolEventSchema.safeParse(VALID).success).toBe(true) })
  it('status 非法拒', () => { expect(PublicToolEventSchema.safeParse({ ...VALID, status: 'unknown' }).success).toBe(false) })
  it('runtime 非 desktop 拒', () => { expect(PublicToolEventSchema.safeParse({ ...VALID, runtime: 'backend' }).success).toBe(false) })
  it('strict：未知键拒（含 arguments/paramHash/expiresAt）', () => {
    for (const banned of ['arguments', 'paramHash', 'expiresAt', 'riskLevel']) {
      expect(PublicToolEventSchema.safeParse({ ...VALID, [banned]: 1 }).success).toBe(false)
    }
  })
  it('capture/diff/pathSummary/attachmentCount 扩展通过', () => {
    expect(PublicToolEventSchema.safeParse({ ...VALID, pathSummary: '/home/u/notes.md', attachmentCount: 2,
      captureSources: [{ sourceId: 's1', sourceName: '屏', thumbnailDataUrl: 'data:image/png;base64,AA==' }] }).success).toBe(true)
    expect(PublicToolEventSchema.safeParse({ ...VALID, diff: { lines: [{ kind: 'added', text: 'x' }], added: 1, removed: 0, truncated: false, totalLines: 1, formatNote: 'UTF-8', isNewFile: false } }).success).toBe(true)   // totalLines 必填（H2）
  })
})
describe('ToolCallRecordSchema + MessageSchema.toolCalls', () => {
  it('MessageSchema.safeParse 保留 toolCalls（preload 剥字段修复，M1 加强：断言 parsed.data 保留而非仅 success）', () => {
    const input = { ...assistantMsg, toolCalls: [{ id: 'tc_1', toolName: 'seed.tool.read', runtime: 'backend', status: 'completed' }] }
    const parsed = MessageSchema.safeParse(input)
    expect(parsed.success).toBe(true)
    expect(parsed.data!.toolCalls).toEqual(input.toolCalls)   // 剥字段回归守卫：schema 未声明 toolCalls 时此处必失败
  })
  it('attachmentCount 合法/非法', () => {
    expect(ToolCallRecordSchema.safeParse({ id: 'a', toolName: 'x', runtime: 'backend', status: 'completed', attachmentCount: 3 }).success).toBe(true)
    expect(ToolCallRecordSchema.safeParse({ id: 'a', toolName: 'x', runtime: 'backend', status: 'completed', attachmentCount: -1 }).success).toBe(false)
  })
})
