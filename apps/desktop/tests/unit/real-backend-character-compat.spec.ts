// FE-A2：RealBackend 连接边界的角色能力与身份分发回归。
// 证明 server_info 能力旗标是 literal true 且每次连接状态
// 采用整体替换，不把旧连接的 character feature 泄漏到 connecting/reconnecting/error。
import { describe, expect, it, vi } from 'vitest'
import { RealBackend, type WebSocketLike } from '../../src/main/transport/real-backend'
import type { BackendEvent } from '@shared/contracts'
import { CyreneErrorCode } from '@shared/errors'

class FakeWs {
  private readonly handlers = new Map<string, (arg?: unknown, arg2?: unknown) => void>()
  send = vi.fn()
  close = vi.fn()
  readyState = 1
  on(event: string, callback: (arg?: unknown, arg2?: unknown) => void): this {
    this.handlers.set(event, callback)
    return this
  }
  push(frame: unknown): void { this.handlers.get('message')?.(JSON.stringify(frame)) }
  trigger(event: string, arg?: unknown, arg2?: unknown): void { this.handlers.get(event)?.(arg, arg2) }
}

function pushHandshake(ws: FakeWs, features: Record<string, unknown>, connectionId = 'conn-1'): void {
  ws.push({ type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 0, byModel: {} } })
  ws.push({ type: 'server_info', protocol_version: '2.0', server_version: '0.4.0', features, services: {}, connectionId })
}

