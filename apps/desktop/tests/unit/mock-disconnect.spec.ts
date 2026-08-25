// tests/unit/mock-disconnect.spec.ts —— Task 4:mock-backend 断线模拟。
// 断言:disconnectAfterMs 到期 → error 态(lastError='mock-disconnect');手动 connect 恢复 connected;
// parseMockDisconnectAfterMsEnv env 解析正整数/空串/非法值。
import { describe, expect, it } from 'vitest'
import { MockBackend, parseMockDisconnectAfterMsEnv } from '../../src/main/transport/mock-backend'

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe('mock-backend 断线模拟（Task 4）', () => {
  it('disconnectAfterMs 到期 → error 态 + 手动 connect 恢复 connected', async () => {
    const states: Array<{ status: string; lastError?: string }> = []
    const b = new MockBackend({
      disconnectAfterMs: 10,
      onConnectionStateChange: (s) => states.push({ status: s.status, lastError: s.lastError })
    })
    await b.connect({ serverUrl: 'mock://test' })
    expect(b.getConnectionState().status).toBe('connected')

    await delay(30) // 等 > disconnectAfterMs

    expect(b.getConnectionState().status).toBe('error')
    expect(b.getConnectionState().lastError).toBe('mock-disconnect')
    // onConnectionStateChange 收到 error 帧（末态为 error）
    expect(states[states.length - 1]).toEqual({ status: 'error', lastError: 'mock-disconnect' })

    // 手动 reconnect:connect() 重置 errored=false + 发 connected
    await b.connect({ serverUrl: 'mock://test' })
    expect(b.getConnectionState().status).toBe('connected')
    expect(b.getConnectionState().lastError).toBeUndefined()
  })

  it('parseMockDisconnectAfterMsEnv:正整数 → n;空串/未设/0/负数/NaN → undefined', () => {
    expect(parseMockDisconnectAfterMsEnv('15')).toBe(15)
    expect(parseMockDisconnectAfterMsEnv(undefined)).toBeUndefined()
    expect(parseMockDisconnectAfterMsEnv('')).toBeUndefined()
    expect(parseMockDisconnectAfterMsEnv('0')).toBeUndefined()
    expect(parseMockDisconnectAfterMsEnv('-5')).toBeUndefined()
    expect(parseMockDisconnectAfterMsEnv('abc')).toBeUndefined()
  })
})
