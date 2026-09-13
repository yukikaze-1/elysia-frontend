import { describe, expect, it } from 'vitest'
import { RestMapper, pairToolCalls } from '../../src/main/transport/protocol-v2/rest-mapper'
import type { Message, MessageToolInfo } from '@shared/contracts/message'
import type { RestMessage } from '../../src/main/transport/protocol-v2/rest-types'

const mapper = new RestMapper()
const asRest = (raw: unknown): RestMessage => raw as RestMessage // review P-10：显式类型，不用 as never

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
    const fail = pairToolCalls([mkSkeleton(), { ...resultOk, content: undefined, tool: { callId: 'tc_1', name: 'get_time', success: false, error: '数据库不可用', errorType: 'DB_DOWN' } }])
    expect(fail[0].toolCalls?.[0]).toMatchObject({ status: 'failed', error: { code: 'DB_DOWN', message: '数据库不可用' }, errorType: 'DB_DOWN' })
  })
  it('UII-QQ 收尾：errorType=TIMEOUT → timeout（超时非「执行失败」）', () => {
    const t = pairToolCalls([mkSkeleton(), { ...resultOk, content: undefined, tool: { callId: 'tc_1', name: 'get_time', success: false, error: '服务端已过期', errorType: 'TIMEOUT' } }])
    expect(t[0].toolCalls?.[0]).toMatchObject({ status: 'timeout', error: { code: 'TIMEOUT', message: '服务端已过期' }, errorType: 'TIMEOUT' })
  })
  it('UII-QQ 收尾：errorType=CANCELLED → cancelled（用户取消非执行失败，灰态非红框）', () => {
    const c = pairToolCalls([mkSkeleton(), { ...resultOk, content: undefined, tool: { callId: 'tc_1', name: 'get_time', success: false, error: '用户取消', errorType: 'CANCELLED' } }])
    expect(c[0].toolCalls?.[0]).toMatchObject({ status: 'cancelled', errorType: 'CANCELLED' })
  })
  it('UII-QQ 收尾：旧归档仅错误文字「用户取消」/「用户取消选择」（无 error_type）→ cancelled（文案全等严格兼容）', () => {
    const c1 = pairToolCalls([mkSkeleton(), { ...resultOk, content: undefined, tool: { callId: 'tc_1', name: 'get_time', success: false, error: '用户取消' } }])
    expect(c1[0].toolCalls?.[0]?.status).toBe('cancelled')
    const c2 = pairToolCalls([mkSkeleton(), { ...resultOk, content: undefined, tool: { callId: 'tc_1', name: 'get_time', success: false, error: '用户取消选择' } }])
    expect(c2[0].toolCalls?.[0]?.status).toBe('cancelled')
  })
  it('UII-QQ 收尾：错误文字含「取消」但非全等 → 仍 failed（禁止宽泛 includes 猜测）', () => {
    const f = pairToolCalls([mkSkeleton(), { ...resultOk, content: undefined, tool: { callId: 'tc_1', name: 'get_time', success: false, error: '取消重试后仍失败：磁盘错误' } }])
    expect(f[0].toolCalls?.[0]?.status).toBe('failed')
  })
  it('UII-QQ 收尾：骨架 runtime 判定——desktop. 前缀推断 desktop；显式 runtime 优先；普通 read_file 不误标 desktop', () => {
    const m = mapper.toDomainMessage(asRest({
      role: 'assistant', message_id: 'm-rt', timestamp: '2026-08-30T00:00:00.000Z',
      tool_calls: [
        { id: 'tc_d', function: { name: 'desktop.file.read', arguments: '{}' } },
        { id: 'tc_lw', runtime: 'local_worker', function: { name: 'index_docs', arguments: '{}' } },
        { id: 'tc_be', function: { name: 'read_file', arguments: '{}' } }
      ]
    }), 'c')
    expect(m.toolCalls).toEqual([
      { id: 'tc_d', toolName: 'desktop.file.read', runtime: 'desktop', status: 'completed' },
      { id: 'tc_lw', toolName: 'index_docs', runtime: 'local_worker', status: 'completed' },
      { id: 'tc_be', toolName: 'read_file', runtime: 'backend', status: 'completed' }
    ])
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
      mapper.toDomainMessageFromReplay({ role: 'assistant', message_id: 'm1', timestamp: 't0', tool_calls: [{ id: 'tc_1', function: { name: 'get_time', arguments: '{}' } }] }, 'c'),
      mapper.toDomainMessageFromReplay({ role: 'tool', message_id: 'm2', timestamp: 't1', content: 'ok', tool_call_id: 'tc_1', name: 'get_time', success: true }, 'c')
    ]
    const out = pairToolCalls(msgs)
    expect(out[0].toolCalls?.[0]?.outputSummary).toBe('ok')
  })
  it('桌面截图 ContentPart → 仅派生安全 callId/附件数，并把归档卡 runtime 修正为 desktop', () => {
    const assistant = mapper.toDomainMessage(asRest({
      role: 'assistant', message_id: 'm-cap-a', timestamp: 't0',
      tool_calls: [{ id: 'tc_cap', function: { name: 'desktop.screen.capture', arguments: '{}' } }]
    }), 'c')
    const result = mapper.toDomainMessage(asRest({
      role: 'tool', message_id: 'm-cap-r', timestamp: 't1', tool_call_id: 'tc_cap',
      name: 'desktop.screen.capture', success: true,
      content: [
        { type: 'text', content: '' },
        { type: 'image', src: '/uploads/desktop/call_2025c9e03ffa.png', mime: 'image/png', attachment_id: null }
      ]
    }), 'c')
    expect(result.tool).toMatchObject({ desktopCallId: 'call_2025c9e03ffa', attachmentCount: 1 })
    expect(JSON.stringify(result.tool)).not.toContain('/uploads/desktop/')
    expect(pairToolCalls([assistant, result])[0].toolCalls?.[0]).toMatchObject({
      id: 'tc_cap', runtime: 'desktop', desktopCallId: 'call_2025c9e03ffa', attachmentCount: 1
    })
  })
  it('截图归档路径/MIME 不匹配或混入多个 callId → 不派生代理凭据', () => {
    const malformed = mapper.toDomainMessage(asRest({
      role: 'tool', message_id: 'm-bad', timestamp: 't', tool_call_id: 'tc', success: true,
      content: [
        { type: 'image', src: 'https://evil.example/uploads/desktop/call_a.png', mime: 'image/png' },
        { type: 'image', src: '/uploads/desktop/call_a.png', mime: 'image/jpeg' },
        { type: 'image', src: '/uploads/desktop/call_a.png', mime: 'image/png' },
        { type: 'image', src: '/uploads/desktop/call_b.png', mime: 'image/png' }
      ]
    }), 'c')
    expect(malformed.tool?.desktopCallId).toBeUndefined()
    expect(malformed.tool?.attachmentCount).toBeUndefined()
  })
})

