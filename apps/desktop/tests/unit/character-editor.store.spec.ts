import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type {
  CharacterDetail,
  CharacterDraft,
  CharacterPreviewResult,
  CharacterValidationResult,
  PersistedCharacterDraft,
  CharacterMutationResult,
  CharacterDraftSummary
} from '@shared/contracts'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { createDesktopApiMock } from './helpers/desktop-api'
import { CHARACTER_EDITOR_DRAFT_DEBOUNCE_MS, useCharacterEditorStore } from '../../src/renderer/src/stores/character-editor.store'

function draft(name = '测试角色'): CharacterDraft {
  return {
    displayName: name,
    description: '说明',
    aliases: ['测试'],
    promptProfile: {
      corePersonality: '真诚', relationshipStyle: '朋友', emotionStyle: '细腻',
      speakingStyle: '自然', conversationInitiative: '适度', examples: []
    },
    runtimeDefaults: {
      voice: {}, emotion: { idleExpressions: [] }, wakeWords: ['测试'],
      proactive: { enabled: false, intervalSeconds: 3600, triggers: [] }
    },
    presentation: {}
  }
}

function detail(name = '原角色'): CharacterDetail {
  const value = draft(name)
  return {
    summary: {
      characterId: 'custom/test', source: 'custom', mutable: true, status: 'active',
      currentRevision: 3, displayName: name, description: value.description,
      aliases: value.aliases, presentation: {}, updatedAt: '2026-08-31T00:00:00.000Z'
    },
    current: {
      ...value, characterId: 'custom/test', revision: 3, schemaVersion: 1,
      checksum: 'checksum', compilerVersion: 1, createdBy: 'user', createdAt: '2026-08-31T00:00:00.000Z'
    }
  }
}

