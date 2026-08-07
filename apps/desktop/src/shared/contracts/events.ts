import type { SegmentChannel, SegmentKind, TokenUsage } from './message'

/** 事件外壳:所有后端事件共有的标识字段 */
export interface BackendEventEnvelope {
  eventId: string
  sequence: number
  timestamp?: string
}

/** 一次 AI 回复开始 */
export interface GenerationStartedEvent extends BackendEventEnvelope {
  event: 'generation.started'
  generationId: string
  messageId: string
  responseId: string
  conversationId: string
  model?: string
}

/** 分段增量:仅在 segment 内累计,乱序/重复由 StreamAccumulator 处理 */
export interface GenerationDeltaEvent extends BackendEventEnvelope {
  event: 'generation.delta'
  generationId: string
  segmentId: string
  segmentIndex: number
  channel: SegmentChannel
  kind: SegmentKind
  deltaSequence: number
  text: string
}

/** 一个分段完成(不结束父回复) */
export interface SegmentCompletedEvent extends BackendEventEnvelope {
  event: 'generation.segment.completed'
  generationId: string
  segmentId: string
  segmentIndex: number
  channel: SegmentChannel
}

/** 父回复完成:唯一结束父回复的事件,统一写入 Token/模型/心情 */
export interface GenerationCompletedEvent extends BackendEventEnvelope {
  event: 'generation.completed'
  generationId: string
  responseId: string
  usage?: TokenUsage
  conversationUsage?: { input: number; output: number; total: number }
  model?: string
  emotion?: string
}

export interface GenerationFailedEvent extends BackendEventEnvelope {
  event: 'generation.failed'
  generationId: string
  error: { code: string; message: string }
}

/** 后端事件判别联合 */
export type BackendEvent =
  | GenerationStartedEvent
  | GenerationDeltaEvent
  | SegmentCompletedEvent
  | GenerationCompletedEvent
  | GenerationFailedEvent
