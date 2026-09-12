// @vitest-environment happy-dom
// tests/unit/cy-character-detail.spec.ts
// CyCharacterDetail：loading/error 三态、内置/自定义/归档的动作面差异与离线禁用、
// 「设为默认角色」的成功/冲突/失败反馈（只属于本次详情操作）、只读 authored 内容摘要与 emit 契约。
// CyCharacterRevisionList 以 stub 替换，仅断言其 enabled/busy 入参；API 经 setDesktopApi mock。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import type { CharacterDetail, UserIdentityProfile } from '@shared/contracts'
import CyCharacterDetail from '../../src/renderer/src/components/characters/CyCharacterDetail.vue'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { createDesktopApiMock, typedMock } from './helpers/desktop-api'
import type { DesktopApiMock } from './helpers/desktop-api'
import { useIdentityStore } from '../../src/renderer/src/stores/identity.store'

function detailFixture(overrides: {
  characterId?: string
  displayName?: string
  source?: 'builtin' | 'custom'
  status?: 'active' | 'archived'
  revision?: number
  mutable?: boolean
} = {}): CharacterDetail {
  const characterId = overrides.characterId ?? 'custom/test'
  const source = overrides.source ?? 'custom'
  const displayName = overrides.displayName ?? '测试角色'
  const revision = overrides.revision ?? 3
  return {
    summary: {
      characterId,
      source,
      mutable: overrides.mutable ?? source === 'custom',
      status: overrides.status ?? 'active',
      currentRevision: revision,
      displayName,
      description: '一个用于组件测试的自定义角色。',
      aliases: ['小测', '测试'],
      presentation: { themeColor: '#8db7f2' },
      updatedAt: '2026-08-31T00:00:00.000Z'
    },
    current: {
      characterId,
      revision,
      schemaVersion: 1,
      displayName,
      description: '一个用于组件测试的自定义角色。',
      aliases: ['小测', '测试'],
      promptProfile: {
        corePersonality: '真诚而可靠。',
        relationshipStyle: '平等的伙伴。',
        emotionStyle: '',
        speakingStyle: '自然清晰。',
        conversationInitiative: '',
        examples: [{ user: '你好', assistant: '你也好。' }]
      },
      runtimeDefaults: {
        voice: {}, emotion: { idleExpressions: [] }, wakeWords: [],
        proactive: { enabled: false, intervalSeconds: 3600, triggers: [] }
      },
      presentation: { themeColor: '#8db7f2' },
      openingMessage: '我在这里。',
      checksum: 'checksum',
      compilerVersion: 1,
      createdBy: 'user',
      createdAt: '2026-08-31T00:00:00.000Z'
    }
  }
}

function profileFixture(patch: Partial<UserIdentityProfile> = {}): UserIdentityProfile {
  return {
    userId: 'u', displayName: '我', locale: 'zh-CN', timezone: 'UTC', initialized: true, revision: 1,
    createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z', ...patch
  }
}

const revisionListStub = {
  name: 'CyCharacterRevisionList',
  props: ['characterId', 'currentRevision', 'enabled', 'busy'],
  template: '<div class="revision-stub" />'
}

let pinia: ReturnType<typeof createPinia>
// I-06：`updateMe` 是可选方法 ⇒ 裸 `vi.fn()` 不可赋值，用工厂导出的带签名 Mock 类型 + typedMock 构造。
let updateMe: DesktopApiMock['updateMe']

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  updateMe = typedMock<'updateMe'>(async (input) => profileFixture({ revision: 2, ...input }))
  setDesktopApi(createDesktopApiMock({ updateMe, getMe: vi.fn(async () => profileFixture()) }))   // I-06 / P2-10：原为 `as never`
})

function mountDetail(props: Record<string, unknown>) {
  return mount(CyCharacterDetail, {
    props,
    global: { plugins: [pinia], stubs: { CyCharacterRevisionList: revisionListStub } }
  })
}

