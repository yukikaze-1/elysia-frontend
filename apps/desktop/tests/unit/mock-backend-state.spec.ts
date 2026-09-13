import { describe, expect, it, vi } from 'vitest'
import { MockBackend } from '../../src/main/transport/mock-backend'
import { MockCharacterBackend } from '../../src/main/characters/mock-character-backend'
import type { BackendEvent, CharacterDraft } from '@shared/contracts'

function mockCharacterDraft(displayName: string, themeColor = '#88aaff'): CharacterDraft {
  return {
    displayName, description: '动态绑定测试', aliases: ['动态'],
    promptProfile: {
      corePersonality: '可靠', relationshipStyle: '平等', emotionStyle: '', speakingStyle: '自然',
      conversationInitiative: '', examples: []
    },
    runtimeDefaults: {
      voice: {}, emotion: { idleExpressions: [] }, wakeWords: [displayName],
      proactive: { enabled: false, intervalSeconds: 3600, triggers: [] }
    },
    presentation: { themeColor }, openingMessage: '你好'
  }
}

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

  it('显式 connect 每次生成新的本地 connectionScopeId（同 endpoint 也不复用）', async () => {
    const backend = new MockBackend()
    await backend.connect({ serverUrl: 'mock://same-endpoint' })
    const first = backend.getConnectionState().connectionScopeId
    await backend.connect({ serverUrl: 'mock://same-endpoint' })
    const second = backend.getConnectionState().connectionScopeId
    expect(first).toEqual(expect.any(String))
    expect(second).toEqual(expect.any(String))
    expect(second).not.toBe(first)
    await backend.disconnect()
  })

  it('Mock 延迟 role event 在显式换源后丢弃旧事件，并为 B 事件盖 B scope', async () => {
    const fixtureRaw = [
      JSON.stringify({
        eventId: 'fixture-state', sequence: 1, event: 'character.state.changed', conversationId: 'conv-1001',
        characterId: 'character-a', characterInstanceId: 'instance-a', characterRevision: 1, stateVersion: 1,
        state: { proactiveEnabled: false, updatedAt: '2026-09-01T00:00:00.000Z' }
      }),
      JSON.stringify({
        eventId: 'fixture-catalog', sequence: 2, event: 'character.catalog.changed', characterId: 'character-a',
        currentRevision: 1, status: 'active', updatedAt: '2026-09-01T00:00:00.000Z'
      })
    ].join('\n')
    const backend = new MockBackend({ fixtureRaw, emitDelayMs: 10 })
    const events: BackendEvent[] = []
    backend.subscribe((event) => events.push(event))

    await backend.connect({ serverUrl: 'mock://test', token: 'token-a' })
    const scopeA = backend.getConnectionState().connectionScopeId
    await backend.sendMessage({ conversationId: 'conv-1001', text: 'A', clientRequestId: 'a' })
    await backend.connect({ serverUrl: 'mock://test', token: 'token-b' })
    const scopeB = backend.getConnectionState().connectionScopeId
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(events).toHaveLength(0)

    await backend.sendMessage({ conversationId: 'conv-1001', text: 'B', clientRequestId: 'b' })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(events).toHaveLength(2)
    expect(scopeA).not.toBe(scopeB)
    expect(events).toEqual([
      expect.objectContaining({ event: 'character.state.changed', connectionScopeId: scopeB }),
      expect.objectContaining({ event: 'character.catalog.changed', connectionScopeId: scopeB })
    ])
    backend.dispose()
  })

  it('FE-E1 角色能力 Mock 注入连接 features 与不可变会话 binding', async () => {
    const binding = {
      characterId: 'builtin/elysia',
      characterInstanceId: 'instance-elysia',
      characterRevision: 1,
      displayName: 'Elysia',
      presentation: { themeColor: '#f2a7c6' }
    }
    const backend = new MockBackend({
      features: { characterProfiles: true, characterStateStream: true },
      characterBindings: { [binding.characterId]: binding },
      idFactory: () => 'bound-mock'
    })
    await backend.connect({ serverUrl: 'mock://test' })
    expect(backend.getConnectionState().features).toEqual({ characterProfiles: true, characterStateStream: true })
    const created = await backend.createConversation({ characterId: binding.characterId })
    expect(created.character).toEqual(binding)
    created.character!.displayName = '调用方改写'
    expect((await backend.listConversations({})).items.at(-1)?.character?.displayName).toBe('Elysia')
    await expect(backend.createConversation({})).rejects.toMatchObject({ details: { backendCode: 'CHARACTER_REQUIRED' } })
    await expect(backend.createConversation({ characterId: 'missing' })).rejects.toMatchObject({ details: { backendCode: 'CHARACTER_NOT_FOUND' } })
  })

  it('FE-E1 resolver 按请求读取运行期角色：创建/更新取新快照，旧会话不可变，归档后禁止新建', async () => {
    const characters = new MockCharacterBackend()
    let nextId = 0
    const backend = new MockBackend({
      features: characters.features,
      // 启动时只用于预置内置历史会话；新建始终走运行期 resolver。
      characterBindings: characters.getConversationBindings(),
      characterBindingResolver: (characterId) => characters.getConversationBinding(characterId),
      idFactory: () => `dynamic-conv-${++nextId}`
    })
    await backend.connect({ serverUrl: 'mock://test' })

    const created = await characters.createCharacter({ draft: mockCharacterDraft('初版角色') })
    const first = await backend.createConversation({ characterId: created.summary.characterId })
    expect(first.character).toMatchObject({ displayName: '初版角色', characterRevision: 1 })

    await characters.updateCharacter({
      characterId: created.summary.characterId, expectedRevision: 1, statePolicy: 'preserve', draft: mockCharacterDraft('新版角色', '#ff88aa')
    })
    const second = await backend.createConversation({ characterId: created.summary.characterId })
    expect(second.character).toMatchObject({ displayName: '新版角色', characterRevision: 2, presentation: { themeColor: '#ff88aa' } })
    expect((await backend.listConversations({})).items.find((item) => item.id === first.id)?.character).toMatchObject({ displayName: '初版角色', characterRevision: 1 })

    await characters.archiveCharacter(created.summary.characterId)
    await expect(backend.createConversation({ characterId: created.summary.characterId })).rejects.toMatchObject({ details: { backendCode: 'CHARACTER_NOT_FOUND' } })
  })

  it('FE-E2 profile-enabled generation 事件在各自会话开始时捕获最新 binding tuple', async () => {
    const characters = new MockCharacterBackend()
    let nextId = 0
    const backend = new MockBackend({
      features: characters.features,
      characterBindings: characters.getConversationBindings(),
      characterBindingResolver: (characterId) => characters.getConversationBinding(characterId),
      emitDelayMs: 0,
      idFactory: () => `e2-${++nextId}`
    })
    await backend.connect({ serverUrl: 'mock://test' })
    const created = await characters.createCharacter({ draft: mockCharacterDraft('旧 revision') })
    const oldConversation = await backend.createConversation({ characterId: created.summary.characterId })
    await characters.updateCharacter({
      characterId: created.summary.characterId, expectedRevision: 1, statePolicy: 'preserve', draft: mockCharacterDraft('新 revision', '#ff88aa')
    })
    const newConversation = await backend.createConversation({ characterId: created.summary.characterId })
    const events: BackendEvent[] = []
    backend.subscribe((event) => events.push(event))
    await backend.sendMessage({ conversationId: oldConversation.id, text: 'old', clientRequestId: 'old-request' })
    await new Promise((resolve) => setTimeout(resolve, 15))
    await backend.sendMessage({ conversationId: newConversation.id, text: 'new', clientRequestId: 'new-request' })
    await new Promise((resolve) => setTimeout(resolve, 15))
    const started = events.filter((event): event is Extract<BackendEvent, { event: 'generation.started' }> => event.event === 'generation.started')
    expect(started).toHaveLength(2)
    expect(started[0]).toMatchObject({ conversationId: oldConversation.id, characterId: created.summary.characterId, characterRevision: 2 })
    expect(started[1]).toMatchObject({ conversationId: newConversation.id, characterId: created.summary.characterId, characterRevision: 2 })
    const completed = events.filter((event): event is Extract<BackendEvent, { event: 'generation.completed' }> => event.event === 'generation.completed')
    expect(completed.map((event) => event.characterRevision)).toEqual([2, 2])
    backend.dispose()
  })

  it('FE-E2 同一 follow_latest 会话：编辑发生在途时本轮保留旧 revision，下一轮原子捕获新 revision', async () => {
    const characters = new MockCharacterBackend()
    const backend = new MockBackend({
      features: characters.features,
      characterBindings: characters.getConversationBindings(),
      characterBindingResolver: (characterId) => characters.getConversationBinding(characterId),
      emitDelayMs: 8,
      idFactory: (() => { let n = 0; return () => `follow-${++n}` })()
    })
    await backend.connect({ serverUrl: 'mock://test' })
    const created = await characters.createCharacter({ draft: mockCharacterDraft('首版') })
    const conversation = await backend.createConversation({ characterId: created.summary.characterId })
    const events: BackendEvent[] = []
    backend.subscribe((event) => events.push(event))

    await backend.sendMessage({ conversationId: conversation.id, text: '首轮', clientRequestId: 'first' })
    await vi.waitFor(() => expect(events.some((event) => event.event === 'generation.started')).toBe(true))
    await characters.updateCharacter({
      characterId: created.summary.characterId, expectedRevision: 1, statePolicy: 'preserve', draft: mockCharacterDraft('二版', '#ff88aa')
    })
    await new Promise((resolve) => setTimeout(resolve, 110))
    const firstGeneration = events.filter((event) => event.event === 'generation.started' || event.event === 'generation.completed')
    expect(firstGeneration).toHaveLength(2)
    expect(firstGeneration.every((event) => event.characterRevision === 1)).toBe(true)

    await backend.sendMessage({ conversationId: conversation.id, text: '下一轮', clientRequestId: 'second' })
    await vi.waitFor(() => expect(events.filter((event) => event.event === 'generation.started')).toHaveLength(2))
    const started = events.filter((event): event is Extract<BackendEvent, { event: 'generation.started' }> => event.event === 'generation.started')
    expect(started[1]).toMatchObject({ conversationId: conversation.id, characterId: created.summary.characterId, characterInstanceId: conversation.character?.characterInstanceId, characterRevision: 2 })
    expect((await backend.listConversations({})).items.find((item) => item.id === conversation.id)?.character).toMatchObject({ displayName: '二版', characterRevision: 2 })
    backend.dispose()
  })

  it('FE-E2 profile generation.failed 与 started 共享捕获的 immutable tuple', async () => {
    const characters = new MockCharacterBackend()
    const binding = characters.getConversationBindings()['builtin/elysia']
    const backend = new MockBackend({
      features: characters.features,
      characterBindings: characters.getConversationBindings(),
      fixtureRaw: [
        JSON.stringify({ eventId: 'fixture-start', sequence: 1, event: 'generation.started', generationId: 'fixture-generation', messageId: 'fixture-message', responseId: 'fixture-response', conversationId: 'conv-1001' }),
        JSON.stringify({ eventId: 'fixture-failed', sequence: 2, event: 'generation.failed', generationId: 'fixture-generation', messageId: 'fixture-message', error: { code: 'MOCK_FAILED', message: 'mock failure' } })
      ].join('\n'),
      emitDelayMs: 0,
      idFactory: (() => { let n = 0; return () => `failed-${++n}` })()
    })
    await backend.connect({ serverUrl: 'mock://test' })
    const events: BackendEvent[] = []
    backend.subscribe((event) => events.push(event))
    await backend.sendMessage({ conversationId: 'conv-1001', text: '失败', clientRequestId: 'failed-request' })
    await vi.waitFor(() => expect(events.some((event) => event.event === 'generation.failed')).toBe(true))
    const started = events.find((event): event is Extract<BackendEvent, { event: 'generation.started' }> => event.event === 'generation.started')
    const failed = events.find((event): event is Extract<BackendEvent, { event: 'generation.failed' }> => event.event === 'generation.failed')
    expect(started).toMatchObject({ characterId: binding.characterId, characterInstanceId: binding.characterInstanceId, characterRevision: binding.characterRevision })
    expect(failed).toMatchObject({ characterId: started?.characterId, characterInstanceId: started?.characterInstanceId, characterRevision: started?.characterRevision })
    backend.dispose()
  })

  it('FE-E2 重连同会话时，旧 incarnation 的延迟 replay 不得进入新连接', async () => {
    const fixtureRaw = [
      JSON.stringify({ eventId: 'fixture-start', sequence: 1, event: 'generation.started', generationId: 'fixture-generation', messageId: 'fixture-message', responseId: 'fixture-response', conversationId: 'conv-1001' }),
      JSON.stringify({ eventId: 'fixture-complete', sequence: 2, event: 'generation.completed', generationId: 'fixture-generation', messageId: 'fixture-message', responseId: 'fixture-response' })
    ].join('\n')
    const backend = new MockBackend({ fixtureRaw, emitDelayMs: 20, idFactory: (() => { let n = 0; return () => `inc-${++n}` })() })
    const events: BackendEvent[] = []
    backend.subscribe((event) => events.push(event))

    await backend.connect({ serverUrl: 'mock://test' })
    await backend.sendMessage({ conversationId: 'conv-1001', text: 'old', clientRequestId: 'old-request' })
    // simulateDisconnect intentionally leaves already scheduled timers in
    // place: the incarnation fence, rather than timer cancellation, is what
    // proves delayed callbacks from A cannot leak into B.
    ;(backend as unknown as { simulateDisconnect: () => void }).simulateDisconnect()
    await backend.connect({ serverUrl: 'mock://test' })
    await backend.sendMessage({ conversationId: 'conv-1001', text: 'new', clientRequestId: 'new-request' })
    await new Promise((resolve) => setTimeout(resolve, 45))

    expect(events.filter((event) => event.event === 'generation.started')).toHaveLength(1)
    expect(events.filter((event) => event.event === 'generation.completed')).toHaveLength(1)
    await backend.disconnect()
  })
})

