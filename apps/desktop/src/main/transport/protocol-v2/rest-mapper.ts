import type { Conversation } from '@shared/contracts/conversation'
import type { Message, MessageRole, MessageToolInfo } from '@shared/contracts/message'
import type { ChatHistoryItem, ChatHistoryPage, MessagePage, StickerManifest } from '@shared/contracts'
import type { ProtocolWarning } from '@shared/contracts/protocol'
import type { ToolCallRecord } from '@shared/contracts/tool'
import type { RawSessionMessageItem } from './raw-types'
import type { RestMessage, RestMessagesPageResponse, RestSearchMessageItem, RestSearchMessagesResponse, RestMessageContextResponse, RestSessionSummary, RestStickerListResponse } from './rest-types'
import { extractStickerId, mapContentMedia, mapContentToEntries, toOptionalNonNegativeNumber } from './content-part'
import { classifyArchivedToolStatus } from '@shared/domain/tool-status'

export interface RestMapperOptions { onProtocolWarning?: (warning: ProtocolWarning) => void }

interface MessageSource {
  role: string
  message_id: string
  timestamp?: string
  session_id?: string
  parts?: unknown[]
  content?: unknown
  inner_voice?: string
  mood?: string
  tool_calls?: unknown[]
  tool_call_id?: string
  name?: string
  tool_name?: string
  success?: boolean
  error?: string
  error_type?: string
  duration_ms?: number | null
  truncated?: boolean
}

const DESKTOP_CAPTURE_SRC_PATTERN = /^\/uploads\/desktop\/(call_[A-Za-z0-9_-]+)\.png$/

/**
 * 后端把桌面截图归档为无 attachment_id 的 image ContentPart。这里只从固定相对路径和 PNG MIME
 * 派生调用 ID/数量，不把受鉴权的后端 URL 带入 Renderer。混入多个 callId 时 fail-closed。
 */
function extractDesktopCaptureInfo(content: unknown): Pick<MessageToolInfo, 'desktopCallId' | 'attachmentCount'> | undefined {
  if (!Array.isArray(content)) return undefined
  const ids: string[] = []
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue
    const part = item as { type?: unknown; src?: unknown; mime?: unknown }
    if (part.type !== 'image' || part.mime !== 'image/png' || typeof part.src !== 'string') continue
    const match = DESKTOP_CAPTURE_SRC_PATTERN.exec(part.src)
    if (match?.[1]) ids.push(match[1])
  }
  if (ids.length === 0 || ids.some((id) => id !== ids[0])) return undefined
  return { desktopCallId: ids[0], attachmentCount: ids.length }
}

export class RestMapper {
  // onProtocolWarning 保留在 RestMapperOptions(与 FrameMapper 对齐),当前无告警点,暂不存储
  constructor(_options: RestMapperOptions = {}) {}

