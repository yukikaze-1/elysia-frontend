// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import CyConversationList from '../../src/renderer/src/components/CyConversationList.vue'
import CyChatView from '../../src/renderer/src/components/CyChatView.vue'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { useConnectionStore } from '../../src/renderer/src/stores/connection.store'
import { useConversationStore } from '../../src/renderer/src/stores/conversation.store'
import { useIdentityStore } from '../../src/renderer/src/stores/identity.store'
import { useAppStore } from '../../src/renderer/src/stores/app.store'
import { useCharacterCatalogStore } from '../../src/renderer/src/stores/character-catalog.store'
import { createDesktopApiMock } from './helpers/desktop-api'

const elysia = {
  characterId: 'builtin/elysia',
  source: 'builtin' as const,
  mutable: false,
  status: 'active' as const,
  currentRevision: 1,
  displayName: 'Elysia',
  description: '温柔、明亮的陪伴角色。',
  aliases: ['爱莉希雅'],
  presentation: { themeColor: '#f2a7c6' },
  updatedAt: '2026-08-31T00:00:00.000Z'
}
const cyrene = {
  ...elysia,
  characterId: 'builtin/cyrene',
  displayName: 'Cyrene',
  description: '冷静、可靠的伙伴。',
  aliases: ['赛琳'],
  presentation: { themeColor: '#8db7f2' }
}
const archived = { ...cyrene, characterId: 'custom/archived', displayName: '已归档', status: 'archived' as const }
const profile = {
  userId: 'user-1',
  displayName: '旅行者',
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
  initialized: true,
  defaultCharacterId: elysia.characterId,
  revision: 1,
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z'
}

const mockApi = {
  listConversations: vi.fn(),
  createConversation: vi.fn(),
  activate: vi.fn(),
  getMessages: vi.fn(),
  listCharacters: vi.fn(),
  getMe: vi.fn(),
  getCharacter: vi.fn()
}

let pinia: ReturnType<typeof createPinia>

function prepare(options: { profiles?: boolean; initialized?: boolean; defaultCharacterId?: string; characters?: unknown[] } = {}): void {
  pinia = createPinia()
  setActivePinia(pinia)
  vi.resetAllMocks()
  setDesktopApi(createDesktopApiMock(mockApi))
  const connection = useConnectionStore()
  connection.setState({
    status: 'connected',
    connectionId: 'connection-1',
    ...(options.profiles === false ? {} : { features: { characterProfiles: true, characterStateStream: false } })
  })
  const conversations = useConversationStore()
  conversations.$patch({ ready: true })
  conversations.setConnectionState(connection.state)
  const identity = useIdentityStore()
  identity.profile = {
    ...profile,
    initialized: options.initialized ?? true,
    ...(options.defaultCharacterId === undefined ? {} : { defaultCharacterId: options.defaultCharacterId })
  }
  mockApi.listConversations.mockResolvedValue({ items: [], hasMore: false })
  mockApi.getMessages.mockResolvedValue({ items: [], hasMore: false })
  mockApi.listCharacters.mockResolvedValue({ items: options.characters ?? [elysia, cyrene], hasMore: false })
}

function mountList() {
  return mount(CyConversationList, { global: { plugins: [pinia] } })
}

