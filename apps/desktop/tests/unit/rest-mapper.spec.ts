import { describe, expect, it } from 'vitest'
import { RestMapper } from '../../src/main/transport/protocol-v2/rest-mapper'
import type { RestMessage, RestMessagesPageResponse, RestSessionSummary } from '../../src/main/transport/protocol-v2/rest-types'
import type { RawSessionMessageItem } from '../../src/main/transport/protocol-v2/raw-types'

const mapper = new RestMapper({ onProtocolWarning: () => {} })

const userMsg: RestMessage = {
  role: 'user', content: '你好', parts: [{ content: '你好' }],
  message_id: 'msg-1', timestamp: '2026-08-11T00:00:00.000Z', session_id: 'conv-1', _id: '507f1f77bcf86cd799439011'
}
const assistantMsg: RestMessage = {
  role: 'assistant', content: '好的', parts: [{ content: '好的' }],
  inner_voice: '让我想想',
  message_id: 'msg-2', timestamp: '2026-08-11T00:00:01.000Z', session_id: 'conv-1', _id: '507f1f77bcf86cd799439012'
}
const toolMsg: RestMessage = {
  role: 'tool', content: '文件内容', message_id: 'msg-3', timestamp: '2026-08-11T00:00:02.000Z',
  session_id: 'conv-1', _id: '507f1f77bcf86cd799439013',
  tool_call_id: 'tc-1', tool_name: 'desktop.file.read', success: true, duration_ms: 12
}

describe('RestMapper', () => {
  it('user 消息 → content 文本,status completed', () => {
    const m = mapper.toDomainMessage(userMsg)
    expect(m.messageId).toBe('msg-1')
    expect(m.role).toBe('user')
    expect(m.content).toBe('你好')
    expect(m.conversationId).toBe('conv-1')
    expect(m.status).toBe('completed')
  })

  it('assistant 消息 → inner_voice 段 + public_reply 段,content 不重复写入', () => {
    const m = mapper.toDomainMessage(assistantMsg)
    expect(m.role).toBe('assistant')
    const segs = m.assistantSegments ?? []
    expect(segs.some((s) => s.channel === 'inner_voice' && s.text === '让我想想')).toBe(true)
    expect(segs.some((s) => s.channel === 'public_reply' && s.text === '好的')).toBe(true)
    expect(m.content).toBeUndefined() // assistant 正文单一来源 assistantSegments
  })

  it('tool 消息 → content + tool 元数据保留', () => {
    const m = mapper.toDomainMessage(toolMsg)
    expect(m.content).toBe('文件内容')
    expect(m.tool).toEqual({ callId: 'tc-1', name: 'desktop.file.read', success: true, durationMs: 12 })
  })

  it('tool 消息 duration_ms:null → 领域无 durationMs（P0-02 wire 放行 null 后归一化）', () => {
    const raw: RestMessage = { role: 'tool', content: '已执行', message_id: 'msg-t', timestamp: '2026-08-11T00:00:01.000Z', session_id: 'conv-1', duration_ms: null, tool_name: 'desktop.file.read' }
    const m = mapper.toDomainMessage(raw)
    expect(m.tool).toEqual({ name: 'desktop.file.read' })
  })

  it('toDomainMessageFromReplay:回放项 name/mood 处理', () => {
    const replay: RawSessionMessageItem = {
      role: 'tool', message_id: 'msg-4', timestamp: '2026-08-11T00:00:03.000Z',
      content: '结果', name: 'desktop.file.write', success: false, error: 'denied', mood: 'calm'
    }
    const m = mapper.toDomainMessageFromReplay(replay, 'conv-9')
    expect(m.conversationId).toBe('conv-9')
    expect(m.tool?.name).toBe('desktop.file.write')
    expect(m.tool?.success).toBe(false)
    expect(m.tool?.error).toBe('denied')
    expect(m.emotion).toBe('calm')
  })

  it('toConversation 映射', () => {
    const s: RestSessionSummary = { conversationId: 'conv-1', title: '测试', messageCount: 3, updatedAt: '2026-08-11T00:00:00.000Z', active: true }
    expect(mapper.toConversation(s)).toEqual({ id: 'conv-1', title: '测试', updatedAt: '2026-08-11T00:00:00.000Z' })
  })

  it('toMessagePage before 页倒序归一化 + nextCursor', () => {
    const page: RestMessagesPageResponse = {
      messages: [
        { ...userMsg, message_id: 'msg-5', timestamp: '2026-08-11T00:00:05.000Z', _id: '5' },
        { ...assistantMsg, message_id: 'msg-6', timestamp: '2026-08-11T00:00:04.000Z', _id: '4' }
      ],
      has_more: true, total: 10, cursor: '4'
    }
    const result = mapper.toMessagePage(page, { direction: 'before' })
    expect(result.items.map((i) => i.messageId)).toEqual(['msg-6', 'msg-5']) // 正序
    expect(result.nextCursor).toBe('4')
    expect(result.hasMore).toBe(true)
  })

  it('toMessagePage after 页不反转', () => {
    const page: RestMessagesPageResponse = {
      messages: [
        { ...userMsg, message_id: 'msg-7', timestamp: '2026-08-11T00:00:06.000Z', _id: '6' },
        { ...assistantMsg, message_id: 'msg-8', timestamp: '2026-08-11T00:00:07.000Z', _id: '7' }
      ],
      has_more: false, total: 8
    }
    const result = mapper.toMessagePage(page, { direction: 'after' })
    expect(result.items.map((i) => i.messageId)).toEqual(['msg-7', 'msg-8']) // 不反转
    expect(result.nextCursor).toBeUndefined() // has_more=false 无 cursor
  })

  it('session tool item 不再产出共享 ${convId}:replay 主键（D2）', () => {
    const items = [
      { role: 'user', message_id: 'msg_u', timestamp: 't0', content: 'hi' },
      { role: 'tool', message_id: 'msg_t1', timestamp: 't1', tool_call_id: 'call_1', name: 'get_time', content: 'x', success: true },
      { role: 'tool', message_id: 'msg_t2', timestamp: 't2', tool_call_id: 'call_2', name: 'get_time', content: 'y', success: true }
    ]
    const out = items.map((m) => mapper.toDomainMessageFromReplay(m as never, 'conv-1'))
    expect(out).toHaveLength(3)
    expect(out.map((m) => m.messageId)).toEqual(['msg_u', 'msg_t1', 'msg_t2']) // 两个正式不同 msg_* ID
    expect(out.some((m) => m.messageId === 'conv-1:replay')).toBe(false)
  })
})

