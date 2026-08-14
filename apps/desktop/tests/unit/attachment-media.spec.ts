// tests/unit/attachment-media.spec.ts
// P1-2:占位「重试/刷新」决策纯函数（spec §4.7「expired→刷新」「error→重试」、D6 恢复路径）——
// 重查 ok → 重挂载（重新 resolve 签名/媒体）；error/expired 均能恢复。env=node 纯函数断言。
import { describe, expect, it } from 'vitest'
import { retryDecision } from '../../src/renderer/src/attachments/attachment-media'

describe('retryDecision（占位重试决策，spec §4.7/D6）', () => {
  it('重查 ok → remount（父组件重挂载媒体元素，Main 重新 resolve/重签）', () => {
    expect(retryDecision({ status: 'ok' })).toBe('remount')
  })
  it('重查仍 expired/not_found/revoked/error → 沿用最新状态文案（占位不消失，可再次重试）', () => {
    expect(retryDecision({ status: 'expired' })).toBe('expired')
    expect(retryDecision({ status: 'not_found' })).toBe('not_found')
    expect(retryDecision({ status: 'revoked' })).toBe('revoked')
    expect(retryDecision({ status: 'error' })).toBe('error')
  })
  it('带 reason 的结果只按 status 决策', () => {
    expect(retryDecision({ status: 'ok', reason: undefined })).toBe('remount')
    expect(retryDecision({ status: 'error', reason: 'check_failed' })).toBe('error')
  })
})
