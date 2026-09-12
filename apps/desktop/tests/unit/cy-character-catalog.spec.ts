// @vitest-environment happy-dom
// tests/unit/cy-character-catalog.spec.ts
// CyCharacterCatalog：目录状态机（等待连接/加载/错误/空/stale）、筛选查询契约（即时提交 + 搜索 trim）、
// 本地恢复草稿列表（恢复/删除都要确认）、默认角色徽标与分页加载更多。
// store 走真实 character-catalog/character-editor store，API 经 setDesktopApi mock。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import type { CharacterDraft, CharacterSummary, PersistedCharacterDraft } from '@shared/contracts'
import CyCharacterCatalog from '../../src/renderer/src/components/characters/CyCharacterCatalog.vue'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { createDesktopApiMock, typedMock } from './helpers/desktop-api'
import type { DesktopApiMock } from './helpers/desktop-api'
import { useCharacterCatalogStore } from '../../src/renderer/src/stores/character-catalog.store'
import { useCharacterEditorStore } from '../../src/renderer/src/stores/character-editor.store'
import { useIdentityStore } from '../../src/renderer/src/stores/identity.store'

function summary(characterId: string, patch: Partial<CharacterSummary> = {}): CharacterSummary {
  const builtin = characterId.startsWith('builtin/')
  return {
    characterId,
    source: builtin ? 'builtin' : 'custom',
    mutable: !builtin,
    status: 'active',
    currentRevision: 1,
    displayName: characterId,
    description: '',
    aliases: [],
    presentation: {},
    updatedAt: '2026-08-31T00:00:00.000Z',
    ...patch
  }
}

function draftFixture(displayName: string): CharacterDraft {
  return {
    displayName,
    description: '',
    aliases: [],
    promptProfile: {
      corePersonality: '', relationshipStyle: '', emotionStyle: '', speakingStyle: '',
      conversationInitiative: '', examples: []
    },
    runtimeDefaults: {
      voice: {}, emotion: { idleExpressions: [] }, wakeWords: [],
      proactive: { enabled: false, intervalSeconds: 3600, triggers: [] }
    },
    presentation: {}
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

let pinia: ReturnType<typeof createPinia>
// I-06：这几个都是 `DesktopApiLike` 里的**可选**方法，裸 `vi.fn()`（`Mock<Constructable | Procedure>`）
// 不能赋给 `F | undefined` 联合 ⇒ 用工厂导出的 `DesktopApiMock['x']`（带真实签名的 Mock）标注 + typedMock 构造。
let listCharacters: DesktopApiMock['listCharacters']
let listCharacterDrafts: DesktopApiMock['listCharacterDrafts']
let getCharacterDraft: DesktopApiMock['getCharacterDraft']
let deleteCharacterDraft: DesktopApiMock['deleteCharacterDraft']
let originalConfirm: typeof window.confirm

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  listCharacters = typedMock<'listCharacters'>(async () => ({ items: [], hasMore: false }))
  listCharacterDrafts = typedMock<'listCharacterDrafts'>(async () => [])
  getCharacterDraft = typedMock<'getCharacterDraft'>(async () => undefined)
  deleteCharacterDraft = typedMock<'deleteCharacterDraft'>(async () => {})
  setDesktopApi(createDesktopApiMock({
    listCharacters,
    listCharacterDrafts,
    getCharacterDraft,
    deleteCharacterDraft,
    saveCharacterDraft: typedMock<'saveCharacterDraft'>(async () => {})
  }))
  originalConfirm = window.confirm
  useCharacterEditorStore().setConnectionState('connected', { characterProfiles: true })
})

function setConfirm(value: boolean): ReturnType<typeof vi.fn> {
  const confirm = vi.fn(() => value)
  Object.defineProperty(window, 'confirm', { configurable: true, value: confirm })
  return confirm
}

function mountCatalog() {
  return mount(CyCharacterCatalog, { global: { plugins: [pinia] } })
}

afterEach(() => {
  Object.defineProperty(window, 'confirm', { configurable: true, value: originalConfirm })
})

function lastQuery(): Record<string, unknown> {
  return listCharacters.mock.calls.at(-1)![0] as Record<string, unknown>
}