describe('CyConversationList FE-E1 新建会话与会话角色快照', () => {
  it('legacy 能力缺省保持直接 createConversation({}) 并激活一次', async () => {
    prepare({ profiles: false })
    const created = { id: 'legacy-1', title: '新会话', updatedAt: '2026-08-31T00:00:00.000Z' }
    mockApi.createConversation.mockResolvedValue(created)
    const wrapper = mountList()

    await wrapper.get('button[aria-label="新建会话"]').trigger('click')
    await flushPromises()

    expect(mockApi.createConversation).toHaveBeenCalledTimes(1)
    expect(mockApi.createConversation).toHaveBeenCalledWith({})
    expect(mockApi.activate).toHaveBeenCalledTimes(1)
    expect(mockApi.activate).toHaveBeenCalledWith('legacy-1')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('profiles=true 点击加号先打开选角器，不直接创建；默认角色预选', async () => {
    prepare()
    mockApi.createConversation.mockResolvedValue({
      id: 'bound-1', title: '新会话', updatedAt: '2026-08-31T00:00:00.000Z',
      character: { characterId: elysia.characterId, characterInstanceId: 'instance-elysia', characterRevision: 1, displayName: 'Elysia', presentation: elysia.presentation }
    })
    const wrapper = mountList()

    await wrapper.get('button[aria-label="新建会话"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    expect(mockApi.createConversation).not.toHaveBeenCalled()
    expect(wrapper.find('[data-character-id="builtin/elysia"].is-selected').exists()).toBe(true)
    await wrapper.find('[data-character-id="builtin/elysia"].is-selected').trigger('click')
    await wrapper.get('button.primary').trigger('click')
    // 同一个确认事件在请求刚发起时再次到达，也只能保留一个 create。
    await wrapper.get('button.primary').trigger('click')
    await flushPromises()

    expect(mockApi.createConversation).toHaveBeenCalledTimes(1)
    expect(mockApi.createConversation).toHaveBeenCalledWith({ characterId: elysia.characterId })
    expect(mockApi.activate).toHaveBeenCalledWith('bound-1')
    wrapper.unmount()
  })

  it('选角器搜索透传 active query，加载更多使用当前 cursor 且保留安全分页', async () => {
    prepare({ characters: [elysia, cyrene] })
    mockApi.listCharacters.mockResolvedValueOnce({ items: [elysia], hasMore: true, nextCursor: 'page-2' })
    const wrapper = mountList()
    await wrapper.get('button[aria-label="新建会话"]').trigger('click')
    await flushPromises()
    const search = wrapper.get('#cy-character-picker-search')
    mockApi.listCharacters.mockResolvedValueOnce({ items: [cyrene], hasMore: true, nextCursor: 'page-search-2' })
    await search.setValue('Cy')
    await wrapper.get('form.cy-picker-search').trigger('submit')
    await flushPromises()
    expect(mockApi.listCharacters).toHaveBeenLastCalledWith({ status: 'active', search: 'Cy', limit: 20 })

    mockApi.listCharacters.mockResolvedValueOnce({ items: [elysia], hasMore: false })
    await wrapper.get('.cy-picker-more').trigger('click')
    await flushPromises()
    expect(mockApi.listCharacters).toHaveBeenLastCalledWith({ status: 'active', search: 'Cy', limit: 20, cursor: 'page-search-2' })
    expect(wrapper.findAll('.cy-picker-card')).toHaveLength(1)
    wrapper.unmount()
  })

  it('多角色无默认时必须明确选择，唯一 active 自动选择，归档角色不进入选项', async () => {
    prepare({ defaultCharacterId: 'missing-default', characters: [elysia, cyrene, archived] })
    const wrapper = mountList()
    await wrapper.get('button[aria-label="新建会话"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.cy-picker-card')).toHaveLength(2)
    expect(wrapper.find('.cy-picker-card.is-selected').exists()).toBe(false)
    expect(wrapper.get('button.primary').attributes('disabled')).toBeDefined()
    await wrapper.find('[data-character-id="builtin/cyrene"]').trigger('click')
    expect(wrapper.get('button.primary').attributes('disabled')).toBeUndefined()
    wrapper.unmount()

    prepare({ characters: [cyrene] })
    const unique = mountList()
    await unique.get('button[aria-label="新建会话"]').trigger('click')
    await flushPromises()
    expect(unique.find('.cy-picker-card.is-selected').attributes('data-character-id')).toBe(cyrene.characterId)
    unique.unmount()
  })

  it('未初始化身份与断线状态均阻止角色新建，并提供可执行设置入口', async () => {
    prepare({ initialized: false })
    const wrapper = mountList()
    await wrapper.get('button[aria-label="新建会话"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('完成“我的档案”后才能新建角色会话')
    expect(wrapper.get('button.primary').attributes('disabled')).toBeDefined()
    await wrapper.findAll('button').find((button) => button.text() === '打开我的档案')!.trigger('click')
    expect(useAppStore().currentView).toBe('settings')
    expect(mockApi.createConversation).not.toHaveBeenCalled()
    wrapper.unmount()

    prepare()
    const connection = useConnectionStore()
    connection.setState({ status: 'disconnected' })
    const offline = mountList()
    expect(offline.get('button[aria-label="新建会话"]').attributes('disabled')).toBeDefined()
    offline.unmount()
  })

  it('会话列表显示 binding 快照的头像/角色辅助名，标题不改写且不提供切角控件', async () => {
    prepare({ profiles: false })
    const snapshot = { characterId: elysia.characterId, characterInstanceId: 'instance-elysia', characterRevision: 1, displayName: 'Elysia', presentation: elysia.presentation }
    mockApi.listConversations.mockResolvedValue({ items: [{ id: 'old-1', title: '我的标题', updatedAt: '2026-08-31T00:00:00.000Z', preview: '你好', character: snapshot }], hasMore: false })
    const wrapper = mountList()
    const conversations = useConversationStore()
    await conversations.list()
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('我的标题')
    expect(wrapper.text()).toContain('Elysia')
    expect(wrapper.find('.cy-conversation-avatar').text()).toBe('E')
    expect(wrapper.findAll('select').filter((select) => select.attributes('aria-label')?.includes('角色'))).toHaveLength(0)
    wrapper.unmount()
  })

  it('AGENT_BUSY 在会话列表显示明确提示，目标会话只能由用户再次点击重试', async () => {
    prepare({ profiles: false })
    const conversation = useConversationStore()
    conversation.$patch({
      ready: true,
      currentId: 'session-a',
      items: [
        { id: 'session-a', title: '会话 A', updatedAt: '2026-08-31T00:00:00.000Z', preview: 'A' },
        { id: 'session-b', title: '会话 B', updatedAt: '2026-08-31T00:00:01.000Z', preview: 'B' }
      ]
    })
    const wrapper = mountList()
    conversation.$patch({
      error: {
        code: 'UNKNOWN',
        backendCode: 'AGENT_BUSY',
        retryable: true,
        message: '当前回复或语音仍在收尾，请稍后再切换会话'
      }
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[role="alert"]').text()).toContain('当前回复或语音仍在收尾，请稍后再切换会话')

    mockApi.activate.mockResolvedValueOnce({ conversationId: 'session-b' })
    await wrapper.findAll('button.cy-conversation-main')[1].trigger('click')
    await flushPromises()

    expect(mockApi.activate).toHaveBeenCalledTimes(1)
    expect(mockApi.activate).toHaveBeenCalledWith('session-b')
    expect(conversation.currentId).toBe('session-b')
    expect(conversation.error).toBeUndefined()
    wrapper.unmount()
  })

  it('创建被拒或响应错绑后选角器不锁死：仍可关闭并重试', async () => {
    prepare()
    const valid = {
      id: 'retry-bound', title: '重试会话', updatedAt: '2026-08-31T00:00:00.000Z',
      character: { characterId: elysia.characterId, characterInstanceId: 'instance-elysia', characterRevision: 1, displayName: 'Elysia', presentation: elysia.presentation }
    }
    mockApi.createConversation
      .mockRejectedValueOnce(new Error('暂时失败'))
      .mockResolvedValueOnce({ id: 'wrong-binding', title: '错绑', updatedAt: '2026-08-31T00:00:00.000Z', character: { ...valid.character, characterId: cyrene.characterId } })
      .mockResolvedValueOnce(valid)
    const wrapper = mountList()
    await wrapper.get('button[aria-label="新建会话"]').trigger('click')
    await flushPromises()
    await wrapper.get('button.primary').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    expect(wrapper.get('button[aria-label="关闭角色选择"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('button[aria-label="关闭角色选择"]').trigger('click')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)

    await wrapper.get('button[aria-label="新建会话"]').trigger('click')
    await flushPromises()
    await wrapper.get('button.primary').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    await wrapper.get('button.primary').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(mockApi.createConversation).toHaveBeenCalledTimes(3)
    wrapper.unmount()
  })

  it('选角器查看详情不改变选择，关闭后重新打开按默认角色重新预选', async () => {
    prepare()
    const wrapper = mountList()
    await wrapper.get('button[aria-label="新建会话"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-character-id="builtin/cyrene"]').trigger('click')
    expect(wrapper.find('.cy-picker-card.is-selected').attributes('data-character-id')).toBe(cyrene.characterId)
    await wrapper.get('[aria-label="查看 Cyrene 详情"]').trigger('click')
    expect(wrapper.get('.cy-picker-detail').text()).toContain('Cyrene')
    expect(wrapper.find('.cy-picker-card.is-selected').attributes('data-character-id')).toBe(cyrene.characterId)
    await wrapper.get('[aria-label="关闭角色详情"]').trigger('click')
    expect(wrapper.find('.cy-picker-detail').exists()).toBe(false)
    mockApi.listCharacters.mockResolvedValueOnce({ items: [elysia], hasMore: false })
    await wrapper.get('#cy-character-picker-search').setValue('Elysia')
    await wrapper.get('form.cy-picker-search').trigger('submit')
    await flushPromises()
    // 搜索结果暂时隐藏已选角色时，选择快照仍保留，可继续确认；清空查询后卡片会回来。
    expect(wrapper.get('button.primary').attributes('disabled')).toBeUndefined()
    await wrapper.get('button[aria-label="关闭角色选择"]').trigger('click')
    await wrapper.get('button[aria-label="新建会话"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.cy-picker-card.is-selected').attributes('data-character-id')).toBe(elysia.characterId)
    wrapper.unmount()
  })

  it('搜索暂时隐藏所选角色时，catalog archived 事件仍立即撤销选择且不创建', async () => {
    const custom = {
      ...cyrene,
      characterId: 'custom/hidden-then-archived',
      source: 'custom' as const,
      mutable: true,
      displayName: '自定义角色'
    }
    prepare({ characters: [elysia, custom] })
    const wrapper = mountList()
    await wrapper.get('button[aria-label="新建会话"]').trigger('click')
    await flushPromises()
    await wrapper.find(`[data-character-id="${custom.characterId}"]`).trigger('click')

    mockApi.listCharacters.mockResolvedValueOnce({ items: [elysia], hasMore: false })
    await wrapper.get('#cy-character-picker-search').setValue('Elysia')
    await wrapper.get('form.cy-picker-search').trigger('submit')
    await flushPromises()
    expect(wrapper.get('button.primary').attributes('disabled')).toBeUndefined()

    const accepted = useCharacterCatalogStore().handleCatalogChanged({
      event: 'character.catalog.changed',
      eventId: 'archive-hidden-1',
      sequence: 1,
      characterId: custom.characterId,
      currentRevision: 2,
      status: 'archived',
      updatedAt: '2026-08-31T00:00:02.000Z'
    })
    expect(accepted).toBe(true)
    await wrapper.vm.$nextTick()
    expect(wrapper.get('button.primary').attributes('disabled')).toBeDefined()
    await wrapper.get('button.primary').trigger('click')
    expect(mockApi.createConversation).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('默认角色不在首个 active 页时补拉 detail 并置顶预选', async () => {
    prepare({ defaultCharacterId: cyrene.characterId, characters: [elysia] })
    mockApi.listCharacters.mockResolvedValue({ items: [elysia], hasMore: true, nextCursor: 'page-2' })
    mockApi.getCharacter.mockResolvedValue({ summary: cyrene, current: {} })
    const wrapper = mountList()
    await wrapper.get('button[aria-label="新建会话"]').trigger('click')
    await flushPromises()
    expect(mockApi.getCharacter).toHaveBeenCalledWith(cyrene.characterId)
    expect(wrapper.find('.cy-picker-card.is-selected').attributes('data-character-id')).toBe(cyrene.characterId)
    expect(wrapper.find('.cy-picker-card').attributes('data-character-id')).toBe(cyrene.characterId)
    wrapper.unmount()
  })

  it('当前会话头部显示角色副身份，详情入口精确路由到角色设置且不提供换角下拉', async () => {
    prepare({ profiles: false })
    const conversation = useConversationStore()
    conversation.$patch({
      items: [{ id: 'header-session', title: '我的聊天标题', updatedAt: '2026-08-31T00:00:00.000Z', character: {
        characterId: cyrene.characterId, characterInstanceId: 'instance-cyrene', characterRevision: 7,
        displayName: 'Cyrene', presentation: cyrene.presentation
      } }],
      currentId: 'header-session'
    })
    const wrapper = mount(CyChatView, {
      global: {
        plugins: [pinia],
        stubs: { CyMessageList: true, CyChatInput: true, CyTtsPlayer: true, CyLiveToolCards: true }
      }
    })
    expect(wrapper.text()).toContain('角色 · Cyrene')
    expect(wrapper.text()).toContain('查看角色详情')
    expect(wrapper.findAll('select').filter((select) => select.attributes('aria-label')?.includes('角色'))).toHaveLength(0)
    await wrapper.get('.cy-chat-character-detail').trigger('click')
    expect(useAppStore().currentView).toBe('settings')
    expect(useAppStore().settingsSection).toBe('characters')
    expect(useAppStore().settingsCharacterId).toBe(cyrene.characterId)
    wrapper.unmount()
  })
})

// —— doc 03 §5.1（2026-09-13）：会话项右键菜单 ——
// 菜单项只暴露已存在的能力（PRD §6.3：重命名/删除），且沿用行内按钮的同一门控（canAct）。
// 集成层另有真实右键用例（context-menu.spec.ts 断言坐标定位与菜单→动作闭环），此处补**确定性**的
// 门控与派发路径——集成用例跑在已连接态，覆盖不到"未连接时禁用"。
describe('CyConversationList 右键菜单（doc 03 §5.1）', () => {
  /** 挂载 + 播一条会话 + 在首行触发右键（菜单项渲染在 teleport 到 body 的容器里，故查询用 document） */
  async function openMenuOnFirstRow(options: Parameters<typeof prepare>[0] = {}, attach = false): Promise<ReturnType<typeof mountList>> {
    prepare(options)
    // 带角色绑定快照：profiles 模式下 store 会拒收"缺绑定"的会话响应（首版就栽在这，
    // 列表渲染成空态 → 找不到 .cy-conversation）
    mockApi.listConversations.mockResolvedValue({
      items: [{
        id: 'c-1', title: '会话一', updatedAt: '2026-09-13T00:00:00.000Z', preview: '你好',
        character: { characterId: elysia.characterId, characterInstanceId: 'instance-elysia', characterRevision: 1, displayName: 'Elysia', presentation: elysia.presentation }
      }],
      hasMore: false
    })
    // 焦点相关断言必须 attachTo（脱离文档时 happy-dom 不把 focus 反映到 document.activeElement）
    const wrapper = attach
      ? mount(CyConversationList, { global: { plugins: [pinia] }, attachTo: document.body })
      : mountList()
    await useConversationStore().list()
    await wrapper.vm.$nextTick()
    await wrapper.get('.cy-conversation').trigger('contextmenu', { clientX: 120, clientY: 80 })
    await wrapper.vm.$nextTick()
    return wrapper
  }

  it('右键会话行 → 菜单打开并渲染「重命名/删除」两项', async () => {
    const wrapper = await openMenuOnFirstRow()
    const menu = document.querySelector('[data-testid="context-menu"]')
    expect(menu).not.toBeNull()
    expect(menu!.querySelectorAll('[role="menuitem"]')).toHaveLength(2)
    expect(document.querySelector('[data-testid="context-menu-rename"]')?.textContent).toBe('重命名')
    expect(document.querySelector('[data-testid="context-menu-delete"]')?.textContent).toBe('删除')
    wrapper.unmount()
  })

  it('未连接（canAct=false）→ 两项都禁用（不提供点不动的假入口）', async () => {
    const wrapper = await openMenuOnFirstRow()
    useConnectionStore().setState({ status: 'disconnected' })
    await wrapper.vm.$nextTick()
    expect((document.querySelector('[data-testid="context-menu-rename"]') as HTMLButtonElement).disabled).toBe(true)
    expect((document.querySelector('[data-testid="context-menu-delete"]') as HTMLButtonElement).disabled).toBe(true)
    wrapper.unmount()
  })

  it('选「重命名」→ 进入重命名态并聚焦输入框（点完就能打字）', async () => {
    const wrapper = await openMenuOnFirstRow({}, true)
    ;(document.querySelector('[data-testid="context-menu-rename"]') as HTMLButtonElement).click()
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    const input = wrapper.find('.cy-rename-input')
    expect(input.exists()).toBe(true)
    expect(document.activeElement, '输入框渲染后必须拿到焦点').toBe(input.element)
    wrapper.unmount()
  })
})
