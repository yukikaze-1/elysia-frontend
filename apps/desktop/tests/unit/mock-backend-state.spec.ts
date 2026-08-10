import { describe, expect, it } from 'vitest'
import { MockBackend } from '../../src/main/transport/mock-backend'

describe('MockBackend 连接状态', () => {
  it('getConnectionState 初始 disconnected,connect 后 connected', async () => {
    const b = new MockBackend()
    expect(b.getConnectionState().status).toBe('disconnected')
    await b.connect({ serverUrl: 'mock://test' })
    expect(b.getConnectionState().status).toBe('connected')
    await b.disconnect()
    expect(b.getConnectionState().status).toBe('disconnected')
  })

  it('connect/disconnect 触发 onConnectionStateChange', async () => {
    const states: string[] = []
    const b = new MockBackend({ onConnectionStateChange: (s) => states.push(s.status) })
    await b.connect({ serverUrl: 'mock://test' })
    await b.disconnect()
    expect(states).toContain('connected')
    expect(states).toContain('disconnected')
  })
})
