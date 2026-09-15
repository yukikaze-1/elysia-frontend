/**
 * 协议告警(纯逻辑层上报,不打断事件流)。
 * mapper/accumulator 通过 onProtocolWarning 注入上报;code 常量供测试/日志稳定引用。
 */
export interface ProtocolWarning {
  code: ProtocolWarningCode
  message: string
}

export const ProtocolWarningCode = {
  // mapper
  MAPPER_SEGMENT_INDEX_MISMATCH: 'MAPPER_SEGMENT_INDEX_MISMATCH',
  MAPPER_TOKEN_SUM_MISMATCH: 'MAPPER_TOKEN_SUM_MISMATCH',
  MAPPER_UNEXPECTED_COMPLETENESS: 'MAPPER_UNEXPECTED_COMPLETENESS',
  /** C7（2026-09-15 契约评审）：一代内分段索引不连续 ⇒ 有整段从未到达（终态已标 `segmentGap`） */
  MAPPER_SEGMENT_GAP: 'MAPPER_SEGMENT_GAP',
  MAPPER_ERROR: 'MAPPER_ERROR',
  // accumulator
  ACCUMULATOR_LATE_DELTA_AFTER_AUTHORITATIVE: 'ACCUMULATOR_LATE_DELTA_AFTER_AUTHORITATIVE',
  // real-backend(WS 连接层)
  RAW_FRAME_INVALID: 'RAW_FRAME_INVALID',
  /**
   * C5（2026-09-15 契约评审）：`session` 帧缺 `conversationId` ⇒ 那批回放无法归属会话，**已丢弃**。
   * 取代了原 `SESSION_BUFFER_REPLACED`——后者属于「先缓冲、等 REST active:true 解析后投递」的旧设计，
   * 而那条投递路径从未实现（缓冲写进去就再也不出来）。
   */
  SESSION_REPLAY_UNATTRIBUTED: 'SESSION_REPLAY_UNATTRIBUTED',
  ACK_UNKNOWN_CLIENT_REQUEST_ID: 'ACK_UNKNOWN_CLIENT_REQUEST_ID',
  WS_ERROR_FRAME: 'WS_ERROR_FRAME',
  // real-backend(P4-B 语音:二进制上行守卫 + 意外二进制接收)
  VOICE_BINARY_NOT_CONNECTED: 'VOICE_BINARY_NOT_CONNECTED',
  VOICE_BINARY_NO_SESSION: 'VOICE_BINARY_NO_SESSION',
  UNEXPECTED_BINARY: 'UNEXPECTED_BINARY',
  // real-backend(P4-B TTS 播放:audio_* 帧缓冲守卫 + sink 缺失)
  TTS_MEDIA_SINK_MISSING: 'TTS_MEDIA_SINK_MISSING',
  AUDIO_ORPHAN_CHUNK: 'AUDIO_ORPHAN_CHUNK',
  AUDIO_END_NO_BUFFER: 'AUDIO_END_NO_BUFFER'
} as const

export type ProtocolWarningCode = typeof ProtocolWarningCode[keyof typeof ProtocolWarningCode]
