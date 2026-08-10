import type { Conversation } from '@shared/contracts/conversation'
import type { Message, MessageRole, MessageToolInfo } from '@shared/contracts/message'
import type { MessagePage } from '@shared/contracts/backend'
import type { ProtocolWarning } from '@shared/contracts/protocol'
import type { RawSessionMessageItem } from './raw-types'
import type { RestMessage, RestMessagesPageResponse, RestSessionSummary } from './rest-types'

export interface RestMapperOptions { onProtocolWarning?: (warning: ProtocolWarning) => void }

interface MessageSource {
  role: string
  message_id?: string
  timestamp?: string
  session_id?: string
  parts?: unknown[]
  content?: unknown
  inner_voice?: string
  mood?: string
  tool_call_id?: string
  name?: string
  tool_name?: string
  success?: boolean
  error?: string
  error_type?: string
  duration_ms?: number
  truncated?: boolean
}

export class RestMapper {
  // onProtocolWarning 保留在 RestMapperOptions(与 FrameMapper 对齐),当前无告警点,暂不存储
  constructor(_options: RestMapperOptions = {}) {}

  toDomainMessage(raw: RestMessage, conversationId?: string): Message { return this.assemble({ ...raw }, conversationId) }
  toDomainMessageFromReplay(raw: RawSessionMessageItem, conversationId: string): Message { return this.assemble({ ...raw, session_id: conversationId }, conversationId) }
  toConversation(raw: RestSessionSummary): Conversation { return { id: raw.conversationId, title: raw.title ?? '', updatedAt: raw.updatedAt } }
  toMessagePage(raw: RestMessagesPageResponse, opts: { direction: 'before' | 'after'; conversationId?: string }): MessagePage {
    const items = raw.messages.map((m) => this.toDomainMessage(m, opts.conversationId))
    if (opts.direction === 'before') items.sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.messageId < b.messageId ? -1 : 1) // (timestamp, messageId) 稳定排序
    let nextCursor: string | undefined
    if (raw.has_more) nextCursor = raw.cursor ?? raw.messages.at(-1)?._id
    return { items, hasMore: raw.has_more, nextCursor }
  }

  private assemble(src: MessageSource, conversationId?: string): Message {
    const role = src.role as MessageRole
    const convId = conversationId ?? src.session_id ?? ''
    const base: Message = {
      messageId: src.message_id ?? `${convId}:${src.timestamp ?? 'replay'}`, // 缺省可复现本地 id
      conversationId: convId,
      role,
      createdAt: src.timestamp ?? '',
      status: 'completed'
    }
    if (role === 'user' || role === 'tool') {
      base.content = extractText(src.content, src.parts)
    } else if (role === 'assistant') {
      const segments: NonNullable<Message['assistantSegments']> = []
      if (src.inner_voice) segments.push({ segmentId: `iv-${base.messageId}`, segmentIndex: 0, channel: 'inner_voice', kind: 'text', text: src.inner_voice, completed: true })
      const mainText = extractText(src.content, src.parts)
      if (mainText) segments.push({ segmentId: `pr-${base.messageId}`, segmentIndex: segments.length, channel: 'public_reply', kind: 'markdown', text: mainText, completed: true })
      if (segments.length) base.assistantSegments = segments
    }
    if (role === 'tool' || src.tool_call_id || src.name || src.tool_name || src.success !== undefined) {
      const tool: MessageToolInfo = {}
      if (src.tool_call_id) tool.callId = src.tool_call_id
      if (src.name ?? src.tool_name) tool.name = src.name ?? src.tool_name // REST wire 用 tool_name;WS 回放用 name
      if (src.success !== undefined) tool.success = src.success
      if (src.error !== undefined) tool.error = src.error
      if (src.error_type !== undefined) tool.errorType = src.error_type
      if (src.duration_ms !== undefined) tool.durationMs = src.duration_ms
      if (src.truncated !== undefined) tool.truncated = src.truncated
      if (Object.keys(tool).length) base.tool = tool
    }
    if (src.mood) base.emotion = src.mood // 回放项 mood → 领域 emotion(docs/18 §14 不静默丢弃)
    return base
  }
}

/** 提取纯文本:content 为 string 优先;否则 parts 拼接(assistant content/parts 同文本时不重复)。
 *  parts 来自 REST `{content:string}[]` 或 WS 回放宽松 `unknown[]`,逐项安全提取字符串 content。 */
function extractText(content: unknown, parts?: unknown[]): string | undefined {
  if (typeof content === 'string' && content.length > 0) return content
  if (typeof content === 'string' && content.length === 0) return undefined
  const joined = (parts ?? []).reduce<string>((acc, p) => {
    if (typeof p === 'object' && p !== null && 'content' in p) {
      const c = (p as { content?: unknown }).content
      if (typeof c === 'string') return acc + c
    }
    return acc
  }, '')
  return joined.length > 0 ? joined : undefined
}