function mutation(value: CharacterDetail): CharacterMutationResult {
  return { character: value, stateImpact: { statePolicy: 'preserve', affectedInstances: 0, pendingInstances: 0, resetFields: [] } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve()
}

describe('characterEditorStore FE-D2', () => {
  let saved: PersistedCharacterDraft[]
  let api: ReturnType<typeof buildApi>

  /**
   * I-06 / P2-10：把 mock 字面量收进工厂函数，`api` 的类型因此由字面量**推断**——每个键保留真实签名，
   * 本文件 67 处 `api.x` 的 `toHaveBeenCalledWith` 实参检查得以保留。原先声明为
   * `Record<string, ReturnType<typeof vi.fn>>`：键被擦成 `string`，工厂的键/值校验无从进行。
   */
  function buildApi(original: CharacterDetail) {
    return {
      listCharacterDrafts: vi.fn(async () => saved.map(({ draft: _draft, ...summary }) => summary)),
      getCharacterDraft: vi.fn(async (key: string) => saved.find((item) => item.key === key)),
      saveCharacterDraft: vi.fn(async (entry: PersistedCharacterDraft) => {
        saved = [...saved.filter((item) => item.key !== entry.key), entry]
      }),
      deleteCharacterDraft: vi.fn(async (key: string) => { saved = saved.filter((item) => item.key !== key) }),
      validateCharacter: vi.fn(async (): Promise<CharacterValidationResult> => ({ valid: true, issues: [] })),
      previewCharacter: vi.fn(async (): Promise<CharacterPreviewResult> => ({ ephemeral: true, reply: '临时回复', model: 'mock' })),
      createCharacter: vi.fn(async (input: { draft: CharacterDraft }) => ({ ...original, summary: { ...original.summary, displayName: input.draft.displayName }, current: { ...original.current, ...input.draft, revision: 1 } })),
      updateCharacter: vi.fn(async (input: { draft: CharacterDraft }) => mutation({ ...original, summary: { ...original.summary, displayName: input.draft.displayName, currentRevision: 4 }, current: { ...original.current, ...input.draft, revision: 4 } }))
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    saved = []
    api = buildApi(detail())
    setDesktopApi(createDesktopApiMock(api))
    // The production store fails closed until bootstrap observes a connected
    // state; unit tests that exercise remote operations explicitly opt in.
    useCharacterEditorStore().setOnline(true)
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('三种模式都深拷贝详情；edit/clone 保存语义分离', async () => {
    const store = useCharacterEditorStore()
    const source = detail()
    store.beginEdit(source)
    source.current.promptProfile.examples.push({ user: '外部修改', assistant: '不应进入草稿' })
    expect(store.draft?.promptProfile.examples).toEqual([])
    expect(store.mode).toBe('edit')
    expect(store.baseCharacterId).toBe('custom/test')
    expect(store.baseRevision).toBe(3)

    store.beginClone(detail(), '复制角色')
    await store.save()
    expect(api.createCharacter).toHaveBeenCalledWith(expect.objectContaining({ draft: expect.objectContaining({ displayName: '复制角色' }) }))
    expect(api.updateCharacter).not.toHaveBeenCalled()

    store.beginCreate(draft('新角色'))
    await store.save()
    expect(api.createCharacter).toHaveBeenLastCalledWith({ draft: expect.objectContaining({ displayName: '新角色' }) })
  })

  it('更新字段只改当前 draft，防抖写入 Main 草稿并可 flush/recover', async () => {
    const store = useCharacterEditorStore()
    store.beginCreate(draft())
    const key = store.draftKey
    store.updateField('/promptProfile/corePersonality', '新的性格')
    expect(store.dirty).toBe(true)
    expect(store.draft?.promptProfile.corePersonality).toBe('新的性格')
    expect(api.saveCharacterDraft).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(799)
    expect(api.saveCharacterDraft).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(api.saveCharacterDraft).toHaveBeenCalledTimes(1)
    expect(saved[0]).toMatchObject({ key, displayName: '测试角色', draft: { promptProfile: { corePersonality: '新的性格' } } })

    const other = useCharacterEditorStore()
    expect(await other.recoverDraft(key!)).toBe(true)
    expect(other.dirty).toBe(true)
    expect(other.draft?.promptProfile.corePersonality).toBe('新的性格')
    expect(other.draft).not.toBe(saved[0].draft)
  })

  it('半成品长表单也能写入并恢复；远端 strict schema 仍留给显式校验', async () => {
    const store = useCharacterEditorStore()
    store.beginCreate()
    store.updateField('/displayName', '')
    await vi.advanceTimersByTimeAsync(CHARACTER_EDITOR_DRAFT_DEBOUNCE_MS)
    expect(api.saveCharacterDraft).toHaveBeenCalledTimes(1)
    expect(saved[0].displayName).toBe('')
    expect(saved[0].draft.promptProfile.corePersonality).toBe('')

    const recovered = useCharacterEditorStore()
    expect(await recovered.recoverDraft(store.draftKey!)).toBe(true)
    expect(recovered.draft?.displayName).toBe('')
  })

  it('校验 error 阻止保存，warning 允许保存；preview 只写独立 preview 状态', async () => {
    const store = useCharacterEditorStore()
    store.beginCreate(draft())
    api.validateCharacter.mockResolvedValueOnce({ valid: false, issues: [{ severity: 'error', code: 'REQUIRED', path: '/displayName', message: '缺少名称' }] })
    await expect(store.save()).rejects.toThrow('CHARACTER_VALIDATION')
    expect(api.createCharacter).not.toHaveBeenCalled()
    expect(store.saveStatus).toBe('error')
    expect(store.validation?.issues[0].path).toBe('/displayName')

    api.validateCharacter.mockResolvedValueOnce({ valid: true, issues: [{ severity: 'warning', code: 'STYLE', path: '/description', message: '建议补充' }] })
    await store.previewCharacter('你好')
    expect(store.preview).toMatchObject({ ephemeral: true, reply: '临时回复' })
    expect(api.previewCharacter).toHaveBeenCalledWith({ draft: expect.any(Object), userMessage: '你好' })
    await store.save()
    expect(api.createCharacter).toHaveBeenCalledTimes(1)
    expect(store.preview).toMatchObject({ ephemeral: true })
  })

  it('409 保留草稿并记录 currentRevision；离线和 epoch 变化不排队/不回填', async () => {
    const store = useCharacterEditorStore()
    store.beginEdit(detail())
    store.updateDraft({ displayName: '本地冲突草稿' })
    api.validateCharacter.mockResolvedValueOnce({ valid: true, issues: [] })
    api.updateCharacter.mockRejectedValueOnce(new Error('[BACKEND_REJECTED] [backendCode=CHARACTER_REVISION_CONFLICT] 冲突 [currentRevision=7]'))
    await expect(store.save()).rejects.toThrow('CHARACTER_REVISION_CONFLICT')
    expect(store.saveStatus).toBe('conflict')
    expect(store.conflict).toMatchObject({ backendCode: 'CHARACTER_REVISION_CONFLICT', currentRevision: 7 })
    expect(store.draft?.displayName).toBe('本地冲突草稿')

    store.setOnline(false)
    await expect(store.validate()).rejects.toThrow('CHARACTER_OFFLINE')
    expect(api.validateCharacter).toHaveBeenCalledTimes(1)
    store.setOnline(true)
    const late = new Promise<CharacterValidationResult>(() => {})
    api.validateCharacter.mockReturnValueOnce(late)
    const pending = store.validate()
    store.setConnectionEpoch(2)
    await Promise.resolve()
    expect(store.validationStatus).toBe('idle')
    void pending
  })

  it('同步抛错不会把持久化状态卡在 loading，保存成功后清理本地草稿', async () => {
    const store = useCharacterEditorStore()
    store.beginCreate(draft())
    api.saveCharacterDraft.mockImplementationOnce(() => { throw new Error('[BACKEND_REJECTED] [backendCode=STORAGE_DOWN] 本地不可用') })
    expect(await store.flushDraft()).toBe(false)
    expect(store.persistenceStatus).toBe('error')

    api.saveCharacterDraft.mockImplementation(async (entry: PersistedCharacterDraft) => {
      saved = [...saved.filter((item) => item.key !== entry.key), entry]
    })
    await store.flushDraft()
    expect(saved).toHaveLength(1)
    await store.save()
    expect(api.deleteCharacterDraft).toHaveBeenCalledWith(store.draftKey)
    expect(saved).toHaveLength(0)
    expect(store.dirty).toBe(false)
  })

  it('updateDraft 后立即保存失败，防抖恢复写仍保存当前完整草稿', async () => {
    const store = useCharacterEditorStore()
    store.beginCreate(draft('保存失败仍可恢复'))
    store.updateDraft({ description: '远端 create 失败后的最新说明' })
    api.createCharacter.mockRejectedValueOnce(new Error('[BACKEND_REJECTED] create failed'))

    await expect(store.save()).rejects.toThrow('create failed')
    expect(api.saveCharacterDraft).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(CHARACTER_EDITOR_DRAFT_DEBOUNCE_MS)
    await flushMicrotasks()
    expect(api.saveCharacterDraft).toHaveBeenCalledTimes(1)
    expect(saved[0]).toMatchObject({
      key: store.draftKey,
      mode: 'create',
      displayName: '保存失败仍可恢复',
      draft: expect.objectContaining({
        displayName: '保存失败仍可恢复',
        description: '远端 create 失败后的最新说明',
        promptProfile: expect.objectContaining({ corePersonality: '真诚' }),
        runtimeDefaults: expect.objectContaining({ proactive: expect.any(Object) })
      })
    })
    expect(saved[0].draft).toEqual(store.draft)
  })

  it.each<[string, (store: ReturnType<typeof useCharacterEditorStore>) => void]>([
    ['connection epoch 变化', (store) => store.setConnectionEpoch(1)],
    ['连接断开', (store) => store.setConnectionState('disconnected')],
    ['角色能力不可用', (store) => store.setConnectionState('connected', { characterProfiles: false })]
  ])('%s 不应取消尚未执行的本地恢复写', async (_label, invalidateRemote) => {
    const store = useCharacterEditorStore()
    store.beginCreate(draft('连接变化仍保存'))
    store.updateDraft({ description: '连接 token 变化前的最新草稿' })
    invalidateRemote(store)

    expect(api.saveCharacterDraft).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(CHARACTER_EDITOR_DRAFT_DEBOUNCE_MS)
    await flushMicrotasks()
    expect(api.saveCharacterDraft).toHaveBeenCalledTimes(1)
    expect(store.persistenceStatus).toBe('success')
    expect(saved[0]).toMatchObject({
      displayName: '连接变化仍保存',
      draft: expect.objectContaining({ description: '连接 token 变化前的最新草稿' })
    })
  })

  it('保存进行中修改 statePolicy，远端成功后保留策略并落盘脏草稿', async () => {
    const store = useCharacterEditorStore()
    store.beginEdit(detail('保存中策略'))
    store.updateDraft({ description: '保存中仍要保留的内容' })
    const remote = deferred<CharacterMutationResult>()
    api.updateCharacter.mockReturnValueOnce(remote.promise)
    const saving = store.save()
    await flushMicrotasks()
    expect(api.updateCharacter).toHaveBeenCalledTimes(1)

    store.setStatePolicy('reset_evolution')
    expect(store.statePolicy).toBe('reset_evolution')
    expect(store.dirty).toBe(true)

    const authoritative = detail('保存中策略')
    authoritative.summary.currentRevision = 4
    authoritative.current.revision = 4
    remote.resolve(mutation(authoritative))
    await saving

    expect(store.statePolicy).toBe('reset_evolution')
    expect(store.dirty).toBe(true)
    await vi.advanceTimersByTimeAsync(CHARACTER_EDITOR_DRAFT_DEBOUNCE_MS)
    await flushMicrotasks()
    expect(saved).toContainEqual(expect.objectContaining({
      key: 'edit:custom/test',
      statePolicy: 'reset_evolution',
      draft: expect.objectContaining({ description: '保存中仍要保留的内容' })
    }))
  })

  it('reload-after-confirm 丢弃当前草稿前必须显式确认，save-as-new 使用 create', async () => {
    const store = useCharacterEditorStore()
    store.beginEdit(detail())
    store.updateDraft({ displayName: '冲突副本' })
    const key = store.draftKey
    expect(store.reloadAfterCallerConfirm(detail('服务端新版本'), false)).toBe(false)
    expect(store.draft?.displayName).toBe('冲突副本')
    expect(store.reloadAfterCallerConfirm(detail('服务端新版本'), true)).toBe(true)
    expect(store.draft?.displayName).toBe('服务端新版本')
    expect(store.draftKey).not.toBe(key)

    store.beginEdit(detail())
    store.updateDraft({ displayName: '另存为新角色' })
    await store.saveAsNew()
    expect(api.createCharacter).toHaveBeenLastCalledWith({ draft: expect.objectContaining({ displayName: '另存为新角色' }) })
  })

  it('validation/preview 使用各自 token：preview 不会令迟到 validation 永久卡在 loading', async () => {
    const store = useCharacterEditorStore()
    store.beginCreate(draft())
    const validationResult = deferred<CharacterValidationResult>()
    api.validateCharacter.mockReturnValueOnce(validationResult.promise)
    const validating = store.validate()
    await Promise.resolve()
    expect(store.validationStatus).toBe('loading')

    await store.previewCharacter('预览消息')
    expect(store.previewStatus).toBe('success')
    validationResult.resolve({ valid: true, issues: [] })
    await validating
    expect(store.validationStatus).toBe('success')
  })

  it('同一 editor 的重复 save 复用同一个 Promise；sync throw 后 token/finally 释放', async () => {
    const store = useCharacterEditorStore()
    store.beginCreate(draft('重复保存'))
    const creation = deferred<CharacterDetail>()
    api.createCharacter.mockReturnValueOnce(creation.promise)
    const first = store.save()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    const second = store.save()
    // Pinia wraps Promise-returning actions, so object identity at the public
    // action boundary is not stable; the invariant is one remote mutation.
    expect(second).not.toBeUndefined()
    creation.resolve(detail('重复保存'))
    await Promise.all([first, second])
    expect(api.createCharacter).toHaveBeenCalledTimes(1)

    store.beginCreate(draft('同步失败'))
    api.createCharacter.mockImplementationOnce(() => { throw new Error('[BACKEND_REJECTED] sync') })
    await expect(store.save()).rejects.toThrow('sync')
    api.createCharacter.mockResolvedValueOnce(detail('同步成功'))
    await expect(store.save()).resolves.toBeDefined()
    expect(api.createCharacter).toHaveBeenCalledTimes(3)
  })

  it('create/clone 成功转为 edit 基线，后续保存使用 update 而非再次 create', async () => {
    const store = useCharacterEditorStore()
    const created = detail('新角色')
    created.summary = { ...created.summary, characterId: 'custom/created', displayName: '新角色', currentRevision: 5 }
    created.current = { ...created.current, characterId: 'custom/created', displayName: '新角色', revision: 5 }
    api.createCharacter.mockResolvedValueOnce(created)
    store.beginCreate(draft('新角色'))
    await store.save()
    expect(store.mode).toBe('edit')
    expect(store.baseCharacterId).toBe('custom/created')
    expect(store.baseRevision).toBe(5)

    store.updateDraft({ description: '第二次修改' })
    const updated = detail('第二次修改')
    updated.summary = { ...updated.summary, characterId: 'custom/created', displayName: '新角色', currentRevision: 6 }
    updated.current = { ...updated.current, characterId: 'custom/created', displayName: '新角色', revision: 6, description: '第二次修改' }
    api.updateCharacter.mockResolvedValueOnce(mutation(updated))
    await store.save()
    expect(api.createCharacter).toHaveBeenCalledTimes(1)
    expect(api.updateCharacter).toHaveBeenCalledWith(expect.objectContaining({ characterId: 'custom/created', expectedRevision: 5 }))
    expect(store.baseRevision).toBe(6)
  })

  it('valid=false 即使只有 warning 也阻止保存；只有 valid=true 的 warning 放行', async () => {
    const store = useCharacterEditorStore()
    store.beginCreate(draft('校验语义'))
    api.validateCharacter.mockResolvedValueOnce({ valid: false, issues: [{ severity: 'warning', code: 'STYLE', path: '/description', message: '建议补充' }] })
    await expect(store.save()).rejects.toThrow('CHARACTER_VALIDATION')
    expect(api.createCharacter).not.toHaveBeenCalled()

    api.validateCharacter.mockResolvedValueOnce({ valid: true, issues: [{ severity: 'warning', code: 'STYLE', path: '/description', message: '建议补充' }] })
    await expect(store.save()).resolves.toBeDefined()
    expect(api.createCharacter).toHaveBeenCalledTimes(1)
  })

  it('clean edit 成功会删除旧恢复草稿；同 session 继续编辑会保留并重写 rebased key', async () => {
    const store = useCharacterEditorStore()
    store.beginEdit(detail())
    const oldKey = store.draftKey!
    store.updateDraft({ displayName: '已写入旧草稿' })
    await store.flushDraft()
    expect(saved.some((item) => item.key === oldKey)).toBe(true)

    const cleanResult = detail('已保存')
    cleanResult.current.displayName = '已保存'
    cleanResult.summary.displayName = '已保存'
    cleanResult.summary.currentRevision = 4
    cleanResult.current.revision = 4
    api.updateCharacter.mockResolvedValueOnce(mutation(cleanResult))
    await store.save()
    expect(api.deleteCharacterDraft).toHaveBeenCalledWith(oldKey)
    expect(saved.some((item) => item.key === oldKey)).toBe(false)

    store.beginCreate(draft('初始创建'))
    const createResult = detail('创建后的权威角色')
    createResult.summary = { ...createResult.summary, characterId: 'custom/rebased', displayName: '初始创建', currentRevision: 7 }
    createResult.current = { ...createResult.current, characterId: 'custom/rebased', displayName: '初始创建', revision: 7 }
    const createPending = deferred<CharacterDetail>()
    api.createCharacter.mockReturnValueOnce(createPending.promise)
    const saving = store.save()
    store.updateDraft({ description: '保存期间的新输入' })
    createPending.resolve(createResult)
    await saving
    expect(store.mode).toBe('edit')
    expect(store.baseCharacterId).toBe('custom/rebased')
    expect(store.baseRevision).toBe(7)
    expect(store.draft?.description).toBe('保存期间的新输入')
    expect(store.dirty).toBe(true)
    await vi.advanceTimersByTimeAsync(CHARACTER_EDITOR_DRAFT_DEBOUNCE_MS)
    expect(saved).toContainEqual(expect.objectContaining({ key: 'edit:custom/rebased', draft: expect.objectContaining({ description: '保存期间的新输入' }) }))
  })

  it('保存清理等待期间切换 editor：不同 key 删除旧 key，同 deterministic edit key 保护新会话', async () => {
    const persistPending = deferred<void>()
    api.saveCharacterDraft.mockReturnValueOnce(persistPending.promise)
    const store = useCharacterEditorStore()
    store.beginEdit(detail())
    const oldKey = store.draftKey!
    const oldPersist = store.flushDraft()
    const remote = deferred<CharacterMutationResult>()
    api.updateCharacter.mockReturnValueOnce(remote.promise)
    const saving = store.save()
    await flushMicrotasks()
    remote.resolve(mutation(detail('服务端保存')))
    store.beginEdit(detail('同 key 新会话'))
    persistPending.resolve()
    await oldPersist
    await saving
    expect(api.deleteCharacterDraft).not.toHaveBeenCalledWith(oldKey)

    store.beginEdit(detail())
    const differentOldKey = store.draftKey!
    const otherPersist = deferred<void>()
    api.saveCharacterDraft.mockReturnValueOnce(otherPersist.promise)
    const otherFlush = store.flushDraft()
    const otherRemote = deferred<CharacterMutationResult>()
    api.updateCharacter.mockReturnValueOnce(otherRemote.promise)
    const otherSaving = store.save()
    await flushMicrotasks()
    otherRemote.resolve(mutation(detail('切换前保存')))
    store.beginCreate(draft('不同 key'))
    otherPersist.resolve()
    await otherFlush
    await otherSaving
    expect(api.deleteCharacterDraft).toHaveBeenCalledWith(differentOldKey)
  })

  it('discard 等待旧 persist 时只保护同 key 新 editor，不阻止不同 key 清理', async () => {
    const store = useCharacterEditorStore()
    store.beginEdit(detail())
    const sameKey = store.draftKey!
    const samePersist = deferred<void>()
    api.saveCharacterDraft.mockReturnValueOnce(samePersist.promise)
    const sameFlush = store.flushDraft()
    const discardSame = store.discardDraft()
    store.beginEdit(detail('重新打开同 key'))
    api.deleteCharacterDraft.mockClear()
    samePersist.resolve()
    await sameFlush
    await discardSame
    expect(api.deleteCharacterDraft).not.toHaveBeenCalledWith(sameKey)

    store.beginEdit(detail())
    const differentKey = store.draftKey!
    const differentPersist = deferred<void>()
    api.saveCharacterDraft.mockReturnValueOnce(differentPersist.promise)
    const differentFlush = store.flushDraft()
    const discardDifferent = store.discardDraft()
    store.beginCreate(draft('新建 editor'))
    differentPersist.resolve()
    await differentFlush
    await discardDifferent
    expect(api.deleteCharacterDraft).toHaveBeenCalledWith(differentKey)
  })

  it('reload/save-as-new 的旧 key 清理受 generation guard 保护，切换不同 key 仍清理', async () => {
    const store = useCharacterEditorStore()
    store.beginEdit(detail())
    const reloadKey = store.draftKey!
    const reloadPersist = deferred<void>()
    api.saveCharacterDraft.mockReturnValueOnce(reloadPersist.promise)
    const reloadFlush = store.flushDraft()
    store.reloadAfterCallerConfirm(detail('服务器版本'), true)
    store.beginEdit(detail('同 key 新编辑'))
    api.deleteCharacterDraft.mockClear()
    reloadPersist.resolve()
    await reloadFlush
    expect(api.deleteCharacterDraft).not.toHaveBeenCalledWith(reloadKey)

    store.beginEdit(detail())
    const saveAsNewKey = store.draftKey!
    const newPersist = deferred<void>()
    api.saveCharacterDraft.mockReturnValueOnce(newPersist.promise)
    const newFlush = store.flushDraft()
    // 刻意不 await：本用例要的就是"saveAsNew 的持久化还没落地时又开新草稿"这段交错（`newFlush` 才是被等待的那个）。
    // 测试目录接入 type-aware（2026-09-13）后用 `void` 显式声明"这个 promise 是有意忽略的"，而不是让它悬空。
    void store.saveAsNew()
    store.beginCreate(draft('另一个 key'))
    newPersist.resolve()
    await newFlush
    expect(api.deleteCharacterDraft).toHaveBeenCalledWith(saveAsNewKey)
  })

  it('迟到 recover/list 不覆盖后来的 editor，非法 recover key 不调用 IPC', async () => {
    const store = useCharacterEditorStore()
    const invalidGetterCalls = api.getCharacterDraft.mock.calls.length
    expect(await store.recoverDraft('')).toBe(false)
    expect(api.getCharacterDraft).toHaveBeenCalledTimes(invalidGetterCalls)

    store.beginCreate(draft('当前编辑'))
    const recoverPending = deferred<PersistedCharacterDraft>()
    api.getCharacterDraft.mockReturnValueOnce(recoverPending.promise)
    const recovering = store.recoverDraft(store.draftKey!)
    store.beginCreate(draft('后来打开'))
    recoverPending.resolve({ key: 'create:recovered', mode: 'create', displayName: '迟到恢复', updatedAt: '2026-08-31T00:00:00.000Z', draft: draft('迟到恢复'), statePolicy: 'preserve' })
    expect(await recovering).toBe(false)
    expect(store.draft?.displayName).toBe('后来打开')
    expect(store.recoveryStatus).toBe('idle')

    const listPending = deferred<CharacterDraftSummary[]>()
    api.listCharacterDrafts.mockReturnValueOnce(listPending.promise)
    const listing = store.listDrafts()
    store.beginCreate(draft('列表期间的新 editor'))
    listPending.resolve([{ key: 'create:late', mode: 'create', displayName: '迟到列表', updatedAt: '2026-08-31T00:00:00.000Z' }])
    await listing
    expect(store.recoverySummaries).toEqual([])
    expect(store.recoveryStatus).toBe('idle')
  })

  it('preview object 只能提供 userMessage，不能注入另一份 draft', async () => {
    const store = useCharacterEditorStore()
    store.beginCreate(draft('真实当前草稿'))
    await store.previewCharacter({ draft: draft('攻击者草稿'), userMessage: '只采用这条消息' } as never)
    expect(api.previewCharacter).toHaveBeenLastCalledWith(expect.objectContaining({
      userMessage: '只采用这条消息',
      draft: expect.objectContaining({ displayName: '真实当前草稿' })
    }))
  })

  it('归档当前角色立即失效未到 debounce 的草稿；归档其它角色不取消当前写入', async () => {
    const store = useCharacterEditorStore()
    store.beginEdit(detail())
    store.updateDraft({ description: '归档前未落盘' })
    await store.handleCharacterArchived('custom/test')
    await vi.advanceTimersByTimeAsync(CHARACTER_EDITOR_DRAFT_DEBOUNCE_MS)
    expect(api.saveCharacterDraft).not.toHaveBeenCalled()

    store.beginEdit(detail())
    store.updateDraft({ description: '其它角色归档仍应保留' })
    await store.handleCharacterArchived('custom/other')
    await vi.advanceTimersByTimeAsync(CHARACTER_EDITOR_DRAFT_DEBOUNCE_MS)
    expect(api.saveCharacterDraft).toHaveBeenCalledWith(expect.objectContaining({ draft: expect.objectContaining({ description: '其它角色归档仍应保留' }) }))
  })
})