describe('pairToolCalls R-A3 空串错误（Task 6 / D6B-21）', () => {
  const mkSkeleton = (id: string): Message => ({ messageId: 'm1', conversationId: 'c', role: 'assistant', createdAt: 't0', status: 'completed', toolCalls: [{ id, toolName: 'get_time', runtime: 'backend', status: 'completed' }] })
  const mkResult = (id: string, tool: Partial<MessageToolInfo>): Message =>
    ({ messageId: 'm2', conversationId: 'c', role: 'tool', createdAt: 't1', status: 'completed', tool: { callId: id, name: 'get_time', ...tool } })

  it('R-A3：info.error === "" 视为无错误走 success 分支', () => {
    // mkSkeleton() 骨架 + role=tool 结果消息（tool.success=false, error=''）——空串错误不判 failed（spec B-1/A-16/A-17）
    const messages = [mkSkeleton('tc_1'), mkResult('tc_1', { success: false, error: '' })]
    const out = pairToolCalls(messages)
    const tc = out[0].toolCalls![0]
    expect(tc.status).toBe('completed')     // 空串 error 不判 failed
    expect(tc.error).toBeUndefined()
  })
  it('非空 error → failed 保持', () => {
    const messages = [mkSkeleton('tc_2'), mkResult('tc_2', { success: false, error: 'boom' })]
    const tc = pairToolCalls(messages)[0].toolCalls![0]
    expect(tc.status).toBe('failed')
    expect(tc.error?.message).toBe('boom')
  })
  it('回放路径断言（A-17/L6）：toDomainMessageFromReplay 组装 → pairToolCalls（sessionBuffer tool 帧不回归）', () => {
    // 基于既有回放用例：构造含 assistant tool_calls + role=tool 结果（error 空串）的 replay 数组 →
    // toDomainMessageFromReplay → pairToolCalls → toolCalls 配对成功且不被空串错误翻转
    const msgs = [
      mapper.toDomainMessageFromReplay({ role: 'assistant', message_id: 'm1', timestamp: 't0', tool_calls: [{ id: 'tc_1', function: { name: 'get_time', arguments: '{}' } }] }, 'c'),
      mapper.toDomainMessageFromReplay({ role: 'tool', message_id: 'm2', timestamp: 't1', content: 'ok', tool_call_id: 'tc_1', name: 'get_time', success: false, error: '' }, 'c')
    ]
    const out = pairToolCalls(msgs)
    expect(out[0].toolCalls?.[0]?.status).toBe('completed')
    expect(out[0].toolCalls?.[0]?.outputSummary).toBe('ok')
    expect(out[0].toolCalls?.[0]?.error).toBeUndefined()
  })
})