  toDomainMessage(raw: RestMessage, conversationId?: string): Message { return this.assemble({ ...raw }, conversationId) }
  toDomainMessageFromReplay(raw: RawSessionMessageItem, conversationId: string): Message { return this.assemble({ ...raw, session_id: conversationId }, conversationId) }
  toConversation(raw: RestSessionSummary): Conversation { return { id: raw.conversationId, title: raw.title ?? '', updatedAt: raw.updatedAt } }
  toMessagePage(raw: RestMessagesPageResponse, opts: { direction: 'before' | 'after'; conversationId?: string }): MessagePage {
    const items = pairToolCalls(raw.messages.map((m) => this.toDomainMessage(m, opts.conversationId)))
    if (opts.direction === 'before') items.sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.messageId < b.messageId ? -1 : 1) // (timestamp, messageId) 稳定排序
    let nextCursor: string | undefined
    if (raw.has_more) nextCursor = raw.cursor ?? raw.messages.at(-1)?._id
    return { items, hasMore: raw.has_more, nextCursor }
  }

  /** search item → ChatHistoryItem（D2 归一化，P0-1：仅文本映射——search item 无 kind/url，不产 resource） */
  toChatHistoryItem(raw: RestSearchMessageItem): ChatHistoryItem {
    const base: ChatHistoryItem = {
      hitId: `${raw.conversationId}:${raw.messageId}:${raw.segmentId ?? ''}`,
      conversationId: raw.conversationId,
      messageId: raw.messageId,
      senderLabel: senderLabelOf(raw.role),
      createdAt: raw.timestamp,
      sortKey: `${raw.timestamp}|${raw.messageId}`
    }
    if (raw.responseId) base.responseId = raw.responseId
    if (raw.segmentId) base.segmentId = raw.segmentId
    if (raw.snippet) base.snippet = raw.snippet
    // P0-1：search item 无 kind/url，不产 resource（查看器分类缩略图缺口见「P0-1 设计缺口」）
    return base
  }

  toChatHistoryPage(raw: RestSearchMessagesResponse): ChatHistoryPage {
    const items = raw.items.map((i) => this.toChatHistoryItem(i)).sort(compareBySortKey)
    return { items, nextCursor: raw.cursor, hasMore: raw.has_more }
  }

  toMessagePageFromContext(res: RestMessageContextResponse): MessagePage {
    const items = pairToolCalls([res.anchor, ...res.before, ...res.after]
      .map((m) => this.toDomainMessage(m, res.conversationId)))
      .sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.messageId < b.messageId ? -1 : 1) // review P-15：保留既有 sort
    return { items, hasMore: false }
  }

  toStickerManifest(raw: RestStickerListResponse): StickerManifest {
    return { stickers: raw.stickers.map((s) => ({ stickerId: s.stickerId, src: s.src })) }
  }

  private assemble(src: MessageSource, conversationId?: string): Message {
    const role = src.role as MessageRole
    const convId = conversationId ?? src.session_id ?? ''
    const base: Message = {
      messageId: src.message_id, // D2:正式 v2 路径不设 fallback——身份缺失已在 schema 层拒帧(§5.4 #3)
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
      let segIndex = segments.length
      // P2-3：保留 parts 文本兜底——assistant content 为纯媒体数组（无文本条目）时，正文经 extractText(src.content, src.parts) 兜底补一个文本条目
      const entries = mapContentToEntries(src.content)
      const mainText = entries.some((e) => e.type === 'text') ? undefined : extractText(src.content, src.parts)
      const ordered = mainText ? [{ type: 'text' as const, text: mainText }, ...entries] : entries
      for (const entry of ordered) {
        if (entry.type === 'text') {
          segments.push({ segmentId: `pr-${base.messageId}-${segIndex}`, segmentIndex: segIndex, channel: 'public_reply', kind: 'markdown', text: entry.text, completed: true })
          segIndex += 1
        } else if (entry.type === 'media') {
          segments.push({
            segmentId: `media-${base.messageId}-${segIndex}`, segmentIndex: segIndex, channel: 'public_reply',
            kind: entry.media.kind, completed: true,
            ...(entry.media.attachmentId ? { attachmentId: entry.media.attachmentId } : {}),
            ...(entry.media.url ? { url: entry.media.url } : {}),
            ...(entry.media.mediaType ? { mediaType: entry.media.mediaType } : {}),
            ...(entry.media.name ? { name: entry.media.name } : {}),
            ...(entry.media.size !== undefined ? { size: entry.media.size } : {}),
            ...(entry.media.width !== undefined ? { width: entry.media.width } : {}),
            ...(entry.media.height !== undefined ? { height: entry.media.height } : {}),
            ...(entry.media.durationMs !== undefined ? { durationMs: entry.media.durationMs } : {})
          })
          segIndex += 1
        } else if (entry.type === 'sticker') {
          segments.push({   // P0-03：assistant sticker 分段（st- 前缀不撞 pr-/media-）
            segmentId: `st-${base.messageId}-${segIndex}`, segmentIndex: segIndex, channel: 'public_reply',
            kind: 'sticker', stickerId: entry.stickerId, completed: true
          })
          segIndex += 1
        }
      }
      if (segments.length) base.assistantSegments = segments
      const toolCalls = parseToolCallSkeletons(src.tool_calls)
      if (toolCalls.length) base.toolCalls = toolCalls
    }
    const media = mapContentMedia(src.content)
    if (media.length) base.attachments = media
    if (role === 'user') {
      const stickerId = extractStickerId(src.content)
      if (stickerId) base.stickerId = stickerId   // P0-03：用户贴图消息恢复 Message.stickerId（first-wins）
    }
    if (role === 'tool' || src.tool_call_id || src.name || src.tool_name || src.success !== undefined) {
      const tool: MessageToolInfo = {}
      if (src.tool_call_id) tool.callId = src.tool_call_id
      if (src.name ?? src.tool_name) tool.name = src.name ?? src.tool_name // REST wire 用 tool_name;WS 回放用 name
      if (src.success !== undefined) tool.success = src.success
      if (src.error !== undefined) tool.error = src.error
      if (src.error_type !== undefined) tool.errorType = src.error_type
      const toolDurationMs = toOptionalNonNegativeNumber(src.duration_ms)
      if (toolDurationMs !== undefined) tool.durationMs = toolDurationMs
      if (src.truncated !== undefined) tool.truncated = src.truncated
      const capture = extractDesktopCaptureInfo(src.content)
      if (capture) Object.assign(tool, capture)
      if (Object.keys(tool).length) base.tool = tool
    }
    if (src.mood) base.emotion = src.mood // 回放项 mood → 领域 emotion(docs/18 §14 不静默丢弃)
    return base
  }
}