describe('RealBackend typed character features / connection replacement', () => {
  it('explicit connect rotates local scope while automatic socket reconnect keeps it', async () => {
    const sockets: FakeWs[] = []
    const backend = new RealBackend({
      now: () => Date.now(),
      reconnectBaseDelayMs: 1,
      wsFactory: () => {
        const socket = new FakeWs()
        sockets.push(socket)
        return socket as WebSocketLike
      }
    })
    const firstConnect = backend.connect({ serverUrl: 'http://scope.test', token: 'token-a' })
    pushHandshake(sockets[0]!, { character_profiles: true, character_state_stream: true }, 'reused-connection')
    await firstConnect
    const firstScope = backend.getConnectionState().connectionScopeId
    expect(firstScope).toEqual(expect.any(String))

    sockets[0]!.trigger('close')
    expect(backend.getConnectionState()).toMatchObject({ status: 'reconnecting', connectionScopeId: firstScope })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(sockets).toHaveLength(2)
    pushHandshake(sockets[1]!, { character_profiles: true, character_state_stream: true }, 'reused-connection')
    await vi.waitFor(() => expect(backend.getConnectionState().status).toBe('connected'))
    expect(backend.getConnectionState().connectionScopeId).toBe(firstScope)

    const secondConnect = backend.connect({ serverUrl: 'http://scope.test', token: 'token-b' })
    expect(backend.getConnectionState().status).toBe('connecting')
    const secondScope = backend.getConnectionState().connectionScopeId
    expect(secondScope).toEqual(expect.any(String))
    expect(secondScope).not.toBe(firstScope)
    pushHandshake(sockets[2]!, { character_profiles: true, character_state_stream: true }, 'reused-connection')
    await secondConnect
    await backend.disconnect()
  })

  it('只有 wire literal true 映射为 true，新的 server_info {} 整体替换为全 false', async () => {
    const ws = new FakeWs()
    const backend = new RealBackend({ now: () => Date.now(), wsFactory: () => ws as WebSocketLike })
    const connecting = backend.connect({ serverUrl: 'http://test.local', token: 'sk-test' })
    expect(backend.getConnectionState()).toMatchObject({ status: 'connecting' })
    pushHandshake(ws, {
      character_profiles: true,
      character_state_stream: 'true',
      unrelated: true
    })
    await connecting
    expect(backend.getConnectionState().features).toEqual({ characterProfiles: true, characterStateStream: false })

    // 同一连接再次收到空能力表时也必须全量替换，而不是浅合并保留旧 true。
    ws.push({ type: 'server_info', protocol_version: '2.0', server_version: '0.4.0', features: {}, services: {}, connectionId: 'conn-2' })
    expect(backend.getConnectionState().features).toEqual({ characterProfiles: false, characterStateStream: false })
    await backend.disconnect()
  })

  it('connected 后迁移到 connecting/reconnecting/error/disconnected 均不残留上一连接 features', async () => {
    const ws = new FakeWs()
    const backend = new RealBackend({
      now: () => Date.now(),
      wsFactory: () => ws as WebSocketLike,
      reconnectBaseDelayMs: 60_000
    })
    const first = backend.connect({ serverUrl: 'http://test.local', token: 'sk-test' })
    pushHandshake(ws, { character_profiles: true, character_state_stream: true })
    await first
    expect(backend.getConnectionState().features).toEqual({ characterProfiles: true, characterStateStream: true })

    ws.trigger('close')
    expect(backend.getConnectionState()).toMatchObject({ status: 'reconnecting' })
    expect(backend.getConnectionState().features).toBeUndefined()

    await backend.disconnect()
    expect(backend.getConnectionState()).toEqual({ status: 'disconnected' })

    const second = backend.connect({ serverUrl: 'http://test.local', token: 'sk-test' })
    expect(backend.getConnectionState()).toMatchObject({ status: 'connecting' })
    expect(backend.getConnectionState().features).toBeUndefined()
    pushHandshake(ws, {}, 'conn-2')
    await second
    expect(backend.getConnectionState().features).toEqual({ characterProfiles: false, characterStateStream: false })

    ws.trigger('unexpected-response', undefined, { statusCode: 401 })
    expect(backend.getConnectionState()).toMatchObject({ status: 'error' })
    expect(backend.getConnectionState().features).toBeUndefined()
    await backend.disconnect()
  })

  it('createConversation 将显式 characterId 透传到 REST；legacy 仍发送空对象', async () => {
    const ws = new FakeWs()
    const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
      void args
      return new Response(JSON.stringify({
        conversationId: 'conv-created', title: '角色会话', messageCount: 0,
        updatedAt: '2026-08-31T00:00:00.000Z', active: false
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const backend = new RealBackend({ now: () => Date.now(), wsFactory: () => ws as WebSocketLike, fetchImpl })
    const connecting = backend.connect({ serverUrl: 'http://test.local', token: 'sk-test' })
    pushHandshake(ws, { character_profiles: true })
    await connecting

    await backend.createConversation({ title: '角色会话', characterId: 'ch_elysia' })
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ title: '角色会话', characterId: 'ch_elysia' })
    await backend.createConversation({})
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({})
    await backend.disconnect()
  })

  it('显式 connect B 清除 A activeVoice；B 可用同 sessionId 开始 realtime', async () => {
    const sockets: FakeWs[] = []
    const backend = new RealBackend({
      now: () => Date.now(),
      wsFactory: () => {
        const socket = new FakeWs()
        sockets.push(socket)
        return socket as WebSocketLike
      }
    })
    const first = backend.connect({ serverUrl: 'http://scope.test', token: 'token-a' })
    pushHandshake(sockets[0]!, {}, 'reused-connection')
    await first
    await backend.startRealtimeVoice({ sessionId: 'same-session' })

    const second = backend.connect({ serverUrl: 'http://scope.test', token: 'token-b' })
    pushHandshake(sockets[1]!, {}, 'reused-connection')
    await second
    await expect(backend.startRealtimeVoice({ sessionId: 'same-session' })).resolves.toEqual({ sessionId: 'same-session' })
    await backend.disconnect()
  })

  it('显式 source boundary 明确 reject A pending ack/switch/voice，B 同 key 的结果独立结算', async () => {
    const sockets: FakeWs[] = []
    const backend = new RealBackend({
      now: () => Date.now(),
      wsFactory: () => {
        const socket = new FakeWs()
        sockets.push(socket)
        return socket as WebSocketLike
      }
    })
    const first = backend.connect({ serverUrl: 'http://scope.test', token: 'token-a' })
    pushHandshake(sockets[0]!, {}, 'reused-connection')
    await first

    const ackA = backend.sendMessage({ conversationId: 'conv-1', text: 'A', clientRequestId: 'same-request' })
    const switchA = backend.activateModelProfile({ profileId: 'same-model', service: 'llm' })
    const voiceA = backend.setTtsVoice({ voice: 'same-voice' })

    const second = backend.connect({ serverUrl: 'http://scope.test', token: 'token-b' })
    pushHandshake(sockets[1]!, {}, 'reused-connection')
    await second
    await expect(ackA).rejects.toMatchObject({ code: CyreneErrorCode.GENERATION_CONFLICT })
    await expect(switchA).rejects.toMatchObject({ code: CyreneErrorCode.GENERATION_CONFLICT })
    await expect(voiceA).rejects.toMatchObject({ code: CyreneErrorCode.GENERATION_CONFLICT })

    // A's socket remains able to receive a queued frame in this harness, but
    // its retired incarnation must not settle B's same-key operations.
    sockets[0]!.push({ type: 'user_message.ack', messageId: 'old', clientRequestId: 'same-request', receivedAt: '2026-09-01T00:00:00.000Z', status: 'accepted' })
    sockets[0]!.push({ type: 'switch_model_result', service: 'llm', model: 'same-model', ok: true })
    sockets[0]!.push({ type: 'set_tts_voice_result', voice: 'same-voice', ok: true })

    const ackB = backend.sendMessage({ conversationId: 'conv-1', text: 'B', clientRequestId: 'same-request' })
    const switchB = backend.activateModelProfile({ profileId: 'same-model', service: 'llm' })
    const voiceB = backend.setTtsVoice({ voice: 'same-voice' })
    sockets[1]!.push({ type: 'user_message.ack', messageId: 'new', clientRequestId: 'same-request', receivedAt: '2026-09-01T00:00:01.000Z', status: 'accepted' })
    sockets[1]!.push({ type: 'switch_model_result', service: 'llm', model: 'same-model', ok: true })
    sockets[1]!.push({ type: 'set_tts_voice_result', voice: 'same-voice', ok: true })
    await expect(ackB).resolves.toEqual({ clientRequestId: 'same-request', serverMessageId: 'new' })
    await expect(switchB).resolves.toBeUndefined()
    await expect(voiceB).resolves.toBeUndefined()
    await backend.disconnect()
  })

  it('显式 source boundary 清空 TTS buffer/mapper identity；B 同 streamId 只消费 B 音频', async () => {
    const sockets: FakeWs[] = []
    const sink = { putTtsAudio: vi.fn((_id: string, bytes: Uint8Array) => ({ url: `cyrene://tts/${bytes.length}` })) }
    const events: BackendEvent[] = []
    const backend = new RealBackend({
      now: () => Date.now(),
      getTtsMedia: () => sink,
      wsFactory: () => {
        const socket = new FakeWs()
        sockets.push(socket)
        return socket as WebSocketLike
      }
    })
    const first = backend.connect({ serverUrl: 'http://scope.test', token: 'token-a' })
    pushHandshake(sockets[0]!, {}, 'reused-connection')
    await first
    backend.subscribe((event) => events.push(event))
    sockets[0]!.push({ type: 'audio_start', stream_id: 7, format: 'wav', characterId: 'character-a', characterInstanceId: 'instance-a', characterRevision: 1 })
    sockets[0]!.push({ type: 'audio', stream_id: 7, seq: 0, data: Buffer.from([1]).toString('base64'), is_final: false })

    const second = backend.connect({ serverUrl: 'http://scope.test', token: 'token-b' })
    pushHandshake(sockets[1]!, {}, 'reused-connection')
    await second
    // No B audio_start: A's buffered chunk/identity cannot be completed by B.
    sockets[1]!.push({ type: 'audio_end', stream_id: 7, format: 'wav' })
    expect(sink.putTtsAudio).not.toHaveBeenCalled()

    sockets[1]!.push({ type: 'audio_start', stream_id: 7, format: 'wav', characterId: 'character-b', characterInstanceId: 'instance-b', characterRevision: 1 })
    sockets[1]!.push({ type: 'audio', stream_id: 7, seq: 0, data: Buffer.from([2]).toString('base64'), is_final: false })
    sockets[1]!.push({ type: 'audio_end', stream_id: 7, format: 'wav' })
    expect(sink.putTtsAudio).toHaveBeenCalledTimes(1)
    expect(Array.from(sink.putTtsAudio.mock.calls[0]![1])).toEqual([2])
    expect(events.find((event) => event.event === 'audio.session.ready')).toMatchObject({ characterId: 'character-b', characterInstanceId: 'instance-b' })
    await backend.disconnect()
  })

  it('显式 source boundary abort A REST；迟到 A 响应不能覆盖 B 请求', async () => {
    const sockets: FakeWs[] = []
    let call = 0
    let resolveB!: (response: Response) => void
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      if (call++ === 0) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
        })
      }
      return new Promise<Response>((resolve) => { resolveB = resolve })
    }) as unknown as typeof fetch
    const backend = new RealBackend({
      now: () => Date.now(),
      fetchImpl,
      wsFactory: () => {
        const socket = new FakeWs()
        sockets.push(socket)
        return socket as WebSocketLike
      }
    })
    const first = backend.connect({ serverUrl: 'http://scope.test', token: 'token-a' })
    pushHandshake(sockets[0]!, {}, 'reused-connection')
    await first
    const oldRequest = backend.listConversations({ limit: 10 })

    const second = backend.connect({ serverUrl: 'http://scope.test', token: 'token-b' })
    pushHandshake(sockets[1]!, {}, 'reused-connection')
    await second
    await expect(oldRequest).rejects.toMatchObject({ code: CyreneErrorCode.GENERATION_CONFLICT })

    const newRequest = backend.listConversations({ limit: 10 })
    resolveB(new Response(JSON.stringify({ sessions: [], has_more: false }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(newRequest).resolves.toEqual({ items: [], hasMore: false, nextCursor: undefined })
    await backend.disconnect()
  })

  it('RealBackend mapper 后为 character state/catalog 事件盖当前 desktop scope', async () => {
    const ws = new FakeWs()
    const events: BackendEvent[] = []
    const backend = new RealBackend({ now: () => Date.now(), wsFactory: () => ws as WebSocketLike })
    backend.subscribe((event) => events.push(event))
    const first = backend.connect({ serverUrl: 'http://scope.test', token: 'token-a' })
    pushHandshake(ws, {}, 'reused-connection')
    await first
    const scope = backend.getConnectionState().connectionScopeId
    ws.push({
      type: 'character.state.changed', conversationId: 'conv-1', characterId: 'character-a', characterInstanceId: 'instance-a', characterRevision: 1, stateVersion: 1,
      state: { mood: { label: '平静', intensity: 0.2, updatedAt: '2026-09-01T00:00:00.000Z' }, proactiveEnabled: false, updatedAt: '2026-09-01T00:00:00.000Z' }
    })
    ws.push({ type: 'character.catalog.changed', characterId: 'character-a', currentRevision: 1, status: 'active', updatedAt: '2026-09-01T00:00:00.000Z' })
    expect(events.filter((event) => event.event === 'character.state.changed' || event.event === 'character.catalog.changed')).toEqual([
      expect.objectContaining({ event: 'character.state.changed', connectionScopeId: scope }),
      expect.objectContaining({ event: 'character.catalog.changed', connectionScopeId: scope })
    ])
    await backend.disconnect()
  })
})
