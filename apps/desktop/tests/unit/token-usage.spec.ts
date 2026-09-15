// tests/unit/token-usage.spec.ts
// C2（2026-09-15）：`protocol-v2/token-usage.ts` 这个**唯一映射点**的纯函数性质。
//
// 为什么值得单独钉：同一份 wire 形状现在有三条到达路径（实时 generation.completed、
// 回放 session.token_stats、REST 归档 Message.token_usage）。任何一条路径的映射语义漂移
// 都会让"同一个事实两个答案"，而这是纯函数，可以在这里最便宜地钉死。
import { describe, expect, it, vi } from 'vitest'
import { mapRawTokenStats, mapRawTokenUsage } from '../../src/main/transport/protocol-v2/token-usage'

describe('mapRawTokenStats（会话级累计）', () => {
  it('只补来源标签：total 取服务端口径（不对 byModel 求和），byModel 是拷贝', () => {
    const raw = { total: 100, byModel: { 'm-a': 30, 'm-b': 40 } }   // 故意与 total 不一致：前端不得"顺手纠正"
    const mapped = mapRawTokenStats(raw)
    expect(mapped).toEqual({ total: 100, byModel: { 'm-a': 30, 'm-b': 40 }, source: 'server_aggregate' })
    // 拷贝语义：改写入参（wire 解析结果）不得影响已映射的领域对象
    raw.byModel['m-a'] = 999
    expect(mapped.byModel['m-a']).toBe(30)
  })

  it('空 byModel 合法（后端无按模型记录），不被当成形状错误', () => {
    expect(mapRawTokenStats({ total: 0, byModel: {} })).toEqual({ total: 0, byModel: {}, source: 'server_aggregate' })
  })
})

describe('mapRawTokenUsage（回复级用量）', () => {
  it('input/output 求和、total 取服务端 turn_total、source 恒 provider_reported', () => {
    const mapped = mapRawTokenUsage({
      rounds: [
        { model: 'm-a', input_tokens: 100, output_tokens: 20, total_tokens: 120, cached_tokens: 50, round_num: 1 },
        { model: 'm-a', input_tokens: 200, output_tokens: 30, total_tokens: 230, round_num: 2 }
      ],
      turn_total: 350
    })
    expect(mapped).toEqual({
      input: 300,
      output: 50,
      total: 350,
      source: 'provider_reported',
      rounds: [
        { model: 'm-a', inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedTokens: 50, roundNum: 1 },
        { model: 'm-a', inputTokens: 200, outputTokens: 30, totalTokens: 230, roundNum: 2 }
      ]
    })
  })

  it('Σrounds ≠ turn_total 时告警但不改数（保留服务端口径）', () => {
    const onWarning = vi.fn()
    const mapped = mapRawTokenUsage({ rounds: [{ input_tokens: 1, output_tokens: 1, total_tokens: 2, round_num: 1 }], turn_total: 5 }, onWarning)
    expect(onWarning).toHaveBeenCalledWith({ sumTotal: 2, turnTotal: 5 })
    expect(mapped.total).toBe(5)
  })
})
