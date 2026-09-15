// tests/unit/renderer-bootstrap.spec.ts
import { describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { createRendererBootstrap } from '../../src/renderer/src/bootstrap'
import type { BackendEvent, CharacterCatalogChangedEvent, CharacterStateChangedEvent, ConnectionState, SessionPersistenceState } from '@shared/contracts'

function makeFake() {
  const stateHandlers: Array<(s: ConnectionState) => void> = []
  const eventHandlers: Array<(e: BackendEvent) => void> = []
  const persistFlushHandlers: Array<() => void> = []   // H-04
  let resolveSnapshot: ((s: ConnectionState) => void) | undefined
  let rejectSnapshot: ((e: Error) => void) | undefined
  const api = {
    onChatEvent: vi.fn((h: (e: BackendEvent) => void) => { eventHandlers.push(h); return () => {} }),
    onChatState: vi.fn((h: (s: ConnectionState) => void) => { stateHandlers.push(h); return () => {} }),
    onChatReplay: vi.fn(() => () => {}),
    onChatError: vi.fn(() => () => {}),
    // H-04（2026-09-11）：退出前持久化 flush 契约——bootstrap.register() 会订阅它
    onPersistFlushRequest: vi.fn((h: () => void) => { persistFlushHandlers.push(h); return () => {} }),
    persistFlushDone: vi.fn(async () => {}),
    getConnectionState: vi.fn(() => new Promise<ConnectionState>((res, rej) => { resolveSnapshot = res; rejectSnapshot = rej })),
    hydratePersistence: vi.fn(async () => ({ drafts: [], scrollAnchors: {}, conversations: [], messageSnapshots: {} })), // G2 新增
    fireState: (s: ConnectionState) => stateHandlers.forEach((h) => h(s)),
    fireEvent: (e: BackendEvent) => eventHandlers.forEach((h) => h(e)),
    firePersistFlush: () => persistFlushHandlers.forEach((h) => h()),   // H-04
    resolveSnapshot: (s: ConnectionState) => resolveSnapshot?.(s),
    rejectSnapshot: (e: Error) => rejectSnapshot?.(e)
  }
  return api
}
function makeStores() {
  return {
    connection: { setState: vi.fn(), setError: vi.fn() },
    message: { applyEvent: vi.fn(), handleConnectionStateChange: vi.fn(), loadReplay: vi.fn(), setToolWorkActive: vi.fn() },
    conversation: { onConnected: vi.fn(async () => {}), onActiveConversationAppeared: vi.fn(async () => {}), setOfflineCache: vi.fn(), activateLocal: vi.fn(async () => {}) },
    draft: { hydrate: vi.fn(), flushAll: vi.fn(async () => {}) },                    // G2 新增；flushAll：H-04
    cache: { hydrate: vi.fn() },                    // G2 新增
    voice: { init: vi.fn(), reset: vi.fn() },       // P4-B Task 13
    settings: { hydrate: vi.fn(), flush: vi.fn(async () => {}) },                 // P4-B Task 13；flush：H-04
    layout: { flush: vi.fn() },                     // H-04
    identity: { setConnectionEpoch: vi.fn(), load: vi.fn(async () => {}) },
    characterCatalog: { setConnectionEpoch: vi.fn(), loadList: vi.fn(async () => {}), handleCatalogChanged: vi.fn(() => true) },
    characterEditor: { setConnectionEpoch: vi.fn(), setConnectionState: vi.fn(), handleCharacterArchived: vi.fn(async () => 0) },
    characterRuntime: { setConnectionEpoch: vi.fn(), handleStateChanged: vi.fn() },
    characterRuntimeCoordinator: { start: vi.fn() }
  }
}

describe('createRendererBootstrap（P0-01 水合编排）', () => {
  it('register 注册 4 订阅（onChatEvent/onChatState/onChatReplay/onChatError）', () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
    expect(api.onChatEvent).toHaveBeenCalled()
    expect(api.onChatState).toHaveBeenCalled()
    expect(api.onChatReplay).toHaveBeenCalled()
    expect(api.onChatError).toHaveBeenCalled()
  })
  it('connected snapshot → applyChatState 完整编排（setState+handleConnectionStateChange+onConnected+onActiveConversationAppeared）', async () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
    await Promise.resolve() // G2：getConnectionState 在 hydratePersistence.then 内异步调用，需先冲刷微任务
    api.resolveSnapshot({ status: 'connected', connectionId: 'c1', activeConversationId: 'conv1' })
    await Promise.resolve()
    expect(stores.connection.setState).toHaveBeenCalledWith({ status: 'connected', connectionId: 'c1', activeConversationId: 'conv1' })
    expect(stores.message.handleConnectionStateChange).toHaveBeenCalled()
    expect(stores.conversation.onConnected).toHaveBeenCalledWith('c1')
    expect(stores.conversation.onActiveConversationAppeared).toHaveBeenCalledWith('conv1')
  })
  it('disconnected snapshot → 不触发 onConnected/onActiveConversationAppeared（不制造假 connected）', async () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
    await Promise.resolve()
    api.resolveSnapshot({ status: 'disconnected' })
    await Promise.resolve()
    expect(stores.connection.setState).toHaveBeenCalledWith({ status: 'disconnected' })
    expect(stores.conversation.onConnected).not.toHaveBeenCalled()
    expect(stores.conversation.onActiveConversationAppeared).not.toHaveBeenCalled()
  })
  it('启动代次守卫：snapshot 等待期间收到 push → 迟到 snapshot 丢弃', async () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
    await Promise.resolve()
    api.fireState({ status: 'connected', connectionId: 'c2', activeConversationId: 'conv2' }) // push 先到
    api.resolveSnapshot({ status: 'disconnected' }) // 迟到旧 snapshot
    await Promise.resolve()
    // 只应用了 push 的 connected；迟到 snapshot 被丢弃
    expect(stores.connection.setState).toHaveBeenCalledTimes(1)
    expect(stores.connection.setState).toHaveBeenCalledWith({ status: 'connected', connectionId: 'c2', activeConversationId: 'conv2' })
    expect(stores.conversation.setOfflineCache).not.toHaveBeenCalled()
  })
  it('snapshot 拒绝 → setError(UNKNOWN) 且不调用 disconnect', async () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
    await Promise.resolve()
    api.rejectSnapshot(new Error('ipc failed'))
    await new Promise((r) => setTimeout(r, 0)) // .then().catch() 链需 2 个微任务冲刷（实测 1 次 flush 不够）
    expect(stores.connection.setError).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNKNOWN' }))
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 2026-09-16 审计 P1-2：工具活动 → 静默看门狗窗口的镜像
//
// 走 sync watch 而不是在工具事件旁路里补一次调用：桌面工具的 `awaiting_permission` 由
// `tool:event` → `toolStore.upsertLocal` 写入，**不经过** bootstrap 的 `chat:event` 旁路，
// 只在旁路里镜像会漏掉最需要覆盖的那条路径（等人工授权）。
// ═══════════════════════════════════════════════════════════════════════════════
describe('createRendererBootstrap（2026-09-16 审计 P1-2：工具活动镜像）', () => {
  function makeToolsDouble() {
    // 必须用 reactive 而非裸 ref：bootstrap 读的是 `tools.toolWorkActive`（Pinia setup store
    // 会把 ref 解包成值），裸 ref 在这里会是个恒真的对象，测出来的是假绿。
    return reactive({
      toolWorkActive: false,
      init: vi.fn(),
      applyBackendEvent: vi.fn(),
      clearForGeneration: vi.fn(),
      setActiveConversationId: vi.fn()
    })
  }

  it('注册即镜像初值，且工具活动变化同步生效（无需 flush）', () => {
    const api = makeFake(); const stores = makeStores()
    const tools = makeToolsDouble()
    createRendererBootstrap(api as never, { ...stores, tools } as never).register()

    expect(stores.message.setToolWorkActive).toHaveBeenLastCalledWith(false)

    tools.toolWorkActive = true
    expect(stores.message.setToolWorkActive).toHaveBeenLastCalledWith(true)

    tools.toolWorkActive = false
    expect(stores.message.setToolWorkActive).toHaveBeenLastCalledWith(false)
    expect(stores.message.setToolWorkActive).toHaveBeenCalledTimes(3)
  })

  it('未接线 toolStore 时镜像 false（不留下一个悬空的 true）', () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()

    expect(stores.message.setToolWorkActive).toHaveBeenCalledWith(false)
  })
})

