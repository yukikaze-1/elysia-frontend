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
    await mock.sendMessage({ conversationId: 'conv-1001', text: 'hi', clientRequestId: 'cr-1' })
    await new Promise((r) => setTimeout(r, 50))
    expect(events).toEqual(['tool.started', 'tool.completed'])
  })
  it('desktop kind：发射 tool.request（call_mock_1/tc_mock_desktop_1/expiresAt 未来/inputSummary 脱敏）', async () => {
    let req: unknown
    const mock = new MockBackend({ emitDelayMs: 0, toolFlow: { kind: 'desktop', request: { toolName: 'desktop.file.read', arguments: { path: '/etc/passwd' }, reason: '读取文件' } } })
    mock.subscribe((e) => { if (e.event === 'tool.request') req = e })
    await mock.connect({ serverUrl: 'mock://test' })
    await mock.activateConversation('conv-1001')
    await mock.sendMessage({ conversationId: 'conv-1001', text: 'hi', clientRequestId: 'cr-1' })
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
