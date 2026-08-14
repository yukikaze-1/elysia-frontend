import { describe, expect, it } from 'vitest'
import { parseRestSessions, parseRestMessagesPage, parseRestMessage, parseRestSessionDetail, parseRestActivateResult } from '../../src/main/transport/protocol-v2/rest-schemas'

const validSummary = { conversationId: 'conv-1', title: '测试', messageCount: 3, updatedAt: '2026-08-11T00:00:00.000Z', active: true }

const validMessage = {
  role: 'assistant', parts: [{ content: '你好' }], content: '你好',
  message_id: 'msg-1', timestamp: '2026-08-11T00:00:00.000Z',
  session_id: 'conv-1', _id: '507f1f77bcf86cd799439011',
  inner_voice: '内心独白', tool_call_id: 'tc-1', tool_name: 'desktop.file.read',
  success: true, error: '', error_type: '', duration_ms: 10, truncated: false
}

describe('REST wire schema', () => {
  it('SessionSummary 合法通过,缺 title 通过', () => {
    expect(parseRestSessions({ sessions: [validSummary], has_more: false }).success).toBe(true)
    const noTitle = { ...validSummary }; delete (noTitle as Record<string, unknown>).title
    expect(parseRestSessions({ sessions: [noTitle], has_more: true, cursor: 'c1' }).success).toBe(true)
  })

  it('Message 全字段(混合命名 message_id/_id/tool_call_id)通过', () => {
    expect(parseRestMessage(validMessage).success).toBe(true)
  })

  it('Message 缺 message_id/timestamp 拒绝(必填)', () => {
    const bad = { ...validMessage }; delete (bad as Record<string, unknown>).message_id
    expect(parseRestMessage(bad).success).toBe(false)
    const bad2 = { ...validMessage }; delete (bad2 as Record<string, unknown>).timestamp
    expect(parseRestMessage(bad2).success).toBe(false)
  })

  it('Message 缺 _id 通过(可选,Mongo 归档 id)', () => {
    const noId = { ...validMessage }; delete (noId as Record<string, unknown>)._id
    expect(parseRestMessage(noId).success).toBe(true)
  })

  it('strict:未知键拒绝', () => {
    expect(parseRestMessage({ ...validMessage, bogus: 1 }).success).toBe(false)
  })

  it('MessagesPageResponse 全字段通过,has_more=false 时 cursor 缺省', () => {
    expect(parseRestMessagesPage({ messages: [validMessage], has_more: false, total: 1 }).success).toBe(true)
    expect(parseRestMessagesPage({ messages: [validMessage], has_more: true, total: 2, cursor: '507f' }).success).toBe(true)
  })

  it('SessionDetail 通过,activate 结果通过', () => {
    expect(parseRestSessionDetail({ session: validSummary, messages: [validMessage], active: true }).success).toBe(true)
    expect(parseRestActivateResult({ activeConversationId: 'conv-2' }).success).toBe(true)
  })

  it('未知 role 拒绝(仅 user/assistant/tool)', () => {
    expect(parseRestMessage({ ...validMessage, role: 'system' }).success).toBe(false)
  })

  it('Message 顶层 duration_ms:null 通过（P0-02 wire 边界放行，映射层归一化）', () => {
    const withNull = { ...validMessage, duration_ms: null }
    expect(parseRestMessage(withNull).success).toBe(true)
  })
  it('parseRestMessagesPage 一页含 null duration_ms → success（单字段 null 不拒整页）', () => {
    const page = {
      messages: [
        { role: 'tool', message_id: 'm1', timestamp: '2026-08-11T00:00:00.000Z', duration_ms: null },
        { role: 'user', message_id: 'm2', timestamp: '2026-08-11T00:00:01.000Z', content: 'hi' }
      ],
      has_more: false, total: 2
    }
    expect(parseRestMessagesPage(page).success).toBe(true)
  })
})
