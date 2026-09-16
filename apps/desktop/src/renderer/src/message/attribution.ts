// renderer/src/message/attribution.ts
// 生成事件的**归属与栅栏判据**（design §4.2.1 / §4.2.2 / P2-2 / P2-5 / C4 / FE-E2）。
//
// 这是 `message.store.applyEvent` 里原先那一串 `if (...) { guardDropEvent(...); break }` 的判据本体。
// 之所以要把「判定」与「副作用」分开：判定是可以被穷举测试的（跨会话、跨连接世代、跨代、
// 重复 started、终态身份不符），而副作用（建 accumulator / 改消息状态 / 落缓存）必须留在 store。
//
// 关键不变量（全部在此处显式表达，不再散落在四个 case 分支里各写一遍）：
//   · `generation.started` 是**唯一**带 `conversationId` 的事件 ⇒ 会话归属在此登记；
//   · 中间事件（delta / segment.*）与终态都**没有** conversationId ⇒ 归属只能查登记表，查无即丢；
//   · 归属通过后还有一道**连接世代 + 会话**栅栏：`connected(A) → connected(B)` 中间没有观察到
//     断线状态，故不能只比会话 id；
//   · 同一 `generationId` 的重复 `started` 幂等（只补缺失的身份字段，绝不重建 accumulator）；
//   · 后一代 `started` 到达时上一代必须就地收成 interrupted 并注销，其迟到终态才碰不到新消息。
//
// 本模块不 import `vue` / `pinia` / 任何 store。
import type { CharacterGenerationRef } from '@shared/contracts'
import type { GenerationSessionIdentity } from './fencing'

/**
 * 一代的不可变角色身份快照（FE-E2：生成开始时捕获，目录编辑永不回写）。
 *
 * 有意**不含**传输世代：会话/连接栅栏由 `generationSessionById`（`GenerationSessionIdentity`）
 * 独立承担。早期版本把 `connectionEpoch`/`connectionSignature` 也拷进这里，但没有任何判据读它，
 * 于是同一事实出现第三份只写不读的副本——删掉比"留着备用"更安全。
 */
export interface GenerationIdentity {
  conversationId: string
  characterId: string
  characterInstanceId: string
  characterRevision: number
  /** 生成开始时捕获的快照；永不重新读目录。 */
  snapshot: CharacterGenerationRef
}

/**
 * 判定所需的全部状态：响应式容器与连接事实由 store 注入。
 *
 * 依赖一律写成「函数类型的属性」而非对象方法：本模块会把其中几个直接当谓词传给
 * `GenerationSessionRegistry`，方法签名会在脱离接收者时丢掉 `this` 语义（unbound-method），
 * 而这里的依赖本来就都是闭包，不存在 `this`。
 *
 * 字段**有意不加 `readonly`**：判定器按调用时刻读取的是注入方（store 的 getter / 测试假体）
 * 所反映的**当前**状态，只读修饰只会迫使调用方多写一层转发而不增加任何保证。
 */
export interface GenerationStore {
  generationByConversation: Record<string, string>
  generationSessionById: Record<string, GenerationSessionIdentity>
  generationIdentityById: Record<string, GenerationIdentity>
  activeGenerationId: string | undefined
  /** 当前活动 accumulator 的 generationId（无 accumulator ⇒ undefined）。 */
  accumulatorGenerationId: string | undefined
  accumulatorMessageId: string | undefined
  /** 当前会话身份（会话 id + 连接世代）。 */
  currentSession: () => GenerationSessionIdentity
  /**
   * 当前会话是否仍等于捕获时的会话身份。
   *
   * store 注入的是 `message/fencing.ts` 的 `generationSessionMatches`（捕获 vs 当前三字段相等），
   * 此处只把它当谓词用，不再叠加任何本模块自有的台账。
   */
  sessionIsCurrent: (session: GenerationSessionIdentity) => boolean
  /** 角色能力是否开启（开启后归属 fail-closed）。 */
  profilesEnabled: () => boolean
  /** 生成开始时从会话绑定捕获身份；不满足条件 ⇒ undefined。 */
  identityForStarted: (event: GenerationEvent) => GenerationIdentity | undefined
  /** 终态事件的身份是否与开始时捕获的元组一致。 */
  terminalIdentityMatches: (event: GenerationEvent, identity: GenerationIdentity) => boolean
}