describe('CyCharacterCatalog 角色目录', () => {
  it('挂载即加载目录与本地草稿，渲染计数、卡片与默认角色徽标', async () => {
    listCharacters.mockResolvedValueOnce({
      items: [summary('builtin/elysia', { displayName: 'Elysia' }), summary('custom/a', { displayName: '自定义 A' })],
      hasMore: false
    })
    useIdentityStore().profile = {
      userId: 'u', displayName: '我', locale: 'zh-CN', timezone: 'UTC', initialized: true, revision: 1,
      createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z', defaultCharacterId: 'custom/a'
    }
    const wrapper = mountCatalog()
    await flushPromises()

    expect(listCharacters).toHaveBeenCalledWith(expect.objectContaining({ status: 'active', limit: 20 }))
    expect(listCharacterDrafts).toHaveBeenCalledTimes(1)
    expect(wrapper.get('.cy-catalog-heading-actions > span').text()).toBe('2 个角色')
    expect(wrapper.findAll('.cy-character-card')).toHaveLength(2)
    expect(wrapper.get('[data-character-id="custom/a"] .cy-badge.default').text()).toBe('默认')
    expect(wrapper.find('[data-character-id="builtin/elysia"] .cy-badge.default').exists()).toBe(false)
    expect(wrapper.get('[data-character-id="builtin/elysia"] .cy-badge').text()).toBe('内置')
    wrapper.unmount()
  })

  it('来源/状态即时提交查询，搜索在提交时才 trim 下发且空搜索不带 search 字段', async () => {
    const wrapper = mountCatalog()
    await flushPromises()

    await wrapper.get('select[aria-label="角色来源"]').setValue('custom')
    await flushPromises()
    expect(lastQuery()).toMatchObject({ status: 'active', source: 'custom' })

    await wrapper.get('select[aria-label="角色状态"]').setValue('archived')
    await flushPromises()
    expect(lastQuery()).toMatchObject({ status: 'archived', source: 'custom' })

    await wrapper.get('input[type="search"]').setValue('  艾  ')
    await wrapper.get('form[role="search"]').trigger('submit')
    await flushPromises()
    expect(lastQuery()).toMatchObject({ search: '艾', status: 'archived' })

    await wrapper.get('input[type="search"]').setValue('   ')
    await wrapper.get('form[role="search"]').trigger('submit')
    await flushPromises()
    expect('search' in lastQuery()).toBe(false)
    wrapper.unmount()
  })

  it('等待连接与错误态可重试，重试使用 force 绕过在途去重', async () => {
    const wrapper = mountCatalog()
    await flushPromises()
    const catalog = useCharacterCatalogStore()
    catalog.status = 'idle'
    await wrapper.vm.$nextTick()
    const waiting = wrapper.get('.cy-catalog-state')
    expect(waiting.text()).toContain('角色目录正在等待连接')
    const callsBeforeRetry = listCharacters.mock.calls.length
    await waiting.get('button').trigger('click')
    await flushPromises()
    expect(listCharacters).toHaveBeenCalledTimes(callsBeforeRetry + 1)
    wrapper.unmount()

    const errorPinia = createPinia()
    setActivePinia(errorPinia)
    useCharacterEditorStore().setConnectionState('connected', { characterProfiles: true })
    listCharacters.mockRejectedValue(new Error('[BACKEND_REJECTED] 后端未启用角色档案能力'))
    const errorWrapper = mount(CyCharacterCatalog, { global: { plugins: [errorPinia] } })
    await flushPromises()
    const errorState = errorWrapper.get('.cy-catalog-state.error')
    expect(errorState.attributes('role')).toBe('alert')
    expect(errorState.text()).toContain('角色目录当前不可用')
    expect(errorState.text()).toContain('后端未启用角色档案能力')
    const errorCalls = listCharacters.mock.calls.length
    await errorState.get('button').trigger('click')
    await flushPromises()
    expect(listCharacters.mock.calls.length).toBe(errorCalls + 1)
    errorWrapper.unmount()
  })

  it('空结果可清除搜索，stale 与刷新中提示互斥且加载更多按 cursor 分页', async () => {
    const wrapper = mountCatalog()
    await flushPromises()
    const catalog = useCharacterCatalogStore()

    await wrapper.get('input[type="search"]').setValue('不存在的角色')
    await wrapper.get('form[role="search"]').trigger('submit')
    await flushPromises()
    expect(catalog.status).toBe('empty')
    expect(wrapper.get('.cy-catalog-state').text()).toContain('没有符合条件的角色')
    await wrapper.get('.cy-catalog-state button').trigger('click')
    await flushPromises()
    expect((wrapper.get('input[type="search"]').element as HTMLInputElement).value).toBe('')
    expect('search' in lastQuery()).toBe(false)

    listCharacters.mockResolvedValueOnce({ items: [summary('custom/paged')], hasMore: true, nextCursor: 'cursor-1' })
    catalog.markStale()
    await wrapper.vm.$nextTick()
    expect(wrapper.get('.cy-catalog-notice').text()).toContain('角色目录有更新，当前结果可能已过期。')
    await wrapper.get('.cy-catalog-notice button').trigger('click')
    await flushPromises()
    expect(wrapper.find('.cy-catalog-notice').exists()).toBe(false)

    const nextPage = deferred<{ items: CharacterSummary[]; hasMore: boolean }>()
    listCharacters.mockImplementationOnce(() => nextPage.promise)
    await wrapper.get('.cy-load-more').trigger('click')
    await wrapper.vm.$nextTick()
    expect(lastQuery()).toMatchObject({ cursor: 'cursor-1' })
    expect(wrapper.get('.cy-load-more').text()).toBe('加载中…')
    expect(wrapper.get('.cy-load-more').attributes('disabled')).toBeDefined()
    nextPage.resolve({ items: [summary('custom/second', { displayName: '第二页角色' })], hasMore: false })
    await flushPromises()
    expect(wrapper.text()).toContain('第二页角色')
    expect(wrapper.find('.cy-load-more').exists()).toBe(false)
    wrapper.unmount()
  })

  it('本地恢复草稿按模式标注，恢复需确认且成功后才通知父组件', async () => {
    const record: PersistedCharacterDraft = {
      key: 'edit:custom/a',
      mode: 'edit',
      characterId: 'custom/a',
      baseRevision: 3,
      displayName: '编辑草稿',
      updatedAt: '2026-08-31T01:00:00.000Z',
      draft: draftFixture('编辑草稿'),
      statePolicy: 'preserve'
    }
    listCharacterDrafts.mockResolvedValue([
      { key: 'create:k1', mode: 'create', displayName: '新建草稿', updatedAt: '2026-08-31T01:00:00.000Z' },
      { key: record.key, mode: record.mode, characterId: record.characterId, baseRevision: record.baseRevision, displayName: record.displayName, updatedAt: record.updatedAt },
      { key: 'clone:k2', mode: 'clone', characterId: 'builtin/elysia', baseRevision: 1, displayName: '克隆草稿', updatedAt: '2026-08-31T01:00:00.000Z' }
    ])
    getCharacterDraft.mockResolvedValue(record)
    const wrapper = mountCatalog()
    await flushPromises()

    expect(wrapper.get('#cy-character-recovery-title').text()).toBe('本地未提交草稿')
    const recoveryItems = () => wrapper.findAll('.cy-recovery li')
    expect(recoveryItems()).toHaveLength(3)
    expect(recoveryItems()[0].find('small').text()).toContain('新建')
    expect(recoveryItems()[1].find('small').text()).toContain('编辑')
    expect(recoveryItems()[2].find('small').text()).toContain('克隆')

    useCharacterEditorStore().dirty = true
    setConfirm(false)
    await recoveryItems()[1].findAll('button')[0].trigger('click')
    await flushPromises()
    expect(getCharacterDraft).not.toHaveBeenCalled()
    expect(wrapper.emitted('recover')).toBeUndefined()

    setConfirm(true)
    await recoveryItems()[1].findAll('button')[0].trigger('click')
    await flushPromises()
    expect(getCharacterDraft).toHaveBeenCalledWith('edit:custom/a')
    expect(wrapper.emitted('recover')).toEqual([['edit:custom/a']])
    expect(useCharacterEditorStore().mode).toBe('edit')

    setConfirm(false)
    await recoveryItems()[0].findAll('button')[1].trigger('click')
    await flushPromises()
    expect(deleteCharacterDraft).not.toHaveBeenCalled()
    setConfirm(true)
    await recoveryItems()[0].findAll('button')[1].trigger('click')
    await flushPromises()
    expect(deleteCharacterDraft).toHaveBeenCalledWith('create:k1')
    expect(recoveryItems()).toHaveLength(2)
    wrapper.unmount()
  })

  it('本地草稿列表失败只降级提示，不阻塞目录浏览；新建入口在保存中禁用', async () => {
    listCharacterDrafts.mockRejectedValueOnce(new Error('[STORAGE_UNAVAILABLE] 本地存储不可用'))
    listCharacters.mockResolvedValueOnce({ items: [summary('builtin/elysia', { displayName: 'Elysia' })], hasMore: false })
    const wrapper = mountCatalog()
    await flushPromises()

    const recoveryError = wrapper.get('.cy-recovery-error')
    expect(recoveryError.attributes('role')).toBe('alert')
    expect(recoveryError.text()).toContain('本地草稿列表暂时不可用')
    expect(wrapper.findAll('.cy-character-card')).toHaveLength(1)

    const createButton = wrapper.findAll('button').find((button) => button.text() === '新建角色')!
    expect(createButton.attributes('disabled')).toBeUndefined()
    await createButton.trigger('click')
    expect(wrapper.emitted('create')).toHaveLength(1)

    useCharacterEditorStore().saveStatus = 'saving'
    await wrapper.vm.$nextTick()
    expect(createButton.attributes('disabled')).toBeDefined()
    await createButton.trigger('click')
    expect(wrapper.emitted('create')).toHaveLength(1)
    wrapper.unmount()
  })
})
