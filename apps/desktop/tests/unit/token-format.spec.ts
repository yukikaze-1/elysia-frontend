// tests/unit/token-format.spec.ts
// C2 展示半边（2026-09-15）：token 展示格式的**边界**测试。
//
// 为什么单独成文：这条 UI 的全部风险都在"缺数据时的表现"上——把 unknown 渲染成 0、
// 把部分轮次的缺失当成命中率、把 12.3K 当成唯一可得的数字。逐条钉住这些边界，
// 而不是只测"正常显示对不对"。
import { describe, expect, it } from 'vitest'
import type { TokenUsage } from '@shared/contracts'
import {
  cacheHitRateOf,
  formatCacheHitRate,
  formatExactTokens,
  formatTokenCount,
  usageModelLabel
} from '../../src/renderer/src/utils/token-format'

function usage(rounds: TokenUsage['rounds'], overrides: Partial<TokenUsage> = {}): TokenUsage {
  return { input: 0, output: 0, total: 0, source: 'provider_reported', ...(rounds ? { rounds } : {}), ...overrides }
}

describe('formatTokenCount / formatExactTokens', () => {
  it('小于 1000 保持精确（不做无谓的近似）', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(999)).toBe('999')
  })

  it('K/M/B 一位小数，整数不显示 ".0"', () => {
    expect(formatTokenCount(1000)).toBe('1K')
    expect(formatTokenCount(12_345)).toBe('12.3K')
    expect(formatTokenCount(1_000_000)).toBe('1M')
    expect(formatTokenCount(1_833_000_000)).toBe('1.8B')
  })

  it('精确值带千分位（title 用），locale 固定 en-US', () => {
    expect(formatExactTokens(1_234_567)).toBe('1,234,567')
    expect(formatExactTokens(42)).toBe('42')
  })

  it('非法输入不美化：负数/NaN 原样返回字符串（schema 本应拦住，这里只保证不崩、不伪装成 0）', () => {
    expect(formatTokenCount(-1)).toBe('-1')
    expect(formatTokenCount(Number.NaN)).toBe('NaN')
    expect(formatExactTokens(Number.NaN)).toBe('NaN')
  })
})

describe('formatCacheHitRate（本轮缓存命中率）', () => {
  it('正常比值四舍五入到整数百分比', () => {
    expect(formatCacheHitRate(3000, 3600)).toBe('83%')
    expect(formatCacheHitRate(0, 100)).toBe('0%')
    expect(formatCacheHitRate(100, 100)).toBe('100%')
  })

  it('极小非零比值显示 "<1%"——四舍五入成 0% 会与"没有缓存命中"混淆', () => {
    expect(formatCacheHitRate(1, 1000)).toBe('<1%')
    expect(formatCacheHitRate(4, 1000)).toBe('<1%')
  })

  it('缺一半数据 / 分母为 0 → undefined（调用方隐藏，不补 0%）', () => {
    expect(formatCacheHitRate(undefined, 100)).toBeUndefined()
    expect(formatCacheHitRate(10, undefined)).toBeUndefined()
    expect(formatCacheHitRate(10, 0)).toBeUndefined()
  })

  it('cached > input → undefined（口径不符时不猜、也不夹到 100%）', () => {
    expect(formatCacheHitRate(150, 100)).toBeUndefined()
  })
})

describe('cacheHitRateOf（按 rounds 求和）', () => {
  it('多轮分别求和', () => {
    const u = usage([
      { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cachedTokens: 500, roundNum: 1 },
      { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cachedTokens: 900, roundNum: 2 }
    ])
    expect(cacheHitRateOf(u)).toBe('70%')   // (500+900)/(1000+1000)
  })

  it('任一轮缺 cachedTokens → undefined（部分求和会系统性低估命中率，比不显示更糟）', () => {
    const u = usage([
      { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cachedTokens: 500, roundNum: 1 },
      { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, roundNum: 2 }
    ])
    expect(cacheHitRateOf(u)).toBeUndefined()
  })

  it('无 rounds（后端只给了总计）→ undefined', () => {
    expect(cacheHitRateOf(usage(undefined, { input: 10, output: 5, total: 15 }))).toBeUndefined()
    expect(cacheHitRateOf(undefined)).toBeUndefined()
  })
})

describe('usageModelLabel', () => {
  it('去重保序；无 model 字段 → undefined（不写"未知模型"）', () => {
    const u = usage([
      { model: 'm-a', inputTokens: 1, outputTokens: 1, totalTokens: 2, roundNum: 1 },
      { model: 'm-a', inputTokens: 1, outputTokens: 1, totalTokens: 2, roundNum: 2 },
      { model: 'm-b', inputTokens: 1, outputTokens: 1, totalTokens: 2, roundNum: 3 }
    ])
    expect(usageModelLabel(u)).toBe('m-a / m-b')
    expect(usageModelLabel(usage([{ inputTokens: 1, outputTokens: 1, totalTokens: 2, roundNum: 1 }]))).toBeUndefined()
    expect(usageModelLabel(undefined)).toBeUndefined()
  })
})