/** 带 generationId 的事件（会话/连接类事件没有）。 */
export interface GenerationEvent {
  generationId: string
  conversationId?: string
  messageId?: string
  characterId?: string
  characterInstanceId?: string
  characterRevision?: number
}

export type GenerationEventKind = 'started' | 'progress' | 'terminal'

/** 一代开始时的三种归属结果（幂等补身份 / 建立新代 / 取代上一代）。 */
export type GenerationStartedReady =
  | { verdict: 'ready'; kind: 'startedEstablish'; generationId: string; conversationId: string; messageId: string }
  | { verdict: 'ready'; kind: 'startedDuplicate'; generationId: string; messageId: string | undefined }
  | {
      verdict: 'ready'
      kind: 'startedSupersede'
      generationId: string
      conversationId: string
      messageId: string
      previousGenerationId: string
      previousMessageId: string | undefined
    }

/** 中间事件（delta / segment.*）的通过结果。 */
export type GenerationProgressReady = { verdict: 'ready'; kind: 'progress'; generationId: string; messageId: string }

/** 终态事件（completed / failed）的通过结果。 */
export type GenerationTerminalReady = { verdict: 'ready'; kind: 'terminal'; generationId: string; messageId: string }

export type GenerationReady = GenerationStartedReady | GenerationProgressReady | GenerationTerminalReady

/** 统一判定结果的三个出口：丢弃 / 身份不符（协议故障）/ 通过。 */
export type AttributeFailure =
  | { verdict: 'drop'; reason: string }
  | { verdict: 'identityMismatch'; generationId: string; messageId: string | undefined }

export type AttributeDecision = AttributeFailure | GenerationReady

const DROP_SESSION = 'session'
const DROP_UNKNOWN = 'unknown-generation'
const DROP_STALE = 'stale-generation'
const DROP_CHARACTER_STARTED = 'generation.started.character'

