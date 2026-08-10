import { describe, expect, it, vi } from 'vitest'
import { createChatService } from '../../src/main/chat/chat-service'
import { MockBackend } from '../../src/main/transport/mock-backend'

function makeDeps(overrides: Partial<Parameters<typeof createChatService>[0]> = {}) {
  const adapter = new MockBackend()
  const sent: { channel: string; payload: unknown }[] = []
  const deps = {
    adapter,
    send: vi.fn((channel: string, payload: unknown) => sent.push({ channel, payload })),
    getToken: () => 'sk-test',
    requireToken: false,   // mock 免 token 演示
    ...overrides
  }
  return { deps, sent }
}

describe('chat-service', () => {
  it('connect 转发 Adapter 并广播连接状态', async () => {
    const { deps, sent } = makeDeps()
    const svc = createChatService(deps)
    const session = await svc.connect({ serverUrl: 'mock://test' })
    expect(session.serverUrl).toBe('mock://test')
    // MockBackend connect 触发 onConnectionStateChange? —— 需 chat-service 在 connect 后主动推一次状态
    // 简化:chat-service 的 connect 调用后调 send('chat:state', adapter.getConnectionState())
    expect(sent.some((s) => s.channel === 'chat:state' && (s.payload as { status: string }).status === 'connected')).toBe(true)
    svc.dispose()
  })

  it('subscribe 的领域事件转发 chat:event', async () => {
    const { deps, sent } = makeDeps()
    const svc = createChatService(deps)
    await svc.connect({ serverUrl: 'mock://test' })
    const ref = await svc.send({ conversationId: 'conv-1001', text: 'hi', clientRequestId: 'c1' })
    expect(ref.clientRequestId).toBe('c1')
    await new Promise((r) => setTimeout(r, 35))   // P1-1:MockBackend 回放用 setTimeout 宏任务,须等待再断言
    expect(sent.some((s) => s.channel === 'chat:event')).toBe(true)
    svc.dispose()
  })

  it('connect 缺 token 且 requireToken=true → CREDENTIAL_UNAVAILABLE', async () => {
    const { deps } = makeDeps({ getToken: () => undefined, requireToken: true })
    const svc = createChatService(deps)
    await expect(svc.connect({ serverUrl: 'mock://test' })).rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })
  })
})
