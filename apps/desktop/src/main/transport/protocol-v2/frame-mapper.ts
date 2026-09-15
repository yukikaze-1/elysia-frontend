import type { BackendEvent, CharacterCatalogChangedEvent, CharacterEventIdentity, CharacterStateChangedEvent, ExpressionEvent, Live2DDirectiveEvent, ToolRequestEvent, ToolStartedEvent, ToolCompletedEvent } from '@shared/contracts/events'
import type { CharacterPublicStateView } from '@shared/contracts/character'
import type { ConversationTokenUsage, TokenUsage } from '@shared/contracts/message'
import type { ProtocolWarning } from '@shared/contracts/protocol'
import { ProtocolWarningCode } from '@shared/contracts/protocol'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import { redactToolArguments } from '../../tools/input-summary'
import type {
  RawFrame, RawGenerationCompleted, RawGenerationFailed,
  RawSegmentChannel, RawSegmentKind, RawTokenUsage, RawConversationUsage
} from './raw-types'
import { mapRawTokenStats, mapRawTokenUsage } from './token-usage'

export interface FrameMapperOptions {
  connectionId?: string
  activeConversationId?: string
  onProtocolWarning?: (warning: ProtocolWarning) => void
}

/** segment 元数据缓存(从 segment.started 建立;channel 用 raw 三值以便 status 过滤) */
interface SegmentMeta {
  generationId: string
  segmentIndex: number
  channel: RawSegmentChannel
  kind: RawSegmentKind
}

/**
 * C8（2026-09-15 契约评审）：`segmentMeta` 此前**只以 `segmentId` 为键**，跨代不校验、终态也不清理。
 * 后果两条：① 若两代复用同一 `segmentId`（或某代中途 failed 留下陈旧条目），后续 delta 会被**静默**
 * 按上一代的 `channel/kind/segmentIndex` 归位——连 UI 通道都可能错；② 已终态的条目永不释放，
 * 单连接内缓慢增长。
 *
 * 现在键含代（`generationId\0segmentId`）：跨代查找自然落空（delta 走既有的 PROTOCOL_MISMATCH 分支，
 * 整帧丢弃 + warn，而不是错归因），且终态帧按代回收全部条目。
 */
const segmentKey = (generationId: string, segmentId: string): string => `${generationId}\u0000${segmentId}`

export class FrameMapper {
  private nextSequence = 1
  private segmentMeta = new Map<string, SegmentMeta>()
  /**
   * C7（2026-09-15 契约评审）：每代**实际出现过的** `segmentIndex` 集合。
   * 停在这里而不是在 Renderer 判缺口，是因为 mapper 看得到全部 `generation.segment.started`
   * ——**包括 channel=status 的段**（它们不进事件流，若在 Renderer 判会天然"跳号"而误报）。
   * 终态时若 `max-min+1 !== 个数`，说明中间有段从未到达 ⇒ 整段丢失，标 `segmentGap`。
   */
  private segmentIndexesByGeneration = new Map<string, Set<number>>()
  /** audio_start 建立的身份表；audio_end/cancel wire 无需重复身份，transport 通过此表续接。 */
  private audioIdentityByStream = new Map<number, CharacterEventIdentity>()
  private activeConversationId?: string
  private readonly connectionId: string
  private readonly onProtocolWarning: (warning: ProtocolWarning) => void

  constructor(options: FrameMapperOptions = {}) {
    this.connectionId = options.connectionId ?? 'local'
    this.activeConversationId = options.activeConversationId
    this.onProtocolWarning = options.onProtocolWarning ?? (() => {})
  }

  setActiveConversationId(id: string | undefined): void {
    this.activeConversationId = id
  }

  /** audio 已 ready/丢弃后释放身份表项。 */
  clearAudioIdentity(streamId: number): void {
    this.audioIdentityByStream.delete(streamId)
  }