export function createGenerationAttribution(store: GenerationStore) {
  /**
   * 事件是否归属于**当前**会话与传输世代。
   *
   * 两条判据都必须成立，且两条都只读 store 唯一的那份状态（`generationByConversation` 与
   * `generationSessionById`）——本模块**不另存**一份身份台账，否则换连接世代/切会话时两处
   * 就会各自被清一次（或漏清一次），「这一代属于谁」出现两个可分别编辑的答案。
   */
  function belongsToCurrentSession(generationId: string): boolean {
    if (store.generationByConversation[generationId] !== store.currentSession().conversationId) return false
    const captured = store.generationSessionById[generationId]
    return captured !== undefined && store.sessionIsCurrent(captured)
  }

  function attributeStarted(event: GenerationEvent): AttributeDecision {
    // 归属守卫：started 校验 conversationId，防 A 的 started 迟到到 B 时覆盖 B 的 accumulator。
    // 空/非字符串同样拒绝——`currentSession().conversationId` 在无活动会话时归一到空串，
    // 若只比相等，一条 `conversationId: ''` 的事件会在「没有会话」时被当成归属成立，
    // 进而置位 activeGenerationId（锁住输入区）。传输层有 schema 兜底，这里是渲染层自己的守卫。
    if (typeof event.conversationId !== 'string' || event.conversationId.length === 0) {
      return { verdict: 'drop', reason: 'generation.started' }
    }
    if (event.conversationId !== store.currentSession().conversationId) return { verdict: 'drop', reason: 'generation.started' }

    const characterIdentity = store.profilesEnabled() ? store.identityForStarted(event) : undefined
    if (store.profilesEnabled() && !characterIdentity) {
      // 能力开启后归属是 fail-closed 的：拿不到完整身份，或与会话绑定不符，
      // 都不得创建一条日后可能被归到别的角色名下的消息。
      return { verdict: 'drop', reason: DROP_CHARACTER_STARTED }
    }

    // C4：同一 generationId 的**重复** started（后端重发 / 将来若引入在途回放 / 双通道投递）
    // 必须幂等——重建 accumulator 会清空已渲染的 assistantSegments 并覆盖 usage/model，
    // 违反「一代 = 一条 assistant 消息 + 有序分段」。
    if (store.activeGenerationId === event.generationId) {
      return {
        verdict: 'ready',
        kind: 'startedDuplicate',
        generationId: event.generationId,
        messageId: store.accumulatorMessageId ?? event.messageId
      }
    }

    const previousGenerationId = store.activeGenerationId
    if (previousGenerationId && previousGenerationId !== event.generationId) {
      // Renderer 只有一个 accumulator。后端在上一代终结前起了新一代时，必须就地关掉本地旧流
      // 并注销其身份映射，否则旧代的迟到终态仍能保留状态或碰到新消息。
      return {
        verdict: 'ready',
        kind: 'startedSupersede',
        generationId: event.generationId,
        conversationId: event.conversationId,
        messageId: event.messageId ?? '',
        previousGenerationId,
        previousMessageId: store.accumulatorMessageId
      }
    }

    return {
      verdict: 'ready',
      kind: 'startedEstablish',
      generationId: event.generationId,
      conversationId: event.conversationId,
      messageId: event.messageId ?? ''
    }
  }

  /**
   * 归属与栅栏判定。
   *
   * 三条互不重叠的路径（started / 中间事件 / 终态）各自返回自己的判别式类型，故调用方
   * switch 之后拿到的是**精确的**分支——不存在"判定说 ready 但字段不在这条分支上"的形态。
   */
  function attribute(event: GenerationEvent, kind: 'started'): GenerationStartedReady | AttributeFailure
  function attribute(event: GenerationEvent, kind: 'progress'): GenerationProgressReady | AttributeFailure
  function attribute(event: GenerationEvent, kind: 'terminal'): GenerationTerminalReady | AttributeFailure
  function attribute(event: GenerationEvent, kind: GenerationEventKind): AttributeDecision
  function attribute(event: GenerationEvent, kind: GenerationEventKind): AttributeDecision {
    if (kind === 'started') return attributeStarted(event)

    if (!belongsToCurrentSession(event.generationId)) return { verdict: 'drop', reason: DROP_SESSION }
    // 跨代/迟到事件：accumulator 已换人或查无 ⇒ 丢弃（P2-2）。
    if (store.accumulatorGenerationId !== event.generationId) return { verdict: 'drop', reason: DROP_UNKNOWN }

    // 终态身份校验**先于**「这一代是否还是活动代」：顺序承重（与重构前的
    // `identity && !terminalIdentityMatches → failGenerationProtocol` 分支逐字一致）。
    // 反过来的话，「cancel 已清 activeGenerationId、而 accumulator 仍在」那条窄路径上，
    // 身份不符会被当成普通迟到事件静默丢弃，`CHARACTER_GENERATION_PROTOCOL_MISMATCH`
    // 横幅就再也不会出现——那正是协议漂移最需要被看见的时刻。
    if (kind === 'terminal') {
      const identity = store.generationIdentityById[event.generationId]
      if (identity && !store.terminalIdentityMatches(event, identity)) {
        // 身份不符是**协议故障**，不是可重试的流：保留已收到的分段供诊断，但必须释放活动代
        // 与全部映射，否则输入区会被永久锁在「生成中」。
        return { verdict: 'identityMismatch', generationId: event.generationId, messageId: store.accumulatorMessageId ?? event.messageId }
      }
    }

    // cancel / 断线 / 换连接已清 activeGenerationId，而同代迟到事件仍能查到 accumulator：
    // 这些必须丢弃，否则会把已经置为 interrupted 的消息改回流式或 completed（P2-5）。
    if (store.activeGenerationId !== event.generationId) return { verdict: 'drop', reason: DROP_STALE }

    if (kind === 'progress') {
      return { verdict: 'ready', kind: 'progress', generationId: event.generationId, messageId: store.accumulatorMessageId ?? '' }
    }
    return { verdict: 'ready', kind: 'terminal', generationId: event.generationId, messageId: store.accumulatorMessageId ?? '' }
  }

  return { attribute }
}
