// @vitest-environment happy-dom
// tests/unit/cy-character-editor.spec.ts
// CyCharacterEditor：三种编辑模式的标题/基线、离线与 busy 的保存门禁、保存/冲突/错误三态渲染、
// 可选字段白名单（presentation.* / runtimeDefaults.voice.* / openingMessage）写入 draft，
// 以及校验 issue 定位到高级折叠区时自动展开。store 走真实 character-editor.store，API 经 setDesktopApi mock。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import type { CharacterDetail, CharacterDraft, CharacterMutationResult, CharacterValidationResult } from '@shared/contracts'
import CyCharacterEditor from '../../src/renderer/src/components/characters/CyCharacterEditor.vue'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { useCharacterEditorStore } from '../../src/renderer/src/stores/character-editor.store'

function draftFixture(displayName = '测试角色'): CharacterDraft {
  return {
    displayName,
    description: '简介',
    aliases: ['别名'],
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

function detailFixture(overrides: {
  displayName?: string
  source?: 'builtin' | 'custom'
  status?: 'active' | 'archived'
  revision?: number
} = {}): CharacterDetail {
  const value = draftFixture(overrides.displayName ?? '测试角色')
  const revision = overrides.revision ?? 3
  return {
    summary: {
      characterId: 'custom/test',
      source: overrides.source ?? 'custom',
      mutable: (overrides.source ?? 'custom') === 'custom',
      status: overrides.status ?? 'active',
      currentRevision: revision,
      displayName: value.displayName,
      description: value.description,
      aliases: value.aliases,
      presentation: {},
      updatedAt: '2026-08-31T00:00:00.000Z'
    },
    current: {
      ...value, characterId: 'custom/test', revision, schemaVersion: 1,
      checksum: 'checksum', compilerVersion: 1, createdBy: 'user', createdAt: '2026-08-31T00:00:00.000Z'
    }
  }
}

function mutationResult(draft: CharacterDraft, revision: number): CharacterMutationResult {
  const detail = detailFixture({ revision })
  return {
    character: { ...detail, current: { ...detail.current, ...draft, revision } },
    stateImpact: { statePolicy: 'preserve', affectedInstances: 0, pendingInstances: 0, resetFields: [] }
  }
}

let pinia: ReturnType<typeof createPinia>
let createCharacter: ReturnType<typeof vi.fn>
let updateCharacter: ReturnType<typeof vi.fn>
let validateCharacter: ReturnType<typeof vi.fn>
let deleteCharacterDraft: ReturnType<typeof vi.fn>
let originalConfirm: typeof window.confirm

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  createCharacter = vi.fn(async (input: { draft: CharacterDraft }) => mutationResult(input.draft, 1))
  updateCharacter = vi.fn(async (input: { draft: CharacterDraft; expectedRevision: number }) => mutationResult(input.draft, input.expectedRevision + 1))
  validateCharacter = vi.fn(async (): Promise<CharacterValidationResult> => ({ valid: true, issues: [] }))
  deleteCharacterDraft = vi.fn(async () => {})
  setDesktopApi({
    createCharacter,
    updateCharacter,
    validateCharacter,
    previewCharacter: vi.fn(async () => ({ ephemeral: true, reply: '预览' })),
    listCharacterDrafts: vi.fn(async () => []),
    getCharacterDraft: vi.fn(async () => undefined),
    saveCharacterDraft: vi.fn(async () => {}),
    deleteCharacterDraft
  } as never)
  originalConfirm = window.confirm
  useCharacterEditorStore().setConnectionState('connected', { characterProfiles: true })
})

afterEach(() => {
  Object.defineProperty(window, 'confirm', { configurable: true, value: originalConfirm })
})

function setConfirm(value: boolean): ReturnType<typeof vi.fn> {
  const confirm = vi.fn(() => value)
  Object.defineProperty(window, 'confirm', { configurable: true, value: confirm })
  return confirm
}

