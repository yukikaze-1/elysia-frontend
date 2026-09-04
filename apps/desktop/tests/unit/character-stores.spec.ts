import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { CharacterCatalogChangedEvent, CharacterDraft, CharacterStateChangedEvent, UpdateUserIdentityCommand, UserIdentityProfile } from '@shared/contracts'
import { MockCharacterBackend } from '../../src/main/characters/mock-character-backend'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { useIdentityStore } from '../../src/renderer/src/stores/identity.store'
import { useCharacterCatalogStore } from '../../src/renderer/src/stores/character-catalog.store'
import { useCharacterRuntimeStore } from '../../src/renderer/src/stores/character-runtime.store'
import { useCharacterEditorStore } from '../../src/renderer/src/stores/character-editor.store'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const backend = new MockCharacterBackend()
const baseApi = {
  getMe: vi.fn(() => backend.getMe()),
  updateMe: vi.fn(async (input: UpdateUserIdentityCommand): Promise<UserIdentityProfile> => {
    const current = await backend.getMe()
    return {
      ...current,
      displayName: input.displayName,
      locale: input.locale,
      timezone: input.timezone,
      initialized: true,
      revision: input.expectedRevision + 1,
      updatedAt: '2026-08-31T01:00:00.000Z',
      ...(input.preferredAddress !== undefined ? { preferredAddress: input.preferredAddress } : {}),
      ...(input.pronouns !== undefined ? { pronouns: input.pronouns } : {}),
      ...(input.defaultCharacterId !== undefined ? { defaultCharacterId: input.defaultCharacterId } : {})
    }
  }),
  listCharacters: vi.fn((input = {}) => backend.listCharacters(input)),
  getCharacter: vi.fn((id: string) => backend.getCharacter(id)),
  listCharacterRevisions: vi.fn((input) => backend.listCharacterRevisions(input)),
  getCharacterState: vi.fn((id: string) => backend.getCharacterState(id)),
  createCharacter: vi.fn((input) => backend.createCharacter(input)),
  updateCharacter: vi.fn((input) => backend.updateCharacter(input)),
  cloneCharacter: vi.fn((input) => backend.cloneCharacter(input)),
  archiveCharacter: vi.fn((id: string) => backend.archiveCharacter(id)),
  rollbackCharacter: vi.fn((input) => backend.rollbackCharacter(input)),
  validateCharacter: vi.fn((draft) => backend.validateCharacter(draft)),
  previewCharacter: vi.fn((input) => backend.previewCharacter(input))
}

function characterDraft(name: string): CharacterDraft {
  return {
    displayName: name, description: '', aliases: [],
    promptProfile: { corePersonality: '真诚', relationshipStyle: '朋友', emotionStyle: '', speakingStyle: '自然', conversationInitiative: '', examples: [] },
    runtimeDefaults: { voice: {}, emotion: { idleExpressions: [] }, wakeWords: [name], proactive: { enabled: false, intervalSeconds: 3600, triggers: [] } },
    presentation: {}
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  setDesktopApi(baseApi as never)
})

describe('identityStore FE-B', () => {
  it('加载 profile 并区分 initialized；epoch 变化阻止迟到 profile 回填', async () => {
    const profile = await backend.getMe()
    profile.initialized = false
    let resolveProfile: ((value: typeof profile) => void) | undefined
    baseApi.getMe.mockImplementationOnce(() => new Promise((resolve) => { resolveProfile = resolve }))
    const store = useIdentityStore()
    const loading = store.load()
    expect(store.status).toBe('loading')
    store.setConnectionEpoch(1)
    resolveProfile?.(profile)
    await loading
    expect(store.profile).toBeUndefined()
    expect(store.status).toBe('idle')

    baseApi.getMe.mockResolvedValueOnce(profile)
    await store.load()
    expect(store.status).toBe('ready')
    expect(store.initialized).toBe(false)
  })

  it('同一连接内的重复 load 共享 in-flight', async () => {
    const store = useIdentityStore()
    const first = store.load()
    const second = store.load()
    expect(baseApi.getMe).toHaveBeenCalledTimes(1)
    await Promise.all([first, second])
    expect(store.profile?.userId).toBe('user-mock')
  })

  it('读取失败进入 error，并保留后端公开错误语义', async () => {
    baseApi.getMe.mockRejectedValueOnce(new Error('[BACKEND_REJECTED] [backendCode=CHARACTER_DOWN] 暂不可用'))
    const store = useIdentityStore()
    await store.load()
    expect(store.status).toBe('error')
    expect(store.error).toMatchObject({ code: 'BACKEND_REJECTED', backendCode: 'CHARACTER_DOWN' })

    baseApi.listCharacters.mockRejectedValueOnce(new Error('[BACKEND_REJECTED] [backendCode=CATALOG_DOWN] 暂不可用'))
    const catalog = useCharacterCatalogStore()
    await catalog.loadList()
    expect(catalog.status).toBe('error')
    expect(catalog.error).toMatchObject({ code: 'BACKEND_REJECTED', backendCode: 'CATALOG_DOWN' })

    baseApi.getCharacterState.mockRejectedValueOnce(new Error('[BACKEND_REJECTED] [backendCode=STATE_DOWN] 暂不可用'))
    const runtime = useCharacterRuntimeStore()
    await runtime.loadState('instance-elysia')
    expect(runtime.stateStatus['instance-elysia']).toBe('error')
    expect(runtime.stateErrors['instance-elysia']).toMatchObject({ code: 'BACKEND_REJECTED', backendCode: 'STATE_DOWN' })
  })

  it('identity 读取/保存的同步抛错也会释放 loading/saving 锁', async () => {
    baseApi.getMe.mockImplementationOnce(() => { throw new Error('[BACKEND_REJECTED] [backendCode=PROFILE_SYNC_DOWN] 读取失败') })
    const store = useIdentityStore()
    await store.load()
    expect(store.status).toBe('error')
    expect(store.error).toMatchObject({ backendCode: 'PROFILE_SYNC_DOWN' })

    await store.load()
    store.updateDraft({ displayName: '同步保存错误' })
    baseApi.updateMe.mockImplementationOnce(() => { throw new Error('[BACKEND_REJECTED] [backendCode=PROFILE_SYNC_SAVE_DOWN] 保存失败') })
    expect(await store.save()).toBe(false)
    expect(store.saveStatus).toBe('error')
    expect(store.status).toBe('ready')
  })

  it('FE-C 档案草稿与保存状态分离，成功替换 profile 且并发保存去重', async () => {
    const store = useIdentityStore()
    await store.load()
    store.updateDraft({ displayName: '小雨', defaultCharacterId: 'builtin/cyrene' })
    expect(store.dirty).toBe(true)
    expect(store.status).toBe('ready')
    const first = store.save()
    const second = store.save()
    expect(store.saveStatus).toBe('saving')
    await Promise.all([first, second])
    expect(baseApi.updateMe).toHaveBeenCalledTimes(1)
    expect(baseApi.updateMe).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 1, displayName: '小雨', defaultCharacterId: 'builtin/cyrene' }))
    expect(store.profile).toMatchObject({ displayName: '小雨', revision: 2, initialized: true })
    expect(store.saveStatus).toBe('success')
    expect(store.dirty).toBe(false)
  })

  it('写成功使保存期间启动的旧 GET 失效，不允许 revision 1 覆盖 revision 2', async () => {
    const store = useIdentityStore()
    await store.load()
    store.updateDraft({ displayName: 'revision 2' })
    const write = deferred<UserIdentityProfile>()
    const staleRead = deferred<UserIdentityProfile>()
    baseApi.updateMe.mockImplementationOnce(() => write.promise)
    baseApi.getMe.mockImplementationOnce(() => staleRead.promise)

    const saving = store.save()
    const loading = store.load(true)
    const original = await backend.getMe()
    write.resolve({ ...original, displayName: 'revision 2', revision: 2, updatedAt: '2026-08-31T02:00:00.000Z' })
    expect(await saving).toBe(true)
    staleRead.resolve({ ...original, revision: 1 })
    await loading
    expect(store.profile).toMatchObject({ displayName: 'revision 2', revision: 2 })
    expect(store.status).toBe('ready')
  })

  it('FE-C revision conflict 保留输入；连接 epoch 变化后迟到成功/错误不回填', async () => {
    const store = useIdentityStore()
    await store.load()
    store.updateDraft({ displayName: '保留的本地输入' })
    baseApi.updateMe.mockRejectedValueOnce(new Error('[BACKEND_REJECTED] [backendCode=USER_PROFILE_REVISION_CONFLICT] 档案冲突'))
    expect(await store.save()).toBe(false)
    expect(store.saveStatus).toBe('conflict')
    expect(store.draft?.displayName).toBe('保留的本地输入')
    expect(store.profile?.displayName).not.toBe('保留的本地输入')

    const late = deferred<UserIdentityProfile>()
    baseApi.updateMe.mockImplementationOnce(() => late.promise)
    const pending = store.save()
    store.setConnectionEpoch(1)
    late.resolve({ ...(await backend.getMe()), displayName: '迟到成功', revision: 2 })
    expect(await pending).toBe(false)
    expect(store.profile).toBeUndefined()
    expect(store.saveStatus).toBe('idle')

    await store.load()
    store.updateDraft({ displayName: '新连接输入' })
    const lateError = deferred<UserIdentityProfile>()
    baseApi.updateMe.mockImplementationOnce(() => lateError.promise)
    const failed = store.save()
    store.setConnectionEpoch(2)
    lateError.reject(new Error('[BACKEND_REJECTED] [backendCode=OLD_CONFLICT] old'))
    expect(await failed).toBe(false)
    expect(store.saveError).toBeUndefined()
    expect(store.saveStatus).toBe('idle')
  })

  it('FE-D1 archive 权威 rev3 阻止迟到 save rev2，后续 rev4 仍可落地且草稿不丢', async () => {
    const initial = await backend.getMe()
    const delayed = deferred<UserIdentityProfile>()
    const updateMe = vi.fn(() => delayed.promise)
    setDesktopApi({ getMe: vi.fn(async () => ({ ...initial, revision: 1 })), updateMe } as never)
    const store = useIdentityStore()
    await store.load()
    store.updateDraft({ displayName: '不能丢的草稿' })
    const saving = store.save()
    store.applyServerProfile({ ...initial, revision: 3, defaultCharacterId: 'builtin/cyrene', updatedAt: '2026-08-31T03:00:00.000Z' })
    delayed.resolve({ ...initial, revision: 2, displayName: '迟到 rev2', updatedAt: '2026-08-31T02:00:00.000Z' })
    expect(await saving).toBe(false)
    expect(store.profile).toMatchObject({ revision: 3, defaultCharacterId: 'builtin/cyrene' })
    expect(store.draft?.displayName).toBe('不能丢的草稿')
    expect(store.saveStatus).toBe('conflict')
    expect(store.saveError).toMatchObject({ backendCode: 'USER_PROFILE_REVISION_CONFLICT', currentRevision: 3 })

    updateMe.mockResolvedValueOnce({ ...initial, revision: 4, displayName: '不能丢的草稿', updatedAt: '2026-08-31T04:00:00.000Z' })
    expect(await store.save()).toBe(true)
    expect(store.profile).toMatchObject({ revision: 4, displayName: '不能丢的草稿' })
  })
})

