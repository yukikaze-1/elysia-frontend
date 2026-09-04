// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import type { CharacterDetail, CharacterListQuery, CharacterSummary, Page } from '@shared/contracts'
import { MockCharacterBackend } from '../../src/main/characters/mock-character-backend'
import CyCharacterPane from '../../src/renderer/src/components/characters/CyCharacterPane.vue'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { useCharacterCatalogStore } from '../../src/renderer/src/stores/character-catalog.store'
import { useCharacterEditorStore } from '../../src/renderer/src/stores/character-editor.store'
import { useIdentityStore } from '../../src/renderer/src/stores/identity.store'

let details: CharacterDetail[]
let listCharacters: ReturnType<typeof vi.fn>
let backend: MockCharacterBackend
let pinia: ReturnType<typeof createPinia>

function clone<T>(value: T): T { return structuredClone(value) }

beforeEach(async () => {
  pinia = createPinia()
  setActivePinia(pinia)
  backend = new MockCharacterBackend()
  const elysia = await backend.getCharacter('builtin/elysia')
  const custom = clone(await backend.getCharacter('builtin/cyrene'))
  custom.summary.characterId = 'custom/cyrene-soft'
  custom.summary.source = 'custom'
  custom.summary.mutable = true
  custom.summary.displayName = '自定义 Cyrene'
  custom.current.characterId = custom.summary.characterId
  custom.current.displayName = custom.summary.displayName
  const archived = clone(custom)
  archived.summary.characterId = 'custom/archived'
  archived.summary.displayName = '已归档角色'
  archived.summary.status = 'archived'
  archived.current.characterId = archived.summary.characterId
  archived.current.displayName = archived.summary.displayName
  details = [elysia, custom, archived]
  listCharacters = vi.fn(async (input: CharacterListQuery = {}): Promise<Page<CharacterSummary>> => {
    const items = details.map((item) => clone(item.summary))
      .filter((item) => input.status ? item.status === input.status : item.status === 'active')
      .filter((item) => input.source ? item.source === input.source : true)
      .filter((item) => input.search ? item.displayName.toLocaleLowerCase().includes(input.search.toLocaleLowerCase()) : true)
    return { items, hasMore: false }
  })
  setDesktopApi({
    getMe: vi.fn(() => backend.getMe()),
    updateMe: vi.fn((input) => backend.updateMe(input)),
    listCharacters,
    getCharacter: vi.fn(async (id: string) => clone(details.find((item) => item.summary.characterId === id)!))
  } as never)
  useCharacterEditorStore().setConnectionState('connected', { characterProfiles: true })
})

function mountPane() {
  return mount(CyCharacterPane, { global: { plugins: [pinia] } })
}

