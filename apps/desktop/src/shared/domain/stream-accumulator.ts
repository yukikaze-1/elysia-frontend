import type {
  AssistantSegment,
  BackendEvent,
  SegmentChannel,
  SegmentKind,
  TokenUsage
} from '../contracts'

/**
 * 流式消息累加器(纯逻辑,不依赖 Electron/Vue)。
 * 规则见 docs/06 §5:
 * - 按 responseId 归组父回复,按 segmentId 合并增量;
 * - segmentIndex 决定全局顺序,deltaSequence 仅在分段内累计;
 * - 重复增量忽略,缺口进入 pendingChunks 等待补传;
 * - generation.segment.completed 只完成一个分段;
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
  conversationUsage?: { input: number; output: number; total: number }
  model?: string
  emotion?: string
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
    completed: false
  }
}

export class StreamAccumulator {
  private state: StreamAccumulatorState

  constructor(init?: {
    generationId?: string
    messageId?: string
    responseId?: string
    conversationId?: string
  }) {
    this.state = {
      generationId: init?.generationId ?? '',
      messageId: init?.messageId ?? '',
      responseId: init?.responseId ?? '',
      conversationId: init?.conversationId ?? '',
      orderedSegmentIds: [],
      segments: {},
      status: 'streaming'
    }
  }

  getState(): StreamAccumulatorState {
    return this.state
  }

  /** 应用一个后端事件,推进累加器状态 */
  apply(event: BackendEvent): void {
    switch (event.event) {
      case 'generation.started':
        this.applyStarted(event)
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

  /** 停止生成:保留已提交内容,标记中断 */
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

  private applyDelta(event: Extract<BackendEvent, { event: 'generation.delta' }>): void {
    const segment = this.ensureSegment(event.segmentId, event.segmentIndex, event.channel, event.kind)
    // 已应用的序号直接忽略(重复增量)
    if (event.deltaSequence < segment.expectedSequence) return
    // 命中下一个期望序号:连续刷出
    if (event.deltaSequence === segment.expectedSequence) {
      segment.committedText += event.text
      segment.expectedSequence += 1
      this.flushContiguous(segment)
    } else {
      // 缺口:放入 pendingChunks,等待补传后连续刷出
      if (segment.pendingChunks[event.deltaSequence] === undefined) {
        segment.pendingChunks[event.deltaSequence] = event.text
      }
    }
    segment.renderText = segment.committedText
  }

  private applySegmentCompleted(event: Extract<BackendEvent, { event: 'generation.segment.completed' }>): void {
    const segment = this.ensureSegment(event.segmentId, event.segmentIndex, event.channel, 'text')
    segment.completed = true
    // segment.completed 不结束父回复
  }

  private applyCompleted(event: Extract<BackendEvent, { event: 'generation.completed' }>): void {
    if (event.usage) this.state.usage = event.usage
    if (event.conversationUsage) this.state.conversationUsage = event.conversationUsage
    if (event.model) this.state.model = event.model
    if (event.emotion) this.state.emotion = event.emotion
    this.state.status = this.hasGap() ? 'completing' : 'completed'
  }

  private ensureSegment(
    segmentId: string,
    segmentIndex: number,
    channel: SegmentChannel,
    kind: SegmentKind
  ): SegmentAccumulatorState {
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

  /** 是否存在未补齐的序列缺口 */
  private hasGap(): boolean {
    return Object.values(this.state.segments).some((s) => Object.keys(s.pendingChunks).length > 0)
  }

  /** 按 segmentIndex 全局排序输出有序分段(仅包含有内容的) */
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
