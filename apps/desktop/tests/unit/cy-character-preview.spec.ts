// @vitest-environment happy-dom
// tests/unit/cy-character-preview.spec.ts
// CyCharacterPreview：临时预览的入口守卫（离线 / 空白消息 / 请求中不得重复提交）、
// trim 后的 userMessage 与当前 draft 一起下发、成功只展示临时结果、失败走公开错误映射且不泄露后端正文。
// 环境 happy-dom：mount + createPinia + setDesktopApi mock（沿用 cy-character-management.spec.ts 的 harness 惯例）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import type { CharacterPreviewResult } from '@shared/contracts'
import CyCharacterPreview from '../../src/renderer/src/components/characters/CyCharacterPreview.vue'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { createDesktopApiMock } from './helpers/desktop-api'
import type { DesktopApiMock } from './helpers/desktop-api'
import { useCharacterEditorStore } from '../../src/renderer/src/stores/character-editor.store'

const markdownStub = { props: ['source'], template: '<div class="cy-markdown">{{ source }}</div>' }

let pinia: ReturnType<typeof createPinia>
// I-06：`previewCharacter` 是可选方法 ⇒ 裸 `ReturnType<typeof vi.fn>` 不可赋值。
let previewCharacter: DesktopApiMock['previewCharacter']

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  previewCharacter = vi.fn(async (): Promise<CharacterPreviewResult> => ({ ephemeral: true, reply: '**安全预览**' }))
  setDesktopApi(createDesktopApiMock({
    previewCharacter,
    saveCharacterDraft: vi.fn(async () => {}),
    deleteCharacterDraft: vi.fn(async () => {})
  }))
})

function mountPreview() {
  return mount(CyCharacterPreview, {
    global: { plugins: [pinia], stubs: { CyMarkdown: markdownStub } }
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

describe('CyCharacterPreview 临时预览', () => {
  it('离线时禁用入口并说明原因，点击不调用预览 API', async () => {
    useCharacterEditorStore().beginCreate()
    const wrapper = mountPreview()
    const button = wrapper.get('.cy-preview button')
    expect(button.text()).toBe('离线不可预览')
    expect(button.attributes('disabled')).toBeDefined()
    expect(wrapper.get('.cy-preview-empty').text()).toBe('运行预览后，结果会显示在这里。')
    await button.trigger('click')
    expect(previewCharacter).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('消息为空或全空白时禁用生成，避免下发无意义预览', async () => {
    const editor = useCharacterEditorStore()
    editor.beginCreate()
    editor.setConnectionState('connected', { characterProfiles: true })
    const wrapper = mountPreview()
    expect(wrapper.get('.cy-preview button').text()).toBe('生成预览')
    await wrapper.get('.cy-preview textarea').setValue('   ')
    expect(wrapper.get('.cy-preview button').attributes('disabled')).toBeDefined()
    await wrapper.get('.cy-preview button').trigger('click')
    expect(previewCharacter).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('成功后发送 trim 过的 userMessage 与当前 draft，并标记为临时结果', async () => {
    const editor = useCharacterEditorStore()
    editor.beginCreate()
    editor.setConnectionState('connected', { characterProfiles: true })
    editor.updateDraft({ displayName: '预览角色' })
    const wrapper = mountPreview()
    await wrapper.get('.cy-preview textarea').setValue('  请问候我  ')
    await wrapper.get('.cy-preview button').trigger('click')
    await flushPromises()

    expect(previewCharacter).toHaveBeenCalledTimes(1)
    const command = previewCharacter.mock.calls[0][0] as { draft: { displayName: string }; userMessage: string }
    expect(command.userMessage).toBe('请问候我')
    expect(command.draft.displayName).toBe('预览角色')
    expect(wrapper.get('.cy-preview-chip').text()).toBe('临时结果')
    expect(wrapper.get('.cy-preview-result .cy-markdown').text()).toBe('**安全预览**')
    expect(wrapper.get('.cy-preview-result small').text()).toBe('本结果不会修改草稿。')
    wrapper.unmount()
  })

  it('请求在途时按钮禁用并显示预览中，重复点击不会二次提交', async () => {
    const editor = useCharacterEditorStore()
    editor.beginCreate()
    editor.setConnectionState('connected', { characterProfiles: true })
    const pending = deferred<CharacterPreviewResult>()
    previewCharacter.mockImplementationOnce(() => pending.promise)
    const wrapper = mountPreview()
    await wrapper.get('.cy-preview button').trigger('click')
    await wrapper.vm.$nextTick()
    const button = wrapper.get('.cy-preview button')
    expect(button.text()).toBe('预览中…')
    expect(button.attributes('disabled')).toBeDefined()
    await button.trigger('click')
    expect(previewCharacter).toHaveBeenCalledTimes(1)
    pending.resolve({ ephemeral: true, reply: '完成' })
    await flushPromises()
    expect(wrapper.get('.cy-preview-chip').text()).toBe('临时结果')
    wrapper.unmount()
  })

  it('预览失败显示映射后的公开文案，不回显后端正文', async () => {
    const editor = useCharacterEditorStore()
    editor.beginCreate()
    editor.setConnectionState('connected', { characterProfiles: true })
    previewCharacter.mockRejectedValueOnce(new Error('[BACKEND_REJECTED] [backendCode=CHARACTER_PREVIEW_FAILED] 内部模型调用栈'))
    const wrapper = mountPreview()
    await wrapper.get('.cy-preview button').trigger('click')
    await flushPromises()

    const alert = wrapper.get('.cy-preview-error')
    expect(alert.attributes('role')).toBe('alert')
    expect(alert.text()).toBe('临时预览失败，请检查连接或稍后重试。')
    expect(wrapper.text()).not.toContain('内部模型调用栈')
    expect(wrapper.get('.cy-preview button').text()).toBe('生成预览')
    wrapper.unmount()
  })

  it('继续编辑草稿会清空上一次临时结果，避免把旧回复误当当前草稿', async () => {
    const editor = useCharacterEditorStore()
    editor.beginCreate()
    editor.setConnectionState('connected', { characterProfiles: true })
    const wrapper = mountPreview()
    await wrapper.get('.cy-preview button').trigger('click')
    await flushPromises()
    expect(wrapper.find('.cy-preview-result').exists()).toBe(true)

    editor.updateDraft({ description: '改了描述' })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.cy-preview-result').exists()).toBe(false)
    expect(wrapper.find('.cy-preview-chip').exists()).toBe(false)
    expect(wrapper.get('.cy-preview-empty').text()).toBe('运行预览后，结果会显示在这里。')
    wrapper.unmount()
  })
})
