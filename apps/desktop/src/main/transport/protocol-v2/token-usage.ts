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
//
// 2026-09-15 追加：**会话级累计**（`{total, byModel}`）也归本模块。它有三个来源——实时
// `generation.completed.conversationUsage`、建连/切换会话的 `session.token_stats`
// （X99 取证：`ws_handler._send_session_replay` 取 `agent.token_tracker.get_session_stats(sid)`，
// 严格按 sid，无记录返回 0/空）、以及 v1 兼容 `token_usage.session`（前端有意不消费）。
// 三个来源是同一种事实，故只留一个映射点，避免"某一条路径忘了补 source 标签"。
import type { ConversationTokenUsage, TokenUsage } from '@shared/contracts'

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

/** 会话级累计的 wire 最小结构（`RawTokenStats` 与 `RawConversationUsage` 同形，X99 `rest.py:471`） */
export interface RawTokenStatsLike {
  total: number
  byModel: Record<string, number>
}

/**
 * 会话级累计映射：`{total, byModel}` → 领域 `ConversationTokenUsage`。
 *
 * 与 `mapRawTokenUsage` 同一取舍：`total` **取服务端口径**（不自行对 byModel 求和——两者在
 * token_tracker 里由同一份 per-model 记录派生，前端重算只会在后端口径变化时先悄悄漂移），
 * 只补来源标签。后端**只提供 total + byModel**，故 `input`/`output` 有意不虚构（契约里
 * `ConversationTokenUsage` 也没有这两个字段）——界面上不能出现"会话级输入/输出"这种编出来的数。
 *
 * `byModel` 做浅拷贝：领域对象随后进入 Renderer 的响应式表，直接共享 wire 对象会让
 * 后续任何就地改动反向污染协议解析结果。
 */
export function mapRawTokenStats(raw: RawTokenStatsLike): ConversationTokenUsage {
  return { total: raw.total, byModel: { ...raw.byModel }, source: 'server_aggregate' }
}