describe('CyCharacterPane FE-C', () => {
  it('目录展示 builtin/custom、筛选与 stale；列表不泄露 authored Prompt', async () => {
    const wrapper = mountPane()
    await flushPromises()
    expect(wrapper.text()).toContain('Elysia')
    expect(wrapper.text()).toContain('自定义 Cyrene')
    expect(wrapper.text()).toContain('内置')
    expect(wrapper.text()).toContain('自定义')
    expect(wrapper.text()).not.toContain(details[0].current.promptProfile.corePersonality)

    await wrapper.get('select[aria-label="角色来源"]').setValue('custom')
    await flushPromises()
    expect(listCharacters).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'custom', status: 'active' }))
    expect(wrapper.text()).not.toContain('Elysia')
    expect(wrapper.text()).toContain('自定义 Cyrene')

    useCharacterCatalogStore().markStale()
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('角色目录有更新')
    wrapper.unmount()
  })

  it('remount 从共享 lastQuery 恢复 archived/custom/search 控件且不重复请求', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useCharacterEditorStore().setConnectionState('connected', { characterProfiles: true })
    const first = mount(CyCharacterPane, { global: { plugins: [pinia] } })
    await flushPromises()
    await first.get('select[aria-label="角色来源"]').setValue('custom')
    await first.get('select[aria-label="角色状态"]').setValue('archived')
    await first.get('input[type="search"]').setValue('已归档')
    await first.get('form[role="search"]').trigger('submit')
    await flushPromises()
    expect(first.text()).toContain('已归档角色')
    const callsBeforeRemount = listCharacters.mock.calls.length
    first.unmount()

    const second = mount(CyCharacterPane, { global: { plugins: [pinia] } })
    await flushPromises()
    expect((second.get('select[aria-label="角色来源"]').element as HTMLSelectElement).value).toBe('custom')
    expect((second.get('select[aria-label="角色状态"]').element as HTMLSelectElement).value).toBe('archived')
    expect((second.get('input[type="search"]').element as HTMLInputElement).value).toBe('已归档')
    expect(second.text()).toContain('已归档角色')
    expect(listCharacters).toHaveBeenCalledTimes(callsBeforeRemount)
    second.unmount()
  })

  it('挂载期间外部连接世代与 active 查询会同步控件/结果，并从失效详情安全返回目录', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const catalog = useCharacterCatalogStore()
    await catalog.loadList({ status: 'archived', source: 'custom', limit: 20 })
    const wrapper = mount(CyCharacterPane, { global: { plugins: [pinia] } })
    await flushPromises()
    expect(wrapper.text()).toContain('已归档角色')

    catalog.setConnectionEpoch(1)
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('角色目录正在等待连接')
    await catalog.loadList({ status: 'active', limit: 20 })
    await flushPromises()
    expect((wrapper.get('select[aria-label="角色来源"]').element as HTMLSelectElement).value).toBe('all')
    expect((wrapper.get('select[aria-label="角色状态"]').element as HTMLSelectElement).value).toBe('active')
    expect(wrapper.text()).toContain('Elysia')

    await wrapper.findAll('button').find((button) => button.text() === '查看详情')!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('基本信息')
    catalog.setConnectionEpoch(2)
    await flushPromises()
    expect(wrapper.text()).not.toContain('基本信息')
    expect(wrapper.find('form[role="search"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('覆盖 loading/error/empty 与分页加载更多', async () => {
    let resolveFirst: ((page: Page<CharacterSummary>) => void) | undefined
    listCharacters.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
    const wrapper = mountPane()
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('正在加载角色目录')
    resolveFirst?.({ items: [], hasMore: false })
    await flushPromises()
    expect(wrapper.text()).toContain('没有符合条件的角色')
    wrapper.unmount()

    const pinia = createPinia(); setActivePinia(pinia)
    listCharacters.mockRejectedValueOnce(new Error('[NOT_IMPLEMENTED] 目录不可用'))
    const errorWrapper = mount(CyCharacterPane, { global: { plugins: [pinia] } })
    await flushPromises()
    expect(errorWrapper.text()).toContain('角色目录当前不可用')
    errorWrapper.unmount()

    const pagePinia = createPinia(); setActivePinia(pagePinia)
    listCharacters
      .mockResolvedValueOnce({ items: [details[0].summary], hasMore: true, nextCursor: 'next' })
      .mockResolvedValueOnce({ items: [details[1].summary], hasMore: false })
    const pageWrapper = mount(CyCharacterPane, { global: { plugins: [pagePinia] } })
    await flushPromises()
    expect(pageWrapper.text()).toContain('加载更多')
    await pageWrapper.get('.cy-load-more').trigger('click')
    await flushPromises()
    expect(pageWrapper.text()).toContain('Elysia')
    expect(pageWrapper.text()).toContain('自定义 Cyrene')
    expect(listCharacters).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'next' }))
    pageWrapper.unmount()
  })

  it('详情以纯文本折叠展示 authored 内容，并精确呈现内置角色的只读动作', async () => {
    details[0].current.promptProfile.corePersonality = '<img src=x onerror=alert(1)> 纯文本人格'
    const wrapper = mountPane()
    await flushPromises()
    const detailButton = wrapper.findAll('button').find((button) => button.text() === '查看详情')!
    await detailButton.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('<img src=x onerror=alert(1)> 纯文本人格')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('authored 人格设定（只读）')
    const labels = wrapper.findAll('.cy-detail-actions button').map((button) => button.text())
    expect(labels).toContain('克隆并自定义')
    expect(labels).not.toContain('编辑')
    expect(labels).not.toContain('归档')
    expect(labels).not.toContain('预览')
    expect(wrapper.text()).toContain('内置角色定义保持只读')
    wrapper.unmount()
  })

  it('默认角色反馈只属于本次详情操作，历史保存不误报且成功/冲突精确显示', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const identity = useIdentityStore()
    await identity.load()
    identity.updateDraft({ displayName: '历史保存' })
    await identity.save()

    const historical = mount(CyCharacterPane, { global: { plugins: [pinia] } })
    await flushPromises()
    await historical.findAll('button').find((button) => button.text() === '查看详情')!.trigger('click')
    await flushPromises()
    expect(historical.text()).not.toContain('已设为默认角色。')
    historical.unmount()

    const successPinia = createPinia()
    setActivePinia(successPinia)
    useCharacterEditorStore().setConnectionState('connected', { characterProfiles: true })
    const nextProfile = await backend.getMe()
    setDesktopApi({
      getMe: vi.fn(() => backend.getMe()),
      listCharacters,
      getCharacter: vi.fn(async (id: string) => clone(details.find((item) => item.summary.characterId === id)!)),
      updateMe: vi.fn(async (input: { defaultCharacterId?: string }) => ({
        ...nextProfile,
        revision: nextProfile.revision + 1,
        defaultCharacterId: input.defaultCharacterId
      }))
    } as never)
    await useIdentityStore().load()
    const success = mount(CyCharacterPane, { global: { plugins: [successPinia] } })
    await flushPromises()
    await success.findAll('button').filter((button) => button.text() === '查看详情')[1].trigger('click')
    await flushPromises()
    await success.get('.cy-default-action').trigger('click')
    await flushPromises()
    expect(success.text()).toContain('已设为默认角色。')
    useIdentityStore().setConnectionEpoch(1)
    await success.vm.$nextTick()
    expect(success.text()).not.toContain('已设为默认角色。')
    success.unmount()

    const conflictPinia = createPinia()
    setActivePinia(conflictPinia)
    useCharacterEditorStore().setConnectionState('connected', { characterProfiles: true })
    setDesktopApi({
      getMe: vi.fn(() => backend.getMe()),
      listCharacters,
      getCharacter: vi.fn(async (id: string) => clone(details.find((item) => item.summary.characterId === id)!)),
      updateMe: vi.fn(() => Promise.reject(new Error('[BACKEND_REJECTED] [backendCode=USER_PROFILE_REVISION_CONFLICT] 冲突')))
    } as never)
    await useIdentityStore().load()
    const conflict = mount(CyCharacterPane, { global: { plugins: [conflictPinia] } })
    await flushPromises()
    await conflict.findAll('button').filter((button) => button.text() === '查看详情')[1].trigger('click')
    await flushPromises()
    await conflict.get('.cy-default-action').trigger('click')
    await flushPromises()
    expect(conflict.text()).toContain('档案版本发生冲突')
    expect(conflict.text()).not.toContain('已设为默认角色。')
    conflict.unmount()
  })

  it('initial-character-id 路由可从会话头部准确打开对应角色详情', async () => {
    const wrapper = mount(CyCharacterPane, {
      props: { initialCharacterId: details[1].summary.characterId },
      global: { plugins: [pinia] }
    })
    await flushPromises()
    expect(wrapper.text()).toContain('自定义 Cyrene')
    expect(wrapper.text()).toContain('基本信息')
    expect(wrapper.text()).not.toContain('Elysia 内置角色定义保持只读')
    wrapper.unmount()
  })
})
