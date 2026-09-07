import { describe, expect, it, vi } from 'vitest'
import { IpcChannels, type CharacterDraft, type IpcResult, type PersistedCharacterDraft } from '@shared/contracts'
import { MockCharacterBackend } from '../../src/main/characters/mock-character-backend'
import { registerCharacterHandlers } from '../../src/main/characters/character-handlers'
import { CharacterService } from '../../src/main/characters/character-service'
import { parsePublicError } from '../../src/renderer/src/utils/public-error'

const sanitize = (message: string): string => message
const draft: CharacterDraft = {
  displayName: 'IPC 角色', description: '', aliases: [],
  promptProfile: { corePersonality: '真诚', relationshipStyle: '朋友', emotionStyle: '', speakingStyle: '自然', conversationInitiative: '', examples: [] },
  runtimeDefaults: { voice: {}, emotion: { idleExpressions: [] }, wakeWords: ['IPC'], proactive: { enabled: false, intervalSeconds: 3600, triggers: [] } },
  presentation: {}
}

function registerOnce() {
  const backend = new MockCharacterBackend()
  const service = new CharacterService({ backend, getFeatures: () => backend.features })
  const handlers = new Map<string, { invoke: (raw: unknown) => Promise<IpcResult<unknown>>; arity: number }>()
  registerCharacterHandlers({
    service,
    sanitize,
    register: (channel, invoke, arity = 0) => handlers.set(channel, { invoke, arity })
  })
  return { backend, handlers }
}

async function invoke(handlers: Map<string, { invoke: (raw: unknown) => Promise<IpcResult<unknown>>; arity: number }>, channel: string, raw?: unknown) {
  const registered = handlers.get(channel)
  if (!registered) throw new Error(`未注册通道: ${channel}`)
  return registered.invoke(raw)
}