const offlineState: SessionPersistenceState = {
  drafts: [{ conversationId: 'c1', text: '草稿', attachmentLocalIds: [], updatedAt: 't' }],
  scrollAnchors: {}, lastActiveConversationId: 'c1',
  conversations: [{ id: 'c1', title: 'A', updatedAt: 't' }],
  messageSnapshots: { c1: [] }
}

describe('G2 持久化水合 + 离线视图（spec §4.5.3 P1-1/P2-2）', () => {
  function makeG2Stores() {
    const stores = makeStores()
    return {
      ...stores,
      conversation: { ...stores.conversation, setOfflineCache: vi.fn(), activateLocal: vi.fn(async () => {}) }
    }
  }
  it('register 调 hydratePersistence 并水合 draft/cache store', async () => {
    const api = makeFake(); const stores = makeG2Stores()
    ;(api.hydratePersistence as ReturnType<typeof vi.fn>).mockResolvedValue(offlineState)
    createRendererBootstrap(api as never, stores as never).register()
    await Promise.resolve()
    expect(api.hydratePersistence).toHaveBeenCalled()
    expect(stores.draft.hydrate).toHaveBeenCalledWith(offlineState)
    expect(stores.cache.hydrate).toHaveBeenCalledWith(offlineState)
  })
  it('disconnected snapshot → setOfflineCache + activateLocal(lastActive)（离线视图可读，消息快照进 messageStore）', async () => {
    const api = makeFake(); const stores = makeG2Stores()
    ;(api.hydratePersistence as ReturnType<typeof vi.fn>).mockResolvedValue(offlineState)
    createRendererBootstrap(api as never, stores as never).register()
    await Promise.resolve()
    api.resolveSnapshot({ status: 'disconnected' })
    await Promise.resolve()
    expect(stores.conversation.setOfflineCache).toHaveBeenCalledWith(offlineState.conversations)
    expect(stores.conversation.activateLocal).toHaveBeenCalledWith('c1')
  })
  it('disconnected 且 lastActive 不在缓存 → 退化到 updatedAt 最近会话', async () => {
    const api = makeFake(); const stores = makeG2Stores()
    ;(api.hydratePersistence as ReturnType<typeof vi.fn>).mockResolvedValue({ ...offlineState, lastActiveConversationId: 'gone', conversations: [{ id: 'c2', title: 'B', updatedAt: 'z' }] })
    createRendererBootstrap(api as never, stores as never).register()
    await Promise.resolve()
    api.resolveSnapshot({ status: 'disconnected' })
    await Promise.resolve()
    expect(stores.conversation.activateLocal).toHaveBeenCalledWith('c2')
  })
  it('connected snapshot → 不激活离线视图、不把快照写进 messageStore（P2-2 缓存不进入 Store）', async () => {
    const api = makeFake(); const stores = makeG2Stores()
    ;(api.hydratePersistence as ReturnType<typeof vi.fn>).mockResolvedValue(offlineState)
    createRendererBootstrap(api as never, stores as never).register()
    await Promise.resolve()
    api.resolveSnapshot({ status: 'connected', connectionId: 'c1', activeConversationId: 'conv1' })
    await Promise.resolve()
    expect(stores.conversation.setOfflineCache).not.toHaveBeenCalled()
    expect(stores.conversation.activateLocal).not.toHaveBeenCalled()
    expect(stores.conversation.onConnected).toHaveBeenCalledWith('c1')
  })

  it('disconnected push → 迟到 connected snapshot 仍按最后已应用状态离线水合', async () => {
    const api = makeFake(); const stores = makeG2Stores()
    ;(api.hydratePersistence as ReturnType<typeof vi.fn>).mockResolvedValue(offlineState)
    createRendererBootstrap(api as never, stores as never).register()
    await Promise.resolve()
    api.fireState({ status: 'disconnected' })
    api.resolveSnapshot({ status: 'connected', connectionId: 'stale-connected' })
    await Promise.resolve()
    expect(stores.connection.setState).toHaveBeenCalledTimes(1)
    expect(stores.connection.setState).toHaveBeenCalledWith({ status: 'disconnected' })
    expect(stores.conversation.setOfflineCache).toHaveBeenCalledWith(offlineState.conversations)
    expect(stores.conversation.activateLocal).toHaveBeenCalledWith('c1')
  })
})

