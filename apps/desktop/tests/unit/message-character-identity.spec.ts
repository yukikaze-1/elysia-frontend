// FE-E2：消息生成/回放的角色身份不可变快照。
// 这些测试只消费 Renderer domain contract；raw→domain 的形状另由 frame/rest mapper 测试覆盖。
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConnectionStore } from '../../src/renderer/src/stores/connection.store'
import { useConversationStore } from '../../src/renderer/src/stores/conversation.store'
import { useMessageStore } from '../../src/renderer/src/stores/message.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { createDesktopApiMock } from './helpers/desktop-api'
import type {
  BackendEvent,
  CharacterBindingSnapshot,
  CharacterGenerationRef,
  GenerationCompletedEvent,
  GenerationStartedEvent,
  Message
} from '@shared/contracts'

// I-06 / P2-10：原为 `{ cacheMessages: vi.fn().mockResolvedValue(undefined) } as never` 的单键 mock。
const mockApi = createDesktopApiMock()

const binding: CharacterBindingSnapshot = {
  characterId: 'custom/elysia',
  characterInstanceId: 'instance-elysia-v2',
  characterRevision: 2,
  displayName: 'Elysia',
  presentation: { themeColor: '#f2a7c6' }
}

function generationIdentity(overrides: Partial<CharacterGenerationRef> = {}): CharacterGenerationRef {
  return { ...binding, ...overrides }
}

function started(overrides: Partial<GenerationStartedEvent> = {}): GenerationStartedEvent {
  return {
    eventId: 'event-started',
    sequence: 1,
    event: 'generation.started',
    generationId: 'generation-1',
    messageId: 'message-1',
    responseId: 'response-1',
    conversationId: 'conversation-1',
    characterId: binding.characterId,
    characterInstanceId: binding.characterInstanceId,
    characterRevision: binding.characterRevision,
    ...overrides
  }
}

function completed(overrides: Partial<GenerationCompletedEvent> = {}): GenerationCompletedEvent {
  return {
    eventId: 'event-completed',
    sequence: 2,
    event: 'generation.completed',
    generationId: 'generation-1',
    messageId: 'message-1',
    responseId: 'response-1',
    usage: { input: 1, output: 2, total: 3, source: 'provider_reported' },
    model: 'test-model',
    characterId: binding.characterId,
    characterInstanceId: binding.characterInstanceId,
    characterRevision: binding.characterRevision,
    ...overrides
  }
}

function assistantMessage(id: string, character?: CharacterGenerationRef): Message {
  return {
    messageId: id,
    conversationId: 'conversation-1',
    role: 'assistant',
    status: 'completed',
    createdAt: '2026-08-31T01:00:00.000Z',
    assistantSegments: [],
    ...(character ? { character } : {})
  }
}

function enableProfiles(): void {
  useConnectionStore().setState({
    status: 'connected',
    serverUrl: 'http://backend.test',
    connectionId: 'connection-1',
    features: { characterProfiles: true, characterStateStream: false }
  })
  useConversationStore().$patch({
    currentId: 'conversation-1',
    items: [{ id: 'conversation-1', title: 'Elysia chat', updatedAt: '2026-08-31T01:00:00.000Z', character: binding }]
  })
}