/** 提取纯文本:content 为 string 优先;否则 typed parts 经 mapContentToEntries 提取 type:'text'(P0-03 文字+贴图);
 *  再退 parts 旧形状 `{content:string}[]`(assistant content/parts 同文本时不重复)。 */
function extractText(content: unknown, parts?: unknown[]): string | undefined {
  if (typeof content === 'string' && content.length > 0) return content
  const fromEntries = mapContentToEntries(content)
    .filter((e) => e.type === 'text')
    .map((e) => (e as { type: 'text'; text: string }).text)
    .join('')
  if (fromEntries.length > 0) return fromEntries
  const joined = (parts ?? []).reduce<string>((acc, p) => {
    if (typeof p === 'object' && p !== null && 'content' in p) {
      const c = (p as { content?: unknown }).content
      if (typeof c === 'string') return acc + c
    }
    return acc
  }, '')
  return joined.length > 0 ? joined : undefined
}

/** search item role → 领域 senderLabel（D2 归一化；未命中缺省 user） */
function senderLabelOf(role?: 'user' | 'assistant' | 'tool' | 'system'): string {
  switch (role) {
    case 'user': return 'user'
    case 'assistant': return 'assistant'
    case 'system': return '系统'
    case 'tool': return '工具'
    default: return 'user'
  }
}

/** P1-01：历史项稳定升序比较（sortKey 含 timestamp|messageId 稳定次键；单流/image_video/store 同款） */
export function compareBySortKey(a: ChatHistoryItem, b: ChatHistoryItem): number {
  return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0
}

/** 归档 tool_calls 骨架解析（F-6-19）：`{id, type?, function:{name, arguments}}` 契约形状；arguments 为 JSON 字符串不解析。
 * 非结构条目静默跳过（归档 wire 有意放宽，防整段拒）；同 id 幂等去重（后见同 id 骨架忽略，review P-17）。
 * UII-QQ 收尾 runtime 判定优先级：① 数据存在显式 runtime 字段 → 用明确值（实时事件中的明确 runtime 不被名称推断覆盖）；
 * ② toolName 以 `desktop.` 开头 → 确定性推断 desktop（归档卡不再把 desktop.file.read 误标「后端」；
 *   友好名同为「读取文件」的普通 read_file 不受影响）；local_worker 无可靠标识、不猜测；③ 其余回退 backend（D6A-06 缺省）。
 * desktopCallId 证据在 pairToolCalls 中仍会修正为 desktop（优先级②，与名称推断同向）。 */
