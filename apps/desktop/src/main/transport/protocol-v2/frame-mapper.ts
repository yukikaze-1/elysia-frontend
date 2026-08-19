import type { BackendEvent, Live2DDirectiveEvent, ToolRequestEvent, ToolStartedEvent, ToolCompletedEvent } from '@shared/contracts/events'
import type { ConversationTokenUsage, SegmentChannel, SegmentKind, TokenUsage } from '@shared/contracts/message'
import type { ProtocolWarning } from '@shared/contracts/protocol'
import { ProtocolWarningCode } from '@shared/contracts/protocol'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import { redactToolArguments } from '../../tools/input-summary'
import type {
  RawFrame, RawGenerationCompleted, RawGenerationFailed,
  RawSegmentChannel, RawSegmentKind, RawTokenUsage, RawConversationUsage
} from './raw-types'

export interface FrameMapperOptions {
  connectionId?: string
  activeConversationId?: string
  onProtocolWarning?: (warning: ProtocolWarning) => void
}

/** segment 元数据缓存(从 segment.started 建立;channel 用 raw 三值以便 status 过滤) */
interface SegmentMeta {
  segmentIndex: number
  channel: RawSegmentChannel
  kind: RawSegmentKind
}

export class FrameMapper {
  private nextSequence = 1
  private segmentMeta = new Map<string, SegmentMeta>()
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
        return { ...this.envelope(), event: 'audio.session.started', streamId: frame.stream_id, format: frame.format }
      case 'audio_cancelled':
        return { ...this.envelope(), event: 'audio.session.cancelled', streamId: frame.stream_id }
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
      ...(frame.model ? { model: frame.model } : {})
    }
  }

  private mapSegmentStarted(frame: Extract<RawFrame, { type: 'generation.segment.started' }>): BackendEvent | null {
    this.segmentMeta.set(frame.segmentId, { segmentIndex: frame.segmentIndex, channel: frame.channel, kind: frame.kind })
    if (frame.channel === 'status') return null
    return {
      ...this.envelope(),
      event: 'generation.segment.started',
      generationId: frame.generationId,
      segmentId: frame.segmentId,
      segmentIndex: frame.segmentIndex,
      channel: frame.channel as SegmentChannel,
      kind: frame.kind as SegmentKind
    }
  }

  private mapDelta(frame: Extract<RawFrame, { type: 'generation.delta' }>): BackendEvent | null {
    const meta = this.segmentMeta.get(frame.segmentId)
    if (!meta) {
      throw new CyreneError(CyreneErrorCode.PROTOCOL_MISMATCH, `delta 帧找不到 segment meta: ${frame.segmentId}`)
    }
    if (meta.channel === 'status') return null
    if (meta.segmentIndex !== frame.segmentIndex) {
      this.onProtocolWarning({
        code: ProtocolWarningCode.MAPPER_SEGMENT_INDEX_MISMATCH,
        message: `segment ${frame.segmentId} delta 的 segmentIndex ${frame.segmentIndex} 与 started 元数据 ${meta.segmentIndex} 不一致,以 started 为准`
      })
    }
    return {
      ...this.envelope(),
      event: 'generation.delta',
      generationId: frame.generationId,
      segmentId: frame.segmentId,
      segmentIndex: meta.segmentIndex,
      channel: meta.channel as SegmentChannel,
      kind: meta.kind as SegmentKind,
      deltaSequence: frame.deltaSequence,
      text: frame.delta
    }
  }

  private mapSegmentCompleted(frame: Extract<RawFrame, { type: 'generation.segment.completed' }>): BackendEvent | null {
    const meta = this.segmentMeta.get(frame.segmentId)
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
      channel: channel as SegmentChannel,
      kind: kind as SegmentKind,
      ...(frame.content !== undefined ? { content: frame.content } : {})
    }
    this.segmentMeta.delete(frame.segmentId) // 普通段映射结束后清理(docs/18 §8.4)
    return event
  }

  private mapCompleted(frame: RawGenerationCompleted): BackendEvent {
    if (frame.completeness !== undefined && frame.completeness !== 'complete') {
      this.onProtocolWarning({
        code: ProtocolWarningCode.MAPPER_UNEXPECTED_COMPLETENESS,
        message: `generation ${frame.generationId} completeness 异常: ${frame.completeness}`
      })
    }
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
      ...(frame.finishReason ? { finishReason: frame.finishReason } : {})
    }
  }

  private mapFailed(frame: RawGenerationFailed): BackendEvent {
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
      }
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
      ...(frame.durationMs !== undefined ? { durationMs: frame.durationMs } : {})
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
      ...(frame.requestId !== undefined ? { requestId: frame.requestId } : {})
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

  private mapUsage(raw: RawTokenUsage): TokenUsage {
    const sumTotal = raw.rounds.reduce((s, r) => s + r.total_tokens, 0)
    const mapped: TokenUsage = {
      input: raw.rounds.reduce((s, r) => s + r.input_tokens, 0),
      output: raw.rounds.reduce((s, r) => s + r.output_tokens, 0),
      total: raw.turn_total,
      source: 'provider_reported',
      rounds: raw.rounds.map((r) => ({
        ...(r.model ? { model: r.model } : {}),
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        totalTokens: r.total_tokens,
        ...(r.cached_tokens !== undefined ? { cachedTokens: r.cached_tokens } : {}),
        ...(r.reasoning_tokens !== undefined ? { reasoningTokens: r.reasoning_tokens } : {}),
        roundNum: r.round_num
      }))
    }
    if (sumTotal !== raw.turn_total) {
      this.onProtocolWarning({
        code: ProtocolWarningCode.MAPPER_TOKEN_SUM_MISMATCH,
        message: `usage Σtotal_tokens(${sumTotal}) !== turn_total(${raw.turn_total}),保留服务端 turn_total`
      })
    }
    return mapped
  }

  private mapConversationUsage(raw: RawConversationUsage): ConversationTokenUsage {
    return { total: raw.total, byModel: raw.byModel, source: 'server_aggregate' }
  }
}
