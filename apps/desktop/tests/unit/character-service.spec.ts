import { describe, expect, it, vi } from 'vitest'
import { CyreneError, CyreneErrorCode } from '../../src/shared/errors'
import type { CharacterServiceBackendPort } from '../../src/main/characters/character-backend-port'
import { CharacterService, CHARACTER_SERVICE_BACKEND_CODES } from '../../src/main/characters/character-service'
import { MockCharacterBackend } from '../../src/main/characters/mock-character-backend'

function makePort(): { port: CharacterServiceBackendPort; mock: MockCharacterBackend } {
  const mock = new MockCharacterBackend()
  return {
    mock,
    port: {
      getMe: vi.fn(() => mock.getMe()),
      updateMe: vi.fn((input) => mock.updateMe(input)),
      listCharacters: vi.fn((input) => mock.listCharacters(input)),
      getCharacter: vi.fn((id) => mock.getCharacter(id)),
      createCharacter: vi.fn((input) => mock.createCharacter(input)),
      updateCharacter: vi.fn((input) => mock.updateCharacter(input)),
      cloneCharacter: vi.fn((input) => mock.cloneCharacter(input)),
      archiveCharacter: vi.fn((id) => mock.archiveCharacter(id)),
      rollbackCharacter: vi.fn((input) => mock.rollbackCharacter(input)),
      validateCharacter: vi.fn((draft) => mock.validateCharacter(draft)),
      previewCharacter: vi.fn((input) => mock.previewCharacter(input)),
      listCharacterRevisions: vi.fn((input) => mock.listCharacterRevisions(input)),
      getCharacterState: vi.fn((id) => mock.getCharacterState(id)),
      resetCharacterEvolution: vi.fn((input) => mock.resetCharacterEvolution(input))
    }
  }
}