describe('P4-B Task 13：voice/settings 接线 + 断线 reset（Important-2）', () => {
  it('register 调 settings.hydrate + voice.init（P4-B 并行水合与独立订阅接线）', async () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
    expect(stores.settings.hydrate).toHaveBeenCalled()
    expect(stores.voice.init).toHaveBeenCalled()
  })
  it('connected push → 不调 voice.reset（语音会话在连接内保持）', async () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
    api.fireState({ status: 'connected', connectionId: 'c1' })
    expect(stores.voice.reset).not.toHaveBeenCalled()
  })
  it('connected → disconnected 状态迁移 → 调 voice.reset（断线停采集/取消会话/清态/停 TTS）', async () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
    api.fireState({ status: 'connected', connectionId: 'c1' })
    expect(stores.voice.reset).not.toHaveBeenCalled()
    api.fireState({ status: 'disconnected' })
    expect(stores.voice.reset).toHaveBeenCalledTimes(1)
  })
  it('初始 disconnected snapshot（启动离线）→ 不调 voice.reset（非离开 connected 语义）', async () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
    await Promise.resolve()
    api.resolveSnapshot({ status: 'disconnected' })
    await Promise.resolve()
    expect(stores.voice.reset).not.toHaveBeenCalled()
  })
})

