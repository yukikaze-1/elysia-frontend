// tests/unit/history-date.spec.ts
// Task 1:日期时区纯函数（spec §4.4，D3）——localDateToHalfOpenRange / isoToLocalDate，Intl 实现。
// env=node：Intl 全 ICU 可用，无需 Electron。
import { describe, expect, it } from 'vitest'
import { isoToLocalDate, localDateToHalfOpenRange } from '../../src/shared/domain/history-date'

describe('localDateToHalfOpenRange（本地自然日 → UTC 半开区间）', () => {
  it('Asia/Shanghai（UTC+8，无 DST）：本地日映射前一日 16:00Z 起', () => {
    expect(localDateToHalfOpenRange('2026-08-14', 'Asia/Shanghai')).toEqual({ from: '2026-08-13T16:00:00.000Z', to: '2026-08-14T16:00:00.000Z' })
  })
  it('America/New_York 冬季 EST（UTC-5）', () => {
    expect(localDateToHalfOpenRange('2026-01-15', 'America/New_York')).toEqual({ from: '2026-01-15T05:00:00.000Z', to: '2026-01-16T05:00:00.000Z' })
  })
  it('America/New_York 夏季 EDT（UTC-4，夏令时跨日正确）', () => {
    expect(localDateToHalfOpenRange('2026-07-15', 'America/New_York')).toEqual({ from: '2026-07-15T04:00:00.000Z', to: '2026-07-16T04:00:00.000Z' })
  })
  it('相邻两日区间无缝衔接（半开区间不重不漏）', () => {
    const a = localDateToHalfOpenRange('2026-08-14', 'Asia/Shanghai')
    const b = localDateToHalfOpenRange('2026-08-15', 'Asia/Shanghai')
    expect(a.to).toBe(b.from)
  })
})

describe('isoToLocalDate（UTC 时间 → 用户本地自然日标签）', () => {
  it('UTC 前一日深夜 → 上海本地次日（跨 UTC 日）', () => {
    expect(isoToLocalDate('2026-08-13T17:00:00.000Z', 'Asia/Shanghai')).toBe('2026-08-14')
  })
  it('本地日边界内不跨日', () => {
    expect(isoToLocalDate('2026-08-14T15:59:00.000Z', 'Asia/Shanghai')).toBe('2026-08-14')
  })
  it('纽约冬季 UTC-5：本地日与 UTC 日一致/边界 04:59Z 仍属前一日', () => {
    expect(isoToLocalDate('2026-01-15T10:00:00.000Z', 'America/New_York')).toBe('2026-01-15')
    expect(isoToLocalDate('2026-01-15T04:59:00.000Z', 'America/New_York')).toBe('2026-01-14')
  })
})
