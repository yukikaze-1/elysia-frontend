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
  // accumulator
  ACCUMULATOR_LATE_DELTA_AFTER_AUTHORITATIVE: 'ACCUMULATOR_LATE_DELTA_AFTER_AUTHORITATIVE'
} as const

export type ProtocolWarningCode = typeof ProtocolWarningCode[keyof typeof ProtocolWarningCode]
