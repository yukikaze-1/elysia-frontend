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
  it('desktop kind：经 toolRequestSink 交付 DesktopToolRequest（call_mock_1/tc_mock_desktop_1/原始 arguments/expiresAt 未来）', async () => {
    const sink: unknown[] = []
    const mock = new MockBackend({ emitDelayMs: 0, toolFlow: { kind: 'desktop', request: { toolName: 'desktop.file.read', arguments: { path: '/etc/passwd' }, reason: '读取文件' } }, toolRequestSink: (req) => sink.push(req) })
    await mock.connect({ serverUrl: 'mock://test' })
    await mock.activateConversation('conv-1001')
    await mock.sendMessage({ conversationId: 'conv-1001', text: 'hi', clientRequestId: 'cr-1' })
    await new Promise((r) => setTimeout(r, 50))
    expect(sink).toHaveLength(1)
    expect(sink[0]).toMatchObject({ callId: 'call_mock_1', sourceCallId: 'tc_mock_desktop_1', toolName: 'desktop.file.read', runtime: 'desktop', toolVersion: '1.0', reason: '读取文件', arguments: { path: '/etc/passwd' } })
    expect((sink[0] as { expiresAt: number }).expiresAt > Date.now()).toBe(true)
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
  it('submitToolResult：id 自增后 call_mock_<n> → tc_mock_desktop_<n> 通用映射（新发现4，固定串不再只认 call_mock_1）', async () => {
    const mock = new MockBackend({ emitDelayMs: 0 })
    await mock.connect({ serverUrl: 'mock://test' })
    await mock.activateConversation('conv-1001')
    await mock.submitToolResult({ callId: 'call_mock_2', status: 'result', toolName: 'desktop.file.read', toolVersion: '1.0', runtime: 'desktop', paramHash: 'h', output: '内容' })
    const page = await mock.getMessageContext({ conversationId: 'conv-1001', messageId: 'msg-1002', before: 0, after: 10 })
    const toolMsgs = page.items.filter((m) => m.role === 'tool' && m.tool?.callId === 'tc_mock_desktop_2')
    expect(toolMsgs).toHaveLength(1)
    expect(toolMsgs[0].tool).toMatchObject({ callId: 'tc_mock_desktop_2', success: true })
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

describe('批次 B 改接（toolRequestSink）', () => {
  it('desktop kind 不再 emit chat:event；经 sink 交付 DesktopToolRequest（id 自增）', async () => {
    const sink: Array<{ callId?: string; sourceCallId?: string; toolName?: string; runtime?: string; paramHash?: unknown }> = []
    const mb = new MockBackend({ emitDelayMs: 0, toolFlow: { kind: 'desktop', request: { toolName: 'desktop.file.read', arguments: { path: '/tmp/x.txt' } } }, toolRequestSink: (req) => sink.push(req) })
    const events: Array<{ event?: string }> = []
    mb.subscribe((e) => events.push(e))
    await mb.connect({ serverUrl: 'mock://test' })
    await mb.activateConversation('conv-1001')
    await mb.sendMessage({ conversationId: 'conv-1001', text: 'hi', clientRequestId: 'r1' })
    await new Promise((r) => setTimeout(r, 50))
    expect(sink.length).toBe(1)
    expect(sink[0]).toMatchObject({ callId: 'call_mock_1', sourceCallId: 'tc_mock_desktop_1', toolName: 'desktop.file.read', runtime: 'desktop' })
    expect(sink[0].paramHash).toBeUndefined()
    expect(events.some((e) => e.event === 'tool.request')).toBe(false)   // 不再直发 chat:event（判别键 event，代码 M7）
    // 第二次发射 id 自增（A3）
    await mb.sendMessage({ conversationId: 'conv-1001', text: 'hi2', clientRequestId: 'r2' })
    await new Promise((r) => setTimeout(r, 50))
    expect(sink[1].callId).toBe('call_mock_2')
    expect(sink[1].sourceCallId).toBe('tc_mock_desktop_2')
  })
  it('backend kind 发射不变（L3：补最小断言——started/completed 仍经订阅面且 sourceCallId 固定）', async () => {
    const mb = new MockBackend({ toolFlow: { kind: 'backend', started: { toolName: 'search_web', inputSummary: 'q=<str:2>' }, completed: { success: true, outputSummary: 'ok' } }, emitDelayMs: 0 })   // emitDelayMs:0——scheduleReplay 缺省 30ms×11 帧尾事件（对齐既有 sink 用例）
    const events: Array<{ event?: string }> = []; mb.subscribe((e) => events.push(e))
    mb.connect({ serverUrl: 'mock://server' }); await mb.activateConversation('conv-1001'); await mb.sendMessage({ conversationId: 'conv-1001', text: 'hi', clientRequestId: 'r1' })
    await new Promise(r => setTimeout(r, 50))
    const started = events.find(e => e.event === 'tool.started')
    const completed = events.find(e => e.event === 'tool.completed')
    expect(started).toMatchObject({ callId: 'tc_mock_backend_1', toolName: 'search_web' })
    expect(completed).toMatchObject({ callId: 'tc_mock_backend_1', success: true, outputSummary: 'ok' })
  })
})