describe('FE-C 角色档案/目录 bootstrap', () => {
  it('聊天 connected 不依赖角色能力；角色能力 false/undefined 不加载，legacy 无 scope 的重复 connected 按新来源重新加载', async () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
    api.fireState({ status: 'connected', connectionId: 'legacy-c1' })
    api.fireState({ status: 'connected', connectionId: 'legacy-c1', features: { characterProfiles: false, characterStateStream: false } })
    expect(stores.conversation.onConnected).toHaveBeenCalledTimes(2)
    expect(stores.identity.load).not.toHaveBeenCalled()
    expect(stores.characterCatalog.loadList).not.toHaveBeenCalled()

    api.fireState({ status: 'connected', connectionId: 'legacy-c1', features: { characterProfiles: true, characterStateStream: false } })
    await Promise.resolve()
    expect(stores.identity.setConnectionEpoch).toHaveBeenCalledWith(1)
    expect(stores.characterCatalog.setConnectionEpoch).toHaveBeenCalledWith(1)
    expect(stores.identity.load).toHaveBeenCalledWith(true)
    expect(stores.characterCatalog.loadList).toHaveBeenCalledWith({ status: 'active' }, { force: true })

    api.fireState({ status: 'connected', connectionId: 'legacy-c1', features: { characterProfiles: true, characterStateStream: false } })
    // A legacy adapter cannot prove that a direct connected→connected notice
    // belongs to the same account/backend, so bootstrap fences it as a new
    // source even when every visible connection field is unchanged.
    expect(stores.identity.load).toHaveBeenCalledTimes(2)
    expect(stores.characterCatalog.loadList).toHaveBeenCalledTimes(2)
  })

  it('concrete source 才抑制重复 connected；legacy 无 scope 每次 direct connected 都推进新世代，true→false 仍推进 epoch', async () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
    api.fireState({ status: 'connected', connectionId: 'character-c1', features: { characterProfiles: true, characterStateStream: false } })
    api.fireState({ status: 'connected', connectionId: 'character-c1', features: { characterProfiles: true, characterStateStream: false } })
    api.fireState({ status: 'connected', connectionId: 'character-c2', features: { characterProfiles: true, characterStateStream: false } })
    api.fireState({ status: 'connected', connectionId: 'character-c2', features: { characterProfiles: true, characterStateStream: false } })
    api.fireState({ status: 'connected', connectionId: 'character-c2', features: { characterProfiles: false, characterStateStream: false } })
    expect(stores.identity.setConnectionEpoch).toHaveBeenLastCalledWith(5)
    expect(stores.characterCatalog.setConnectionEpoch).toHaveBeenLastCalledWith(5)
    api.fireState({ status: 'disconnected' })
    await Promise.resolve()
    expect(stores.identity.setConnectionEpoch).toHaveBeenLastCalledWith(5)
    expect(stores.characterCatalog.setConnectionEpoch).toHaveBeenLastCalledWith(5)
    expect(stores.identity.load).toHaveBeenCalledTimes(4)
    expect(stores.characterCatalog.loadList).toHaveBeenCalledTimes(4)
    expect(stores.characterEditor.setConnectionState).toHaveBeenCalledTimes(6)
    expect(stores.characterEditor.setConnectionState).toHaveBeenNthCalledWith(1, 'connected', { characterProfiles: true, characterStateStream: false })
    expect(stores.characterEditor.setConnectionState).toHaveBeenLastCalledWith('disconnected', undefined)
    expect(stores.connection.setError).not.toHaveBeenCalled()
  })

  it('character.catalog.changed 只有 catalog 接受才触发 editor 归档清理且不进入消息流', async () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
    // Catalog events are consumed only while the character capability is
    // active; this fixture intentionally exercises the legacy no-scope path.
    api.fireState({ status: 'connected', features: { characterProfiles: true, characterStateStream: false } })
    const event: CharacterCatalogChangedEvent = {
      event: 'character.catalog.changed', eventId: 'catalog-archived', sequence: 1,
      characterId: 'custom/archived', currentRevision: 4, status: 'archived', updatedAt: '2026-09-01T00:00:00.000Z'
    }
    stores.characterCatalog.handleCatalogChanged.mockReturnValueOnce(false)
    api.fireEvent(event)
    await Promise.resolve()
    expect(stores.characterEditor.handleCharacterArchived).not.toHaveBeenCalled()
    expect(stores.message.applyEvent).not.toHaveBeenCalled()

    stores.characterCatalog.handleCatalogChanged.mockReturnValueOnce(true)
    api.fireEvent(event)
    await Promise.resolve()
    expect(stores.characterEditor.handleCharacterArchived).toHaveBeenCalledWith('custom/archived')
    expect(stores.message.applyEvent).not.toHaveBeenCalled()

    stores.characterEditor.handleCharacterArchived.mockImplementationOnce(() => { throw new Error('cleanup sync failure') })
    expect(() => api.fireEvent(event)).not.toThrow()
  })

  it('同 connectionId 但 endpoint 或 state-stream capability 改变时推进角色连接世代，并启动 coordinator', async () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
    expect(stores.characterRuntimeCoordinator.start).toHaveBeenCalledTimes(1)

    api.fireState({ status: 'connected', serverUrl: 'http://127.0.0.1:8765/', connectionId: 'reused', features: { characterProfiles: true, characterStateStream: true } })
    api.fireState({ status: 'connected', serverUrl: 'http://127.0.0.1:9765/', connectionId: 'reused', features: { characterProfiles: true, characterStateStream: true } })
    expect(stores.characterRuntime.setConnectionEpoch).toHaveBeenNthCalledWith(1, 1)
    expect(stores.characterRuntime.setConnectionEpoch).toHaveBeenNthCalledWith(2, 2)
    expect(stores.identity.setConnectionEpoch).toHaveBeenLastCalledWith(2)
    expect(stores.characterCatalog.setConnectionEpoch).toHaveBeenLastCalledWith(2)
  })

  it('custom scheme 使用 protocol/host/path 规范化；同 connectionId 的 mock://a→mock://b 推进 epoch', () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
    api.fireState({ status: 'connected', serverUrl: 'mock://a/runtime///', connectionId: 'reused', features: { characterProfiles: true, characterStateStream: false } })
    api.fireState({ status: 'connected', serverUrl: 'mock://b/runtime/', connectionId: 'reused', features: { characterProfiles: true, characterStateStream: false } })
    expect(stores.characterRuntime.setConnectionEpoch).toHaveBeenNthCalledWith(1, 1)
    expect(stores.characterRuntime.setConnectionEpoch).toHaveBeenNthCalledWith(2, 2)
  })

  it('concrete connectionScopeId 先交给 runtime：同 scope 重连保留来源，新 scope 在 connected 前切换', () => {
    const api = makeFake()
    const base = makeStores()
    const setConnectionScopeId = vi.fn()
    const stores = {
      ...base,
      characterRuntime: { ...base.characterRuntime, setConnectionScopeId }
    }
    createRendererBootstrap(api as never, stores as never).register()

    api.fireState({ status: 'connecting', connectionScopeId: 'scope-a' })
    api.fireState({ status: 'connected', connectionScopeId: 'scope-a', features: { characterProfiles: true, characterStateStream: true } })
    api.fireState({ status: 'reconnecting', connectionScopeId: 'scope-a' })
    api.fireState({ status: 'connected', connectionScopeId: 'scope-a', features: { characterProfiles: true, characterStateStream: true } })
    api.fireState({ status: 'connecting', connectionScopeId: 'scope-b' })

    expect(setConnectionScopeId).toHaveBeenNthCalledWith(1, 'scope-a')
    expect(setConnectionScopeId).toHaveBeenNthCalledWith(2, 'scope-a')
    expect(setConnectionScopeId).toHaveBeenNthCalledWith(3, 'scope-a')
    expect(setConnectionScopeId).toHaveBeenNthCalledWith(4, 'scope-a')
    expect(setConnectionScopeId).toHaveBeenNthCalledWith(5, 'scope-b')
    expect(stores.characterRuntime.setConnectionEpoch).toHaveBeenCalledTimes(4)
  })

  it('legacy 无 scope 直接重复 connected 也按新来源清理并推进 epoch', () => {
    const api = makeFake()
    const base = makeStores()
    const setConnectionScopeId = vi.fn()
    const stores = {
      ...base,
      characterRuntime: { ...base.characterRuntime, setConnectionScopeId }
    }
    createRendererBootstrap(api as never, stores as never).register()

    const state = { status: 'connected' as const, serverUrl: 'http://legacy.local', connectionId: 'reused', features: { characterProfiles: true, characterStateStream: true } }
    api.fireState(state)
    api.fireState(state)

    expect(setConnectionScopeId).toHaveBeenNthCalledWith(1, undefined, true)
    expect(setConnectionScopeId).toHaveBeenNthCalledWith(2, undefined, true)
    expect(stores.characterRuntime.setConnectionEpoch).toHaveBeenNthCalledWith(1, 1)
    expect(stores.characterRuntime.setConnectionEpoch).toHaveBeenNthCalledWith(2, 2)
  })

  it('character state/catalog 事件按 concrete scope 栅栏：排队的 A 在 B 切换后丢弃，B 接受', () => {
    const api = makeFake()
    const base = makeStores()
    const setConnectionScopeId = vi.fn()
    const stores = {
      ...base,
      characterRuntime: { ...base.characterRuntime, setConnectionScopeId }
    }
    createRendererBootstrap(api as never, stores as never).register()
    const stateEvent = (scope: string, version: number): CharacterStateChangedEvent => ({
      event: 'character.state.changed', eventId: `state-${scope}-${version}`, sequence: version,
      connectionScopeId: scope, conversationId: 'conv-a', characterId: 'builtin/elysia', characterInstanceId: 'instance-a',
      characterRevision: 1, stateVersion: version,
      state: { currentActivity: scope, proactiveEnabled: false, updatedAt: '2026-09-01T00:00:00.000Z' }
    })
    const catalogEvent = (scope: string, revision: number): CharacterCatalogChangedEvent => ({
      event: 'character.catalog.changed', eventId: `catalog-${scope}-${revision}`, sequence: revision,
      connectionScopeId: scope, characterId: 'builtin/elysia', currentRevision: revision,
      status: 'active', updatedAt: '2026-09-01T00:00:00.000Z'
    })

    api.fireState({ status: 'connected', connectionScopeId: 'scope-a', features: { characterProfiles: true, characterStateStream: true } })
    const oldState = stateEvent('scope-a', 9)
    const oldCatalog = catalogEvent('scope-a', 9)
    api.fireState({ status: 'connecting', connectionScopeId: 'scope-b' })
    api.fireState({ status: 'connected', connectionScopeId: 'scope-b', features: { characterProfiles: true, characterStateStream: true } })
    api.fireEvent(oldState)
    api.fireEvent(oldCatalog)
    api.fireEvent(stateEvent('scope-b', 1))
    api.fireEvent(catalogEvent('scope-b', 1))
    // A concrete current source must reject even a missing event scope.
    api.fireEvent({ ...stateEvent('scope-b', 2), connectionScopeId: undefined })
    api.fireEvent({ ...catalogEvent('scope-b', 2), connectionScopeId: undefined })

    expect(stores.characterRuntime.handleStateChanged).toHaveBeenCalledTimes(1)
    expect(stores.characterRuntime.handleStateChanged).toHaveBeenCalledWith(expect.objectContaining({ connectionScopeId: 'scope-b', stateVersion: 1 }), 3)
    expect(stores.characterCatalog.handleCatalogChanged).toHaveBeenCalledTimes(1)
    expect(stores.characterCatalog.handleCatalogChanged).toHaveBeenCalledWith(expect.objectContaining({ connectionScopeId: 'scope-b', currentRevision: 1 }))
  })

  it('character.state.changed 只旁路 runtime，不进入 messageStore；stream 能力关闭时丢弃', () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
    const event: CharacterStateChangedEvent = {
      event: 'character.state.changed', eventId: 'state-1', sequence: 1,
      conversationId: 'conv-a', characterId: 'builtin/elysia', characterInstanceId: 'instance-a',
      characterRevision: 1, stateVersion: 1,
      state: { mood: { label: '平静', intensity: 0.4, updatedAt: '2026-09-01T00:00:00.000Z' }, proactiveEnabled: false, updatedAt: '2026-09-01T00:00:00.000Z' }
    }

    api.fireState({ status: 'connected', connectionId: 'c1', features: { characterProfiles: true, characterStateStream: true } })
    api.fireEvent(event)
    expect(stores.characterRuntime.handleStateChanged).toHaveBeenCalledWith(event, 1)
    expect(stores.message.applyEvent).not.toHaveBeenCalled()

    api.fireState({ status: 'connected', connectionId: 'c1', features: { characterProfiles: true, characterStateStream: false } })
    api.fireEvent({ ...event, eventId: 'state-2', sequence: 2, stateVersion: 2 })
    expect(stores.characterRuntime.handleStateChanged).toHaveBeenCalledTimes(1)
    expect(stores.message.applyEvent).not.toHaveBeenCalled()
  })

  // —— H-04（2026-09-11）：Main 在 before-quit 发 flush 请求 → bootstrap flush 各 store → 回 ack ——
  it('收到 flush 请求：flush 全部防抖 store 并回 ack', async () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
    api.firePersistFlush()
    await vi.waitFor(() => expect(api.persistFlushDone).toHaveBeenCalledTimes(1))
    expect(stores.draft.flushAll).toHaveBeenCalledTimes(1)
    expect(stores.settings.flush).toHaveBeenCalledTimes(1)
    expect(stores.layout.flush).toHaveBeenCalledTimes(1)
  })

  it('某个 store flush 失败也照样回 ack（fail-open——否则 Main 只能空等满超时预算）', async () => {
    const api = makeFake(); const stores = makeStores()
    stores.draft.flushAll = vi.fn(async () => { throw new Error('persist failed') })
    createRendererBootstrap(api as never, stores as never).register()
    api.firePersistFlush()
    await vi.waitFor(() => expect(api.persistFlushDone).toHaveBeenCalledTimes(1))
    expect(stores.settings.flush).toHaveBeenCalledTimes(1) // 其余 store 不受影响
  })
})