describe('characterCatalogStore FE-B', () => {
  it('FE-D1 mutation 合并服务端权威 detail/archive profile，且同对象互斥与 epoch 迟到不回填', async () => {
    const d1Backend = new MockCharacterBackend()
    const d1Api = {
      getMe: vi.fn(() => d1Backend.getMe()),
      listCharacters: vi.fn((input = {}) => d1Backend.listCharacters(input)),
      getCharacter: vi.fn((id: string) => d1Backend.getCharacter(id)),
      listCharacterRevisions: vi.fn((input) => d1Backend.listCharacterRevisions(input)),
      createCharacter: vi.fn((input) => d1Backend.createCharacter(input)),
      updateCharacter: vi.fn((input) => d1Backend.updateCharacter(input)),
      cloneCharacter: vi.fn((input) => d1Backend.cloneCharacter(input)),
      archiveCharacter: vi.fn((id: string) => d1Backend.archiveCharacter(id)),
      rollbackCharacter: vi.fn((input) => d1Backend.rollbackCharacter(input)),
      validateCharacter: vi.fn((draft) => d1Backend.validateCharacter(draft)),
      previewCharacter: vi.fn((input) => d1Backend.previewCharacter(input))
    }
    setDesktopApi(d1Api as never)
    const store = useCharacterCatalogStore()
    const identity = useIdentityStore()
    await Promise.all([store.loadList({}), identity.load()])
    const created = await store.createCharacter({ draft: characterDraft('store-created') })
    expect(created).toBeDefined()
    const id = created!.summary.characterId
    expect(store.details[id].summary.displayName).toBe('store-created')
    const updated = await store.updateCharacter({ characterId: id, expectedRevision: 1, statePolicy: 'preserve', draft: characterDraft('store-v2') })
    expect(updated?.character.current.revision).toBe(2)
    expect(store.details[id].summary.displayName).toBe('store-v2')

    await d1Backend.updateMe({ expectedRevision: 1, displayName: '旅行者', locale: 'zh-CN', timezone: 'Asia/Shanghai', defaultCharacterId: id })
    await identity.load(true)
    const archived = await store.archiveCharacter(id)
    expect(archived?.character.status).toBe('archived')
    expect(store.details[id]).toBeUndefined()
    expect(identity.profile).toMatchObject({ defaultCharacterId: 'builtin/elysia', revision: 3 })

    const another = await d1Backend.createCharacter({ draft: characterDraft('pending') })
    const pending = deferred<Awaited<ReturnType<MockCharacterBackend['updateCharacter']>>>()
    d1Api.updateCharacter.mockImplementationOnce(() => pending.promise)
    const first = store.updateCharacter({ characterId: another.summary.characterId, expectedRevision: 1, statePolicy: 'preserve', draft: characterDraft('pending-v2') })
    await expect(store.archiveCharacter(another.summary.characterId)).rejects.toThrow('CHARACTER_MUTATION_IN_PROGRESS')
    store.setConnectionEpoch(store.connectionEpoch + 1)
    pending.resolve({ character: { ...another, summary: { ...another.summary, displayName: '迟到' } }, stateImpact: { statePolicy: 'preserve', affectedInstances: 0, pendingInstances: 0, resetFields: [] } })
    expect(await first).toBeUndefined()
    expect(store.summaries).toEqual([])
  })

  it('FE-D1 写成功精确 fence 旧 list/detail/revisions，update/archive 后旧成功和错误不复活', async () => {
    const local = new MockCharacterBackend()
    const created = await local.createCharacter({ draft: characterDraft('old-name') })
    const oldList = deferred<Awaited<ReturnType<MockCharacterBackend['listCharacters']>>>()
    const oldDetail = deferred<Awaited<ReturnType<MockCharacterBackend['getCharacter']>>>()
    const oldRevisions = deferred<Awaited<ReturnType<MockCharacterBackend['listCharacterRevisions']>>>()
    const apiMock = {
      listCharacters: vi.fn((input = {}) => local.listCharacters(input)),
      getCharacter: vi.fn((id: string) => local.getCharacter(id)),
      listCharacterRevisions: vi.fn((input) => local.listCharacterRevisions(input)),
      updateCharacter: vi.fn((input) => local.updateCharacter(input)),
      archiveCharacter: vi.fn((id: string) => local.archiveCharacter(id))
    }
    setDesktopApi(apiMock as never)
    const store = useCharacterCatalogStore()
    await store.loadList({ status: 'active' })
    await Promise.all([store.loadDetail(created.summary.characterId), store.loadRevisions({ characterId: created.summary.characterId })])
    apiMock.listCharacters.mockImplementationOnce(() => oldList.promise)
    apiMock.getCharacter.mockImplementationOnce(() => oldDetail.promise)
    apiMock.listCharacterRevisions.mockImplementationOnce(() => oldRevisions.promise)
    const reads = [store.loadList({ status: 'active' }, { force: true }), store.loadDetail(created.summary.characterId, true), store.loadRevisions({ characterId: created.summary.characterId }, true)]
    const mutation = await store.updateCharacter({ characterId: created.summary.characterId, expectedRevision: 1, statePolicy: 'preserve', draft: characterDraft('new-name') })
    expect(store.status).toBe('stale')
    expect(store.detailStatus[created.summary.characterId]).toBe('ready')
    expect(Object.values(store.revisionStatus)).not.toContain('loading')
    oldList.resolve({ items: [created.summary], hasMore: false })
    oldDetail.resolve(created)
    oldRevisions.resolve({ items: [{ revision: 1, checksum: created.current.checksum, createdBy: 'user', createdAt: created.current.createdAt }], hasMore: false })
    await Promise.all(reads)
    expect(mutation?.character.current.revision).toBe(2)
    expect(store.details[created.summary.characterId].current.revision).toBe(2)
    expect(store.summaries.find((item) => item.characterId === created.summary.characterId)?.displayName).toBe('new-name')

    const activeBeforeArchive = await local.listCharacters({ status: 'active' })
    const staleList = deferred<typeof activeBeforeArchive>()
    const staleDetail = deferred<typeof created>()
    apiMock.listCharacters.mockImplementationOnce(() => staleList.promise)
    apiMock.getCharacter.mockImplementationOnce(() => staleDetail.promise)
    const oldReads = [store.loadList({ status: 'active' }, { force: true }), store.loadDetail(created.summary.characterId, true)]
    await store.archiveCharacter(created.summary.characterId)
    expect(store.status).toBe('stale')
    expect(store.detailStatus[created.summary.characterId]).toBeUndefined()
    staleList.resolve(activeBeforeArchive)
    staleDetail.reject(new Error('旧连接详情失败'))
    await Promise.all(oldReads)
    expect(store.summaries.some((item) => item.characterId === created.summary.characterId)).toBe(false)
    expect(store.details[created.summary.characterId]).toBeUndefined()
    expect(store.error).toBeUndefined()
  })

  it('FE-D1 mutation 的 default/active/archived query 语义正确且主动 fence 不遗留 loading', async () => {
    const local = new MockCharacterBackend()
    const apiMock = {
      listCharacters: vi.fn((input = {}) => local.listCharacters(input)),
      createCharacter: vi.fn((input) => local.createCharacter(input)),
      archiveCharacter: vi.fn((id: string) => local.archiveCharacter(id))
    }
    setDesktopApi(apiMock as never)
    const store = useCharacterCatalogStore()

    const defaultItem = await store.createCharacter({ draft: characterDraft('default-active') })
    await store.loadList({})
    await store.archiveCharacter(defaultItem!.summary.characterId)
    expect(store.summaries.some((item) => item.characterId === defaultItem!.summary.characterId)).toBe(false)
    expect(store.hasMore).toBe(false)
    expect(store.nextCursor).toBeUndefined()

    const activeItem = await store.createCharacter({ draft: characterDraft('explicit-active') })
    await store.loadList({ status: 'active' })
    await store.archiveCharacter(activeItem!.summary.characterId)
    expect(store.summaries.some((item) => item.characterId === activeItem!.summary.characterId)).toBe(false)

    const archivedItem = await store.createCharacter({ draft: characterDraft('explicit-archived') })
    await store.loadList({ status: 'archived' })
    await store.archiveCharacter(archivedItem!.summary.characterId)
    expect(store.summaries.some((item) => item.characterId === archivedItem!.summary.characterId)).toBe(true)
    expect(store.status).not.toBe('loading')
  })

  it('FE-D1 catalog.changed 推进 current 时清理 detail/revisions，旧在途成功/失败不复活', async () => {
    const local = new MockCharacterBackend()
    const created = await local.createCharacter({ draft: characterDraft('event-target') })
    const oldDetail = deferred<Awaited<ReturnType<MockCharacterBackend['getCharacter']>>>()
    const oldRevisions = deferred<Awaited<ReturnType<MockCharacterBackend['listCharacterRevisions']>>>()
    const apiMock = {
      listCharacters: vi.fn((input = {}) => local.listCharacters(input)),
      getCharacter: vi.fn((id: string) => local.getCharacter(id)),
      listCharacterRevisions: vi.fn((input) => local.listCharacterRevisions(input))
    }
    setDesktopApi(apiMock as never)
    const store = useCharacterCatalogStore()
    await store.loadList({})
    await Promise.all([store.loadDetail(created.summary.characterId), store.loadRevisions({ characterId: created.summary.characterId })])
    apiMock.getCharacter.mockImplementationOnce(() => oldDetail.promise)
    apiMock.listCharacterRevisions.mockImplementationOnce(() => oldRevisions.promise)
    const pending = [store.loadDetail(created.summary.characterId, true), store.loadRevisions({ characterId: created.summary.characterId }, true)]
    store.handleCatalogChanged({
      event: 'character.catalog.changed', eventId: 'event-current-2', sequence: 1,
      characterId: created.summary.characterId, currentRevision: 2, status: 'active', updatedAt: '2026-08-31T05:00:00.000Z'
    })
    expect(store.details[created.summary.characterId]).toBeUndefined()
    expect(store.detailStatus[created.summary.characterId]).toBeUndefined()
    expect(Object.keys(store.revisions)).toHaveLength(0)
    expect(Object.values(store.revisionStatus)).not.toContain('loading')
    expect(store.summaries.find((item) => item.characterId === created.summary.characterId)).toMatchObject({ currentRevision: 2, status: 'active' })
    oldDetail.resolve(created)
    oldRevisions.reject(new Error('old revision failure'))
    await Promise.all(pending)
    expect(store.details[created.summary.characterId]).toBeUndefined()
    expect(store.error).toBeUndefined()

    store.handleCatalogChanged({
      event: 'character.catalog.changed', eventId: 'event-archived', sequence: 2,
      characterId: created.summary.characterId, currentRevision: 2, status: 'archived', updatedAt: '2026-08-31T06:00:00.000Z'
    })
    expect(store.summaries.some((item) => item.characterId === created.summary.characterId)).toBe(false)
    await store.loadList({ status: 'archived' })
    store.handleCatalogChanged({
      event: 'character.catalog.changed', eventId: 'event-archived-no-summary', sequence: 3,
      characterId: created.summary.characterId, currentRevision: 3, status: 'archived', updatedAt: '2026-08-31T07:00:00.000Z'
    })
    expect(store.summaries).toEqual([])
    expect(store.status).toBe('stale')
  })

  it('FE-D1 mutation 遵守 event fence/lastQuery，并以 token 防旧 epoch finally 误释放新锁', async () => {
    const local = new MockCharacterBackend()
    const created = await local.createCharacter({ draft: characterDraft('match-me') })
    const apiMock = {
      listCharacters: vi.fn((input = {}) => local.listCharacters(input)),
      updateCharacter: vi.fn((input) => local.updateCharacter(input)),
      archiveCharacter: vi.fn((id: string) => local.archiveCharacter(id)),
      previewCharacter: vi.fn((input) => local.previewCharacter(input))
    }
    setDesktopApi(apiMock as never)
    const store = useCharacterCatalogStore()
    await store.loadList({ status: 'active', search: 'match-me' })
    store.handleCatalogChanged({ event: 'character.catalog.changed', eventId: 'd1-fence', sequence: 10, characterId: created.summary.characterId, currentRevision: 3, status: 'active', updatedAt: '2026-08-31T03:00:00.000Z' })
    await store.updateCharacter({ characterId: created.summary.characterId, expectedRevision: 1, statePolicy: 'preserve', draft: characterDraft('no-longer-matches') })
    expect(store.summaries).toMatchObject([{ currentRevision: 3, status: 'active', updatedAt: '2026-08-31T03:00:00.000Z' }])
    expect(store.details[created.summary.characterId]?.current.revision).not.toBe(2)

    // archived query 应在 archive 成功后加入，active/search 不匹配则移除。
    const archivable = await local.createCharacter({ draft: characterDraft('archivable') })
    await store.loadList({ status: 'archived' })
    await store.archiveCharacter(archivable.summary.characterId)
    expect(store.summaries.map((item) => item.characterId)).toContain(archivable.summary.characterId)

    const old = deferred<Awaited<ReturnType<MockCharacterBackend['updateCharacter']>>>()
    const fresh = deferred<Awaited<ReturnType<MockCharacterBackend['updateCharacter']>>>()
    apiMock.updateCharacter.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise)
    const oldMutation = store.updateCharacter({ characterId: 'custom/lock', expectedRevision: 1, statePolicy: 'preserve', draft: characterDraft('old') })
    store.setConnectionEpoch(1)
    const newMutation = store.updateCharacter({ characterId: 'custom/lock', expectedRevision: 1, statePolicy: 'preserve', draft: characterDraft('new') })
    old.reject(new Error('old failure'))
    expect(await oldMutation).toBeUndefined()
    await expect(store.updateCharacter({ characterId: 'custom/lock', expectedRevision: 1, statePolicy: 'preserve', draft: characterDraft('third') })).rejects.toThrow('CHARACTER_MUTATION_IN_PROGRESS')
    fresh.reject(new Error('current failure'))
    await expect(newMutation).rejects.toThrow('current failure')

    apiMock.updateCharacter.mockImplementationOnce(() => { throw new Error('sync failure') })
    await expect(store.updateCharacter({ characterId: 'custom/sync', expectedRevision: 1, statePolicy: 'preserve', draft: characterDraft('sync') })).rejects.toThrow('sync failure')
    apiMock.updateCharacter.mockRejectedValueOnce(new Error('released'))
    await expect(store.updateCharacter({ characterId: 'custom/sync', expectedRevision: 1, statePolicy: 'preserve', draft: characterDraft('again') })).rejects.toThrow('released')
  })

  it('FE-D1 低版本摘要不能把不匹配当前 query 的旧状态带回', async () => {
    const local = new MockCharacterBackend()
    const apiMock = { listCharacters: vi.fn((input = {}) => local.listCharacters(input)) }
    setDesktopApi(apiMock as never)
    const store = useCharacterCatalogStore()
    await store.loadList({})
    const current = {
      ...store.summaries[0],
      aliases: [...store.summaries[0].aliases],
      presentation: { ...store.summaries[0].presentation }
    }
    store.handleCatalogChanged({
      event: 'character.catalog.changed', eventId: 'd1-query-fence', sequence: 1,
      characterId: current.characterId, currentRevision: current.currentRevision + 1,
      status: 'active', updatedAt: '2026-08-31T08:00:00.000Z'
    })

    // 旧后端响应声称该角色已归档且版本更低；它不能把 active rev3 的旧摘要
    // 伪装成 archived query 的结果，也不能绕过当前 query 的状态过滤。
    apiMock.listCharacters.mockResolvedValueOnce({
      items: [{ ...current, status: 'archived', currentRevision: current.currentRevision }],
      hasMore: false
    })
    await store.loadList({ status: 'archived' }, { force: true })
    expect(store.summaries).toEqual([])
  })

  it('FE-D1 迟到低版本 archive 不能擦掉当前 detail', async () => {
    const local = new MockCharacterBackend()
    const created = await local.createCharacter({ draft: characterDraft('archive-fence') })
    const staleArchive = deferred<Awaited<ReturnType<MockCharacterBackend['archiveCharacter']>>>()
    const apiMock = {
      listCharacters: vi.fn((input = {}) => local.listCharacters(input)),
      getCharacter: vi.fn((id: string) => local.getCharacter(id)),
      updateCharacter: vi.fn((input) => local.updateCharacter(input)),
      archiveCharacter: vi.fn(() => staleArchive.promise)
    }
    setDesktopApi(apiMock as never)
    const store = useCharacterCatalogStore()
    await store.loadList({})
    await store.loadDetail(created.summary.characterId)
    const current = await store.updateCharacter({
      characterId: created.summary.characterId,
      expectedRevision: 1,
      statePolicy: 'preserve',
      draft: characterDraft('archive-fence-v2')
    })
    expect(current?.character.current.revision).toBe(2)

    const pending = store.archiveCharacter(created.summary.characterId)
    staleArchive.resolve({ character: created.summary })
    await pending
    expect(store.details[created.summary.characterId]?.current.revision).toBe(2)
    expect(store.detailStatus[created.summary.characterId]).toBe('ready')
    expect(store.summaries.find((item) => item.characterId === created.summary.characterId)?.currentRevision).toBe(2)
  })

  it('FE-D1 query 外缓存的高版本 detail 会阻止更低 catalog.changed', async () => {
    const local = new MockCharacterBackend()
    let detail = await local.createCharacter({ draft: characterDraft('query-outside-v1') })
    for (const name of ['query-outside-v2', 'query-outside-v3', 'query-outside-v4']) {
      const result = await local.updateCharacter({
        characterId: detail.summary.characterId,
        expectedRevision: detail.current.revision,
        statePolicy: 'preserve',
        draft: characterDraft(name)
      })
      detail = result.character
    }
    const apiMock = {
      listCharacters: vi.fn(() => Promise.resolve({ items: [], hasMore: false })),
      getCharacter: vi.fn(() => Promise.resolve(detail))
    }
    setDesktopApi(apiMock as never)
    const store = useCharacterCatalogStore()
    await store.loadList({})
    await store.loadDetail(detail.summary.characterId)
    expect(store.summaries).toEqual([])
    expect(store.details[detail.summary.characterId]?.current.revision).toBe(4)

    const statusBefore = store.status
    store.handleCatalogChanged({
      event: 'character.catalog.changed', eventId: 'd1-detail-floor', sequence: 1,
      characterId: detail.summary.characterId, currentRevision: 3, status: 'active', updatedAt: '2026-08-31T09:00:00.000Z'
    })

    expect(store.details[detail.summary.characterId]?.current.revision).toBe(4)
    expect(store.detailStatus[detail.summary.characterId]).toBe('ready')
    expect(store.status).toBe(statusBefore)
  })

  it('FE-D1 event rev5 fence 后 fresh detail GET 返回 rev4 不回填且不遗留 loading', async () => {
    const local = new MockCharacterBackend()
    let detail = await local.createCharacter({ draft: characterDraft('detail-fence-v1') })
    for (const name of ['detail-fence-v2', 'detail-fence-v3', 'detail-fence-v4']) {
      const result = await local.updateCharacter({
        characterId: detail.summary.characterId,
        expectedRevision: detail.current.revision,
        statePolicy: 'preserve',
        draft: characterDraft(name)
      })
      detail = result.character
    }
    const staleDetail = deferred<Awaited<ReturnType<MockCharacterBackend['getCharacter']>>>()
    const apiMock = {
      listCharacters: vi.fn((input = {}) => local.listCharacters(input)),
      getCharacter: vi.fn(() => staleDetail.promise)
    }
    setDesktopApi(apiMock as never)
    const store = useCharacterCatalogStore()
    await store.loadList({})
    store.handleCatalogChanged({
      event: 'character.catalog.changed', eventId: 'd1-detail-fence-rev5', sequence: 1,
      characterId: detail.summary.characterId, currentRevision: 5, status: 'active', updatedAt: '2026-08-31T10:00:00.000Z'
    })
    const pending = store.loadDetail(detail.summary.characterId, true)
    expect(store.detailStatus[detail.summary.characterId]).toBe('loading')
    staleDetail.resolve(detail)
    await pending

    expect(store.details[detail.summary.characterId]).toBeUndefined()
    expect(store.detailStatus[detail.summary.characterId]).toBe('stale')
    expect(store.detailStatus[detail.summary.characterId]).not.toBe('loading')
  })

  it('FE-D1 无 summary 时低版本 archive 不删除高版本 detail', async () => {
    const local = new MockCharacterBackend()
    let detail = await local.createCharacter({ draft: characterDraft('archive-no-summary-v1') })
    for (const name of ['archive-no-summary-v2', 'archive-no-summary-v3', 'archive-no-summary-v4']) {
      const result = await local.updateCharacter({
        characterId: detail.summary.characterId,
        expectedRevision: detail.current.revision,
        statePolicy: 'preserve',
        draft: characterDraft(name)
      })
      detail = result.character
    }
    const apiMock = {
      listCharacters: vi.fn(() => Promise.resolve({ items: [], hasMore: false })),
      getCharacter: vi.fn(() => Promise.resolve(detail)),
      archiveCharacter: vi.fn(() => Promise.resolve({
        character: { ...detail.summary, currentRevision: 3, status: 'archived', updatedAt: '2026-08-31T11:00:00.000Z' }
      }))
    }
    setDesktopApi(apiMock as never)
    const store = useCharacterCatalogStore()
    await store.loadList({})
    await store.loadDetail(detail.summary.characterId)
    await store.archiveCharacter(detail.summary.characterId)

    expect(store.summaries).toEqual([])
    expect(store.details[detail.summary.characterId]?.current.revision).toBe(4)
    expect(store.detailStatus[detail.summary.characterId]).toBe('ready')
  })

  it('FE-D1 失效某角色时不误清理另一个角色带有相同 cursor 文本的 revision 读取', async () => {
    const local = new MockCharacterBackend()
    const target = await local.createCharacter({ draft: characterDraft('target') })
    const other = await local.createCharacter({ draft: characterDraft('other') })
    const otherRevisions = deferred<Awaited<ReturnType<MockCharacterBackend['listCharacterRevisions']>>>()
    const apiMock = {
      listCharacters: vi.fn((input = {}) => local.listCharacters(input)),
      listCharacterRevisions: vi.fn((input) => input.characterId === other.summary.characterId
        ? otherRevisions.promise
        : local.listCharacterRevisions(input)),
      updateCharacter: vi.fn((input) => local.updateCharacter(input))
    }
    setDesktopApi(apiMock as never)
    const store = useCharacterCatalogStore()
    const revisionRequest = store.loadRevisions({ characterId: other.summary.characterId, cursor: target.summary.characterId })
    expect(Object.values(store.revisionStatus)).toContain('loading')

    await store.updateCharacter({ characterId: target.summary.characterId, expectedRevision: 1, statePolicy: 'preserve', draft: characterDraft('target-v2') })
    // 目标 ID 只出现在另一个请求的 opaque cursor 中；该请求仍是合法在途读取。
    expect(Object.values(store.revisionStatus)).toContain('loading')
    otherRevisions.resolve({ items: [], hasMore: false })
    await revisionRequest
    expect(Object.values(store.revisionStatus)).toContain('empty')
  })

  it('目录分页/去重，detail loading 与 list 相互独立', async () => {
    const store = useCharacterCatalogStore()
    await store.loadList({ limit: 1 })
    expect(store.status).toBe('ready')
    expect(store.summaries).toHaveLength(1)
    const detailPromise = store.loadDetail(store.summaries[0].characterId)
    expect(store.detailStatus[store.summaries[0].characterId]).toBe('loading')
    await detailPromise
    expect(store.detailStatus[store.summaries[0].characterId]).toBe('ready')
    await store.loadNextPage()
    expect(store.summaries).toHaveLength(2)
    expect(new Set(store.summaries.map((item) => item.characterId)).size).toBe(2)
  })

  it('clear 使 list/detail/revision 在途 Promise 失效，且同键重载后旧成功/错误都不能回填', async () => {
    const oldList = deferred<Awaited<ReturnType<MockCharacterBackend['listCharacters']>>>()
    const oldDetail = deferred<Awaited<ReturnType<MockCharacterBackend['getCharacter']>>>()
    const oldRevisions = deferred<Awaited<ReturnType<MockCharacterBackend['listCharacterRevisions']>>>()
    baseApi.listCharacters.mockImplementationOnce(() => oldList.promise)
    baseApi.getCharacter.mockImplementationOnce(() => oldDetail.promise)
    baseApi.listCharacterRevisions.mockImplementationOnce(() => oldRevisions.promise)
    const store = useCharacterCatalogStore()
    const staleList = store.loadList({ status: 'archived', search: '旧查询' })
    const staleDetail = store.loadDetail('builtin/elysia')
    const staleRevisions = store.loadRevisions({ characterId: 'builtin/elysia' })

    store.clear()
    expect(store.lastQuery).toEqual({})
    const freshDetail = await backend.getCharacter('builtin/elysia')
    freshDetail.summary.description = 'clear 后详情'
    const freshRevisionPage = await backend.listCharacterRevisions({ characterId: 'builtin/elysia' })
    const freshListPage = await backend.listCharacters({})
    baseApi.listCharacters.mockResolvedValueOnce(freshListPage)
    baseApi.getCharacter.mockResolvedValueOnce(freshDetail)
    baseApi.listCharacterRevisions.mockResolvedValueOnce(freshRevisionPage)
    const currentList = store.loadList({})
    const currentDetail = store.loadDetail('builtin/elysia')
    const currentRevisions = store.loadRevisions({ characterId: 'builtin/elysia' })
    await Promise.all([currentList, currentDetail, currentRevisions])

    // 旧成功响应不能越过 clear generation；同键新请求已经完成后，旧响应仍不能覆盖。
    const oldSummaryPage = await backend.listCharacters({ limit: 1 })
    const oldDetailValue = await backend.getCharacter('builtin/elysia')
    oldDetailValue.summary.description = '旧响应详情'
    const oldRevisionPage = await backend.listCharacterRevisions({ characterId: 'builtin/elysia', limit: 1 })
    oldList.resolve(oldSummaryPage)
    oldDetail.resolve(oldDetailValue)
    oldRevisions.resolve(oldRevisionPage)
    await Promise.all([staleList, staleDetail, staleRevisions])
    expect(store.summaries).toHaveLength(2)
    expect(store.status).toBe('ready')
    expect(store.error).toBeUndefined()
    expect(store.details['builtin/elysia'].summary.description).toBe('clear 后详情')
    expect(store.detailStatus['builtin/elysia']).toBe('ready')
    const revisionKey = Object.keys(store.revisions)[0]
    expect(revisionKey).toBeDefined()
    expect(store.revisionStatus[revisionKey]).toBe('ready')
    expect(store.revisions[revisionKey].items).toHaveLength(2)
  })

  it('clear 后 list/detail/revision 的旧错误不能回填 error/status', async () => {
    const oldList = deferred<Awaited<ReturnType<MockCharacterBackend['listCharacters']>>>()
    const oldDetail = deferred<Awaited<ReturnType<MockCharacterBackend['getCharacter']>>>()
    const oldRevisions = deferred<Awaited<ReturnType<MockCharacterBackend['listCharacterRevisions']>>>()
    baseApi.listCharacters.mockImplementationOnce(() => oldList.promise)
    baseApi.getCharacter.mockImplementationOnce(() => oldDetail.promise)
    baseApi.listCharacterRevisions.mockImplementationOnce(() => oldRevisions.promise)
    const store = useCharacterCatalogStore()
    const list = store.loadList({})
    const detail = store.loadDetail('builtin/elysia')
    const revisions = store.loadRevisions({ characterId: 'builtin/elysia' })
    store.clear()
    oldList.reject(new Error('[BACKEND_REJECTED] [backendCode=OLD_LIST] old'))
    oldDetail.reject(new Error('[BACKEND_REJECTED] [backendCode=OLD_DETAIL] old'))
    oldRevisions.reject(new Error('[BACKEND_REJECTED] [backendCode=OLD_REVISION] old'))
    await Promise.all([list, detail, revisions])
    expect(store.status).toBe('idle')
    expect(store.error).toBeUndefined()
    expect(store.detailStatus).toEqual({})
    expect(store.revisionStatus).toEqual({})
  })

  it('列表 epoch 变化时迟到页不覆盖新连接，catalog.changed 只接受不回退 revision', async () => {
    let resolveList: ((value: Awaited<ReturnType<MockCharacterBackend['listCharacters']>>) => void) | undefined
    baseApi.listCharacters.mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve }))
    const store = useCharacterCatalogStore()
    const loading = store.loadList({})
    await Promise.resolve()
    store.setConnectionEpoch(1)
    resolveList?.(await backend.listCharacters({}))
    await loading
    expect(store.summaries).toEqual([])
    expect(store.status).toBe('idle')

    await store.loadList({})
    const summary = store.summaries[0]
    store.handleCatalogChanged({ event: 'character.catalog.changed', eventId: 'ev-1', sequence: 1, characterId: summary.characterId, currentRevision: 2, status: 'archived', updatedAt: '2026-08-31T00:00:00.000Z' })
    expect(store.summaries.some((item) => item.characterId === summary.characterId)).toBe(false)
    store.handleCatalogChanged({ event: 'character.catalog.changed', eventId: 'ev-2', sequence: 2, characterId: summary.characterId, currentRevision: 1, status: 'active', updatedAt: '2026-08-31T00:00:00.000Z' })
    expect(store.summaries.some((item) => item.characterId === summary.characterId)).toBe(false)
  })

  it('catalog.changed 建 revision fence：迟到低版本列表不降级，且新 query 不带回其它旧项', async () => {
    const store = useCharacterCatalogStore()
    await store.loadList({})
    const elysia = store.summaries.find((item) => item.characterId === 'builtin/elysia')!
    const stale = deferred<Awaited<ReturnType<MockCharacterBackend['listCharacters']>>>()
    baseApi.listCharacters.mockImplementationOnce(() => stale.promise)
    const loading = store.loadList({ search: 'elysia' }, { force: true })
    store.handleCatalogChanged({
      event: 'character.catalog.changed', eventId: 'ev-fence', sequence: 9,
      characterId: elysia.characterId, currentRevision: elysia.currentRevision + 2,
      status: 'archived', updatedAt: '2026-08-31T00:00:00.000Z'
    })
    const staleResponse = await backend.listCharacters({ search: 'elysia' })
    stale.resolve(staleResponse)
    await loading
    expect(store.summaries).toEqual([])
  })

  it('无 catalog.changed fence 时，刷新列表可更新同 revision 的 status/updatedAt', async () => {
    const store = useCharacterCatalogStore()
    await store.loadList({})
    const refreshed = await backend.listCharacters({})
    refreshed.items[0].status = 'archived'
    refreshed.items[0].updatedAt = '2026-08-31T01:00:00.000Z'
    baseApi.listCharacters.mockResolvedValueOnce(refreshed)
    await store.loadList({}, { force: true })
    expect(store.summaries[0]).toMatchObject({ status: 'archived', updatedAt: '2026-08-31T01:00:00.000Z' })
  })

  it('无 catalog.changed fence 时，刷新列表的低 revision 不能降级已有摘要', async () => {
    const store = useCharacterCatalogStore()
    await store.loadList({})
    const current = store.summaries[0]
    expect(current.currentRevision).toBeGreaterThan(1)
    const stale = await backend.listCharacters({})
    const staleItem = stale.items.find((item) => item.characterId === current.characterId)!
    staleItem.currentRevision = current.currentRevision - 1
    staleItem.status = current.status === 'active' ? 'archived' : 'active'
    baseApi.listCharacters.mockResolvedValueOnce(stale)
    await store.loadList({}, { force: true })
    expect(store.summaries.find((item) => item.characterId === current.characterId)).toEqual(current)
  })

  it('同 revision 的 catalog.changed 按 sequence 单调，高 revision 即使 sequence 较低也优先', async () => {
    const store = useCharacterCatalogStore()
    await store.loadList({})
    const current = store.summaries[0]
    const updatedAt = '2026-08-31T02:00:00.000Z'
    store.handleCatalogChanged({
      event: 'character.catalog.changed', eventId: 'ev-seq-1', sequence: 10,
      characterId: current.characterId, currentRevision: current.currentRevision,
      status: 'active', updatedAt
    })
    store.handleCatalogChanged({
      event: 'character.catalog.changed', eventId: 'ev-seq-duplicate', sequence: 10,
      characterId: current.characterId, currentRevision: current.currentRevision,
      status: 'active', updatedAt: '2026-08-31T02:01:00.000Z'
    })
    store.handleCatalogChanged({
      event: 'character.catalog.changed', eventId: 'ev-seq-late', sequence: 9,
      characterId: current.characterId, currentRevision: current.currentRevision,
      status: 'active', updatedAt: '2026-08-31T02:02:00.000Z'
    })
    expect(store.summaries.find((item) => item.characterId === current.characterId)).toMatchObject({ status: 'active', updatedAt })

    store.handleCatalogChanged({
      event: 'character.catalog.changed', eventId: 'ev-revision-next', sequence: 1,
      characterId: current.characterId, currentRevision: current.currentRevision + 1,
      status: 'active', updatedAt: '2026-08-31T03:00:00.000Z'
    })
    expect(store.summaries.find((item) => item.characterId === current.characterId)).toMatchObject({ currentRevision: current.currentRevision + 1, status: 'active' })

    store.handleCatalogChanged({
      event: 'character.catalog.changed', eventId: 'ev-seq-next', sequence: 2,
      characterId: current.characterId, currentRevision: current.currentRevision + 1,
      status: 'archived', updatedAt: '2026-08-31T03:01:00.000Z'
    })
    expect(store.summaries.some((item) => item.characterId === current.characterId)).toBe(false)
  })

  it('archive 仅接受 archived 结果后清理 editor；reject/高 revision fence 不清理，清理异常不翻转成功', async () => {
    const local = new MockCharacterBackend()
    const accepted = await local.createCharacter({ draft: characterDraft('archive-accepted') })
    const rejected = await local.createCharacter({ draft: characterDraft('archive-rejected') })
    const fenced = await local.createCharacter({ draft: characterDraft('archive-fenced') })
    const syncFailure = await local.createCharacter({ draft: characterDraft('archive-sync-failure') })
    const asyncFailure = await local.createCharacter({ draft: characterDraft('archive-async-failure') })
    const apiMock = {
      listCharacters: vi.fn((input = {}) => local.listCharacters(input)),
      archiveCharacter: vi.fn((id: string) => local.archiveCharacter(id))
    }
    setDesktopApi(apiMock as never)
    const editor = useCharacterEditorStore()
    const cleanup = vi.spyOn(editor, 'handleCharacterArchived').mockResolvedValue(1)
    const store = useCharacterCatalogStore()
    await store.loadList({ status: 'active' })

    const archived = await store.archiveCharacter(accepted.summary.characterId)
    expect(archived?.character.status).toBe('archived')
    expect(cleanup).toHaveBeenCalledWith(accepted.summary.characterId)

    cleanup.mockClear()
    apiMock.archiveCharacter.mockRejectedValueOnce(new Error('[BACKEND_REJECTED] archive rejected'))
    await expect(store.archiveCharacter(rejected.summary.characterId)).rejects.toThrow('archive rejected')
    expect(cleanup).not.toHaveBeenCalled()

    await store.loadList({ status: 'active' })
    const fencedRevision = fenced.summary.currentRevision + 2
    store.handleCatalogChanged({
      event: 'character.catalog.changed', eventId: 'archive-fence', sequence: 1,
      characterId: fenced.summary.characterId, currentRevision: fencedRevision,
      status: 'active', updatedAt: '2026-09-01T01:00:00.000Z'
    } satisfies CharacterCatalogChangedEvent)
    cleanup.mockClear()
    apiMock.archiveCharacter.mockResolvedValueOnce({ character: fenced.summary })
    await store.archiveCharacter(fenced.summary.characterId)
    expect(cleanup).not.toHaveBeenCalled()

    cleanup.mockImplementationOnce(() => { throw new Error('sync cleanup failure') })
    const syncArchived = await store.archiveCharacter(syncFailure.summary.characterId)
    expect(syncArchived?.character.status).toBe('archived')

    cleanup.mockRejectedValueOnce(new Error('async cleanup failure'))
    const asyncArchived = await store.archiveCharacter(asyncFailure.summary.characterId)
    expect(asyncArchived?.character.status).toBe('archived')
  })
})