describe('RestMapper 媒体 ContentPart（D7 主路径：映射层不丢媒体）', () => {
  it('assistant 消息 content 含媒体 → 分段 + 消息级附件（name/size/尺寸从 ContentPart 映射）', () => {
    const raw: RestMessage = {
      role: 'assistant', content: [
        { type: 'text', text: '见图：' },
        { type: 'image', src: '/api/attachments/att_1', mime: 'image/png', attachment_id: 'att_1', filename: 'a.png', size_bytes: 1024, width: 100, height: 80 }
      ],
      message_id: 'msg-img', timestamp: '2026-08-11T00:00:04.000Z', session_id: 'conv-1', _id: 'i1'
    }
    const m = mapper.toDomainMessage(raw)
    const segs = m.assistantSegments ?? []
    expect(segs.map((s) => s.kind)).toEqual(['markdown', 'image'])
    expect(segs[1]).toMatchObject({ kind: 'image', attachmentId: 'att_1', mediaType: 'image/png', name: 'a.png', size: 1024, width: 100, height: 80 })
    expect(m.attachments).toEqual([{ attachmentId: 'att_1', kind: 'image', mediaType: 'image/png', name: 'a.png', size: 1024, width: 100, height: 80 }])
  })
  it('user 消息 content 含媒体 → Message.attachments（正文空则 content 缺省）', () => {
    const raw: RestMessage = {
      role: 'user', content: [{ type: 'file', src: '/api/attachments/att_2', mime: 'application/pdf', attachment_id: 'att_2', filename: 'doc.pdf', size_bytes: 2048 }],
      message_id: 'msg-f', timestamp: '2026-08-11T00:00:05.000Z', session_id: 'conv-1', _id: 'i2'
    }
    const m = mapper.toDomainMessage(raw)
    expect(m.content).toBeUndefined()
    expect(m.attachments).toEqual([{ attachmentId: 'att_2', kind: 'file', mediaType: 'application/pdf', name: 'doc.pdf', size: 2048 }])
  })
  it('assistant 纯媒体 content 且 parts 有文本 → 文本分段兜底（P2-3 parts 兜底）', () => {
    const raw: RestMessage = {
      role: 'assistant',
      content: [{ type: 'image', src: '/api/attachments/att_9', mime: 'image/png', attachment_id: 'att_9' }],
      parts: [{ content: '见附件' }],
      message_id: 'msg-parts', timestamp: '2026-08-11T00:00:06.000Z', session_id: 'conv-1', _id: 'i9'
    }
    const m = mapper.toDomainMessage(raw)
    const segs = m.assistantSegments ?? []
    expect(segs.map((s) => s.kind)).toEqual(['markdown', 'image'])
    expect(segs[0].text).toBe('见附件')
    expect(segs[1]).toMatchObject({ kind: 'image', attachmentId: 'att_9' })
  })
})