function mountEditor(props: { detail?: CharacterDetail; busy?: boolean } = {}, attachTo?: HTMLElement) {
  return mount(CyCharacterEditor, {
    props,
    ...(attachTo ? { attachTo } : {}),
    global: { plugins: [pinia], stubs: { CyMarkdown: { props: ['source'], template: '<div class="cy-markdown">{{ source }}</div>' } } }
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

describe('CyCharacterEditor 角色编辑器', () => {
  it('按 create/clone/edit 显示标题与基线，克隆模式提示首次保存会新建角色', async () => {
    const editor = useCharacterEditorStore()
    const wrapper = mountEditor()
    editor.beginCreate()
    await wrapper.vm.$nextTick()
    expect(wrapper.get('#cy-character-editor-title').text()).toBe('新建角色')
    expect(wrapper.get('.cy-editor-heading p').text()).toContain('尚未创建远端角色')
    expect(wrapper.find('.cy-editor-note').exists()).toBe(false)

    editor.beginEdit(detailFixture())
    await wrapper.vm.$nextTick()
    expect(wrapper.get('#cy-character-editor-title').text()).toBe('编辑角色')
    expect(wrapper.get('.cy-editor-heading p').text()).toContain('基线 revision 3')
    expect(wrapper.get('.cy-editor-heading p').text()).toContain('未修改')

    editor.beginClone(detailFixture({ source: 'builtin' }), '测试角色（自定义）')
    await wrapper.vm.$nextTick()
    expect(wrapper.get('#cy-character-editor-title').text()).toBe('克隆并自定义')
    expect(wrapper.get('.cy-editor-note').text()).toBe('这是从现有角色复制出的新草稿，首次保存会创建新角色。')
    expect(wrapper.get('.cy-editor-heading p').text()).toContain('有未保存修改')
    expect((wrapper.get('input[name="displayName"]').element as HTMLInputElement).value).toBe('测试角色（自定义）')
    wrapper.unmount()
  })

  it('离线时禁用保存并说明只能在本地保留草稿，表单提交不触发远端写入', async () => {
    const editor = useCharacterEditorStore()
    editor.beginEdit(detailFixture())
    editor.setConnectionState('disconnected')
    const wrapper = mountEditor({ detail: detailFixture() })
    await wrapper.get('input[name="displayName"]').setValue('离线改名')
    expect(editor.dirty).toBe(true)

    const saveButton = wrapper.get('.cy-save-group button.primary')
    expect(saveButton.text()).toBe('离线不可保存')
    expect(saveButton.attributes('disabled')).toBeDefined()
    expect(wrapper.get('.cy-editor-status').text()).toContain('离线：可编辑并保存本地草稿')
    expect(wrapper.get('.offline-note').text()).toContain('当前无法执行远端校验、预览或保存')

    setConfirm(true)
    await wrapper.get('.cy-character-editor-form').trigger('submit')
    await flushPromises()
    expect(updateCharacter).not.toHaveBeenCalled()
    expect(wrapper.emitted('saved')).toBeUndefined()
    wrapper.unmount()
  })

  it('编辑保存以 expected revision 提交，成功后提示新 revision 并 emit saved', async () => {
    const editor = useCharacterEditorStore()
    editor.beginEdit(detailFixture())
    const wrapper = mountEditor({ detail: detailFixture() })
    await wrapper.get('input[name="displayName"]').setValue('保存后的名字')
    const confirm = setConfirm(true)
    await wrapper.get('.cy-character-editor-form').trigger('submit')
    await flushPromises()

    expect(confirm).toHaveBeenCalled()
    expect(validateCharacter).toHaveBeenCalledTimes(1)
    expect(updateCharacter).toHaveBeenCalledWith(expect.objectContaining({
      characterId: 'custom/test', expectedRevision: 3, statePolicy: 'preserve'
    }))
    expect(wrapper.emitted('saved')).toHaveLength(1)
    expect(wrapper.get('.cy-editor-success').text()).toBe('角色已保存为 revision 4。')
    expect(editor.dirty).toBe(false)
    expect(wrapper.get('.cy-editor-heading p').text()).toContain('基线 revision 4')
    wrapper.unmount()
  })

  it('保存中禁用保存按钮与策略选择并显示进行中，避免重复提交', async () => {
    const editor = useCharacterEditorStore()
    editor.beginEdit(detailFixture())
    const pending = deferred<CharacterMutationResult>()
    updateCharacter.mockImplementationOnce(() => pending.promise)
    const wrapper = mountEditor({ detail: detailFixture() })
    await wrapper.get('input[name="displayName"]').setValue('并发保护')
    setConfirm(true)
    await wrapper.get('.cy-character-editor-form').trigger('submit')
    await wrapper.vm.$nextTick()

    const saveButton = wrapper.get('.cy-save-group button.primary')
    expect(saveButton.text()).toBe('保存中…')
    expect(saveButton.attributes('disabled')).toBeDefined()
    expect(wrapper.get('select').attributes('disabled')).toBeDefined()
    pending.resolve(mutationResult(draftFixture('并发保护'), 4))
    await flushPromises()
    expect(wrapper.emitted('saved')).toHaveLength(1)
    wrapper.unmount()
  })

  it('版本冲突展示冲突块与当前 revision，可重新加载或另存为新角色', async () => {
    const editor = useCharacterEditorStore()
    editor.beginEdit(detailFixture())
    updateCharacter.mockRejectedValueOnce(new Error('[BACKEND_REJECTED] [backendCode=CHARACTER_REVISION_CONFLICT] [currentRevision=5] 远端已更新'))
    const wrapper = mountEditor({ detail: detailFixture() })
    await wrapper.get('input[name="displayName"]').setValue('本地版本')
    setConfirm(true)
    await wrapper.get('.cy-character-editor-form').trigger('submit')
    await flushPromises()

    const conflict = wrapper.get('.cy-editor-error.conflict')
    expect(conflict.attributes('role')).toBe('alert')
    expect(conflict.get('strong').text()).toBe('角色版本发生冲突')
    expect(conflict.text()).toContain('角色版本已更新。请重新加载最新版本，或选择另存为新角色。')
    expect(conflict.text()).toContain('当前 revision：5')
    const actions = conflict.findAll('button')
    expect(actions.map((button) => button.text())).toEqual(['重新加载（丢弃当前草稿）', '另存为新角色'])

    await actions[0].trigger('click')
    expect(wrapper.emitted('reload')).toHaveLength(1)

    await actions[1].trigger('click')
    await flushPromises()
    expect(createCharacter).toHaveBeenCalledWith({ draft: expect.objectContaining({ displayName: '本地版本' }) })
    expect(wrapper.emitted('saved')).toHaveLength(1)
    expect(editor.baseCharacterId).toBe('custom/test')
    wrapper.unmount()
  })

  it('保存失败按公开错误码渲染可执行文案，不回显后端正文', async () => {
    const editor = useCharacterEditorStore()
    editor.beginEdit(detailFixture({ source: 'builtin' }))
    updateCharacter.mockRejectedValueOnce(new Error('[BACKEND_REJECTED] [backendCode=CHARACTER_IMMUTABLE] 内部校验栈'))
    const wrapper = mountEditor({ detail: detailFixture({ source: 'builtin' }) })
    await wrapper.get('input[name="displayName"]').setValue('内置角色改名')
    setConfirm(true)
    await wrapper.get('.cy-character-editor-form').trigger('submit')
    await flushPromises()

    const error = wrapper.get('.cy-editor-error')
    expect(error.attributes('role')).toBe('alert')
    expect(error.text()).toBe('内置角色不可修改，请先克隆为自定义角色。')
    expect(wrapper.text()).not.toContain('内部校验栈')
    expect(wrapper.find('.cy-editor-success').exists()).toBe(false)
    wrapper.unmount()
  })

  it('基础字段与可选白名单写入 draft：别名去空、可选字段清空回落 undefined', async () => {
    const editor = useCharacterEditorStore()
    editor.beginEdit(detailFixture())
    const wrapper = mountEditor({ detail: detailFixture() })

    await wrapper.get('[data-field-path="/aliases"]').setValue(' 甲 , 乙 ,, ')
    expect(editor.draft?.aliases).toEqual(['甲', '乙'])
    await wrapper.get('[data-field-path="/openingMessage"]').setValue('你好，我在这里。')
    expect(editor.draft?.openingMessage).toBe('你好，我在这里。')
    await wrapper.get('[data-field-path="/openingMessage"]').setValue('')
    expect(editor.draft?.openingMessage).toBeUndefined()

    await wrapper.get('[data-field-path="/presentation/themeColor"]').setValue('#123456')
    expect(editor.draft?.presentation.themeColor).toBe('#123456')
    await wrapper.get('[data-field-path="/presentation/live2dModelId"]').setValue('model-1')
    expect(editor.draft?.presentation.live2dModelId).toBe('model-1')
    await wrapper.get('[data-field-path="/presentation/live2dModelId"]').setValue('')
    expect(editor.draft?.presentation.live2dModelId).toBeUndefined()

    await wrapper.get('[data-field-path="/runtimeDefaults/voice/providerId"]').setValue('provider-1')
    expect(editor.draft?.runtimeDefaults.voice.providerId).toBe('provider-1')
    await wrapper.get('[data-field-path="/runtimeDefaults/voice/voiceId"]').setValue('voice-1')
    expect(editor.draft?.runtimeDefaults.voice).toEqual({ providerId: 'provider-1', voiceId: 'voice-1' })

    // 非白名单的深层点分路径仍走 store.updateField，列表字段整体替换
    await wrapper.get('[data-field-path="/runtimeDefaults/wakeWords"]').setValue('你好, 嗨')
    expect(editor.draft?.runtimeDefaults.wakeWords).toEqual(['你好', '嗨'])
    await wrapper.get('[data-field-path="/runtimeDefaults/emotion/idleExpressions"]').setValue('calm')
    expect(editor.draft?.runtimeDefaults.emotion.idleExpressions).toEqual(['calm'])
    wrapper.unmount()
  })

  // 2026-09-10 修复：表单原先把保存反馈完全交给浏览器原生约束校验。真机（Chromium 实测）中
  // 无效字段位于折叠的 <details>（高级：主动对话）内时，Chrome 既不展开也不移动焦点，
  // 原生气泡在 display:none 子树中无处渲染 → 用户看到「点保存没反应且零提示」。
  // 修复 = 表单 novalidate + 提交前自查 checkValidity()，并把原因就地渲染出来。
  it('表单声明 novalidate：原生约束不再在提交时静默拦截整个表单', () => {
    const editor = useCharacterEditorStore()
    editor.beginEdit(detailFixture())
    const wrapper = mountEditor({ detail: detailFixture() })
    expect(wrapper.get('.cy-character-editor-form').attributes('novalidate')).toBeDefined()
    wrapper.unmount()
  })

  it('原生约束未通过时就地给出原因、展开折叠区，且不进入确认弹窗与远端写入', async () => {
    const editor = useCharacterEditorStore()
    editor.beginEdit(detailFixture())
    const wrapper = mountEditor({ detail: detailFixture() }, document.body)
    await wrapper.get('input[name="displayName"]').setValue('约束拦截')

    // happy-dom 不实现约束校验算法：显式模拟真实浏览器在 checkValidity() 时派发 invalid
    // 事件（真实浏览器从失败控件派发并冒泡至 form，组件在 form 上以捕获阶段收集）
    const interval = wrapper.get('[data-field-path="/runtimeDefaults/proactive/intervalSeconds"]').element as HTMLInputElement
    const form = wrapper.get('.cy-character-editor-form').element as HTMLFormElement
    const checkValidity = vi.spyOn(form, 'checkValidity').mockImplementation(() => {
      interval.dispatchEvent(new Event('invalid', { bubbles: true, cancelable: true }))
      return false
    })
    try {
      const confirm = setConfirm(true)
      await wrapper.get('.cy-character-editor-form').trigger('submit')
      await flushPromises()

      expect(checkValidity).toHaveBeenCalled()
      // 不弹确认、不写远端——但必须有可见原因
      expect(confirm).not.toHaveBeenCalled()
      expect(updateCharacter).not.toHaveBeenCalled()
      const block = wrapper.get('.cy-editor-error.native-block')
      expect(block.attributes('role')).toBe('alert')
      expect(block.text()).toContain('主动间隔（秒）')
      expect(block.text()).toContain('/runtimeDefaults/proactive/intervalSeconds')
      expect(block.text()).toContain('不符合输入要求')
      // 失败字段所在折叠区被展开，避免「有提示但看不见」
      expect(wrapper.get('details.cy-advanced-fields').attributes('open')).toBeDefined()
      // 同一问题也进校验列表（issue 只带 path + 原因，字段名由上方 blockedMessage 给出），可点击定位
      expect(wrapper.get('.cy-validation-summary').text()).toContain('草稿未通过校验，暂不能保存')
      const issue = wrapper.get('.cy-issue-list button')
      expect(issue.text()).toContain('不符合输入要求')
      expect(issue.text()).toContain('/runtimeDefaults/proactive/intervalSeconds')
      await wrapper.get('.cy-issue-list button').trigger('click')
    } finally {
      checkValidity.mockRestore()
      wrapper.unmount()
    }
  })

  // 同一失效模式的第二个入口：必填项为空（valueMissing）。角色名称是 `required` 且不在折叠区内，
  // 因此这里同时钉住「提示用字段标签 + 原因」，以及「失败字段不在 details 里时不抛错」。
  it('必填项为空时给出「为必填项」原因，且不依赖折叠区', async () => {
    const editor = useCharacterEditorStore()
    editor.beginEdit(detailFixture())
    const wrapper = mountEditor({ detail: detailFixture() }, document.body)
    await wrapper.get('input[name="displayName"]').setValue('')
    expect(editor.dirty).toBe(true)

    const name = wrapper.get('input[name="displayName"]').element as HTMLInputElement
    const form = wrapper.get('.cy-character-editor-form').element as HTMLFormElement
    const checkValidity = vi.spyOn(form, 'checkValidity').mockImplementation(() => {
      name.dispatchEvent(new Event('invalid', { bubbles: true, cancelable: true }))
      return false
    })
    try {
      const confirm = setConfirm(true)
      await wrapper.get('.cy-character-editor-form').trigger('submit')
      await flushPromises()

      expect(confirm).not.toHaveBeenCalled()
      expect(updateCharacter).not.toHaveBeenCalled()
      const block = wrapper.get('.cy-editor-error.native-block').text()
      // 标签文本取自 <label><span>角色名称 <em>*</em></span>，`*` 被剥掉、em 标记不出现在文本里
      expect(block).toContain('角色名称（/displayName）')
      expect(block).toContain('不符合输入要求')
      expect(block).toContain('已阻止保存')
      expect(wrapper.get('.cy-issue-list button').text()).toContain('/displayName')
    } finally {
      checkValidity.mockRestore()
      wrapper.unmount()
    }
  })

  it('校验问题的深层路径会展开高级折叠区并聚焦对应输入', async () => {
    const editor = useCharacterEditorStore()
    editor.beginEdit(detailFixture())
    validateCharacter.mockResolvedValueOnce({
      valid: false,
      issues: [{ severity: 'error', code: 'PROACTIVE_INTERVAL', path: '/runtimeDefaults/proactive/intervalSeconds', message: '主动间隔过短' }]
    } satisfies CharacterValidationResult)
    const wrapper = mountEditor({ detail: detailFixture() }, document.body)
    await wrapper.get('.cy-validation > header button').trigger('click')
    await flushPromises()
    expect(wrapper.get('.cy-validation-summary').text()).toContain('草稿未通过校验，暂不能保存')

    const advanced = wrapper.get('details.cy-advanced-fields')
    expect(advanced.attributes('open')).toBeUndefined()
    await wrapper.get('.cy-issue-list button').trigger('click')
    expect(advanced.attributes('open')).toBeDefined()
    expect(document.activeElement).toBe(wrapper.get('[data-field-path="/runtimeDefaults/proactive/intervalSeconds"]').element)
    wrapper.unmount()
  })

  it('放弃修改需确认：拒绝保留编辑会话，接受清理本地恢复草稿并返回', async () => {
    const editor = useCharacterEditorStore()
    editor.beginEdit(detailFixture())
    const wrapper = mountEditor({ detail: detailFixture() })
    await wrapper.get('input[name="displayName"]').setValue('放弃前的改动')
    const discardButton = wrapper.findAll('.cy-editor-actions button').find((button) => button.text() === '放弃修改')!

    setConfirm(false)
    await discardButton.trigger('click')
    await flushPromises()
    expect(deleteCharacterDraft).not.toHaveBeenCalled()
    expect(wrapper.emitted('back')).toBeUndefined()
    expect(editor.hasEditor).toBe(true)

    setConfirm(true)
    await discardButton.trigger('click')
    await flushPromises()
    expect(deleteCharacterDraft).toHaveBeenCalledWith('edit:custom/test')
    expect(wrapper.emitted('back')).toHaveLength(1)
    expect(editor.hasEditor).toBe(false)
    wrapper.unmount()
  })

  it('busy 属性禁用保存入口并切换演化状态策略写入 store', async () => {
    const editor = useCharacterEditorStore()
    editor.beginEdit(detailFixture())
    const wrapper = mountEditor({ detail: detailFixture(), busy: true })
    await wrapper.get('input[name="displayName"]').setValue('忙时改动')
    expect(wrapper.get('.cy-save-group button.primary').attributes('disabled')).toBeDefined()
    await wrapper.get('.cy-character-editor-form').trigger('submit')
    await flushPromises()
    expect(updateCharacter).not.toHaveBeenCalled()
    wrapper.unmount()

    const idle = mountEditor({ detail: detailFixture() })
    await idle.get('select').setValue('reset_evolution')
    expect(useCharacterEditorStore().statePolicy).toBe('reset_evolution')
    expect(useCharacterEditorStore().dirty).toBe(true)
    idle.unmount()
  })
})