describe('FE-B 角色 IPC Main handler', () => {
  it('注册五个只读通道与唯一 profile 写通道，合法请求返回领域数据且保留身份', async () => {
    const { handlers } = registerOnce()
    expect([...handlers.keys()]).toEqual(expect.arrayContaining([
      IpcChannels.profileGetMe,
      IpcChannels.profileUpdateMe,
      IpcChannels.charactersList,
      IpcChannels.charactersGet,
      IpcChannels.charactersListRevisions,
      IpcChannels.characterInstancesGetState,
      IpcChannels.characterInstancesResetEvolution
    ]))
    const profile = await invoke(handlers, IpcChannels.profileGetMe)
    expect(profile).toMatchObject({ ok: true, data: { userId: 'user-mock' } })
    const updated = await invoke(handlers, IpcChannels.profileUpdateMe, {
      expectedRevision: 1, displayName: '小雨', locale: 'zh-CN', timezone: 'Asia/Shanghai', defaultCharacterId: 'builtin/cyrene'
    })
    expect(updated).toMatchObject({ ok: true, data: { displayName: '小雨', revision: 2, defaultCharacterId: 'builtin/cyrene' } })
    const detail = await invoke(handlers, IpcChannels.charactersGet, { characterId: 'builtin/elysia' })
    expect(detail).toMatchObject({ ok: true, data: { summary: { characterId: 'builtin/elysia' }, current: { characterId: 'builtin/elysia' } } })
    const state = await invoke(handlers, IpcChannels.characterInstancesGetState, { characterInstanceId: 'instance-elysia' })
    expect(state).toMatchObject({ ok: true, data: { characterId: 'builtin/elysia', characterInstanceId: 'instance-elysia' } })
    const reset = await invoke(handlers, IpcChannels.characterInstancesResetEvolution, { characterInstanceId: 'instance-elysia', expectedStateVersion: 1 })
    expect(reset).toMatchObject({ ok: true, data: { state: { stateVersion: 2 }, resetFields: expect.arrayContaining(['mood']) } })
  })

  it('请求/响应均 strict：未知字段和错误 arity 在 Main 边界拒绝', async () => {
    const { handlers } = registerOnce()
    const badRequest = await invoke(handlers, IpcChannels.charactersList, { unknown: true })
    expect(badRequest).toMatchObject({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED' } })
    const badGet = await invoke(handlers, IpcChannels.charactersGet, { characterId: 'builtin/elysia', revision: 1 })
    expect(badGet).toMatchObject({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED' } })
    const badReset = await invoke(handlers, IpcChannels.characterInstancesResetEvolution, { characterInstanceId: 'instance-elysia', expectedStateVersion: 1, unknown: true })
    expect(badReset).toMatchObject({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED' } })
    const badUpdate = await invoke(handlers, IpcChannels.profileUpdateMe, {
      expectedRevision: 1, displayName: '小雨', locale: 'zh-CN', timezone: 'Asia/Shanghai', unknown: true
    })
    expect(badUpdate).toMatchObject({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED' } })
    expect(handlers.get(IpcChannels.charactersList)?.arity).toBe(1)
  })

  it('FE-D1 七个具名通道闭环，strict unknown 拒绝且冲突只公开白名单字段', async () => {
    const { handlers } = registerOnce()
    expect([...handlers.keys()]).toEqual(expect.arrayContaining([
      IpcChannels.charactersCreate, IpcChannels.charactersUpdate, IpcChannels.charactersClone,
      IpcChannels.charactersArchive, IpcChannels.charactersRollback, IpcChannels.charactersValidate,
      IpcChannels.charactersPreview
    ]))
    const created = await invoke(handlers, IpcChannels.charactersCreate, { draft })
    expect(created).toMatchObject({ ok: true, data: { summary: { source: 'custom', currentRevision: 1 } } })
    const characterId = created.ok ? (created.data as { summary: { characterId: string } }).summary.characterId : ''
    const updated = await invoke(handlers, IpcChannels.charactersUpdate, { characterId, expectedRevision: 1, statePolicy: 'preserve', draft: { ...draft, displayName: 'v2' } })
    expect(updated).toMatchObject({ ok: true, data: { character: { current: { revision: 2 } } } })
    const conflict = await invoke(handlers, IpcChannels.charactersUpdate, { characterId, expectedRevision: 1, statePolicy: 'preserve', draft })
    expect(conflict).toMatchObject({ ok: false, error: { backendCode: 'CHARACTER_REVISION_CONFLICT', currentRevision: 2 } })
    expect(conflict).not.toHaveProperty('error.rawBody')
    expect(conflict).not.toHaveProperty('error.details')
    const bad = await invoke(handlers, IpcChannels.charactersPreview, { draft, userMessage: 'hi', unknown: true })
    expect(bad).toMatchObject({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED' } })
    const preview = await invoke(handlers, IpcChannels.charactersPreview, { draft, userMessage: 'hi' })
    expect(preview).toMatchObject({ ok: true, data: { ephemeral: true } })
  })

  it('response schema fail-closed：读写 service 返回未知字段时不把 raw/未知 DTO 送出 IPC', async () => {
    const backend = new MockCharacterBackend()
    const service = {
      getMe: vi.fn(async () => ({ ...(await backend.getMe()), unknown: true })),
      updateMe: vi.fn(async () => ({ ...(await backend.getMe()), revision: 2, unknown: true } as never)),
      listCharacters: backend.listCharacters.bind(backend),
      getCharacter: backend.getCharacter.bind(backend),
      createCharacter: backend.createCharacter.bind(backend),
      updateCharacter: backend.updateCharacter.bind(backend),
      cloneCharacter: backend.cloneCharacter.bind(backend),
      archiveCharacter: backend.archiveCharacter.bind(backend),
      rollbackCharacter: backend.rollbackCharacter.bind(backend),
      validateCharacter: backend.validateCharacter.bind(backend),
      previewCharacter: backend.previewCharacter.bind(backend),
      listCharacterRevisions: backend.listCharacterRevisions.bind(backend),
      getCharacterState: backend.getCharacterState.bind(backend),
      resetCharacterEvolution: backend.resetCharacterEvolution.bind(backend)
    }
    const handlers = new Map<string, (raw: unknown) => Promise<IpcResult<unknown>>>()
    registerCharacterHandlers({ service, sanitize, register: (channel, invoke) => { handlers.set(channel, invoke) } })
    const readResult = await handlers.get(IpcChannels.profileGetMe)!(undefined)
    expect(readResult).toMatchObject({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED' } })
    const writeResult = await handlers.get(IpcChannels.profileUpdateMe)!({
      expectedRevision: 1, displayName: '小雨', locale: 'zh-CN', timezone: 'Asia/Shanghai'
    })
    expect(writeResult).toMatchObject({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED' } })
  })

  it('archive：远端成功后清理同角色草稿；清理同步/异步失败仍返回严格成功', async () => {
    const backend = new MockCharacterBackend()
    const created = await backend.createCharacter({ draft })
    const archiveResult = await backend.archiveCharacter(created.summary.characterId)
    const characterId = created.summary.characterId
    const registerArchive = (
      archiveCharacter: () => Promise<unknown>,
      deleteByCharacterId: () => Promise<void> | void,
      logger: Record<string, ReturnType<typeof vi.fn>>
    ) => {
      const handlers = new Map<string, { invoke: (raw: unknown) => Promise<IpcResult<unknown>>; arity: number }>()
      registerCharacterHandlers({
        service: { archiveCharacter } as never,
        drafts: { deleteByCharacterId } as never,
        sanitize,
        logger: logger as never,
        register: (channel, invoke, arity = 0) => handlers.set(channel, { invoke, arity })
      })
      return handlers
    }

    const cleanup = vi.fn(async () => {})
    const success = await invoke(
      registerArchive(vi.fn(async () => archiveResult), cleanup, { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
      IpcChannels.charactersArchive,
      { characterId }
    )
    expect(success).toMatchObject({ ok: true, data: { character: { characterId, status: 'archived' } } })
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledWith(characterId)

    for (const failureKind of ['sync', 'async'] as const) {
      const secret = `PRIVATE_ARCHIVE_CLEANUP_${failureKind}`
      const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }
      const failedCleanup = failureKind === 'sync'
        ? vi.fn(() => { throw new Error(secret) })
        : vi.fn(async () => { throw new Error(secret) })
      const result = await invoke(
        registerArchive(vi.fn(async () => archiveResult), failedCleanup, logger),
        IpcChannels.charactersArchive,
        { characterId }
      )
      expect(result).toMatchObject({ ok: true, data: { character: { characterId, status: 'archived' } } })
      expect(logger.warn).toHaveBeenCalledWith('character-drafts:archive-cleanup-failed', { code: 'CHARACTER_DRAFT_STORAGE_UNAVAILABLE' })
      const logs = JSON.stringify(logger.warn.mock.calls)
      expect(logs).not.toContain(secret)
      expect(logs).not.toContain(characterId)
    }
  })

  it('archive 远端失败时不触发草稿清理', async () => {
    const cleanup = vi.fn(async () => {})
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }
    const handlers = new Map<string, { invoke: (raw: unknown) => Promise<IpcResult<unknown>>; arity: number }>()
    registerCharacterHandlers({
      service: { archiveCharacter: vi.fn(async () => { throw new Error('REMOTE_ARCHIVE_FAILED') }) } as never,
      drafts: { deleteByCharacterId: cleanup } as never,
      sanitize,
      logger: logger as never,
      register: (channel, invoke, arity = 0) => handlers.set(channel, { invoke, arity })
    })

    const result = await invoke(handlers, IpcChannels.charactersArchive, { characterId: 'custom/remote-failure' })
    expect(result).toMatchObject({ ok: false, error: { code: 'UNKNOWN' } })
    expect(cleanup).not.toHaveBeenCalled()
  })
})

// preload desktop-api 在单独的 describe 中动态 import，避免 Renderer 获得 ipcRenderer 原对象。
const { mockIpc } = vi.hoisted(() => ({ mockIpc: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }))
vi.mock('electron', () => ({ ipcRenderer: mockIpc, webUtils: { getPathForFile: vi.fn(() => '') } }))

describe('FE-B 角色 IPC Preload', () => {
  it('只按具名通道调用并在 preload 复用 strict 请求/响应 schema', async () => {
    const backend = new MockCharacterBackend()
    const profile = await backend.getMe()
    const list = await backend.listCharacters({})
    mockIpc.invoke.mockResolvedValue({ ok: true, data: list })
    const { desktopApi } = await import('../../src/preload/desktop-api')
    await desktopApi.listCharacters({ limit: 1 })
    expect(mockIpc.invoke).toHaveBeenCalledWith(IpcChannels.charactersList, { limit: 1 })
    await expect(desktopApi.listCharacters({ unknown: true } as never)).rejects.toBeTruthy()
    expect(mockIpc.invoke).toHaveBeenCalledTimes(1)

    mockIpc.invoke.mockResolvedValueOnce({ ok: true, data: { ...profile, unknown: true } })
    await expect(desktopApi.getMe()).rejects.toThrow('SCHEMA_VALIDATION_FAILED')

    mockIpc.invoke.mockResolvedValueOnce({ ok: true, data: { ...profile, revision: 2, displayName: '小雨' } })
    await desktopApi.updateMe({ expectedRevision: 1, displayName: '小雨', locale: 'zh-CN', timezone: 'Asia/Shanghai' })
    expect(mockIpc.invoke).toHaveBeenLastCalledWith(IpcChannels.profileUpdateMe, {
      expectedRevision: 1, displayName: '小雨', locale: 'zh-CN', timezone: 'Asia/Shanghai'
    })
    await expect(desktopApi.updateMe({ expectedRevision: 1, displayName: '小雨', locale: 'zh-CN', timezone: 'Asia/Shanghai', unknown: true } as never)).rejects.toThrow('SCHEMA_VALIDATION_FAILED')
    mockIpc.invoke.mockResolvedValueOnce({ ok: true, data: { ...profile, revision: 2, unknown: true } })
    await expect(desktopApi.updateMe({ expectedRevision: 1, displayName: '小雨', locale: 'zh-CN', timezone: 'Asia/Shanghai' })).rejects.toThrow('SCHEMA_VALIDATION_FAILED')

    const created = await backend.createCharacter({ draft })
    mockIpc.invoke.mockResolvedValueOnce({ ok: true, data: created })
    await desktopApi.createCharacter({ draft })
    expect(mockIpc.invoke).toHaveBeenLastCalledWith(IpcChannels.charactersCreate, { draft })
    await expect(desktopApi.createCharacter({ draft, unknown: true } as never)).rejects.toThrow('SCHEMA_VALIDATION_FAILED')
    mockIpc.invoke.mockResolvedValueOnce({ ok: true, data: { ephemeral: true, reply: 'ok', unknown: true } })
    await expect(desktopApi.previewCharacter({ draft, userMessage: 'hi' })).rejects.toThrow('SCHEMA_VALIDATION_FAILED')

    const initialState = await backend.getCharacterState('instance-elysia')
    const resetResult = await backend.resetCharacterEvolution({ characterInstanceId: 'instance-elysia', expectedStateVersion: initialState.stateVersion })
    mockIpc.invoke.mockResolvedValueOnce({ ok: true, data: resetResult })
    await desktopApi.resetCharacterEvolution({ characterInstanceId: 'instance-elysia', expectedStateVersion: initialState.stateVersion })
    expect(mockIpc.invoke).toHaveBeenLastCalledWith(IpcChannels.characterInstancesResetEvolution, {
      characterInstanceId: 'instance-elysia', expectedStateVersion: initialState.stateVersion
    })
    await expect(desktopApi.resetCharacterEvolution({ characterInstanceId: 'instance-elysia', expectedStateVersion: initialState.stateVersion, unknown: true } as never))
      .rejects.toThrow('SCHEMA_VALIDATION_FAILED')

    mockIpc.invoke.mockResolvedValueOnce({ ok: false, error: {
      code: 'BACKEND_REJECTED', message: '校验失败', backendCode: 'CHARACTER_VALIDATION',
      issues: [{ severity: 'error', code: 'REQUIRED', path: '/displayName', message: '含 ] 换行\n仍安全' }]
    } })
    let parsed: ReturnType<typeof parsePublicError> | undefined
    try { await desktopApi.validateCharacter(draft) } catch (error) {
      parsed = parsePublicError(error instanceof Error ? error.message : String(error))
    }
    expect(parsed).toMatchObject({ backendCode: 'CHARACTER_VALIDATION', issues: [{ path: '/displayName', message: '含 ] 换行\n仍安全' }] })

    const persisted: PersistedCharacterDraft = {
      key: 'create:preload', mode: 'create', displayName: draft.displayName,
      updatedAt: '2026-08-31T00:00:00.000Z', draft
    }
    mockIpc.invoke.mockResolvedValueOnce({ ok: true, data: [{
      key: persisted.key, mode: persisted.mode, displayName: persisted.displayName, updatedAt: persisted.updatedAt
    }] })
    await expect(desktopApi.listCharacterDrafts()).resolves.toEqual([{ key: persisted.key, mode: 'create', displayName: 'IPC 角色', updatedAt: persisted.updatedAt }])
    expect(mockIpc.invoke).toHaveBeenLastCalledWith(IpcChannels.characterDraftsList)

    mockIpc.invoke.mockResolvedValueOnce({ ok: true, data: persisted })
    await expect(desktopApi.getCharacterDraft(persisted.key)).resolves.toMatchObject({ key: persisted.key, draft: { displayName: 'IPC 角色' } })
    expect(mockIpc.invoke).toHaveBeenLastCalledWith(IpcChannels.characterDraftsGet, { key: persisted.key })

    mockIpc.invoke.mockResolvedValueOnce({ ok: true, data: undefined })
    await desktopApi.saveCharacterDraft(persisted)
    expect(mockIpc.invoke).toHaveBeenLastCalledWith(IpcChannels.characterDraftsSave, persisted)
    mockIpc.invoke.mockResolvedValueOnce({ ok: true, data: undefined })
    await desktopApi.deleteCharacterDraft(persisted.key)
    expect(mockIpc.invoke).toHaveBeenLastCalledWith(IpcChannels.characterDraftsDelete, { key: persisted.key })
    await expect(desktopApi.getCharacterDraft('')).rejects.toThrow('SCHEMA_VALIDATION_FAILED')
    await expect(desktopApi.saveCharacterDraft({ ...persisted, unknown: true } as never)).rejects.toThrow('SCHEMA_VALIDATION_FAILED')
  })
})