function parseToolCallSkeletons(raw: unknown[] | undefined): ToolCallRecord[] {
  if (!raw?.length) return []
  const out: ToolCallRecord[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as { id?: unknown; runtime?: unknown; function?: { name?: unknown } }
    if (typeof o.id !== 'string' || o.id === '' || typeof o.function?.name !== 'string' || o.function.name === '') continue
    if (seen.has(o.id)) continue
    seen.add(o.id)
    const name = o.function.name
    const explicit = typeof o.runtime === 'string' && ['backend', 'desktop', 'local_worker'].includes(o.runtime)
      ? o.runtime as ToolCallRecord['runtime']
      : undefined
    const runtime = explicit ?? (name.startsWith('desktop.') ? 'desktop' : 'backend')
    out.push({ id: o.id, toolName: name, runtime, status: 'completed' })
  }
  return out
}

/** 归档配对（F-6-19/21）：assistant tool_calls 骨架与 role=tool 结果按 tool.callId 配对修正状态与结果摘要。
 * 命中后 error 非空 → 以错误为准 failed（spec §3.6，review P-17）；否则按 success（缺省视为 true）→ completed/failed；
 * 填 outputSummary/error/errorType/durationMs/finishedAt。
 * 缺配对结果 → 保持 completed + 无 outputSummary（「执行完成但摘要缺失」降级，D6A-06，不伪造）。
 * 跨页配对不支持（批次 B 查看器按上下文重配对）。 */
export function pairToolCalls(messages: Message[]): Message[] {
  const results = new Map<string, Message>()
  for (const m of messages) {
    if (m.role === 'tool' && m.tool?.callId && !results.has(m.tool.callId)) results.set(m.tool.callId, m)
  }
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.toolCalls?.length) continue
    for (const tc of m.toolCalls) {
      const r = results.get(tc.id)
      const info = r?.tool
      if (!r || !info) continue // 缺配对：保持 completed + 无摘要（降级）
      // R-A3（D6B-21）：空串 error 视为无错误且视为成功——后端序列化空串无失败细节，不判 failed（走 success 分支）；
      // error 缺省（undefined）按 success 旗标（缺省视为 true）。UII-QQ 收尾：失败按稳定错误类型分类——
      // 取消（CANCELLED/TOOL_CANCELLED/USER_CANCELLED；旧归档无 error_type 时仅接受「用户取消」/「用户取消选择」
      // 文案全等）→ cancelled（灰「已取消」，非红「执行失败」）；TIMEOUT → timeout；未命中一律真实失败。
      const classified = classifyArchivedToolStatus({ success: info.success, error: info.error, errorType: info.errorType })
      tc.status = classified
      if (classified === 'completed') {
        if (r.content) tc.outputSummary = r.content
      } else {
        tc.error = {
          code: info.errorType ?? (classified === 'cancelled' ? 'CANCELLED' : classified === 'timeout' ? 'TIMEOUT' : 'TOOL_ERROR'),
          message: info.error ?? (classified === 'cancelled' ? '用户取消' : classified === 'timeout' ? '执行超时' : '工具执行失败'),
        }
        tc.errorType = info.errorType
      }
      if (info.durationMs !== undefined) tc.durationMs = info.durationMs
      if (info.truncated !== undefined) tc.truncated = info.truncated
      if (info.desktopCallId !== undefined) {
        tc.desktopCallId = info.desktopCallId
        tc.runtime = 'desktop'
      }
      if (info.attachmentCount !== undefined) tc.attachmentCount = info.attachmentCount
      tc.finishedAt = r.createdAt
    }
  }
  return messages
}
