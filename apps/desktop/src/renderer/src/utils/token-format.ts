// src/renderer/src/utils/token-format.ts
// C2 展示半边（2026-09-15）：会话级 / 最近一轮 token 的**纯展示格式**。
//
// 纪律：**只做展示转换，不产生任何数值**。所有数字都来自后端上报（`TokenUsage` /
// `ConversationTokenUsage`），本模块不做字符数估算、不做跨会话累计、不做缺失补齐——
// 缺值一律返回 `undefined` 由调用方隐藏整项，而不是补 0 或显示"暂无"。
//
// 舍入策略：紧凑单位只用于**一眼能看出是近似值**的窄条，精确值始终留在 `title`（悬浮）里，
// 于是「12.3K」不会成为用户唯一能得到的数字。
import type { TokenUsage } from '@shared/contracts'

/** 精确值（用于 title）：1234567 → "1,234,567"。locale 固定 en-US，避免跟随系统区域产生不确定输出 */
export function formatExactTokens(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : String(value)
}

/** 紧凑值（用于窄条）：<1000 精确；K/M/B 保留一位小数（整数不显示 ".0"，`1.0M` → `1M`） */
export function formatTokenCount(value: number): string {
  // schema 已保证非负整数（TokenUsageSchema/ConversationUsageSchema），此处只保证不崩、且不美化异常值
  if (!Number.isFinite(value) || value < 0) return String(value)
  if (value < 1000) return String(Math.round(value))
  const units: ReadonlyArray<readonly [number, string]> = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]
  for (const [scale, suffix] of units) {
    if (value >= scale) return `${(value / scale).toFixed(1).replace(/\.0$/, '')}${suffix}`
  }
  return String(Math.round(value))
}

/**
 * 缓存命中率：`cachedTokens / inputTokens`。
 *
 * 口径（诚实优先）：这是**本轮的缓存读取占比**，既不是"省钱比例"也不是会话级命中率——
 * 会话级累计只有 `{total, byModel}`，算不出命中率（那需要把每轮 cached/input 全量留存）。
 *
 * 返回 `undefined` 表示**不显示该项**（调用方必须隐藏，不得退化成 0%）：
 *  · 后端没给 `cachedTokens`（`rounds[].cachedTokens` 可缺省）；
 *  · `inputTokens` 为 0（0/0 无定义）；
 *  · `cachedTokens > inputTokens`——真实的 >100% 只说明我们对字段含义的理解与后端不符，
 *    此时**不猜、不夹到 100%**，直接不显示。
 * 极小的非零比值显示 `<1%`：四舍五入成 `0%` 会与"完全没有缓存命中"混淆。
 */
export function formatCacheHitRate(cachedTokens: number | undefined, inputTokens: number | undefined): string | undefined {
  if (cachedTokens === undefined || inputTokens === undefined) return undefined
  if (!Number.isFinite(cachedTokens) || !Number.isFinite(inputTokens)) return undefined
  if (inputTokens <= 0 || cachedTokens < 0 || cachedTokens > inputTokens) return undefined
  const ratio = cachedTokens / inputTokens
  if (ratio === 0) return '0%'
  if (ratio * 100 < 1) return '<1%'
  return `${Math.round(ratio * 100)}%`
}

/**
 * 一次回复的缓存命中率。多轮（一次回复可能含多个 LLM 轮次）时把各轮 cached/input 分别求和。
 *
 * **只要有一轮没报 `cachedTokens` 就返回 undefined**：部分轮次缺字段时求和会把分母算全、
 * 分子算少，得到一个系统性偏低的假命中率——比不显示更糟。
 */
export function cacheHitRateOf(usage: TokenUsage | undefined): string | undefined {
  const rounds = usage?.rounds
  if (!rounds || rounds.length === 0) return undefined
  if (rounds.some((r) => r.cachedTokens === undefined)) return undefined
  const cached = rounds.reduce((sum, r) => sum + (r.cachedTokens ?? 0), 0)
  const input = rounds.reduce((sum, r) => sum + r.inputTokens, 0)
  return formatCacheHitRate(cached, input)
}

/** 本轮涉及的模型（去重保序）；后端未给 model 时返回 undefined（调用方隐藏，不写"未知模型"） */
export function usageModelLabel(usage: TokenUsage | undefined): string | undefined {
  const models = (usage?.rounds ?? [])
    .map((r) => r.model)
    .filter((m): m is string => typeof m === 'string' && m.length > 0)
  const unique = [...new Set(models)]
  return unique.length > 0 ? unique.join(' / ') : undefined
}