  /** 生成一帧领域事件;非 generation 帧与 status 段返回 null(不告警) */
  mapFrame(frame: RawFrame): BackendEvent | null {
    switch (frame.type) {
      case 'generation.started':
        return this.mapStarted(frame)
      case 'generation.segment.started':
        return this.mapSegmentStarted(frame)
      case 'generation.delta':
        return this.mapDelta(frame)
      case 'generation.segment.completed':
        return this.mapSegmentCompleted(frame)
      case 'generation.completed':
        return this.mapCompleted(frame)
      case 'generation.failed':
        return this.mapFailed(frame)
      case 'expression':
        // 握手旧 expression 没有角色身份，保持既有“忽略握手帧”语义；带身份的新表现帧才进入领域事件。
        return this.hasCharacterEventIdentity(frame) ? this.mapExpression(frame) : null
      case 'switch_model_result':
        // 模型 Profile 激活结果（D-A14：ok 必填；error 为 "<CODE>: <msg>" 前缀串，由连接层解析）
        return { ...this.envelope(), event: 'switch_model.result', service: frame.service, model: frame.model, ok: frame.ok, ...(frame.error ? { error: frame.error } : {}) }
      case 'set_tts_voice_result':
        // TTS 声音切换结果（同 D-A14：ok 必填，voice/error 可选）
        return { ...this.envelope(), event: 'set_tts_voice.result', ok: frame.ok, ...(frame.error ? { error: frame.error } : {}), ...(frame.voice ? { voice: frame.voice } : {}) }
      // —— 阶段 4 批次 B：三种语音（BE-060/061/062）——
      case 'voice.transcript':
        return { ...this.envelope(), event: 'voice.transcript', recordingId: frame.recordingId, text: frame.text, ...(frame.emotion ? { emotion: frame.emotion } : {}) }
      case 'voice_session.started':
        return { ...this.envelope(), event: 'voice_session.started', sessionId: frame.sessionId, ...(frame.conversationId ? { conversationId: frame.conversationId } : {}) }
      case 'voice_session.partial':
        return { ...this.envelope(), event: 'voice_session.partial', sessionId: frame.sessionId, turnId: frame.turnId, segmentIndex: frame.segmentIndex, text: frame.text }
      case 'voice_session.turn':
        return { ...this.envelope(), event: 'voice_session.turn', sessionId: frame.sessionId, turnId: frame.turnId, messageId: frame.messageId, ...(frame.conversationId ? { conversationId: frame.conversationId } : {}), text: frame.text }
      case 'voice_session.ack':
        return { ...this.envelope(), event: 'voice_session.ack', sessionId: frame.sessionId, seq: frame.seq }
      case 'voice_session.ended':
        return { ...this.envelope(), event: 'voice_session.ended', sessionId: frame.sessionId, reason: frame.reason }
      case 'dictation.partial':
        return { ...this.envelope(), event: 'dictation.partial', text: frame.text }
      case 'dictation.final':
        return { ...this.envelope(), event: 'dictation.final', clientRequestId: frame.clientRequestId, text: frame.text }
      case 'dictation.cancelled':
        return { ...this.envelope(), event: 'dictation.cancelled', clientRequestId: frame.clientRequestId }
      // —— TTS 播放控制（BE-063）——
      case 'audio_start':
        return this.mapAudioStarted(frame)
      case 'audio_cancelled': {
        const identity = this.audioIdentityByStream.get(frame.stream_id)
        this.audioIdentityByStream.delete(frame.stream_id)
        return { ...this.envelope(), event: 'audio.session.cancelled', streamId: frame.stream_id, ...(identity ?? {}) }
      }
      case 'audio':
      case 'audio_end':
        return null // 音频二进制由 transport（real-backend TTS 缓冲）消费，不进 mapper（D-P9）
      // —— 阶段 5 批次 C（C3）：后端 Live2D 表现指令建议 ——
      case 'live2d.directive':
        return this.mapDirective(frame)
      // —— 阶段 6 批次 A（F-6-04）：工具双轨（D6-01~08）——
      case 'tool.request':
        return this.mapToolRequest(frame)
      case 'tool.started':
        return this.mapToolStarted(frame)
      case 'tool.completed':
        return this.mapToolCompleted(frame)
      // —— 多角色 FE-A（§7.1）：角色状态/目录变更 ——
      case 'character.state.changed':
        return this.mapCharacterStateChanged(frame)
      case 'character.catalog.changed':
        return {
          ...this.envelope(),
          event: 'character.catalog.changed',
          characterId: frame.characterId,
          currentRevision: frame.currentRevision,
          status: frame.status,
          updatedAt: frame.updatedAt
        } satisfies CharacterCatalogChangedEvent
      case 'action':
        return null // 已知忽略（D6A-03：v2 已停发，不告警、不作工具状态源）
      default:
        return null // 握手等帧由连接层分流（工具/音频帧已由显式 case 处理）
    }
  }