describe('CyCharacterDetail 角色详情', () => {
  it('loading 与 error 三态互斥，失败态提供重试而不渲染详情内容', async () => {
    const loading = mountDetail({ loading: true })
    expect(loading.get('.cy-detail-state').text()).toBe('正在读取角色详情…')
    expect(loading.find('.cy-detail-header').exists()).toBe(false)
    loading.unmount()

    const failed = mountDetail({ error: { code: 'BACKEND_REJECTED', message: '角色不存在或连接已断开' } })
    const errorState = failed.get('.cy-detail-state.error')
    expect(errorState.attributes('role')).toBe('alert')
    expect(errorState.text()).toContain('详情加载失败')
    expect(errorState.text()).toContain('角色不存在或连接已断开')
    await errorState.get('button').trigger('click')
    expect(failed.emitted('retry')).toHaveLength(1)
    expect(failed.find('.cy-detail-header').exists()).toBe(false)
    failed.unmount()
  })

  it('内置角色只读：仅提供克隆，展示只读说明与 revision 徽标', async () => {
    const detail = detailFixture({ characterId: 'builtin/elysia', source: 'builtin', displayName: 'Elysia', mutable: false, revision: 2 })
    const wrapper = mountDetail({ detail, remoteAvailable: true })
    const actions = wrapper.findAll('.cy-detail-actions button').map((button) => button.text())
    expect(actions).toEqual(['克隆并自定义', '设为默认角色'])
    expect(wrapper.get('.cy-detail-title').text()).toContain('内置角色')
    expect(wrapper.get('.cy-detail-title').text()).toContain('revision 2')
    expect(wrapper.get('.cy-readonly-note').text()).toContain('内置角色定义保持只读；如需调整，请克隆为自定义角色。')
    expect(wrapper.get('.cy-detail-avatar').text()).toBe('E')
    expect(wrapper.get('.cy-detail-avatar').attributes('style')).toContain('background-color: #8db7f2')

    await wrapper.findAll('.cy-detail-actions button')[0].trigger('click')
    expect(wrapper.emitted('clone')).toHaveLength(1)
    expect(wrapper.emitted('edit')).toBeUndefined()
    expect(wrapper.emitted('archive')).toBeUndefined()
    wrapper.unmount()
  })

  it('自定义角色可编辑/归档；离线或 busy 时按动作分别禁用并阻止 emit', async () => {
    const detail = detailFixture()
    const wrapper = mountDetail({ detail, remoteAvailable: true, busy: false })
    const buttons = () => wrapper.findAll('.cy-detail-actions button')
    expect(buttons().map((button) => button.text())).toEqual(['编辑', '归档', '设为默认角色'])
    expect(wrapper.get('.cy-readonly-note').text()).toContain('自定义角色会以不可变 revision 保存；后续修改会创建新版本。')

    const revisionList = wrapper.findComponent(revisionListStub)
    expect(revisionList.props('characterId')).toBe('custom/test')
    expect(revisionList.props('enabled')).toBe(true)

    await wrapper.setProps({ remoteAvailable: false } as never)
    expect(buttons()[0].attributes('disabled')).toBeUndefined()
    expect(buttons()[1].attributes('disabled')).toBeDefined()
    expect(buttons()[2].attributes('disabled')).toBeDefined()
    expect(wrapper.findComponent(revisionListStub).props('enabled')).toBe(false)
    await buttons()[1].trigger('click')
    await buttons()[2].trigger('click')
    expect(wrapper.emitted('archive')).toBeUndefined()
    expect(updateMe).not.toHaveBeenCalled()

    await wrapper.setProps({ remoteAvailable: true, busy: true } as never)
    expect(buttons()[0].attributes('disabled')).toBeDefined()
    expect(buttons()[1].attributes('disabled')).toBeDefined()
    await buttons()[0].trigger('click')
    expect(wrapper.emitted('edit')).toBeUndefined()

    await wrapper.setProps({ busy: false } as never)
    await buttons()[0].trigger('click')
    expect(wrapper.emitted('edit')).toHaveLength(1)
    wrapper.unmount()
  })

  it('归档角色隐藏全部变更动作，并说明既有会话仍可查看', () => {
    const detail = detailFixture({ status: 'archived' })
    const wrapper = mountDetail({ detail, remoteAvailable: true })
    expect(wrapper.get('.cy-detail-title').text()).toContain('已归档')
    expect(wrapper.findAll('.cy-detail-actions button')).toHaveLength(0)
    expect(wrapper.get('.cy-readonly-note').text()).toContain('已归档角色仍可查看既有会话，但不能用于新会话或继续编辑。')
    expect(wrapper.findComponent(revisionListStub).props('enabled')).toBe(false)
    wrapper.unmount()
  })

  it('已是默认角色时按钮显示当前默认并禁用，点击不发起档案写入', async () => {
    useIdentityStore().profile = profileFixture({ defaultCharacterId: 'custom/test' })
    const wrapper = mountDetail({ detail: detailFixture(), remoteAvailable: true })
    const button = wrapper.get('.cy-default-action')
    expect(button.text()).toBe('当前默认角色')
    expect(button.attributes('disabled')).toBeDefined()
    await button.trigger('click')
    expect(updateMe).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('设为默认角色区分成功/冲突/失败，并在切换角色后清除本次反馈', async () => {
    useIdentityStore().profile = profileFixture()
    const wrapper = mountDetail({ detail: detailFixture(), remoteAvailable: true })
    await wrapper.get('.cy-default-action').trigger('click')
    await flushPromises()
    expect(updateMe).toHaveBeenCalledWith(expect.objectContaining({ defaultCharacterId: 'custom/test', expectedRevision: 1 }))
    expect(wrapper.get('.cy-detail-notice.success').text()).toBe('已设为默认角色。')
    expect(wrapper.get('.cy-default-action').text()).toBe('当前默认角色')

    await wrapper.setProps({ detail: detailFixture({ characterId: 'custom/other', displayName: '另一个角色' }) } as never)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.cy-detail-notice.success').exists()).toBe(false)
    wrapper.unmount()

    const conflictPinia = createPinia()
    setActivePinia(conflictPinia)
    useIdentityStore().profile = profileFixture()
    updateMe.mockRejectedValueOnce(new Error('[BACKEND_REJECTED] [backendCode=USER_PROFILE_REVISION_CONFLICT] 档案已更新'))
    const conflict = mount(CyCharacterDetail, {
      props: { detail: detailFixture(), remoteAvailable: true },
      global: { plugins: [conflictPinia], stubs: { CyCharacterRevisionList: revisionListStub } }
    })
    await conflict.get('.cy-default-action').trigger('click')
    await flushPromises()
    const conflictNotice = conflict.get('.cy-detail-notice.error')
    expect(conflictNotice.attributes('role')).toBe('alert')
    expect(conflictNotice.text()).toContain('档案版本发生冲突，默认角色尚未更新')
    expect(conflict.get('.cy-default-action').text()).toBe('设为默认角色')
    conflict.unmount()

    const errorPinia = createPinia()
    setActivePinia(errorPinia)
    useIdentityStore().profile = profileFixture()
    updateMe.mockRejectedValueOnce(new Error('[BACKEND_REJECTED] [backendCode=USER_PROFILE_INVALID] 档案字段无效'))
    const failed = mount(CyCharacterDetail, {
      props: { detail: detailFixture(), remoteAvailable: true },
      global: { plugins: [errorPinia], stubs: { CyCharacterRevisionList: revisionListStub } }
    })
    await failed.get('.cy-default-action').trigger('click')
    await flushPromises()
    expect(failed.get('.cy-detail-notice.error').text()).toContain('档案字段无效')
    failed.unmount()
  })

  it('父级 actionError 走公开文案映射；只读摘要对空字段给出中性占位', () => {
    const detail = detailFixture()
    detail.summary.aliases = []
    detail.current.aliases = []
    detail.current.openingMessage = undefined
    detail.current.presentation = {}
    detail.current.runtimeDefaults.voice = {}
    const wrapper = mountDetail({
      detail,
      remoteAvailable: true,
      actionError: { code: 'BACKEND_REJECTED', backendCode: 'CHARACTER_ARCHIVED', message: '内部冲突细节' }
    })
    const notice = wrapper.get('.cy-detail-notice.error')
    expect(notice.attributes('role')).toBe('alert')
    expect(notice.text()).toBe('该角色已归档，不能继续编辑或用于新会话。')
    expect(wrapper.text()).not.toContain('内部冲突细节')

    const values = wrapper.findAll('.cy-detail-section dd').map((dd) => dd.text())
    expect(values).toContain('无')
    expect(values).toContain('未设置')
    expect(values).toContain('跟随应用主题')
    expect(values).toContain('使用名称占位头像')
    expect(values).toContain('未指定')
    expect(wrapper.text()).toContain('未单独设置')
    expect(wrapper.get('.cy-prompt-details').text()).toContain('真诚而可靠。')
    expect(wrapper.get('.cy-prompt-grid ol li').text()).toContain('我：你好')
    expect(wrapper.get('.cy-prompt-grid ol li').text()).toContain('角色：你也好。')
    wrapper.unmount()
  })
})
