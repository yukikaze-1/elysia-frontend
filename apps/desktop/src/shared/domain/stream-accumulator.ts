import type {
  AssistantSegment,
  BackendEvent,
  ConversationTokenUsage,
  SegmentChannel,
  SegmentKind,
  TokenUsage
} from '../contracts'
import type { ProtocolWarning } from '../contracts/protocol'
import { ProtocolWarningCode } from '../contracts/protocol'

/**
 * 流式消息累加器(纯逻辑,不依赖 Electron/Vue)。
 * 规则见 docs/06 §5 与 docs/18 §4.3:
 * - 按 responseId 归组父回复,按 segmentId 合并增量;
 * - segmentIndex 决定全局顺序,deltaSequence 仅在分段内累计;
 * - 重复增量忽略,缺口进入 pendingChunks 等待补传;
 * - generation.segment.completed 只完成一个分段;带 content 时为权威文本,
 *   覆盖 committedText/renderText、清 pendingChunks、停更 expectedSequence,
 *   此后迟到 delta 一律忽略并告警;
 * - generation.completed 才完成父回复;有缺口时进入 completing,不伪装完整;
 * - 完成后把有序 AssistantSegment[]、Token、模型、心情写回。
 */

export type StreamStatus = 'streaming' | 'completing' | 'interrupted' | 'completed' | 'failed'

export interface SegmentAccumulatorState {
  segmentId: string
  segmentIndex: number
  channel: SegmentChannel
  kind: SegmentKind
  expectedSequence: number
  pendingChunks: Record<number, string>
  committedText: string
  renderText: string
  completed: boolean
  /** 权威 content 已落地(此后 delta 一律忽略+告警) */
  authoritative?: boolean
}

export interface StreamAccumulatorState {
  generationId: string
  messageId: string
  responseId: string
  conversationId: string
  orderedSegmentIds: string[]
  segments: Record<string, SegmentAccumulatorState>
  status: StreamStatus
  usage?: TokenUsage
  conversationUsage?: ConversationTokenUsage
  model?: string
  emotion?: string
}

export interface StreamAccumulatorOptions {
  onProtocolWarning?: (warning: ProtocolWarning) => void
}

function emptySegment(segmentId: string, segmentIndex: number, channel: SegmentChannel, kind: SegmentKind): SegmentAccumulatorState {
  return {
    segmentId,
    segmentIndex,
    channel,
    kind,
    expectedSequence: 0,
    pendingChunks: {},
    committedText: '',
    renderText: '',
    completed: false,
    authoritative: false
  }
}

export class StreamAccumulator {
  private state: StreamAccumulatorState
  private readonly onProtocolWarning: (warning: ProtocolWarning) => void

  constructor(init?: {
    generationId?: string
    messageId?: string
    responseId?: string
    conversationId?: string
  } & StreamAccumulatorOptions) {
    this.state = {
      generationId: init?.generationId ?? '',
      messageId: init?.messageId ?? '',
      responseId: init?.responseId ?? '',
      conversationId: init?.conversationId ?? '',
      orderedSegmentIds: [],
      segments: {},
      status: 'streaming'
    }
    this.onProtocolWarning = init?.onProtocolWarning ?? (() => {})
  }

  getState(): StreamAccumulatorState {
    return this.state
  }

  apply(event: BackendEvent): void {
    switch (event.event) {
      case 'generation.started':
        this.applyStarted(event)
        break
      case 'generation.segment.started':
        this.applySegmentStarted(event)
        break
      case 'generation.delta':
        this.applyDelta(event)
        break
      case 'generation.segment.completed':
        this.applySegmentCompleted(event)
        break
      case 'generation.completed':
        this.applyCompleted(event)
        break
      case 'generation.failed':
        this.state.status = 'failed'
        break
    }
  }

  markInterrupted(): void {
    if (this.state.status === 'streaming') {
      this.state.status = 'interrupted'
    }
  }

