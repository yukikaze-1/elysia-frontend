import { describe, expect, it, vi } from 'vitest'
import { IpcChannels, type CharacterDraft, type CharacterDraftSummary, type IpcResult, type PersistedCharacterDraft } from '@shared/contracts'
import { registerCharacterDraftHandlers } from '../../src/main/characters/character-draft-handlers'

const sanitize = (message: string): string => message

const draft: CharacterDraft = {
  // The local schema intentionally permits an in-progress empty field. This
  // fixture remains complete to exercise the ordinary IPC round trip as well.
  displayName: '草稿角色',
  description: '本地未提交',
  aliases: [],
  promptProfile: {
    corePersonality: '真诚',
    relationshipStyle: '朋友',
    emotionStyle: '',
    speakingStyle: '自然',
    conversationInitiative: '',
    examples: []
  },
  runtimeDefaults: {
    voice: {},
    emotion: { idleExpressions: [] },
    wakeWords: [],
    proactive: { enabled: false, intervalSeconds: 3600, triggers: [] }
  },
  presentation: {}
}

function record(key = 'create:test'): PersistedCharacterDraft {
  return { key, mode: 'create', displayName: draft.displayName, updatedAt: '2026-08-31T00:00:00.000Z', draft }
}

type Handler = (raw: unknown) => Promise<IpcResult<unknown>>

function registerOnce(initial = record()) {
  let current: PersistedCharacterDraft | undefined = initial
  const store = {
    list: vi.fn((): CharacterDraftSummary[] => current ? [{
      key: current.key,
      mode: current.mode,
      displayName: current.displayName,
      updatedAt: current.updatedAt,
      ...(current.characterId !== undefined ? { characterId: current.characterId } : {}),
      ...(current.baseRevision !== undefined ? { baseRevision: current.baseRevision } : {})
    }] : []),
    get: vi.fn((key: string) => current?.key === key ? current : undefined),
    save: vi.fn(async (input: PersistedCharacterDraft) => { current = input }),
    delete: vi.fn(async (key: string) => { if (current?.key === key) current = undefined })
  }
  const handlers = new Map<string, { invoke: Handler; arity: number }>()
  registerCharacterDraftHandlers({
    drafts: store,
    sanitize,
    register: (channel, invoke, arity = 0) => handlers.set(channel, { invoke, arity })
  })
  return { store, handlers }
}

async function invoke(handlers: Map<string, { invoke: Handler; arity: number }>, channel: string, raw?: unknown) {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`未注册通道: ${channel}`)
  return handler.invoke(raw)
}

describe('FE-D2 角色草稿 IPC', () => {
  it('只注册四个具名通道，list 只返回摘要，get/save/delete 完成闭环', async () => {
    const { store, handlers } = registerOnce()
    expect([...handlers.keys()]).toEqual([
      IpcChannels.characterDraftsList,
      IpcChannels.characterDraftsGet,
      IpcChannels.characterDraftsSave,
      IpcChannels.characterDraftsDelete
    ])
    expect(handlers.get(IpcChannels.characterDraftsList)?.arity).toBe(0)
    expect(handlers.get(IpcChannels.characterDraftsGet)?.arity).toBe(1)
    expect(handlers.get(IpcChannels.characterDraftsSave)?.arity).toBe(1)
    expect(handlers.get(IpcChannels.characterDraftsDelete)?.arity).toBe(1)

    const listed = await invoke(handlers, IpcChannels.characterDraftsList, undefined)
    expect(listed).toEqual({ ok: true, data: [{ key: 'create:test', mode: 'create', displayName: '草稿角色', updatedAt: '2026-08-31T00:00:00.000Z' }] })
    expect(listed).not.toHaveProperty('data[0].draft')

    const loaded = await invoke(handlers, IpcChannels.characterDraftsGet, { key: 'create:test' })
    expect(loaded).toMatchObject({ ok: true, data: { key: 'create:test', draft: { displayName: '草稿角色' } } })

    const next = { ...record('create:next'), displayName: '下一版', draft: { ...draft, displayName: '下一版' }, statePolicy: 'reset_evolution' as const }
    expect(await invoke(handlers, IpcChannels.characterDraftsSave, next)).toEqual({ ok: true, data: undefined })
    expect(store.save).toHaveBeenCalledWith(expect.objectContaining({ key: 'create:next' }))
    const nextLoaded = await invoke(handlers, IpcChannels.characterDraftsGet, { key: 'create:next' })
    expect(nextLoaded).toMatchObject({ ok: true, data: { key: 'create:next', statePolicy: 'reset_evolution', draft: { displayName: '下一版' } } })
    const nextListed = await invoke(handlers, IpcChannels.characterDraftsList, undefined)
    expect(nextListed).toEqual({ ok: true, data: [{ key: 'create:next', mode: 'create', displayName: '下一版', updatedAt: '2026-08-31T00:00:00.000Z' }] })
    expect(nextListed).not.toHaveProperty('data[0].statePolicy')
    expect(nextListed).not.toHaveProperty('data[0].draft')
    expect(await invoke(handlers, IpcChannels.characterDraftsDelete, { key: 'create:next' })).toEqual({ ok: true, data: undefined })
    expect(store.delete).toHaveBeenCalledWith('create:next')
  })

  it('request strict、响应 strict；未知字段、伪造路径和未知 channel 都不能越过 Main', async () => {
    const { handlers } = registerOnce()
    expect(await invoke(handlers, IpcChannels.characterDraftsList, {})).toMatchObject({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED' } })
    expect(await invoke(handlers, IpcChannels.characterDraftsGet, { key: 'create:test', path: 'C:\\secret' })).toMatchObject({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED' } })
    expect(await invoke(handlers, IpcChannels.characterDraftsDelete, { key: '' })).toMatchObject({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED' } })
    expect(await invoke(handlers, IpcChannels.characterDraftsSave, { ...record(), unknown: true })).toMatchObject({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED' } })
    await expect(invoke(handlers, 'character-drafts:raw-path', undefined)).rejects.toThrow('未注册通道')
  })

  it('允许保存表单中间态，但仍拒绝草稿正文中的未知字段', async () => {
    const { store, handlers } = registerOnce()
    const partial: PersistedCharacterDraft = {
      ...record('create:partial'),
      displayName: '',
      draft: { ...draft, displayName: '', promptProfile: { ...draft.promptProfile, corePersonality: '' } }
    }
    expect(await invoke(handlers, IpcChannels.characterDraftsSave, partial)).toEqual({ ok: true, data: undefined })
    expect(store.save).toHaveBeenCalledWith(expect.objectContaining({ displayName: '' }))
    expect(await invoke(handlers, IpcChannels.characterDraftsSave, { ...partial, draft: { ...partial.draft, promptProfile: { ...partial.draft.promptProfile, unknown: true } } })).toMatchObject({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED' } })
  })
})
