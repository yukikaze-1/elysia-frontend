// renderer/src/message/acceptance.ts
// 归档消息的准入判据（replay / REST 页 / 离线快照三条来源共用）。
//
// 为什么抽出来：这三条路径对「哪些消息可以进内存表」的判据必须**逐字一致**——任何一条放松都会
// 让历史会话里出现一份无法归属的角色快照或一份被改写会话 id 的消息，而这类数据一旦进了
// 消息表就会跟着分页/缓存/去重一路传播。原先判据与 store 的告警副作用缠在一起，只能经集成用例到达。
//
// 本模块只做**判定**：所有拒绝都以判别式结果返回，告警与错误横幅由 store 侧投影（它才知道
// `lastError` / `droppedEvents` 这两个 UI 面）。
import type { CharacterBindingSnapshot, Message } from '@shared/contracts'
import { cloneValue } from '@shared/domain'
import { characterIdentityTuple, sameCharacterInstance } from './domain'

/** 归档消息的来源；决定「缺角色快照」是否可容忍。 */
export type ArchiveSource = 'replay' | 'rest' | 'snapshot'

export type ArchivedMessagesResult =
  | { ok: true; messages: Message[] }
  | { ok: false; reason: 'message.character' | 'message.conversation' }

export interface ArchiveAcceptanceContext {
  /** 角色能力当前是否开启。开启后归属是 fail-closed 的：拿不到合法身份就不许落地。 */
  profilesEnabled(): boolean
  /** 按会话 id 取会话绑定（`stores/session.ts` 的镜像查询） */
  bindingFor(conversationId: string): CharacterBindingSnapshot | undefined
}

/**
 * 单条归档消息的准入。
 *
 * 两种「没有快照」必须分开对待：
 *   · 本地持久化快照（`source === 'snapshot'`）可以早于角色归属能力落地，合法地缺
 *     `message.character` —— 保留它并用中性身份展示；
 *   · 远端 replay/REST 页不得凭空发明归属，缺一份合法身份即拒。
 *
 * 反过来，「有快照但畸形 / 跨角色实例」在三条来源里一律拒——包括快照来源。
 */
function acceptOne(
  context: ArchiveAcceptanceContext,
  message: Message,
  source: ArchiveSource
): Message | undefined {
  if (!context.profilesEnabled() || message.role !== 'assistant') return cloneValue(message)
  const binding = context.bindingFor(message.conversationId)
  const ref = message.character
  const tuple = ref ? characterIdentityTuple(ref) : undefined
  if (source === 'snapshot' && ref === undefined) return cloneValue(message)
  // 一个会话绑定稳定的角色实例，而其归档消息可以引用该实例用过的任意不可变内容版本。
  // 因此只拒跨角色/跨实例数据，合法的历史 revision 快照**原样保留**。
  if (!binding || !tuple || !sameCharacterInstance({ characterId: tuple[0], characterInstanceId: tuple[1] }, binding)) {
    return undefined
  }
  // 服务端给出的引用是权威事实。复制一份：REST/replay 的返回对象或其响应式代理都不得反过来改写表里的历史快照。
  return cloneValue(message)
}

/**
 * 一批归档消息的准入。
 *
 * 角色模式下**整批要么全收、要么全拒**：部分接受会在一页历史里静默少一条的同时仍然推进游标，
 * 那份缺口无法被任何后续路径发现。非角色模式（legacy 后端）保持既有的「跳过坏条、收下好条」。
 */
export function acceptArchivedMessages(
  context: ArchiveAcceptanceContext,
  messages: Message[],
  source: ArchiveSource
): ArchivedMessagesResult {
  const accepted: Message[] = []
  for (const message of messages) {
    const next = acceptOne(context, message, source)
    if (!next) {
      if (context.profilesEnabled()) return { ok: false, reason: 'message.character' }
      continue
    }
    accepted.push(next)
  }
  return { ok: true, messages: accepted }
}

/**
 * 消息自带的 `conversationId` 必须与会话信封一致。
 *
 * 判据是**双向**的：缺失/空串与「不一致」同样拒绝。此前只判后者，于是一条 `conversationId`
 * 为空的消息会被静默信封化（`loadPage` 把它过滤掉而游标照样前进）。这里改为显式协议错误。
 *
 * 注意：**绝不**用信封 id 改写消息自身的 `conversationId`——那会把一条属于别的会话的数据
 * 伪装成本会话的。
 */
export function validateMessageConversationIds(
  messages: Message[],
  envelopeConversationId: string
): ArchivedMessagesResult {
  for (const message of messages) {
    if (
      typeof message.conversationId !== 'string'
      || message.conversationId.length === 0
      || message.conversationId !== envelopeConversationId
    ) {
      return { ok: false, reason: 'message.conversation' }
    }
  }
  return { ok: true, messages: cloneValue(messages) }
}
