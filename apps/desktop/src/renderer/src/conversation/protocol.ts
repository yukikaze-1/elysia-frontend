// renderer/src/conversation/protocol.ts
// 会话线的协议解析与不可变绑定快照校验。
//
// 为什么单独存在：会话列表与会话创建响应是**协议事实**的入口。角色能力开启后，列表本身也是
// 角色绑定协议的一部分（不只是 create 才要校验），而绑定快照在一会话内不可变。这些规则原先写在
// store 顶部，只有整棵 store 集成用例能到达，且任何一处放松都会让「同页重复会话」「冲突快照覆写」
// 这类坏数据静默进入列表与缓存。
//
// 本模块不 import `vue` / `pinia` / 任何 store。
import type { Conversation, ConnectionState } from '@shared/contracts'
import { ConversationSchema, PageSchema } from '@shared/schemas'
import { cloneValue } from '@shared/domain'

export function conversationProtocolError(message: string): Error {
  return new Error(`[CHARACTER_CONVERSATION_PROTOCOL] ${message}`)
}

export function parseConversation(value: unknown, profilesEnabled: boolean, requestedCharacterId?: string): Conversation {
  const parsed = ConversationSchema.safeParse(value)
  if (!parsed.success) throw conversationProtocolError('新建会话响应格式无效')
  const conversation = parsed.data
  if (profilesEnabled) {
    if (!conversation.character) throw conversationProtocolError('角色模式的会话响应缺少角色绑定')
    if (requestedCharacterId && conversation.character.characterId !== requestedCharacterId) {
      throw conversationProtocolError('会话响应的角色绑定与请求不一致')
    }
  }
  return cloneValue(conversation)
}

export function parseCreatedConversation(value: unknown, requestedCharacterId?: string, profilesEnabled = false): Conversation {
  return parseConversation(value, profilesEnabled, requestedCharacterId)
}

export const ConversationPageSchema = PageSchema(ConversationSchema)

export interface ParsedConversationPage {
  items: Conversation[]
  hasMore: boolean
  nextCursor?: string
}

/**
 * 角色能力开启后，列表也是角色绑定协议的一部分，而不是只有 create 才需要校验。
 * 先完整解析整页，再交给调用方合并，确保坏页不会半写入 items/cache。
 */
export function parseConversationPage(value: unknown, profilesEnabled: boolean): ParsedConversationPage {
  const parsed = ConversationPageSchema.safeParse(value)
  if (!parsed.success) throw conversationProtocolError('会话列表响应格式无效')
  return {
    items: parsed.data.items.map((item) => parseConversation(item, profilesEnabled)),
    hasMore: parsed.data.hasMore,
    ...(parsed.data.nextCursor !== undefined ? { nextCursor: parsed.data.nextCursor } : {})
  }
}

/** 同一会话的角色能力开关判定（列表与 create 共用一个口径）。 */
export function profilesEnabledFor(state: ConnectionState): boolean {
  return state.status === 'connected' && state.features?.characterProfiles === true
}

export type BindingConflict = 'identity' | 'revision' | 'snapshot'

export function bindingConflict(
  left: NonNullable<Conversation['character']>,
  right: NonNullable<Conversation['character']>
): BindingConflict | undefined {
  // 会话的角色/实例不可变，但 follow_latest 会话可能在轮次之间前进到更新的内容 revision。
  // 同 revision 下的展示变化不是改写既有快照的合法方式。
  if (left.characterId !== right.characterId || left.characterInstanceId !== right.characterInstanceId) return 'identity'
  if (right.characterRevision < left.characterRevision) return 'revision'
  if (right.characterRevision === left.characterRevision && (
    left.displayName !== right.displayName || JSON.stringify(left.presentation) !== JSON.stringify(right.presentation)
  )) return 'snapshot'
  return undefined
}

/**
 * 会话 binding 是创建时不可变快照；列表刷新不得用冲突快照覆盖权威结果。
 *
 * 同页重复 id 即使绑定恰好相同也是协议错误：静默留一条会让标题/顺序的选择取决于
 * Vue 的重复 key 调和结果。
 */
export function assertNoBindingConflict(existing: Conversation[], incoming: Conversation[], compareBindings: boolean): void {
  const byId = new Map(existing.map((item) => [item.id, item]))
  const seenIncoming = new Set<string>()
  for (const next of incoming) {
    if (seenIncoming.has(next.id)) throw conversationProtocolError('会话列表同页包含重复会话')
    seenIncoming.add(next.id)
    const previous = byId.get(next.id)
    if (compareBindings && previous?.character && next.character) {
      const conflict = bindingConflict(previous.character, next.character)
      if (conflict) throw conversationProtocolError(`会话列表返回了冲突的角色绑定快照(${conflict})`)
    }
    byId.set(next.id, next)
  }
}
