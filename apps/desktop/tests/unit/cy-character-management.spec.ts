// @vitest-environment happy-dom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import type { CharacterDraft, CharacterPreviewResult, CharacterRevisionSummary, CharacterValidationResult, Page, PersistedCharacterDraft } from '@shared/contracts'
import { MockCharacterBackend } from '../../src/main/characters/mock-character-backend'
import CyCharacterPane from '../../src/renderer/src/components/characters/CyCharacterPane.vue'
import CyCharacterRevisionList from '../../src/renderer/src/components/characters/CyCharacterRevisionList.vue'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { useCharacterEditorStore } from '../../src/renderer/src/stores/character-editor.store'
import { useIdentityStore } from '../../src/renderer/src/stores/identity.store'

function draft(displayName: string): CharacterDraft {
  return {
    displayName,
    description: '一个用于组件测试的自定义角色。',
    aliases: ['测试'],
    promptProfile: {
      corePersonality: '温柔可靠。',
      relationshipStyle: '把用户视为平等的伙伴。',
      emotionStyle: '真诚而克制。',
      speakingStyle: '清晰自然。',
      conversationInitiative: '适度主动。',
      examples: []
    },
    runtimeDefaults: {
      voice: {},
      emotion: { idleExpressions: [] },
      wakeWords: [displayName],
      proactive: { enabled: false, intervalSeconds: 3600, triggers: [] }
    },
    presentation: {},
    openingMessage: '我在这里。'
  }
}

let pinia: ReturnType<typeof createPinia>
let backend: MockCharacterBackend
let createCharacter: ReturnType<typeof vi.fn>
let updateCharacter: ReturnType<typeof vi.fn>
let updateMe: ReturnType<typeof vi.fn>
let archiveCharacter: ReturnType<typeof vi.fn>
let rollbackCharacter: ReturnType<typeof vi.fn>
let listCharacterRevisions: ReturnType<typeof vi.fn>
let validateCharacter: ReturnType<typeof vi.fn>
let previewCharacter: ReturnType<typeof vi.fn>
let originalConfirm: typeof window.confirm

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  backend = new MockCharacterBackend()
  createCharacter = vi.fn((input) => backend.createCharacter(input))
  updateCharacter = vi.fn((input) => backend.updateCharacter(input))
  updateMe = vi.fn((input) => backend.updateMe(input))
  archiveCharacter = vi.fn((id: string) => backend.archiveCharacter(id))
  rollbackCharacter = vi.fn((input) => backend.rollbackCharacter(input))
  listCharacterRevisions = vi.fn((input) => backend.listCharacterRevisions(input))
  validateCharacter = vi.fn((input) => backend.validateCharacter(input))
  previewCharacter = vi.fn((input) => backend.previewCharacter(input))
  setDesktopApi({
    getMe: vi.fn(() => backend.getMe()),
    updateMe,
    listCharacters: vi.fn((input) => backend.listCharacters(input)),
    getCharacter: vi.fn((id: string) => backend.getCharacter(id)),
    createCharacter,
    updateCharacter,
    cloneCharacter: vi.fn((input) => backend.cloneCharacter(input)),
    archiveCharacter,
    listCharacterRevisions,
    rollbackCharacter,
    validateCharacter,
    previewCharacter,
    listCharacterDrafts: vi.fn(async () => []),
    getCharacterDraft: vi.fn(async () => undefined),
    saveCharacterDraft: vi.fn(async () => {}),
    deleteCharacterDraft: vi.fn(async () => {})
  } as never)
  useCharacterEditorStore().setConnectionState('connected', { characterProfiles: true })
  originalConfirm = window.confirm
})

afterEach(() => {
  Object.defineProperty(window, 'confirm', { configurable: true, value: originalConfirm })
})

function mountPane() {
  return mount(CyCharacterPane, { global: { plugins: [pinia] } })
}

