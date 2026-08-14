// tests/unit/history-date.spec.ts
// Task 1:日期时区纯函数（spec §4.4，D3）——isoToLocalDate，Intl 实现。
// env=node：Intl 全 ICU 可用，无需 Electron。
import { describe, expect, it } from 'vitest'
import { isoToLocalDate } from '../../src/shared/domain/history-date'

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