  private applyStarted(event: Extract<BackendEvent, { event: 'generation.started' }>): void {
    if (this.state.generationId && this.state.generationId !== event.generationId) {
      throw new Error(
        `StreamAccumulator 已归属 generation ${this.state.generationId},无法接收 ${event.generationId}`
      )
    }
    this.state.generationId = event.generationId
    this.state.messageId = event.messageId
    this.state.responseId = event.responseId
    this.state.conversationId = event.conversationId
    if (event.model) this.state.model = event.model
  }

  private applySegmentStarted(event: Extract<BackendEvent, { event: 'generation.segment.started' }>): void {
    this.ensureSegment(event.segmentId, event.segmentIndex, event.channel, event.kind)
  }

  private applyDelta(event: Extract<BackendEvent, { event: 'generation.delta' }>): void {
    const segment = this.ensureSegment(event.segmentId, event.segmentIndex, event.channel, event.kind)
    if (segment.authoritative) {
      this.onProtocolWarning({
        code: ProtocolWarningCode.ACCUMULATOR_LATE_DELTA_AFTER_AUTHORITATIVE,
        message: `segment ${event.segmentId} 权威 content 已落地后收到迟到 delta(seq ${event.deltaSequence}),忽略`
      })
      return
    }
    if (event.deltaSequence < segment.expectedSequence) return
    if (event.deltaSequence === segment.expectedSequence) {
      segment.committedText += event.text
      segment.expectedSequence += 1
      this.flushContiguous(segment)
    } else {
      if (segment.pendingChunks[event.deltaSequence] === undefined) {
        segment.pendingChunks[event.deltaSequence] = event.text
      }
    }
    segment.renderText = segment.committedText
  }

  private applySegmentCompleted(event: Extract<BackendEvent, { event: 'generation.segment.completed' }>): void {
    const segment = this.ensureSegment(event.segmentId, event.segmentIndex, event.channel, event.kind)
    segment.completed = true
    if (event.content !== undefined) {
      segment.committedText = event.content
      segment.renderText = event.content
      segment.pendingChunks = {}
      segment.authoritative = true
    }
  }

  private applyCompleted(event: Extract<BackendEvent, { event: 'generation.completed' }>): void {
    if (event.usage) this.state.usage = event.usage
    if (event.conversationUsage) this.state.conversationUsage = event.conversationUsage
    if (event.model) this.state.model = event.model
    if (event.emotion) this.state.emotion = event.emotion
    // C7（2026-09-15 契约评审）：`hasGap()` 此前只看**段内** `pendingChunks`——整段丢失（segment.started
    // 从未到达）在终态后表现为一条正常 `completed` 的**更短回复**。缺口由 mapper 判定（它看得到全部段，
    // 含不进事件的 status 段），经 `segmentGap` 传到这里；与段内缺口一样落 `completing`，由 UI 明示「可能不完整」。
    this.state.status = (this.hasGap() || event.segmentGap === true) ? 'completing' : 'completed'
  }

  private ensureSegment(segmentId: string, segmentIndex: number, channel: SegmentChannel, kind: SegmentKind): SegmentAccumulatorState {
    let segment = this.state.segments[segmentId]
    if (!segment) {
      segment = emptySegment(segmentId, segmentIndex, channel, kind)
      this.state.segments[segmentId] = segment
      this.state.orderedSegmentIds.push(segmentId)
    }
    return segment
  }

  private flushContiguous(segment: SegmentAccumulatorState): void {
    let chunk = segment.pendingChunks[segment.expectedSequence]
    while (chunk !== undefined) {
      segment.committedText += chunk
      segment.expectedSequence += 1
      delete segment.pendingChunks[segment.expectedSequence - 1]
      chunk = segment.pendingChunks[segment.expectedSequence]
    }
  }

  private hasGap(): boolean {
    return Object.values(this.state.segments).some((s) => Object.keys(s.pendingChunks).length > 0)
  }

  toAssistantSegments(): AssistantSegment[] {
    return this.state.orderedSegmentIds
      .map((id) => this.state.segments[id])
      .filter((s) => s && s.committedText.length > 0)
      .sort((a, b) => a.segmentIndex - b.segmentIndex)
      .map((s) => ({
        segmentId: s.segmentId,
        segmentIndex: s.segmentIndex,
        channel: s.channel,
        kind: s.kind,
        text: s.committedText,
        completed: s.completed
      }))
  }
}