describe('characterRuntimeStore FE-B', () => {
  it('按 instanceId 隔离状态，stateVersion 单调，epoch 迟到响应变 stale', async () => {
    let resolveState: ((value: Awaited<ReturnType<MockCharacterBackend['getCharacterState']>>) => void) | undefined
    baseApi.getCharacterState.mockImplementationOnce(() => new Promise((resolve) => { resolveState = resolve }))
    const store = useCharacterRuntimeStore()
    const loading = store.loadState('instance-elysia')
    await Promise.resolve()
    expect(store.stateStatus['instance-elysia']).toBe('loading')
    store.setConnectionEpoch(1)
    resolveState?.(await backend.getCharacterState('instance-elysia'))
    await loading
    expect(store.stateStatus['instance-elysia']).toBe('stale')

    const event: CharacterStateChangedEvent = {
      event: 'character.state.changed', eventId: 'ev-1', sequence: 1, conversationId: 'conv-a',
      characterId: 'builtin/elysia', characterInstanceId: 'instance-elysia', characterRevision: 2, stateVersion: 3,
      state: { mood: { label: '开心', intensity: 0.9, updatedAt: '2026-08-31T00:00:00.000Z' }, proactiveEnabled: false, updatedAt: '2026-08-31T00:00:00.000Z' }
    }
    store.handleStateChanged(event)
    expect(store.statesByInstanceId['instance-elysia'].stateVersion).toBe(3)
    store.handleStateChanged({ ...event, eventId: 'ev-0', sequence: 0, stateVersion: 2, state: { ...event.state, updatedAt: '2026-08-31T00:00:00.000Z' } })
    expect(store.statesByInstanceId['instance-elysia'].stateVersion).toBe(3)
    store.handleStateChanged({ ...event, eventId: 'ev-2', sequence: 2, characterInstanceId: 'instance-cyrene', characterId: 'builtin/cyrene', conversationId: 'conv-b', stateVersion: 1 })
    expect(Object.keys(store.statesByInstanceId)).toEqual(['instance-elysia', 'instance-cyrene'])
    store.setConnectionEpoch(2)
    expect(store.stateStatus['instance-elysia']).toBe('stale')
    expect(store.activeBinding).toBeUndefined()
  })

  it('clear/clearInstance 使在途请求失效；forced refresh 的旧 state 保留 ready 缓存', async () => {
    const oldClear = deferred<Awaited<ReturnType<MockCharacterBackend['getCharacterState']>>>()
    baseApi.getCharacterState.mockImplementationOnce(() => oldClear.promise)
    const store = useCharacterRuntimeStore()
    const staleClear = store.loadState('instance-elysia')
    store.clear()
    const freshAfterClear = await backend.getCharacterState('instance-elysia')
    freshAfterClear.currentActivity = 'clear 后状态'
    baseApi.getCharacterState.mockResolvedValueOnce(freshAfterClear)
    const currentClear = store.loadState('instance-elysia')
    await currentClear
    oldClear.resolve({ ...(await backend.getCharacterState('instance-elysia')), stateVersion: 99, currentActivity: '旧响应' })
    await staleClear
    expect(store.statesByInstanceId['instance-elysia'].currentActivity).toBe('clear 后状态')
    expect(store.stateStatus['instance-elysia']).toBe('ready')

    const oldInstance = deferred<Awaited<ReturnType<MockCharacterBackend['getCharacterState']>>>()
    baseApi.getCharacterState.mockImplementationOnce(() => oldInstance.promise)
    const staleInstance = store.loadState('instance-cyrene', true)
    store.clearInstance('instance-cyrene')
    const freshAfterInstance = await backend.getCharacterState('instance-cyrene')
    freshAfterInstance.currentActivity = 'instance clear 后状态'
    baseApi.getCharacterState.mockResolvedValueOnce(freshAfterInstance)
    const currentInstance = store.loadState('instance-cyrene')
    await currentInstance
    oldInstance.resolve({ ...(await backend.getCharacterState('instance-cyrene')), stateVersion: 88, currentActivity: '旧实例响应' })
    await staleInstance
    expect(store.statesByInstanceId['instance-cyrene'].currentActivity).toBe('instance clear 后状态')

    const newer = await backend.getCharacterState('instance-elysia')
    newer.stateVersion = 7
    newer.currentActivity = '较新缓存'
    baseApi.getCharacterState.mockResolvedValueOnce(newer)
    await store.loadState('instance-elysia', true)
    const older = await backend.getCharacterState('instance-elysia')
    older.stateVersion = 3
    older.currentActivity = '较旧刷新'
    baseApi.getCharacterState.mockResolvedValueOnce(older)
    await store.loadState('instance-elysia', true)
    expect(store.statesByInstanceId['instance-elysia']).toMatchObject({ stateVersion: 7, currentActivity: '较新缓存' })
    expect(store.stateStatus['instance-elysia']).toBe('ready')
  })

  it('clear/clearInstance 后旧错误不回填，且 clearInstance 允许同实例重新发起读取', async () => {
    const oldClear = deferred<Awaited<ReturnType<MockCharacterBackend['getCharacterState']>>>()
    const oldInstance = deferred<Awaited<ReturnType<MockCharacterBackend['getCharacterState']>>>()
    baseApi.getCharacterState.mockImplementationOnce(() => oldClear.promise)
    baseApi.getCharacterState.mockImplementationOnce(() => oldInstance.promise)
    const store = useCharacterRuntimeStore()
    const clearRequest = store.loadState('instance-elysia')
    const instanceRequest = store.loadState('instance-cyrene')
    store.clear()
    oldClear.reject(new Error('[BACKEND_REJECTED] [backendCode=OLD_STATE] old'))
    oldInstance.reject(new Error('[BACKEND_REJECTED] [backendCode=OLD_INSTANCE] old'))
    await Promise.all([clearRequest, instanceRequest])
    expect(store.statesByInstanceId).toEqual({})
    expect(store.stateStatus).toEqual({})
    expect(store.stateErrors).toEqual({})

    const oldPerInstance = deferred<Awaited<ReturnType<MockCharacterBackend['getCharacterState']>>>()
    baseApi.getCharacterState.mockImplementationOnce(() => oldPerInstance.promise)
    const stale = store.loadState('instance-cyrene')
    store.clearInstance('instance-cyrene')
    const fresh = await backend.getCharacterState('instance-cyrene')
    fresh.currentActivity = '重新读取'
    baseApi.getCharacterState.mockResolvedValueOnce(fresh)
    const current = store.loadState('instance-cyrene')
    await current
    oldPerInstance.reject(new Error('[BACKEND_REJECTED] [backendCode=OLD_INSTANCE_2] old'))
    await stale
    expect(store.statesByInstanceId['instance-cyrene'].currentActivity).toBe('重新读取')
    expect(store.stateStatus['instance-cyrene']).toBe('ready')
    expect(store.stateErrors['instance-cyrene']).toBeUndefined()
  })

  it('接收旧 epoch 事件时拒绝，active binding 不影响后台 instance 缓存', () => {
    const store = useCharacterRuntimeStore()
    store.setActiveBinding({ characterId: 'builtin/elysia', characterInstanceId: 'instance-elysia', characterRevision: 2, displayName: 'Elysia', presentation: {} }, 'conv-a')
    const event: CharacterStateChangedEvent = {
      event: 'character.state.changed', eventId: 'ev-1', sequence: 1, conversationId: 'conv-b', characterId: 'builtin/cyrene', characterInstanceId: 'instance-cyrene', characterRevision: 2, stateVersion: 1,
      state: { proactiveEnabled: false, updatedAt: '2026-08-31T00:00:00.000Z' }
    }
    store.handleStateChanged(event, 99)
    expect(store.statesByInstanceId['instance-cyrene']).toBeUndefined()
    store.handleStateChanged(event)
    expect(store.statesByInstanceId['instance-cyrene'].characterId).toBe('builtin/cyrene')
    expect(store.activeBinding?.characterId).toBe('builtin/elysia')

    store.handleStateChanged({
      ...event,
      eventId: 'ev-same-version-conflict',
      state: { ...event.state, currentActivity: '同版本冲突，不应覆盖' }
    })
    expect(store.statesByInstanceId['instance-cyrene'].currentActivity).not.toBe('同版本冲突，不应覆盖')
  })

  it('REST snapshot 身份与请求 binding 不一致时 fail-closed，不写入 foreign state', async () => {
    const store = useCharacterRuntimeStore()
    const expected = {
      characterId: 'builtin/elysia', characterInstanceId: 'instance-elysia', characterRevision: 2,
      displayName: 'Elysia', presentation: {}
    }
    const foreign = await backend.getCharacterState('instance-cyrene')
    baseApi.getCharacterState.mockResolvedValueOnce(foreign)
    await store.loadState('instance-elysia', expected)
    expect(store.statesByInstanceId['instance-elysia']).toBeUndefined()
    expect(store.stateStatus['instance-elysia']).toBe('error')
    expect(store.stateErrors['instance-elysia']).toMatchObject({ code: 'CHARACTER_STATE_IDENTITY_MISMATCH' })
    expect(store.stateErrors['instance-elysia']?.message).not.toContain('instance-cyrene')
  })

  it('WS 角色身份冲突不覆盖 instance cache 或 active binding，版本仍严格单调', () => {
    const store = useCharacterRuntimeStore()
    store.setActiveBinding({ characterId: 'builtin/elysia', characterInstanceId: 'instance-elysia', characterRevision: 2, displayName: 'Elysia', presentation: {} }, 'conv-a')
    const base: CharacterStateChangedEvent = {
      event: 'character.state.changed', eventId: 'state-identity-1', sequence: 1, conversationId: 'conv-a',
      characterId: 'builtin/elysia', characterInstanceId: 'instance-elysia', characterRevision: 2, stateVersion: 2,
      state: { mood: { label: '平静', intensity: 0.2, updatedAt: '2026-09-01T00:00:00.000Z' }, proactiveEnabled: false, updatedAt: '2026-09-01T00:00:00.000Z' }
    }
    store.handleStateChanged(base)
    store.handleStateChanged({ ...base, eventId: 'state-foreign-character', sequence: 2, characterId: 'builtin/cyrene', stateVersion: 3 })
    store.handleStateChanged({ ...base, eventId: 'state-old-revision', sequence: 3, characterRevision: 1, stateVersion: 4 })
    store.handleStateChanged({ ...base, eventId: 'state-new-version', sequence: 4, stateVersion: 4, state: { ...base.state, currentActivity: '新活动' } })
    expect(store.statesByInstanceId['instance-elysia']).toMatchObject({ characterId: 'builtin/elysia', characterRevision: 2, stateVersion: 4, currentActivity: '新活动' })
    expect(store.activeBinding).toMatchObject({ characterId: 'builtin/elysia', characterRevision: 2 })
  })
})