  /**
   * 用同一私有单调计数器打 eventId/sequence 构造完整事件（transport 构造 audio.session.ready / voice.error 用；
   * 与 mapFrame 共享 nextSequence 不碰撞、sequence 全局严格递增）。partial 已含 event/其余字段，缺 eventId/sequence。
   */
  stampEvent<T extends BackendEvent>(partial: Omit<T, 'eventId' | 'sequence'>): T {
    // RealBackend assembles audio.session.ready after consuming audio_end rather
    // than passing a raw frame through mapFrame. Continue the identity captured
    // by audio_start across that pure assembly boundary, then release it.
    if ((partial as { event?: string }).event === 'audio.session.ready' ||
      (partial as { event?: string }).event === 'audio.session.cancelled') {
      const streamId = (partial as { streamId?: unknown }).streamId
      if (typeof streamId === 'number') {
        const identity = this.audioIdentityByStream.get(streamId)
        this.audioIdentityByStream.delete(streamId)
        return { ...this.envelope(), ...partial, ...(identity ?? {}) } as T
      }
    }
    return { ...this.envelope(), ...partial } as T
  }

  private envelope(): { eventId: string; sequence: number } {
    const sequence = this.nextSequence++
    return { eventId: `${this.connectionId}:${sequence}`, sequence }
  }

  /** conversationId 补齐:帧值优先,否则活动会话;都无法 → PROTOCOL_MISMATCH */
  private resolveConversationId(frameConversationId?: string): string {
    const id = frameConversationId ?? this.activeConversationId
    if (!id) {
      throw new CyreneError(CyreneErrorCode.PROTOCOL_MISMATCH, 'generation 帧缺 conversationId 且无活动会话可补齐')
    }
    return id
  }

  private mapStarted(frame: Extract<RawFrame, { type: 'generation.started' }>): BackendEvent {
    return {
      ...this.envelope(),
      event: 'generation.started',
      generationId: frame.generationId,
      messageId: frame.messageId,
      responseId: frame.generationId,
      conversationId: this.resolveConversationId(frame.conversationId),
      ...(frame.model ? { model: frame.model } : {}),
      ...this.characterIdentity(frame)
    }
  }

  private mapSegmentStarted(frame: Extract<RawFrame, { type: 'generation.segment.started' }>): BackendEvent | null {
    this.segmentMeta.set(segmentKey(frame.generationId, frame.segmentId), { generationId: frame.generationId, segmentIndex: frame.segmentIndex, channel: frame.channel, kind: frame.kind })
    const seen = this.segmentIndexesByGeneration.get(frame.generationId) ?? new Set<number>()
    seen.add(frame.segmentIndex)
    this.segmentIndexesByGeneration.set(frame.generationId, seen)
    if (frame.channel === 'status') return null
    return {
      ...this.envelope(),
      event: 'generation.segment.started',
      generationId: frame.generationId,
      segmentId: frame.segmentId,
      segmentIndex: frame.segmentIndex,
      channel: frame.channel,
      kind: frame.kind
    }
  }

  private mapDelta(frame: Extract<RawFrame, { type: 'generation.delta' }>): BackendEvent | null {
    const meta = this.segmentMeta.get(segmentKey(frame.generationId, frame.segmentId))
    if (!meta) {
      throw new CyreneError(CyreneErrorCode.PROTOCOL_MISMATCH, `delta 帧找不到 segment meta: ${frame.segmentId}`)
    }
    if (meta.channel === 'status') return null
    if (meta.segmentIndex !== frame.segmentIndex) {
      this.onProtocolWarning({
        code: ProtocolWarningCode.MAPPER_SEGMENT_INDEX_MISMATCH,
        message: `segment ${frame.segmentId} delta 的 segmentIndex ${frame.segmentIndex} 与 started 元数据 ${meta.segmentIndex} 不一致，以 started 为准`
      })
    }
    return {
      ...this.envelope(),
      event: 'generation.delta',
      generationId: frame.generationId,
      segmentId: frame.segmentId,
      segmentIndex: meta.segmentIndex,
      channel: meta.channel,
      kind: meta.kind,
      deltaSequence: frame.deltaSequence,
      text: frame.delta
    }
  }