describe('CharacterService 角色编排', () => {
  it('生产连接门禁优先于 feature 判断，离线角色读写统一返回 NOT_CONNECTED', async () => {
    const { port, mock } = makePort()
    const service = new CharacterService({
      backend: port,
      isConnected: () => false,
      getFeatures: () => mock.features
    })
    await expect(service.getMe()).rejects.toMatchObject({
      code: CyreneErrorCode.NOT_CONNECTED,
      details: { backendCode: CHARACTER_SERVICE_BACKEND_CODES.backendUnavailable }
    })
    await expect(service.archiveCharacter('builtin/elysia')).rejects.toMatchObject({
      code: CyreneErrorCode.NOT_CONNECTED,
      details: { backendCode: CHARACTER_SERVICE_BACKEND_CODES.backendUnavailable }
    })
    expect(port.getMe).not.toHaveBeenCalled()
    expect(port.archiveCharacter).not.toHaveBeenCalled()
  })

  it('能力缺省/关闭时稳定拒绝，不调用后端端口', async () => {
    const { port } = makePort()
    const service = new CharacterService({ backend: port, getFeatures: () => undefined })
    await expect(service.getMe()).rejects.toMatchObject({ code: CyreneErrorCode.NOT_IMPLEMENTED })
    // 用 rejects 而非 try/catch：原写法的断言在 catch 内，listCharacters 一旦「不再拒绝」就没有任何断言执行，
    // 测试反而变绿（审查 2026-09-10 实测）。
    await expect(service.listCharacters()).rejects.toMatchObject({
      details: { backendCode: CHARACTER_SERVICE_BACKEND_CODES.profilesUnavailable }
    })
    expect(port.getMe).not.toHaveBeenCalled()
    expect(port.listCharacters).not.toHaveBeenCalled()
  })

  it('FE-D1 mutation 同对象互斥、写后旧 GET 不复活，preview 连接迟到拒绝', async () => {
    let epoch = 1
    const { port, mock } = makePort()
    const service = new CharacterService({ backend: port, getFeatures: () => mock.features, getConnectionEpoch: () => epoch })
    const created = await service.createCharacter({
      draft: {
        displayName: 'D1', description: '', aliases: [],
        promptProfile: { corePersonality: '真诚', relationshipStyle: '朋友', emotionStyle: '', speakingStyle: '自然', conversationInitiative: '', examples: [] },
        runtimeDefaults: { voice: {}, emotion: { idleExpressions: [] }, wakeWords: ['D1'], proactive: { enabled: false, intervalSeconds: 3600, triggers: [] } },
        presentation: {}
      }
    })
    let resolveOld: ((value: typeof created) => void) | undefined
    port.getCharacter = vi.fn(() => new Promise<typeof created>((resolve) => { resolveOld = resolve }))
    const oldRead = service.getCharacter(created.summary.characterId)
    await Promise.resolve()
    await Promise.resolve()
    const updateInput = {
      characterId: created.summary.characterId, expectedRevision: 1, statePolicy: 'preserve' as const,
      draft: { ...created.current, displayName: 'D1-v2' }
    }
    delete (updateInput.draft as { characterId?: string }).characterId
    delete (updateInput.draft as { revision?: number }).revision
    for (const key of ['schemaVersion', 'checksum', 'compilerVersion', 'createdBy', 'createdAt'] as const) delete (updateInput.draft as Record<string, unknown>)[key]
    const updated = await service.updateCharacter(updateInput)
    resolveOld?.(created)
    await oldRead
    vi.mocked(port.getCharacter).mockImplementationOnce(() => mock.getCharacter(created.summary.characterId))
    expect((await service.getCharacter(created.summary.characterId)).current.revision).toBe(updated.character.current.revision)
    expect(port.getCharacter).toHaveBeenCalledTimes(2)

    let release: (() => void) | undefined
    vi.mocked(port.updateCharacter).mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(updated) }))
    const first = service.updateCharacter({ ...updateInput, expectedRevision: 2 })
    await expect(service.archiveCharacter(created.summary.characterId)).rejects.toMatchObject({ details: { backendCode: CHARACTER_SERVICE_BACKEND_CODES.mutationInProgress } })
    await Promise.resolve()
    await Promise.resolve()
    release?.(); await first

    let resolvePreview: ((value: Awaited<ReturnType<MockCharacterBackend['previewCharacter']>>) => void) | undefined
    vi.mocked(port.previewCharacter).mockImplementationOnce(() => new Promise((resolve) => { resolvePreview = resolve }))
    const preview = service.previewCharacter({ draft: updateInput.draft, userMessage: 'test' })
    await Promise.resolve()
    await Promise.resolve()
    epoch = 2
    resolvePreview?.({ ephemeral: true, reply: 'late' })
    await expect(preview).rejects.toMatchObject({ details: { backendCode: CHARACTER_SERVICE_BACKEND_CODES.staleConnection } })
  })

  it('同键 GET 去重并在 TTL 内命中缓存，同时不把调用方改写带回缓存', async () => {
    const deferred: { resolve: (value: Awaited<ReturnType<MockCharacterBackend['getMe']>>) => void } = {} as never
    const { port, mock } = makePort()
    port.getMe = vi.fn(() => new Promise<Awaited<ReturnType<MockCharacterBackend['getMe']>>>(
      (resolve) => { deferred.resolve = resolve }
    ))
    let now = 1000
    const service = new CharacterService({ backend: port, getFeatures: () => mock.features, now: () => now, cacheTtlMs: 100 })

    const first = service.getMe()
    const second = service.getMe()
    await Promise.resolve()
    expect(port.getMe).toHaveBeenCalledTimes(1)
    const source = await mock.getMe()
    deferred.resolve(source)
    const a = await first
    const b = await second
    expect(a).toEqual(b)
    a.displayName = '调用方改写'
    const cached = await service.getMe()
    expect(cached.displayName).toBe(source.displayName)
    expect(port.getMe).toHaveBeenCalledTimes(1)

    now += 101
    vi.mocked(port.getMe).mockImplementationOnce(() => mock.getMe())
    await service.getMe()
    expect(port.getMe).toHaveBeenCalledTimes(2)
  })

  it('连接 epoch 变化时丢弃迟到响应，旧结果既不返回也不进入缓存', async () => {
    let epoch = 1
    let resolveOld: ((value: Awaited<ReturnType<MockCharacterBackend['getMe']>>) => void) | undefined
    const { port, mock } = makePort()
    port.getMe = vi.fn(() => new Promise<Awaited<ReturnType<MockCharacterBackend['getMe']>>>(
      (resolve) => { resolveOld = resolve }
    ))
    const service = new CharacterService({ backend: port, getFeatures: () => mock.features, getConnectionEpoch: () => epoch })
    const old = service.getMe()
    await Promise.resolve()
    // 注入 provider 后 setter 不得永久遮蔽真实 provider；后续 provider 推进仍应失效旧请求。
    service.setConnectionEpoch(99)
    epoch = 2
    resolveOld?.(await mock.getMe())
    await expect(old).rejects.toMatchObject({ details: { backendCode: CHARACTER_SERVICE_BACKEND_CODES.staleConnection } })

    port.getMe = vi.fn(() => mock.getMe())
    const current = await service.getMe()
    expect(current.userId).toBe('user-mock')
    expect(port.getMe).toHaveBeenCalledTimes(1)
  })

  it('同键 state GET 的旧世代在途请求不阻塞新世代读取，也不污染新缓存', async () => {
    let epoch = 1
    const { port, mock } = makePort()
    type State = Awaited<ReturnType<MockCharacterBackend['getCharacterState']>>
    const resolvers: Array<(value: State) => void> = []
    port.getCharacterState = vi.fn(() => new Promise<State>((resolve) => { resolvers.push(resolve) }))
    const service = new CharacterService({ backend: port, getFeatures: () => mock.features, getConnectionEpoch: () => epoch })

    const oldRead = service.getCharacterState('instance-elysia')
    await Promise.resolve()
    await Promise.resolve()
    expect(port.getCharacterState).toHaveBeenCalledTimes(1)

    epoch = 2
    const freshRead = service.getCharacterState('instance-elysia')
    await Promise.resolve()
    await Promise.resolve()
    // syncEpoch releases the old same-key registration before starting the
    // new one; an old unresolved promise must never dedupe the new epoch.
    expect(port.getCharacterState).toHaveBeenCalledTimes(2)

    const source = await mock.getCharacterState('instance-elysia')
    const freshState = { ...source, stateVersion: source.stateVersion + 1 }
    resolvers[1]?.(freshState)
    await expect(freshRead).resolves.toMatchObject({ stateVersion: freshState.stateVersion })

    const oldState = { ...source, stateVersion: source.stateVersion }
    resolvers[0]?.(oldState)
    await expect(oldRead).rejects.toMatchObject({
      code: CyreneErrorCode.NOT_CONNECTED,
      details: { backendCode: CHARACTER_SERVICE_BACKEND_CODES.staleConnection }
    })

    const cached = await service.getCharacterState('instance-elysia')
    expect(cached.stateVersion).toBe(freshState.stateVersion)
    expect(port.getCharacterState).toHaveBeenCalledTimes(2)
  })

  it('reset evolution 受能力/epoch/实例互斥保护，并只失效目标 state cache', async () => {
    let epoch = 1
    const { port, mock } = makePort()
    const service = new CharacterService({ backend: port, getFeatures: () => mock.features, getConnectionEpoch: () => epoch })

    await service.getMe()
    await service.listCharacters()
    await service.getCharacter('builtin/elysia')
    await service.getCharacterState('instance-elysia')
    await service.getCharacterState('instance-cyrene')

    await expect(service.resetCharacterEvolution({ characterInstanceId: 'instance-elysia', expectedStateVersion: 1 }))
      .resolves.toMatchObject({ state: { stateVersion: 2 }, resetFields: expect.arrayContaining(['mood']) })

    await service.getMe()
    await service.listCharacters()
    await service.getCharacter('builtin/elysia')
    await service.getCharacterState('instance-elysia')
    await service.getCharacterState('instance-cyrene')
    expect(port.getMe).toHaveBeenCalledTimes(1)
    expect(port.listCharacters).toHaveBeenCalledTimes(1)
    expect(port.getCharacter).toHaveBeenCalledTimes(1)
    expect(port.getCharacterState).toHaveBeenCalledTimes(3)

    let release: ((value: Awaited<ReturnType<MockCharacterBackend['resetCharacterEvolution']>>) => void) | undefined
    vi.mocked(port.resetCharacterEvolution).mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const pending = service.resetCharacterEvolution({ characterInstanceId: 'instance-cyrene', expectedStateVersion: 1 })
    await Promise.resolve()
    await Promise.resolve()
    await expect(service.resetCharacterEvolution({ characterInstanceId: 'instance-cyrene', expectedStateVersion: 1 }))
      .rejects.toMatchObject({ details: { backendCode: CHARACTER_SERVICE_BACKEND_CODES.mutationInProgress } })

    epoch = 2
    release?.(await mock.resetCharacterEvolution({ characterInstanceId: 'instance-cyrene', expectedStateVersion: 1 }))
    await expect(pending).rejects.toMatchObject({ details: { backendCode: CHARACTER_SERVICE_BACKEND_CODES.staleConnection } })

    const disabled = new CharacterService({ backend: port, getFeatures: () => undefined })
    await expect(disabled.resetCharacterEvolution({ characterInstanceId: 'instance-elysia', expectedStateVersion: 2 }))
      .rejects.toMatchObject({ details: { backendCode: CHARACTER_SERVICE_BACKEND_CODES.profilesUnavailable } })
    expect(port.resetCharacterEvolution).toHaveBeenCalledTimes(2)
  })

  it('reset 旧世代迟到安全失败且不自动重放；新世代先读 state 再使用新的 expectedStateVersion', async () => {
    let epoch = 1
    const { port, mock } = makePort()
    const service = new CharacterService({ backend: port, getFeatures: () => mock.features, getConnectionEpoch: () => epoch })
    const initial = await service.getCharacterState('instance-elysia')

    let resolveLate: ((value: Awaited<ReturnType<MockCharacterBackend['resetCharacterEvolution']>>) => void) | undefined
    vi.mocked(port.resetCharacterEvolution).mockImplementationOnce(() => new Promise((resolve) => { resolveLate = resolve }))
    const staleReset = service.resetCharacterEvolution({
      characterInstanceId: 'instance-elysia',
      expectedStateVersion: initial.stateVersion
    })
    await Promise.resolve()
    await Promise.resolve()

    epoch = 2
    // Resolve the old backend operation only to model a late response.  The
    // service must discard it and must not retry this side-effecting command.
    const lateResult = await mock.resetCharacterEvolution({
      characterInstanceId: 'instance-elysia',
      expectedStateVersion: initial.stateVersion
    })
    resolveLate?.(lateResult)
    await expect(staleReset).rejects.toMatchObject({
      code: CyreneErrorCode.NOT_CONNECTED,
      details: { backendCode: CHARACTER_SERVICE_BACKEND_CODES.staleConnection }
    })
    expect(port.resetCharacterEvolution).toHaveBeenCalledTimes(1)

    // A new epoch must establish a fresh state version before issuing another
    // reset.  This second call is explicit, never a framework replay.
    const freshState = await service.getCharacterState('instance-elysia')
    expect(freshState.stateVersion).toBe(lateResult.state.stateVersion)
    const next = await service.resetCharacterEvolution({
      characterInstanceId: 'instance-elysia',
      expectedStateVersion: freshState.stateVersion
    })
    expect(port.resetCharacterEvolution).toHaveBeenCalledTimes(2)
    expect(port.resetCharacterEvolution).toHaveBeenNthCalledWith(2, {
      characterInstanceId: 'instance-elysia',
      expectedStateVersion: freshState.stateVersion
    })
    expect(next.state.stateVersion).toBe(freshState.stateVersion + 1)
  })

  it('clearCache 使在途结果不再复用或回填缓存，但不伪装成连接变化错误', async () => {
    const { port, mock } = makePort()
    const resolvers: Array<(value: Awaited<ReturnType<MockCharacterBackend['getMe']>>) => void> = []
    port.getMe = vi.fn(() => new Promise<Awaited<ReturnType<MockCharacterBackend['getMe']>>>((resolve) => { resolvers.push(resolve) }))
    const service = new CharacterService({ backend: port, getFeatures: () => mock.features })

    const oldRead = service.getMe()
    await Promise.resolve()
    service.clearCache()

    const oldValue = await mock.getMe()
    oldValue.displayName = '旧在途结果'
    resolvers[0](oldValue)
    await expect(oldRead).resolves.toMatchObject({ displayName: '旧在途结果' })

    // 旧结果已返回但未回填 cache；清除后的首次读取必须再次触碰 backend。
    const freshRead = service.getMe()
    await Promise.resolve()
    expect(port.getMe).toHaveBeenCalledTimes(2)
    const freshValue = await mock.getMe()
    freshValue.displayName = '清除后新结果'
    resolvers[1](freshValue)
    await expect(freshRead).resolves.toMatchObject({ displayName: '清除后新结果' })

    const cached = await service.getMe()
    expect(cached.displayName).toBe('清除后新结果')
    expect(port.getMe).toHaveBeenCalledTimes(2)
  })

  it('角色 mutation 不会因另一个角色的 opaque cursor 文本而失效 revision cache', async () => {
    const { port, mock } = makePort()
    const draft = (name: string) => ({
      displayName: name, description: '', aliases: [],
      promptProfile: { corePersonality: '真诚', relationshipStyle: '朋友', emotionStyle: '', speakingStyle: '自然', conversationInitiative: '', examples: [] },
      runtimeDefaults: { voice: {}, emotion: { idleExpressions: [] }, wakeWords: [name], proactive: { enabled: false, intervalSeconds: 3600, triggers: [] } },
      presentation: {}
    })
    const target = await mock.createCharacter({ draft: draft('target') })
    const other = await mock.createCharacter({ draft: draft('other') })
    port.listCharacterRevisions = vi.fn(() => Promise.resolve({ items: [], hasMore: false }))
    const service = new CharacterService({ backend: port, getFeatures: () => mock.features })
    const query = { characterId: other.summary.characterId, cursor: target.summary.characterId }
    await service.listCharacterRevisions(query)
    await service.listCharacterRevisions(query)
    expect(port.listCharacterRevisions).toHaveBeenCalledTimes(1)

    await service.archiveCharacter(target.summary.characterId)
    await service.listCharacterRevisions(query)
    expect(port.listCharacterRevisions).toHaveBeenCalledTimes(1)
  })

  it('后端 CyreneError 的 code 与 backendCode 原样保留', async () => {
    const { port, mock } = makePort()
    const backendError = new CyreneError(CyreneErrorCode.BACKEND_REJECTED, '后端拒绝', { backendCode: 'CHARACTER_BUSY' })
    port.getCharacter = vi.fn(() => Promise.reject(backendError))
    const service = new CharacterService({ backend: port, getFeatures: () => mock.features })
    await expect(service.getCharacter('builtin/elysia')).rejects.toBe(backendError)
  })

  it('updateMe 使用 capability/epoch 门并在成功后精确失效 profile/catalog 缓存', async () => {
    const { port, mock } = makePort()
    const service = new CharacterService({ backend: port, getFeatures: () => mock.features })
    const profile = await service.getMe()
    await service.listCharacters({ status: 'active' })
    await service.getCharacter('builtin/elysia')
    expect(port.getMe).toHaveBeenCalledTimes(1)
    expect(port.listCharacters).toHaveBeenCalledTimes(1)
    expect(port.getCharacter).toHaveBeenCalledTimes(1)

    const updated = await service.updateMe({
      expectedRevision: profile.revision,
      displayName: '新的旅行者',
      locale: profile.locale,
      timezone: profile.timezone,
      defaultCharacterId: 'builtin/cyrene'
    })
    expect(updated).toMatchObject({ displayName: '新的旅行者', revision: profile.revision + 1, defaultCharacterId: 'builtin/cyrene' })

    await service.getMe()
    await service.listCharacters({ status: 'active' })
    await service.getCharacter('builtin/elysia')
    expect(port.getMe).toHaveBeenCalledTimes(2)
    expect(port.listCharacters).toHaveBeenCalledTimes(2)
    expect(port.getCharacter).toHaveBeenCalledTimes(1)
  })

  it('updateMe 在能力关闭或连接世代变化时拒绝且不伪成功', async () => {
    const { port, mock } = makePort()
    const profile = await mock.getMe()
    const command = { expectedRevision: profile.revision, displayName: profile.displayName, locale: profile.locale, timezone: profile.timezone }
    const disabled = new CharacterService({ backend: port, getFeatures: () => undefined })
    await expect(disabled.updateMe(command)).rejects.toMatchObject({ details: { backendCode: CHARACTER_SERVICE_BACKEND_CODES.profilesUnavailable } })
    expect(port.updateMe).not.toHaveBeenCalled()

    let epoch = 1
    let resolveWrite: ((value: typeof profile) => void) | undefined
    port.updateMe = vi.fn(() => new Promise<typeof profile>((resolve) => { resolveWrite = resolve }))
    const service = new CharacterService({ backend: port, getFeatures: () => mock.features, getConnectionEpoch: () => epoch })
    const pending = service.updateMe(command)
    await Promise.resolve()
    epoch = 2
    resolveWrite?.({ ...profile, revision: profile.revision + 1 })
    await expect(pending).rejects.toMatchObject({ details: { backendCode: CHARACTER_SERVICE_BACKEND_CODES.staleConnection } })
  })
})
