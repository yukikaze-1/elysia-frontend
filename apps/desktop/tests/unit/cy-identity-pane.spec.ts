// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import type { CharacterListQuery, UpdateUserIdentityCommand } from '@shared/contracts'
import { MockCharacterBackend } from '../../src/main/characters/mock-character-backend'
import CyIdentityPane from '../../src/renderer/src/components/characters/CyIdentityPane.vue'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { createDesktopApiMock } from './helpers/desktop-api'
import { useIdentityStore } from '../../src/renderer/src/stores/identity.store'
import { useCharacterCatalogStore } from '../../src/renderer/src/stores/character-catalog.store'
import type { DesktopApiMock } from './helpers/desktop-api'

let backend: MockCharacterBackend
// I-06：`updateMe` 是可选方法 ⇒ 裸 `ReturnType<typeof vi.fn>` 不可赋值。
let updateMe: DesktopApiMock['updateMe']

beforeEach(() => {
  const pinia = createPinia()
  setActivePinia(pinia)
  backend = new MockCharacterBackend({ initialProfile: { initialized: false } })
  updateMe = vi.fn((input: UpdateUserIdentityCommand) => backend.updateMe(input))
  setDesktopApi(createDesktopApiMock({
    getMe: vi.fn(() => backend.getMe()),
    updateMe,
    listCharacters: vi.fn((input: CharacterListQuery) => backend.listCharacters(input))
  }))
})

function mountPane() {
  return mount(CyIdentityPane, { global: { plugins: [createPinia()] } })
}

describe('CyIdentityPane FE-C', () => {
  it('未初始化档案显示引导，保存完整命令并说明只影响下一轮', async () => {
    const wrapper = mountPane()
    await flushPromises()
    expect(wrapper.text()).toContain('未完成初始化')
    expect(wrapper.text()).toContain('旧会话仍然可以浏览')
    expect(wrapper.text()).toContain('从下一轮对话起生效')

    await wrapper.get('input[name="displayName"]').setValue('小雨')
    await wrapper.get('input[name="preferredAddress"]').setValue('小雨')
    await wrapper.get('select[name="defaultCharacterId"]').setValue('builtin/cyrene')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(updateMe).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 1,
      displayName: '小雨',
      preferredAddress: '小雨',
      defaultCharacterId: 'builtin/cyrene'
    }))
    expect(wrapper.text()).toContain('档案已保存')
    expect(useIdentityStore().profile).toMatchObject({ initialized: true, revision: 2, displayName: '小雨' })
    useIdentityStore().setConnectionEpoch(1)
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('档案正在等待连接')
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(wrapper.find('form').exists()).toBe(true)
    wrapper.unmount()
  })

  it('revision conflict 保留表单并给出刷新入口，失败不伪成功', async () => {
    updateMe.mockRejectedValueOnce(new Error('[BACKEND_REJECTED] [backendCode=USER_PROFILE_REVISION_CONFLICT] 档案冲突'))
    const wrapper = mountPane()
    await flushPromises()
    await wrapper.get('input[name="displayName"]').setValue('不能丢的输入')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('档案版本发生冲突')
    expect((wrapper.get('input[name="displayName"]').element as HTMLInputElement).value).toBe('不能丢的输入')
    expect(wrapper.text()).not.toContain('档案已保存。')
    wrapper.unmount()
  })

  it('IPC/能力不可用时显示可理解错误与重试，不影响组件挂载', async () => {
    setDesktopApi(createDesktopApiMock({
      getMe: vi.fn(() => Promise.reject(new Error('[NOT_IMPLEMENTED] [backendCode=CHARACTER_PROFILES_UNAVAILABLE] 当前后端未启用角色档案能力'))),
      listCharacters: vi.fn(() => Promise.reject(new Error('unavailable')))
    }))
    const wrapper = mountPane()
    await flushPromises()
    expect(wrapper.text()).toContain('当前无法使用角色档案')
    expect(wrapper.text()).toContain('当前后端未启用角色档案能力')
    expect(wrapper.find('button').text()).toContain('重试')
    wrapper.unmount()
  })

  it('覆盖任意旧目录查询并加载完整 active 默认角色候选，分页可显式继续', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const all = (await backend.listCharacters({ status: 'active' })).items
    const listCharacters = vi.fn(async (input: { status?: string; source?: string; search?: string; limit?: number; cursor?: string } = {}) => {
      if (input.status === 'archived') return { items: [], hasMore: false }
      if (input.cursor === 'active-next') return { items: [all[1]], hasMore: false }
      return { items: [all[0]], hasMore: true, nextCursor: 'active-next' }
    })
    setDesktopApi(createDesktopApiMock({
      getMe: vi.fn(() => backend.getMe()),
      updateMe,
      listCharacters
    }))
    const catalog = useCharacterCatalogStore()
    await catalog.loadList({ status: 'archived', source: 'custom', search: '旧查询', limit: 20 })

    const wrapper = mount(CyIdentityPane, { global: { plugins: [pinia] } })
    await flushPromises()
    expect(listCharacters).toHaveBeenLastCalledWith({ status: 'active', limit: 100 })
    expect(wrapper.findAll('select[name="defaultCharacterId"] option')).toHaveLength(2)
    expect(wrapper.text()).toContain('加载更多可用角色')
    await wrapper.get('.cy-load-more-candidates').trigger('click')
    await flushPromises()
    expect(listCharacters).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'active', limit: 100, cursor: 'active-next' }))
    expect(wrapper.findAll('select[name="defaultCharacterId"] option')).toHaveLength(3)
    await wrapper.get('select[name="defaultCharacterId"]').setValue(all[1].characterId)
    expect((wrapper.get('select[name="defaultCharacterId"]').element as HTMLSelectElement).value).toBe(all[1].characterId)
    wrapper.unmount()
  })

  it('canonical 候选 stale 会刷新、ready 不重复，error 提供可操作重试', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const canonical = { status: 'active' as const, limit: 100 }
    const listCharacters = vi.fn((input: CharacterListQuery) => backend.listCharacters(input))
    setDesktopApi(createDesktopApiMock({ getMe: vi.fn(() => backend.getMe()), updateMe, listCharacters }))   // I-06 / P2-10：原为 `as never`
    const catalog = useCharacterCatalogStore()
    await catalog.loadList(canonical)
    catalog.markStale()
    const callsBeforeStaleMount = listCharacters.mock.calls.length
    const stale = mount(CyIdentityPane, { global: { plugins: [pinia] } })
    await flushPromises()
    expect(listCharacters).toHaveBeenCalledTimes(callsBeforeStaleMount + 1)
    stale.unmount()

    const callsBeforeReadyMount = listCharacters.mock.calls.length
    const ready = mount(CyIdentityPane, { global: { plugins: [pinia] } })
    await flushPromises()
    expect(listCharacters).toHaveBeenCalledTimes(callsBeforeReadyMount)
    ready.unmount()

    listCharacters.mockRejectedValueOnce(new Error('[BACKEND_REJECTED] [backendCode=CATALOG_DOWN] down'))
    await catalog.loadList(canonical, { force: true })
    const failed = mount(CyIdentityPane, { global: { plugins: [pinia] } })
    await flushPromises()
    expect(failed.text()).toContain('重试角色目录')
    const callsBeforeRetry = listCharacters.mock.calls.length
    await failed.get('.cy-candidate-error button').trigger('click')
    await flushPromises()
    expect(listCharacters).toHaveBeenCalledTimes(callsBeforeRetry + 1)
    expect(failed.text()).not.toContain('重试角色目录')
    failed.unmount()
  })
})
