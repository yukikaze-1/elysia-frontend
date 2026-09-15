// src/main/transport/protocol-v2/token-usage.ts
// C2（2026-09-15 契约评审）：**wire token 用量 → 领域 `TokenUsage` 的唯一映射点**。
//
// 为什么单独抽出来：同一份 wire 形状（`{rounds, turn_total}`）此前只在 `frame-mapper.mapUsage` 里被映射
// ——即只有**实时** `generation.completed` 一条路径；回放（WS `session` 的 `SessionMessageItem.token_usage`
// 与 REST 归档 `Message.token_usage`）解析后**整段丢弃**，于是「重连/回放后的历史消息」拿不到自己的
// 回复级用量（界面上的 model/usage 元数据行只在新生成的回复上出现，历史消息上消失——同一份数据两种命运）。
//
// 口径（与 frame-mapper 原有实现逐字一致，抽出来不改语义）：
//   · `input`/`output` 由各轮求和，`total` **取服务端 `turn_total`**（不自行重算，也不由字符数估算）；
//   · Σrounds.total_tokens ≠ turn_total 时**不静默**：回调告警，仍保留服务端口径；
//   · `source` 恒 `provider_reported`（后端上报）。
import type { TokenUsage } from '@shared/contracts'

/** wire 侧最小结构（`RawTokenUsage` 与本模块的结构子集相容；此处不 import raw-types 以保持纯函数） */
export interface RawTokenUsageLike {
  rounds: Array<{
    model?: string
    input_tokens: number
    output_tokens: number
    total_tokens: number
    cached_tokens?: number
    reasoning_tokens?: number
    round_num: number
  }>
  turn_total: number
}

/**
 * 形状判定：只有**真正是** `{rounds: [...], turn_total: number}` 时才认。
 *
 * REST 归档的 `token_usage` 在契约里是 `dict[str, Any]`（自由形状，X99 `rest.py:280` 取证），
 * 所以这里必须做**正向确认**而不是"取字段试试看"：不是这个形状就返回 undefined（该消息没有可用的
 * 回复级用量），而不是把半截数据映射成看起来正常的用量。
 */
export function isRawTokenUsageLike(value: unknown): value is RawTokenUsageLike {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { rounds?: unknown; turn_total?: unknown }
  if (typeof v.turn_total !== 'number' || !Array.isArray(v.rounds)) return false
  return v.rounds.every((r) => {
    if (typeof r !== 'object' || r === null) return false
    const round = r as Record<string, unknown>
    return typeof round.input_tokens === 'number' && typeof round.output_tokens === 'number'
      && typeof round.total_tokens === 'number' && typeof round.round_num === 'number'
  })
}

export function mapRawTokenUsage(
  raw: RawTokenUsageLike,
  onWarning?: (details: { sumTotal: number; turnTotal: number }) => void
): TokenUsage {
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
  if (sumTotal !== raw.turn_total) onWarning?.({ sumTotal, turnTotal: raw.turn_total })
  return mapped
}
