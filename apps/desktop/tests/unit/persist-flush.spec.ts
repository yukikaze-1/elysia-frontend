// tests/unit/persist-flush.spec.ts —— 退出前 Renderer flush 请求器（H-04，2026-09-11）。
//
// 纪律：本模块的全部失败路径都必须 fail-open（不阻断退出），且**不得静默谎报成功**——
// 超时必须经 onTimeout 留痕。以下逐条钉住。
import { describe, expect, it, vi } from 'vitest'
import { createPersistFlushRequester, PERSIST_FLUSH_TIMEOUT_MS } from '../../src/main/persistence/persist-flush'

describe('createPersistFlushRequester（H-04 退出前 flush）', () => {
  it('投递成功 → 等待 ack；ack 到达后 resolve', async () => {
    const deliver = vi.fn(() => true)
    const r = createPersistFlushRequester({ deliver })
    let settled = false
    const inflight = r.request().then(() => { settled = true })
    await Promise.resolve()
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false) // 未 ack 前必须仍在等
    r.acknowledge()
    await inflight
    expect(settled).toBe(true)
  })

  it('无窗口（deliver=false）→ 立即 resolve，不启动计时器', async () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()
    const r = createPersistFlushRequester({ deliver: () => false, onTimeout })
    await r.request() // 不 await ack 也应立刻返回
    vi.advanceTimersByTime(PERSIST_FLUSH_TIMEOUT_MS * 2)
    expect(onTimeout).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('投递抛错 → fail-open resolve（不把异常抛给退出流程）', async () => {
    const r = createPersistFlushRequester({ deliver: () => { throw new Error('webContents destroyed') } })
    await expect(r.request()).resolves.toBeUndefined()
  })

  it('超时 → 调用 onTimeout 并 resolve（fail-open，但绝不静默）', async () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()
    const r = createPersistFlushRequester({ deliver: () => true, onTimeout })
    let settled = false
    const inflight = r.request().then(() => { settled = true })
    await Promise.resolve()
    vi.advanceTimersByTime(PERSIST_FLUSH_TIMEOUT_MS)
    await inflight
    expect(settled).toBe(true)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('onTimeout 自身抛错也不阻断 resolve（try/finally 语义）', async () => {
    vi.useFakeTimers()
    const r = createPersistFlushRequester({ deliver: () => true, onTimeout: () => { throw new Error('audit down') } })
    const inflight = r.request()
    await Promise.resolve()
    vi.advanceTimersByTime(PERSIST_FLUSH_TIMEOUT_MS)
    await expect(inflight).resolves.toBeUndefined()
    vi.useRealTimers()
  })

  it('在途请求期间再次 request 不重复投递（幂等）', async () => {
    const deliver = vi.fn(() => true)
    const r = createPersistFlushRequester({ deliver })
    const first = r.request()
    await Promise.resolve()
    await expect(r.request()).resolves.toBeUndefined() // 第二次立即返回
    expect(deliver).toHaveBeenCalledTimes(1)
    r.acknowledge()
    await first
  })

  it('超时后才到达的 ack 是 no-op（不抛、不二次 resolve）', async () => {
    vi.useFakeTimers()
    const r = createPersistFlushRequester({ deliver: () => true, timeoutMs: 100 })
    const inflight = r.request()
    await Promise.resolve()
    vi.advanceTimersByTime(100)
    await inflight
    expect(() => r.acknowledge()).not.toThrow()
    vi.useRealTimers()
  })
})