  private mapSegmentCompleted(frame: Extract<RawFrame, { type: 'generation.segment.completed' }>): BackendEvent | null {
    const meta = this.segmentMeta.get(segmentKey(frame.generationId, frame.segmentId))
    const channel = meta?.channel ?? frame.channel
    if (channel === 'status') {
      return null // 保留 status meta(供其迟到 delta 过滤返回 null,不抛 PROTOCOL_MISMATCH)
    }
    const kind = meta?.kind ?? frame.kind
    const segmentIndex = meta?.segmentIndex ?? frame.segmentIndex
    const event: BackendEvent = {
      ...this.envelope(),
      event: 'generation.segment.completed',
      generationId: frame.generationId,
      segmentId: frame.segmentId,
      segmentIndex,
      channel: channel,
      kind: kind,
      ...(frame.content !== undefined ? { content: frame.content } : {})
    }
    this.segmentMeta.delete(segmentKey(frame.generationId, frame.segmentId)) // 普通段映射结束后清理(docs/18 §8.4)
    return event
  }

  private mapCompleted(frame: RawGenerationCompleted): BackendEvent {
    if (frame.completeness !== undefined && frame.completeness !== 'complete') {
      this.onProtocolWarning({
        code: ProtocolWarningCode.MAPPER_UNEXPECTED_COMPLETENESS,
        message: `generation ${frame.generationId} completeness 异常: ${frame.completeness}`
      })
    }
    this.releaseGeneration(frame.generationId)
    const segmentGap = this.detectSegmentGap(frame.generationId)
    return {
      ...this.envelope(),
      event: 'generation.completed',
      generationId: frame.generationId,
      messageId: frame.messageId,
      responseId: frame.generationId,
      usage: this.mapUsage(frame.usage),
      ...(frame.conversationUsage ? { conversationUsage: this.mapConversationUsage(frame.conversationUsage) } : {}),
      model: frame.model,
      ...(frame.mood ? { emotion: frame.mood } : {}),
      ...(frame.finishReason ? { finishReason: frame.finishReason } : {}),
      ...(segmentGap ? { segmentGap: true } : {}),
      ...this.characterIdentity(frame)
    }
  }

  /**
   * C7：整段缺失判定。**只在「有正向证据」时报**：出现了索引 k 与某个 > k+1 的索引，
   * 而 k+1..max 之间存在从未出现的索引 ⇒ 中间确有段没到。一代只出现过一个段（或一个都没有）时不报。
   */
  private detectSegmentGap(generationId: string): boolean {
    const seen = this.segmentIndexesByGeneration.get(generationId)
    this.segmentIndexesByGeneration.delete(generationId)
    if (!seen || seen.size === 0) return false
    const indexes = [...seen]
    const min = Math.min(...indexes)
    const max = Math.max(...indexes)
    const gap = indexes.length !== max - min + 1
    if (gap) {
      this.onProtocolWarning({
        code: ProtocolWarningCode.MAPPER_SEGMENT_GAP,
        message: `generation ${generationId} 的分段索引不连续（收到 ${indexes.length} 个，区间 ${min}..${max}）⇒ 有整段未到达，已标记「可能不完整」`
      })
    }
    return gap
  }

  private mapFailed(frame: RawGenerationFailed): BackendEvent {
    this.releaseGeneration(frame.generationId) // C8：终态回收该代全部 segment meta（此前的无界增长点）
    return {
      ...this.envelope(),
      event: 'generation.failed',
      generationId: frame.generationId,
      ...(frame.messageId ? { messageId: frame.messageId } : {}),
      error: {
        code: frame.code,
        message: frame.message,
        ...(frame.retryable !== undefined ? { retryable: frame.retryable } : {}),
        ...(frame.details !== undefined ? { details: frame.details } : {}) // 空 dict 也保留(details 恒上 wire)
      },
      ...this.characterIdentity(frame)
    }
  }

  /** C8：终态时回收该代全部 segment meta（键含 generationId，故按前缀精确匹配） */
  private releaseGeneration(generationId: string): void {
    const prefix = `${generationId}\u0000`
    for (const key of this.segmentMeta.keys()) {
      if (key.startsWith(prefix)) this.segmentMeta.delete(key)
    }
  }

