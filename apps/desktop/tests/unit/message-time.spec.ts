// tests/unit/message-time.spec.ts —— UII-QQ 时间戳批次：消息时间/日期分隔纯函数。
// 全部用固定时间 + 显式 timeZone，不依赖测试机当前日期或系统时区。
import { describe, expect, it } from 'vitest'
import type { Message } from '@shared/contracts'
import {
  formatMessageTime, formatFullTime, localDayKey, daySeparatorLabel,
  dayFirstDayKeys, estimateMessageRowHeight, DAY_SEPARATOR_ESTIMATE_PX
} from '../../src/renderer/src/utils/message-time'
import { estimateMessageHeight } from '../../src/renderer/src/utils/virtual-window'

const TZ = 'Asia/Shanghai'
const NOW = new Date('2026-08-30T12:00:00.000Z')   // 上海本地 2026-08-30 20:00 → 本地日键 2026-08-30

function msg(id: string, createdAt: string, role: Message['role'] = 'user'): Message {
  return { messageId: id, conversationId: 'c1', role, content: 'hi', status: 'completed', createdAt }
}

describe('formatMessageTime（HH:mm，24 小时制 h23）', () => {
  it('固定时刻 → HH:mm；午夜为 00:xx（非 24:xx）', () => {
    expect(formatMessageTime('2026-08-30T01:42:17.000Z', { timeZone: 'UTC' })).toBe('01:42')
    expect(formatMessageTime('2026-01-01T00:05:00.000Z', { timeZone: 'UTC' })).toBe('00:05')
  })
  it('非法 createdAt → null（不抛错、无 Invalid Date）', () => {
    for (const bad of ['', 'not-a-date', '2026-13-99T99:99:99Z']) {
      expect(() => formatMessageTime(bad, { timeZone: 'UTC' })).not.toThrow()
      expect(formatMessageTime(bad, { timeZone: 'UTC' })).toBeNull()
    }
  })
})

describe('formatFullTime（完整本地时间 YYYY年M月D日 HH:mm:ss）', () => {
  it('按显式时区转换（UTC → Asia/Shanghai，含跨自然日）', () => {
    expect(formatFullTime('2026-08-30T17:00:00.000Z', { timeZone: TZ })).toBe('2026年8月31日 01:00:00')
  })
  it('非法 createdAt → null', () => {
    expect(formatFullTime('garbage', { timeZone: TZ })).toBeNull()
  })
})

describe('localDayKey（本地自然日键，非 UTC 字符串截取）', () => {
  it('同一时刻在不同时区归属不同自然日', () => {
    const iso = '2026-08-30T23:30:00.000Z'
    expect(localDayKey(iso, 'UTC')).toBe('2026-08-30')
    expect(localDayKey(iso, TZ)).toBe('2026-08-31')
  })
  it('非法 createdAt → null', () => {
    expect(localDayKey('nope', TZ)).toBeNull()
  })
})

describe('daySeparatorLabel（今天/昨天/本年/跨年）', () => {
  const opts = { now: NOW, timeZone: TZ }
  it('当天 → 今天', () => {
    expect(daySeparatorLabel('2026-08-30', opts)).toBe('今天')
  })
  it('前一天 → 昨天', () => {
    expect(daySeparatorLabel('2026-08-29', opts)).toBe('昨天')
  })
  it('本年度更早 → M月D日', () => {
    expect(daySeparatorLabel('2026-08-15', opts)).toBe('8月15日')
    expect(daySeparatorLabel('2026-01-01', opts)).toBe('1月1日')
  })
  it('跨年度 → YYYY年M月D日', () => {
    expect(daySeparatorLabel('2025-12-31', opts)).toBe('2025年12月31日')
  })
})

describe('dayFirstDayKeys（全量 items 判定本地日首条，跳过 tool）', () => {
  it('首条非 tool 恒分隔；同日连续只一次；跨天新分隔；tool 占位跳过且全局 index 保留', () => {
    const items = [
      msg('m1', '2026-08-29T10:00:00Z'),
      msg('t1', '2026-08-29T10:01:00Z', 'tool'),
      msg('m2', '2026-08-29T15:00:00Z'),
      msg('m3', '2026-08-30T09:00:00Z'),
      msg('m4', '2026-08-30T10:00:00Z'),
    ]
    expect([...dayFirstDayKeys(items, 'UTC').entries()]).toEqual([[0, '2026-08-29'], [3, '2026-08-30']])
  })
  it('tool 在最前：其后首条非 tool（按全局 index）仍分隔', () => {
    const items = [msg('t0', '2026-08-29T09:00:00Z', 'tool'), msg('m1', '2026-08-29T10:00:00Z')]
    expect([...dayFirstDayKeys(items, 'UTC').entries()]).toEqual([[1, '2026-08-29']])
  })
  it('非法 createdAt：自身不分隔、不更新比较基线（后续同日/跨日判断不受干扰）', () => {
    const items = [
      msg('m1', '2026-08-29T10:00:00Z'),
      msg('bad', 'not-a-date'),
      msg('m2', '2026-08-29T20:00:00Z'),   // 与 m1 同日 → 不分隔
      msg('m3', '2026-08-30T10:00:00Z'),
    ]
    expect([...dayFirstDayKeys(items, 'UTC').entries()]).toEqual([[0, '2026-08-29'], [3, '2026-08-30']])
  })
  it('判定基于全量数组（调用方传入完整 items 即与虚拟窗口 startIndex 无关）：任意切片比较键不变化', () => {
    // 组件侧恒传全量 items.value（见 CyMessageList.dayFirst）；此处锁纯函数语义：index 为全局下标
    const items = [msg('m1', '2026-08-29T10:00:00Z'), msg('m2', '2026-08-30T09:00:00Z'), msg('m3', '2026-08-30T10:00:00Z')]
    const full = dayFirstDayKeys(items, 'UTC')
    expect(full.has(1)).toBe(true)
    expect(full.has(2)).toBe(false)   // m3 与 m2 同日——不会因「它是某窗口首条」而误判
  })
})

describe('estimateMessageRowHeight（日首补额，估高路径计入分隔高度）', () => {
  it('非日首 = estimateMessageHeight；日首 = +DAY_SEPARATOR_ESTIMATE_PX（实测路径由行内 ResizeObserver border-box 覆盖）', () => {
    const m = msg('m1', '2026-08-29T10:00:00Z')
    expect(estimateMessageRowHeight(m, false)).toBe(estimateMessageHeight(m))
    expect(estimateMessageRowHeight(m, true)).toBe(estimateMessageHeight(m) + DAY_SEPARATOR_ESTIMATE_PX)
    expect(DAY_SEPARATOR_ESTIMATE_PX).toBeGreaterThan(0)
  })
})