function setConfirm(value: boolean): ReturnType<typeof vi.fn> {
  const confirm = vi.fn(() => value)
  Object.defineProperty(window, 'confirm', { configurable: true, value: confirm })
  return confirm
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function openCard(wrapper: ReturnType<typeof mountPane>, name: string): Promise<void> {
  const card = wrapper.findAll('.cy-character-card').find((item) => item.text().includes(name))
  if (!card) throw new Error(`missing card: ${name}`)
  await card.find('button').trigger('click')
  await flushPromises()
}

describe('角色管理 UI FE-D3', () => {
  it('内置角色只提供克隆，自定义角色提供编辑与归档', async () => {
    const custom = await backend.createCharacter({ draft: draft('可编辑角色') })
    const wrapper = mountPane()
    await flushPromises()

    await openCard(wrapper, 'Elysia')
    expect(wrapper.text()).toContain('克隆并自定义')
    expect(wrapper.findAll('button').some((button) => button.text() === '编辑')).toBe(false)
    expect(wrapper.findAll('button').some((button) => button.text() === '归档')).toBe(false)
    await wrapper.get('.cy-back').trigger('click')
    await openCard(wrapper, custom.summary.displayName)
    expect(wrapper.text()).toContain('编辑')
    expect(wrapper.text()).toContain('归档')
    wrapper.unmount()
  })

  it('新建角色覆盖完整分区，示例最多 20 组且排序保留 authored 内容', async () => {
    const wrapper = mountPane()
    await flushPromises()
    await wrapper.get('button.primary').trigger('click')
    expect(wrapper.text()).toContain('新建角色')
    expect(wrapper.find('.cy-prompt-fields').exists()).toBe(true)
    expect(wrapper.find('.cy-presentation-fields').exists()).toBe(true)

    for (let index = 0; index < 20; index++) {
      await wrapper.findAll('button').find((button) => button.text() === '添加示例')!.trigger('click')
      await wrapper.vm.$nextTick()
    }
    expect(wrapper.findAll('.cy-example-item')).toHaveLength(20)
    expect(wrapper.findAll('button').find((button) => button.text() === '添加示例')!.attributes('disabled')).toBeDefined()
    await wrapper.find('#character-example-0-user').setValue('第一个示例')
    await wrapper.find('button[aria-label="示例 1 下移"]').trigger('click')
    expect(useCharacterEditorStore().draft?.promptProfile.examples[1]?.user).toBe('第一个示例')
    wrapper.unmount()
  })

  it('目录显示本地恢复摘要，恢复时进入对应编辑模式且不把完整 draft 放入列表', async () => {
    const record: PersistedCharacterDraft = {
      key: 'create:recovery-test',
      mode: 'create',
      displayName: '恢复草稿',
      updatedAt: '2026-08-31T01:00:00.000Z',
      draft: draft('恢复草稿'),
      statePolicy: 'preserve'
    }
    const listDrafts = vi.fn(async () => [{ key: record.key, mode: record.mode, displayName: record.displayName, updatedAt: record.updatedAt }])
    const getDraft = vi.fn(async () => record)
    setDesktopApi({
      listCharacters: vi.fn((input) => backend.listCharacters(input)),
      getCharacter: vi.fn((id: string) => backend.getCharacter(id)),
      listCharacterDrafts: listDrafts,
      getCharacterDraft: getDraft,
      deleteCharacterDraft: vi.fn(async () => {})
    } as never)
    const wrapper = mountPane()
    await flushPromises()
    expect(wrapper.text()).toContain('本地未提交草稿')
    expect(wrapper.text()).toContain('恢复草稿')
    expect(wrapper.text()).not.toContain(record.draft.promptProfile.corePersonality)
    await wrapper.findAll('button').find((button) => button.text() === '恢复')!.trigger('click')
    await flushPromises()
    expect(wrapper.find('.cy-character-editor-form').exists()).toBe(true)
    expect(useCharacterEditorStore().mode).toBe('create')
    expect((wrapper.get('input[name="displayName"]').element as HTMLInputElement).value).toBe('恢复草稿')
    wrapper.unmount()
  })

  it('创建草稿填写必填 authored 字段后保存，Store 将会话基线转为可继续编辑的 detail', async () => {
    const wrapper = mountPane()
    await flushPromises()
    await wrapper.get('button.primary').trigger('click')
    await wrapper.get('input[name="displayName"]').setValue('新建完成角色')
    await wrapper.find('[data-field-path="/promptProfile/corePersonality"]').setValue('可靠而温柔。')
    await wrapper.find('[data-field-path="/promptProfile/relationshipStyle"]').setValue('平等地陪伴用户。')
    const speaking = wrapper.find('[data-field-path="/promptProfile/speakingStyle"]')
    await speaking.setValue('自然清晰。')
    const initiative = wrapper.find('[data-field-path="/promptProfile/conversationInitiative"]')
    await initiative.setValue('主动但尊重用户节奏。')
    await wrapper.vm.$nextTick()
    expect(useCharacterEditorStore().remoteAvailable).toBe(true)
    expect(useCharacterEditorStore().draft?.promptProfile.conversationInitiative).toBe('主动但尊重用户节奏。')
    expect((initiative.element as HTMLTextAreaElement).value).toBe('主动但尊重用户节奏。')
    expect(useCharacterEditorStore().dirty).toBe(true)
    expect(wrapper.get('button.primary').attributes('disabled')).toBeUndefined()
    const confirm = setConfirm(true)
    await wrapper.get('.cy-character-editor-form').trigger('submit')
    await flushPromises()
    expect(confirm).toHaveBeenCalled()
    expect(useCharacterEditorStore().saveStatus).toBe('success')
    expect(createCharacter).toHaveBeenCalled()
    expect(wrapper.find('.cy-character-editor-form').exists()).toBe(false)
    expect(wrapper.text()).toContain('新建完成角色')
    expect(useCharacterEditorStore().mode).toBe('edit')
    expect(useCharacterEditorStore().dirty).toBe(false)
    wrapper.unmount()
  })

  it('校验问题可以定位字段，预览只发送当前 draft 与独立 userMessage', async () => {
    const invalid: CharacterValidationResult = {
      valid: false,
      issues: [{ severity: 'error', code: 'NAME_REQUIRED', path: '/displayName', message: '请填写角色名称' }]
    }
    validateCharacter.mockResolvedValueOnce(invalid)
    const preview: CharacterPreviewResult = { ephemeral: true, reply: '**安全预览**' }
    previewCharacter.mockResolvedValueOnce(preview)
    const wrapper = mountPane()
    await flushPromises()
    await wrapper.get('button.primary').trigger('click')
    await wrapper.get('.cy-validation button').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('草稿未通过校验')
    await wrapper.find('.cy-issue-list button').trigger('click')
    expect(wrapper.find('[data-field-path="/displayName"]').exists()).toBe(true)

    await wrapper.get('.cy-preview textarea').setValue('请问候我')
    await wrapper.get('.cy-preview button').trigger('click')
    await flushPromises()
    expect(previewCharacter).toHaveBeenCalledWith(expect.objectContaining({ userMessage: '请问候我', draft: expect.any(Object) }))
    expect(previewCharacter.mock.calls[0][0].draft).toBeDefined()
    expect(wrapper.text()).toContain('本结果不会修改草稿')
    expect(wrapper.text()).toContain('安全预览')
    expect(wrapper.find('.cy-preview-result .cy-markdown').exists()).toBe(true)
    expect(wrapper.find('.cy-preview-result .cy-markdown strong').text()).toBe('安全预览')
    wrapper.unmount()
  })

  it('校验 focus 支持 exact、容器与叶子路径，未知路径安全回退到表单', async () => {
    const invalid: CharacterValidationResult = {
      valid: false,
      issues: [
        { severity: 'error', code: 'EXAMPLE_ITEM', path: '/promptProfile/examples/0', message: '示例不完整' },
        { severity: 'warning', code: 'EXAMPLES', path: '/promptProfile/examples', message: '请检查示例' },
        { severity: 'warning', code: 'PRESENTATION', path: '/presentation', message: '请检查呈现' },
        { severity: 'warning', code: 'GLOBAL', path: '', message: '请检查整份草稿' },
        { severity: 'warning', code: 'UNKNOWN', path: '/future/field', message: '未知字段' }
      ]
    }
    validateCharacter.mockResolvedValueOnce(invalid)
    const wrapper = mount(CyCharacterPane, { global: { plugins: [pinia] }, attachTo: document.body })
    await flushPromises()
    await wrapper.get('button.primary').trigger('click')
    await wrapper.findAll('button').find((button) => button.text() === '添加示例')!.trigger('click')
    await wrapper.get('.cy-validation button').trigger('click')
    await flushPromises()
    const issues = wrapper.findAll('.cy-issue-list button')
    await issues[0].trigger('click')
    expect(document.activeElement).toBe(wrapper.get('#character-example-0-user').element)
    await issues[1].trigger('click')
    expect(document.activeElement).toBe(wrapper.get('#character-example-0-user').element)
    await issues[2].trigger('click')
    expect(document.activeElement).toBe(wrapper.get('[data-field-path="/presentation/themeColor"]').element)
    await issues[3].trigger('click')
    expect(document.activeElement).toBe(wrapper.get('.cy-character-editor-form').element)
    await issues[4].trigger('click')
    expect(document.activeElement).toBe(wrapper.get('.cy-character-editor-form').element)
    wrapper.unmount()
  })

  it('后端 valid=false 且仅有 warning 时仍阻止 create，并在 UI 显示阻断', async () => {
    validateCharacter.mockResolvedValueOnce({
      valid: false,
      issues: [{ severity: 'warning', code: 'STYLE', path: '/description', message: '建议补充简介' }]
    } satisfies CharacterValidationResult)
    const wrapper = mountPane()
    await flushPromises()
    await wrapper.get('button.primary').trigger('click')
    await wrapper.get('input[name="displayName"]').setValue('只有提醒也不能保存')
    await wrapper.find('[data-field-path="/promptProfile/corePersonality"]').setValue('可靠。')
    await wrapper.find('[data-field-path="/promptProfile/relationshipStyle"]').setValue('平等。')
    await wrapper.find('[data-field-path="/promptProfile/speakingStyle"]').setValue('自然。')
    setConfirm(true)
    await wrapper.get('.cy-character-editor-form').trigger('submit')
    await flushPromises()
    expect(createCharacter).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('草稿未通过校验，暂不能保存')
    expect(wrapper.text()).toContain('建议补充简介')
    wrapper.unmount()
  })

  it('自定义角色离开时保留本地草稿，归档成功后返回目录并清理编辑会话', async () => {
    const custom = await backend.createCharacter({ draft: draft('待归档角色') })
    const wrapper = mountPane()
    await flushPromises()
    await openCard(wrapper, custom.summary.displayName)
    await wrapper.findAll('button').find((button) => button.text() === '编辑')!.trigger('click')
    await wrapper.get('input[name="displayName"]').setValue('待归档角色修改')
    expect(useCharacterEditorStore().dirty).toBe(true)

    setConfirm(false)
    await wrapper.get('.cy-back').trigger('click')
    expect(wrapper.find('.cy-character-editor-form').exists()).toBe(true)
    setConfirm(true)
    await wrapper.get('.cy-back').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('待归档角色')

    await wrapper.get('button.danger').trigger('click')
    await flushPromises()
    expect(archiveCharacter).toHaveBeenCalledWith(custom.summary.characterId)
    expect(wrapper.find('.cy-character-editor-form').exists()).toBe(false)
    expect(useCharacterEditorStore().hasEditor).toBe(false)
    wrapper.unmount()
  })

  it('保存冲突保留草稿并提供重新加载/另存为新角色，离线时只允许本地编辑', async () => {
    const custom = await backend.createCharacter({ draft: draft('冲突角色') })
    updateCharacter.mockRejectedValueOnce(new Error('[BACKEND_REJECTED] [backendCode=CHARACTER_REVISION_CONFLICT] 远端已更新 [currentRevision=2]'))
    const wrapper = mountPane()
    await flushPromises()
    await openCard(wrapper, custom.summary.displayName)
    await wrapper.findAll('button').find((button) => button.text() === '编辑')!.trigger('click')
    await wrapper.get('input[name="displayName"]').setValue('本地版本')
    expect(useCharacterEditorStore().remoteAvailable).toBe(true)
    expect(useCharacterEditorStore().dirty).toBe(true)
    expect(wrapper.get('button.primary').attributes('disabled')).toBeUndefined()
    const confirm = setConfirm(true)
    await wrapper.get('.cy-character-editor-form').trigger('submit')
    await flushPromises()
    expect(confirm).toHaveBeenCalled()
    expect(updateCharacter).toHaveBeenCalled()
    expect(wrapper.text()).toContain('角色版本发生冲突')
    expect(wrapper.text()).toContain('重新加载')
    expect(wrapper.text()).toContain('另存为新角色')

    useCharacterEditorStore().setConnectionState('disconnected')
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('离线不可保存')
    expect(wrapper.get('button.primary').attributes('disabled')).toBeDefined()
    const editor = useCharacterEditorStore()
    const draftKey = editor.draftKey
    const mode = editor.mode
    const conflictButtons = wrapper.findAll('.cy-editor-error button')
    expect(conflictButtons).toHaveLength(2)
    await conflictButtons[0].trigger('click')
    await conflictButtons[1].trigger('click')
    expect(editor.draftKey).toBe(draftKey)
    expect(editor.mode).toBe(mode)
    await expect(editor.saveAsNew()).rejects.toThrow('CHARACTER_OFFLINE')
    expect(editor.draftKey).toBe(draftKey)
    expect(editor.mode).toBe(mode)
    wrapper.unmount()
  })

  it('离线详情禁用设为默认角色，函数级守卫也不调用 updateMe', async () => {
    await useIdentityStore().load()
    const wrapper = mountPane()
    await flushPromises()
    await openCard(wrapper, 'Elysia')
    const editor = useCharacterEditorStore()
    editor.setConnectionState('disconnected')
    await wrapper.vm.$nextTick()
    const button = wrapper.get('.cy-default-action')
    expect(button.attributes('disabled')).toBeDefined()
    await button.trigger('click')
    expect(updateMe).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('自定义详情加载版本并以 expected revision 进行基于旧版本的新版本回滚', async () => {
    const custom = await backend.createCharacter({ draft: draft('版本角色') })
    const changed = { ...draft('版本二') }
    await backend.updateCharacter({ characterId: custom.summary.characterId, expectedRevision: 1, statePolicy: 'preserve', draft: changed })
    const wrapper = mountPane()
    await flushPromises()
    await openCard(wrapper, '版本二')
    await flushPromises()
    const revisionReadsBeforeRollback = listCharacterRevisions.mock.calls.length
    const rollbackButton = wrapper.findAll('.cy-revision-list button').find((button) => button.text().includes('基于此版本创建新版本') && button.attributes('disabled') === undefined)
    expect(rollbackButton).toBeDefined()
    expect(rollbackButton!.attributes('disabled')).toBeUndefined()
    const confirm = setConfirm(true)
    await rollbackButton!.trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalled()
    expect(rollbackCharacter).toHaveBeenCalledWith(expect.objectContaining({
      characterId: custom.summary.characterId,
      targetRevision: 1,
      expectedRevision: 2,
      statePolicy: 'preserve'
    }))
    await flushPromises()
    expect(listCharacterRevisions.mock.calls.length).toBeGreaterThan(revisionReadsBeforeRollback)
    await wrapper.get('select[aria-label="回滚演化状态策略"]').setValue('reset_evolution')
    const resetRollback = wrapper.findAll('.cy-revision-list button').find((button) => button.text().includes('基于此版本创建新版本') && button.attributes('disabled') === undefined)
    expect(resetRollback).toBeDefined()
    await resetRollback!.trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('按后端定义的范围重置演化状态'))
    expect(rollbackCharacter).toHaveBeenLastCalledWith(expect.objectContaining({
      characterId: custom.summary.characterId,
      expectedRevision: 3,
      statePolicy: 'reset_evolution'
    }))
    wrapper.unmount()
  })

  it('版本分页按当前 cursor 显示 pending/error，可重试且 revision 变化会刷新首屏', async () => {
    const first = deferred<Page<CharacterRevisionSummary>>()
    const second = deferred<Page<CharacterRevisionSummary>>()
    const retry = deferred<Page<CharacterRevisionSummary>>()
    const refreshed = deferred<Page<CharacterRevisionSummary>>()
    let rootCalls = 0
    const listRevisions = vi.fn((input: { characterId: string; limit?: number; cursor?: string }) => {
      if (input.cursor === undefined) {
        rootCalls++
        return rootCalls === 1 ? first.promise : refreshed.promise
      }
      return listRevisions.mock.calls.length === 2 ? second.promise : retry.promise
    })
    setDesktopApi({ listCharacterRevisions: listRevisions } as never)
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(CyCharacterRevisionList, {
      props: { characterId: 'custom/paged', currentRevision: 3, enabled: true },
      global: { plugins: [pinia] }
    })
    await wrapper.vm.$nextTick()
    expect(listRevisions).toHaveBeenCalledTimes(1)
    first.resolve({ items: [{ revision: 3, checksum: 'c3', createdBy: 'user', createdAt: '2026-09-01T03:00:00.000Z' }], hasMore: true, nextCursor: 'cursor-1' })
    await flushPromises()
    await wrapper.get('.cy-load-more').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.get('.cy-load-more').text()).toContain('加载中')
    expect(listRevisions).toHaveBeenCalledTimes(2)
    await wrapper.get('.cy-load-more').trigger('click')
    expect(listRevisions).toHaveBeenCalledTimes(2)
    second.reject(new Error('[BACKEND_REJECTED] 下一页暂不可用'))
    await flushPromises()
    expect(wrapper.text()).toContain('下一页加载失败')
    await wrapper.get('.cy-load-more-error button').trigger('click')
    expect(listRevisions).toHaveBeenCalledTimes(3)
    retry.resolve({ items: [{ revision: 2, checksum: 'c2', createdBy: 'user', createdAt: '2026-09-01T02:00:00.000Z' }], hasMore: false })
    await flushPromises()
    expect(wrapper.text()).toContain('版本 2')

    await wrapper.setProps({ currentRevision: 4 } as never)
    await wrapper.vm.$nextTick()
    expect(listRevisions).toHaveBeenCalledTimes(4)
    expect(wrapper.get('.cy-revision-toolbar button').text()).toContain('读取中')
    refreshed.resolve({ items: [{ revision: 4, checksum: 'c4', createdBy: 'user', createdAt: '2026-09-01T04:00:00.000Z' }], hasMore: false })
    await flushPromises()
    expect(wrapper.text()).toContain('版本 4')
    wrapper.unmount()
  })
})