  /** generation 角色身份透传（CHAR-FE-08；undefined 不写键，迁移期 optional） */
  private characterIdentity(frame: { characterId?: string; characterInstanceId?: string; characterRevision?: number }) {    return {
      ...(frame.characterId !== undefined ? { characterId: frame.characterId } : {}),
      ...(frame.characterInstanceId !== undefined ? { characterInstanceId: frame.characterInstanceId } : {}),
      ...(frame.characterRevision !== undefined ? { characterRevision: frame.characterRevision } : {})
    }
  }

  private characterEventIdentity(frame: {
    conversationId?: string
    generationId?: string
    characterId?: string
    characterInstanceId?: string
    characterRevision?: number
  }): CharacterEventIdentity {
    return {
      ...(frame.conversationId !== undefined ? { conversationId: frame.conversationId } : {}),
      ...(frame.generationId !== undefined ? { generationId: frame.generationId } : {}),
      ...(frame.characterId !== undefined ? { characterId: frame.characterId } : {}),
      ...(frame.characterInstanceId !== undefined ? { characterInstanceId: frame.characterInstanceId } : {}),
      ...(frame.characterRevision !== undefined ? { characterRevision: frame.characterRevision } : {})
    }
  }

  private hasCharacterEventIdentity(frame: {
    conversationId?: string
    generationId?: string
    characterId?: string
    characterInstanceId?: string
    characterRevision?: number
  }): boolean {
    return frame.conversationId !== undefined || frame.generationId !== undefined ||
      frame.characterId !== undefined || frame.characterInstanceId !== undefined || frame.characterRevision !== undefined
  }

  private mapExpression(frame: Extract<RawFrame, { type: 'expression' }>): ExpressionEvent {
    return {
      ...this.envelope(),
      event: 'expression',
      expression: frame.expression,
      ...(frame.intensity !== undefined ? { intensity: frame.intensity } : {}),
      ...this.characterEventIdentity(frame)
    }
  }

  private mapAudioStarted(frame: Extract<RawFrame, { type: 'audio_start' }>): BackendEvent {
    const identity = this.characterEventIdentity(frame)
    // 同 stream_id 重开必须覆盖旧身份；没有身份的新 legacy 流不能继承旧角色。
    if (Object.keys(identity).length > 0) this.audioIdentityByStream.set(frame.stream_id, identity)
    else this.audioIdentityByStream.delete(frame.stream_id)
    return {
      ...this.envelope(),
      event: 'audio.session.started',
      streamId: frame.stream_id,
      format: frame.format,
      ...identity
    }
  }

  /** character.state.changed raw 帧 → 领域事件（state 完整 view；raw mood 必填非 null，其他 null 归一 undefined） */
  private mapCharacterStateChanged(frame: Extract<RawFrame, { type: 'character.state.changed' }>): CharacterStateChangedEvent {
    const view: CharacterPublicStateView = {
      ...(frame.state.mood ? { mood: { label: frame.state.mood.label, intensity: frame.state.mood.intensity, updatedAt: frame.state.mood.updatedAt } } : {}),
      ...(frame.state.currentActivity != null ? { currentActivity: frame.state.currentActivity } : {}),
      ...(frame.state.lastInteractionAt != null ? { lastInteractionAt: frame.state.lastInteractionAt } : {}),
      proactiveEnabled: frame.state.proactiveEnabled,
      updatedAt: frame.state.updatedAt
    }
    return {
      ...this.envelope(),
      event: 'character.state.changed',
      conversationId: frame.conversationId,
      characterId: frame.characterId,
      characterInstanceId: frame.characterInstanceId,
      characterRevision: frame.characterRevision,
      stateVersion: frame.stateVersion,
      state: view
    }
  }

  /** live2d.directive raw 帧 → 扁平领域事件（this.envelope() 打 eventId/sequence；undefined 不写键） */
  private mapDirective(frame: Extract<RawFrame, { type: 'live2d.directive' }>): Live2DDirectiveEvent {
    return {
      ...this.envelope(),
      event: 'live2d.directive',
      ...(frame.expression !== undefined ? { expression: frame.expression } : {}),
      ...(frame.motion !== undefined ? { motion: frame.motion } : {}),
      ...(frame.state !== undefined ? { state: frame.state } : {}),
      ...(frame.priority !== undefined ? { priority: frame.priority } : {}),
      ...(frame.durationMs !== undefined ? { durationMs: frame.durationMs } : {}),
      ...this.characterEventIdentity(frame)
    }
  }

