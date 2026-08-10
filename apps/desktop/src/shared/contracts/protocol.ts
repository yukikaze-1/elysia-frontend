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
  MAPPER_ERROR: 'MAPPER_ERROR',
  // accumulator
  ACCUMULATOR_LATE_DELTA_AFTER_AUTHORITATIVE: 'ACCUMULATOR_LATE_DELTA_AFTER_AUTHORITATIVE',
  // real-backend(WS 连接层)
  RAW_FRAME_INVALID: 'RAW_FRAME_INVALID',
  SESSION_BUFFER_REPLACED: 'SESSION_BUFFER_REPLACED',
  ACK_UNKNOWN_CLIENT_REQUEST_ID: 'ACK_UNKNOWN_CLIENT_REQUEST_ID',
  WS_ERROR_FRAME: 'WS_ERROR_FRAME'
} as const

export type ProtocolWarningCode = typeof ProtocolWarningCode[keyof typeof ProtocolWarningCode]
