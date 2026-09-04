// tests/unit/ipc-limit.spec.ts（node）
// spec §4.1「通道上界核对表」：
// ① D7A-13 值表逐项——无界字段补值（title 200 / search query 512 / 消息发送 content 64KiB /
//    语音 commit text 10KiB / attachment 路径 1024），断言为 channels.ts 实际 schema 上界存在性 +
//    超限行为拒绝（本表为契约钉——既补后回退即红）；
// ② 引用性哨兵：既有上界不回退——MAX_IPC_MESSAGE_BYTES=4MiB、MAX_AUDIO_CHUNK_BYTES=1MiB、
//    setBackendToken 4097 拒（schema 级）；openExternal URL>2048 的通道级行为断言归 ipc-security 集成
//    （既有实现为 handler 内联判断，无 unit 可引用常量——spec §4.1 分派）。
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  chatSendSchema, chatRenameSchema, chatCreateSchema, chatQueryHistorySchema, voiceCommitSchema,
  UploadFileDescriptorSchema, credentialsSetSchema,
} from '../../src/main/ipc/channels'
import { BACKEND_TOKEN_KEY, MAX_IPC_MESSAGE_BYTES } from '@shared/contracts'
import { MAX_AUDIO_CHUNK_BYTES } from '../../src/main/voice/voice-handlers'

// voice-handlers → registry 引 electron（voice-handlers.spec 同款 mock，阻止真实 electron 模块装载）
vi.mock('electron', () => ({ BrowserWindow: class {}, ipcMain: { handle: vi.fn(), on: vi.fn() } }))

/** 读 zod v4 字符串字段的 maxLength 上界（无上界时 undefined）；z.ZodType 接口无 .shape 类型——运行时 cast（real-backend-tools.spec 同族先例）；
 *  optional 字段的 maxLength 在内部 ZodString 上——经 .unwrap() 解包读取 */
function maxLengthOf(schema: z.ZodType, field: string): number | undefined {
  const shape = (schema as unknown as { shape: Record<string, unknown> }).shape
  const f = shape[field] as { maxLength?: number; unwrap?: () => unknown } | undefined
  const inner = typeof f?.unwrap === 'function' ? f.unwrap() : f
  return (inner as { maxLength?: number } | undefined)?.maxLength
}

// —— ⑥ D7A-13 值表逐项（无界字段补值后的契约钉：上界存在性 + 超限拒绝 + 边界放行；min 为值表下限）——
// chatRename.title 与 chatCreate.title 同为「title 200」语义（按 channels.ts 实际字段核对补值）。
const LIMIT_CHECKS: Array<{ label: string; base: Record<string, unknown>; schema: z.ZodType; field: string; min: number; over: string }> = [
  { label: 'chatCreate title maxLength >= 200', base: {}, schema: chatCreateSchema, field: 'title', min: 200, over: 'x'.repeat(201) },
  { label: 'chatRename title maxLength >= 200', base: { conversationId: 'c1' }, schema: chatRenameSchema, field: 'title', min: 200, over: 'x'.repeat(201) },
  { label: 'search query maxLength >= 512', base: { scope: { type: 'all_conversations' }, timeZone: 'UTC', category: 'all', limit: 10 }, schema: chatQueryHistorySchema, field: 'query', min: 512, over: 'x'.repeat(513) },
  { label: 'send content maxLength >= 65536', base: { conversationId: 'c1', clientRequestId: 'r1' }, schema: chatSendSchema, field: 'text', min: 65536, over: 'x'.repeat(65537) },
  { label: 'voice commit text maxLength >= 10240', base: { recordingId: 'r1', conversationId: 'c1', clientRequestId: 'r1', clientMessageId: 'm1' }, schema: voiceCommitSchema, field: 'text', min: 10240, over: 'x'.repeat(10241) },
  { label: 'attachment path maxLength >= 1024', base: { localId: 'l1', name: 'a.log', size: 1, mediaType: 'text/plain', source: 'picker', kind: 'file' }, schema: UploadFileDescriptorSchema, field: 'path', min: 1024, over: 'x'.repeat(1025) },
]

describe('ipc-limit（spec §4.1——D7A-13 值表：无界字段 maxLength 补值契约钉）', () => {
  it.each(LIMIT_CHECKS.map((c) => [c.label, c] as const))('%s', (_label, c) => {
    const cap = maxLengthOf(c.schema, c.field)
    expect(cap, '上界缺失（D7A-13 未补值即回退）').toBeDefined()
    expect(cap ?? -1).toBeGreaterThanOrEqual(c.min)
    // 超限拒
    expect(c.schema.safeParse({ ...c.base, [c.field]: c.over }).success).toBe(false)
    // 边界（等于上限）放行
    expect(c.schema.safeParse({ ...c.base, [c.field]: c.over.slice(0, c.min) }).success).toBe(true)
  })
})

describe('ipc-limit（spec §4.1——引用性哨兵：既有上界不回退）', () => {
  it('chatCreate 透传 FE-E1 characterId，同时保持 strict 输入', () => {
    expect(chatCreateSchema.safeParse({ characterId: 'builtin/elysia' }).success).toBe(true)
    expect(chatCreateSchema.safeParse({ characterId: 'builtin/elysia', extra: true }).success).toBe(false)
  })

  it('MAX_IPC_MESSAGE_BYTES 恒为 4MiB', () => {
    expect(MAX_IPC_MESSAGE_BYTES).toBe(4 * 1024 * 1024)
  })
  it('MAX_AUDIO_CHUNK_BYTES 恒为 1MiB（voice-audio-chunk 运行期上限常量）', () => {
    expect(MAX_AUDIO_CHUNK_BYTES).toBe(1024 * 1024)
  })
  it('setBackendToken 4097 拒 / 4096 放行（credentialsSetSchema 既有上限不回退）', () => {
    expect(credentialsSetSchema.safeParse({ key: BACKEND_TOKEN_KEY, value: 'x'.repeat(4097) }).success).toBe(false)
    expect(credentialsSetSchema.safeParse({ key: BACKEND_TOKEN_KEY, value: 'x'.repeat(4096) }).success).toBe(true)
  })
})