describe('MockBackend 附件确定性（spec §3.2 MockBackend 需扩展）', () => {
  it('uploadAttachments 返回确定性 AttachmentInfo（kind 权威，size 用客户端声明）', async () => {
    const mb = new MockBackend({ now: () => new Date('2026-08-14T00:00:00Z') })
    await mb.connect({ serverUrl: 'mock://local' })
    const infos = await mb.uploadAttachments([{ name: 'a.png', mediaType: 'image/png', size: 2, bytes: new Uint8Array([0x89, 0x50]) }])
    expect(infos).toHaveLength(1)
    expect(infos[0].attachmentId).toMatch(/^att_/)
    expect(infos[0].kind).toBe('image')
    expect(infos[0].size).toBe(2)
    expect(infos[0].url).toMatch(/^\/api\/attachments\/att_/)
    expect(infos[0].filename).toBe('a.png')
  })
  it('signAttachmentUrl 返回假签名 URL（可解析、expiresAt 为注入时钟 ISO）', async () => {
    const mb = new MockBackend({ now: () => new Date('2026-08-14T00:00:00Z') })
    await mb.connect({ serverUrl: 'mock://local' })
    const r = await mb.signAttachmentUrl('att_1')
    expect(r.url).toContain('/api/attachments/att_1?')
    expect(r.url).toContain('sig=')
    expect(r.expiresAt).toBe('2026-08-14T00:00:00.000Z')
  })
})