describe('messageStore FE-E2 角色生成身份', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setDesktopApi(mockApi)
  })

  it('profiles=true：started 必须匹配当前 immutable binding，并把 binding 深拷贝为消息快照', () => {
    enableProfiles()
    const store = useMessageStore()
    store.applyEvent(started())

    expect(store.byId['message-1']?.character).toEqual(binding)
    expect(store.generationIdentityById['generation-1']).toMatchObject({
      conversationId: 'conversation-1',
      characterId: binding.characterId,
      characterInstanceId: binding.characterInstanceId,
      characterRevision: binding.characterRevision
    })
    const conversation = useConversationStore()
    conversation.items[0]!.character!.displayName = '目录新名字'
    expect(store.byId['message-1']?.character?.displayName).toBe('Elysia')
  })

  it('profiles=true：started 缺失或冲突身份 fail-closed，不创建 assistant 消息', () => {
    enableProfiles()
    const store = useMessageStore()
    store.applyEvent(started({ generationId: 'missing', messageId: 'missing', characterRevision: undefined }))
    store.applyEvent(started({ generationId: 'wrong', messageId: 'wrong', characterId: 'custom/cyrene' }))
    expect(store.byId.missing).toBeUndefined()
    expect(store.byId.wrong).toBeUndefined()
    expect(store.generationIdentityById.missing).toBeUndefined()
    expect(store.generationByConversation.missing).toBeUndefined()
    expect(store.droppedEvents).toBe(2)
  })

  it('generation segment 只沿 generationId 关联的消息，terminal 身份冲突进入协议失败终态并清理活动代', () => {
    enableProfiles()
    const store = useMessageStore()
    store.applyEvent(started())
    store.applyEvent({ ...completed({ characterRevision: 3 }), event: 'generation.failed', error: { code: 'BAD', message: 'wrong identity' } } as BackendEvent)
    expect(store.byId['message-1']?.status).toBe('failed')
    expect(store.activeGenerationId).toBeUndefined()
    expect(store.generationIdentityById['generation-1']).toBeUndefined()
    // The late valid terminal for the old generation cannot revive it.
    store.applyEvent(completed())
    expect(store.byId['message-1']?.status).toBe('failed')
    store.applyEvent(started({ generationId: 'generation-2', messageId: 'message-2' }))
    store.applyEvent(completed({ generationId: 'generation-2', messageId: 'message-2' }))
    expect(store.byId['message-2']?.status).toBe('completed')
  })

  it('profiles=true：REST/replay assistant 缺失或冲突快照被丢弃，合法快照按同 messageId 覆盖临时结果', () => {
    enableProfiles()
    const store = useMessageStore()
    store.loadReplay('conversation-1', [
      assistantMessage('invalid-missing'),
      assistantMessage('invalid-wrong', generationIdentity({ characterId: 'custom/cyrene' }))
    ])
    expect(store.byId['invalid-missing']).toBeUndefined()
    expect(store.byId['invalid-wrong']).toBeUndefined()

    // A profile-enabled replay page is atomic: the valid item in a malformed
    // batch must not be partially committed.  A clean page can still carry a
    // historical revision snapshot and be replaced by REST authority.
    store.loadReplay('conversation-1', [assistantMessage('same-message', generationIdentity({ displayName: '临时名字' }))])
    expect(store.byId['same-message']?.character?.displayName).toBe('临时名字')

    store.loadPage({
      items: [assistantMessage('same-message', generationIdentity({ displayName: '服务器权威名字' }))],
      hasMore: false
    })
    expect(store.byId['same-message']?.character?.displayName).toBe('服务器权威名字')
    expect(store.order).toEqual(['same-message'])
  })

  it('切换会话后迟到 generation 不污染新会话，legacy profiles=false 仍接受无身份事件', () => {
    enableProfiles()
    const store = useMessageStore()
    store.applyEvent(started())
    const conversations = useConversationStore()
    conversations.$patch({ currentId: 'conversation-2' })
    store.resetConversation('conversation-2')
    store.applyEvent(started())
    expect(store.byId['message-1']).toBeUndefined()

    // 迁移期 legacy：没有角色能力/绑定时，原有 generation 行为不受影响。
    useConnectionStore().setState({ status: 'connected', connectionId: 'legacy-connection' })
    conversations.$patch({ currentId: 'conversation-1', items: [] })
    store.applyEvent(started({ generationId: 'legacy-generation', messageId: 'legacy-message', characterId: undefined, characterInstanceId: undefined, characterRevision: undefined }))
    expect(store.byId['legacy-message']).toMatchObject({ role: 'assistant', status: 'streaming' })
    expect(store.byId['legacy-message']?.character).toBeUndefined()
  })

  it('连接世代变化立即失效旧 generation，迟到 terminal/segment 不得触碰新代', () => {
    enableProfiles()
    const store = useMessageStore()
    const conversations = useConversationStore()
    store.applyEvent(started())

    const connection = useConnectionStore()
    connection.setState({
      status: 'connected', serverUrl: 'http://backend.next', connectionId: 'connection-2',
      features: { characterProfiles: true, characterStateStream: false }
    })
    store.handleConnectionStateChange(connection.state)
    expect(store.connectionEpoch).toBe(1)
    expect(store.byId['message-1']?.status).toBe('interrupted')
    expect(store.generationIdentityById['generation-1']).toBeUndefined()

    store.applyEvent({ ...started({ generationId: 'generation-2', messageId: 'message-2' }), sequence: 10 })
    store.applyEvent({ ...completed({ generationId: 'generation-1', messageId: 'message-1' }), sequence: 11 })
    store.applyEvent({ ...completed({ generationId: 'generation-2', messageId: 'message-2' }), sequence: 12 })
    expect(store.byId['message-1']?.status).toBe('interrupted')
    expect(store.byId['message-2']?.status).toBe('completed')
    expect(conversations.currentId).toBe('conversation-1')
  })

  it('历史不同 revision 只要 characterId+instanceId 相同即可保留服务端快照；旧缓存缺 character 仍可读', () => {
    enableProfiles()
    const store = useMessageStore()
    const old = assistantMessage('old-revision', generationIdentity({ characterRevision: 1, displayName: '旧版本' }))
    store.loadReplay('conversation-1', [old])
    expect(store.byId['old-revision']?.character).toMatchObject({ characterRevision: 1, displayName: '旧版本' })

    const legacyCached = assistantMessage('legacy-cache')
    store.loadSnapshot('conversation-1', [legacyCached])
    expect(store.byId['legacy-cache']?.character).toBeUndefined()
  })

  it('replay/pending/snapshot 逐条校验原始 conversationId，坏批次不改写或半提交', () => {
    enableProfiles()
    const store = useMessageStore()
    const mismatched = { ...assistantMessage('wrong-conversation', binding), conversationId: 'conversation-2' }
    store.loadReplay('conversation-1', [mismatched])
    expect(store.byId['wrong-conversation']).toBeUndefined()
    expect(store.pendingReplay).toBeUndefined()
    expect(store.lastError?.code).toBe('MESSAGE_PROTOCOL_MISMATCH')

    const conversations = useConversationStore()
    conversations.$patch({ currentId: undefined })
    store.loadReplay('conversation-1', [assistantMessage('pending-valid', binding)])
    expect(store.pendingReplay?.conversationId).toBe('conversation-1')
    store.loadSnapshot('conversation-1', [{ ...assistantMessage('snapshot-wrong', binding), conversationId: 'conversation-2' }])
    expect(store.byId['snapshot-wrong']).toBeUndefined()
    expect(store.pendingReplay?.conversationId).toBe('conversation-1')
  })

  it('权威同 messageId 修正 createdAt 后按 (createdAt,messageId) 稳定重排', () => {
    enableProfiles()
    const store = useMessageStore()
    const first = { ...assistantMessage('late', binding), createdAt: '2026-09-01T02:00:00.000Z' }
    const second = { ...assistantMessage('early', binding), createdAt: '2026-09-01T03:00:00.000Z' }
    store.loadPage({ items: [first, second], hasMore: false })
    expect(store.order).toEqual(['late', 'early'])
    store.loadPage({ items: [{ ...first, createdAt: '2026-09-01T04:00:00.000Z' }], hasMore: false })
    expect(store.order).toEqual(['early', 'late'])
  })

  it('profile-enabled 连接进入 reconnecting 后仍 fail-closed，重新 connected=false 才恢复 legacy', () => {
    enableProfiles()
    const store = useMessageStore()
    // Prime the capability latch with a valid profile-mode read.
    store.loadReplay('conversation-1', [assistantMessage('prime', binding)])
    useConnectionStore().setState({ status: 'reconnecting', connectionId: 'connection-1' })
    store.loadReplay('conversation-1', [assistantMessage('late-replay')])
    expect(store.byId['late-replay']).toBeUndefined()

    useConnectionStore().setState({ status: 'connected', connectionId: 'connection-2', features: { characterProfiles: false, characterStateStream: false } })
    store.loadReplay('conversation-1', [assistantMessage('legacy-replay')])
    expect(store.byId['legacy-replay']).toBeDefined()
  })
})