  /** tool.request raw 帧 → 脱敏公开事件（原始 arguments/安全元数据永不进 Renderer，D6-07；toolVersion/expiresAt 必填直映） */
  private mapToolRequest(frame: Extract<RawFrame, { type: 'tool.request' }>): ToolRequestEvent {
    const inputSummary = redactToolArguments(frame.arguments)
    return {
      ...this.envelope(),
      event: 'tool.request',
      callId: frame.callId,
      sourceCallId: frame.sourceCallId,
      toolName: frame.toolName,
      toolVersion: frame.toolVersion,
      runtime: frame.runtime,
      ...(frame.reason !== undefined ? { reason: frame.reason } : {}),
      ...(inputSummary !== undefined ? { inputSummary } : {}),
      expiresAt: frame.expiresAt,
      ...(frame.requestId !== undefined ? { requestId: frame.requestId } : {}),
      // D4-1（2026-09-15）：风险元数据直映（仅 Main 消费；重算与审计用，不随 PublicToolEvent 下发 Renderer）
      ...(frame.riskLevel !== undefined ? { riskLevel: frame.riskLevel } : {}),
      ...(frame.permissionRequired !== undefined ? { permissionRequired: frame.permissionRequired } : {}),
      ...(frame.approvalAuthority !== undefined ? { approvalAuthority: frame.approvalAuthority } : {})
    }
  }

  /** tool.started → ToolStartedEvent（直映） */
  private mapToolStarted(frame: Extract<RawFrame, { type: 'tool.started' }>): ToolStartedEvent {
    return {
      ...this.envelope(),
      event: 'tool.started',
      callId: frame.callId,
      toolName: frame.toolName,
      runtime: frame.runtime,
      ...(frame.inputSummary !== undefined ? { inputSummary: frame.inputSummary } : {}),
      ...(frame.generationId !== undefined ? { generationId: frame.generationId } : {}),
      ...(frame.conversationId !== undefined ? { conversationId: frame.conversationId } : {})
    }
  }

  /** tool.completed → ToolCompletedEvent（error record 只提取已知键 code/message） */
  private mapToolCompleted(frame: Extract<RawFrame, { type: 'tool.completed' }>): ToolCompletedEvent {
    const err = frame.error
    return {
      ...this.envelope(),
      event: 'tool.completed',
      callId: frame.callId,
      toolName: frame.toolName,
      runtime: frame.runtime,
      success: frame.success,
      ...(frame.outputSummary !== undefined ? { outputSummary: frame.outputSummary } : {}),
      ...(err !== undefined ? { error: { ...(typeof err.code === 'string' ? { code: err.code } : {}), ...(typeof err.message === 'string' ? { message: err.message } : {}) } } : {}),
      ...(frame.errorType !== undefined ? { errorType: frame.errorType } : {}),
      ...(frame.durationMs !== undefined ? { durationMs: frame.durationMs } : {}),
      ...(frame.truncated !== undefined ? { truncated: frame.truncated } : {}),
      ...(frame.generationId !== undefined ? { generationId: frame.generationId } : {}),
      ...(frame.conversationId !== undefined ? { conversationId: frame.conversationId } : {})
    }
  }

  /**
   * C2（2026-09-15 契约评审）：映射逻辑已抽到 `token-usage.ts` —— 同一份 wire 形状在**回放**两条路径上
   * （WS `session` 的 `SessionMessageItem.token_usage`、REST 归档 `Message.token_usage`）此前整段丢弃。
   * 此处只保留"实时帧"的告警接线，映射语义不变。
   */
  private mapUsage(raw: RawTokenUsage): TokenUsage {
    return mapRawTokenUsage(raw, ({ sumTotal, turnTotal }) => {
      this.onProtocolWarning({
        code: ProtocolWarningCode.MAPPER_TOKEN_SUM_MISMATCH,
        message: `usage Σtotal_tokens(${sumTotal}) !== turn_total(${turnTotal}),保留服务端 turn_total`
      })
    })
  }

  /**
   * 会话级累计同样只留一个映射点（`token-usage.ts`）——`session.token_stats` 与
   * `generation.completed.conversationUsage` 是同一形状的一种事实，两条路径必须给出同样的领域对象。
   */
  private mapConversationUsage(raw: RawConversationUsage): ConversationTokenUsage {
    return mapRawTokenStats(raw)
  }
}
