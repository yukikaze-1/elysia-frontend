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
