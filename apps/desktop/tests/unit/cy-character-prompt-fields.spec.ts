// @vitest-environment happy-dom
// tests/unit/cy-character-prompt-fields.spec.ts
// CyCharacterPromptFields：authored 人格字段的路径映射（promptProfile.*）与必填标记，
// 以及嵌套示例编辑器的 update 归一（promptProfile.examples）和 (index, field) → DOM id 的聚焦委派。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { CharacterDraft } from '@shared/contracts'
import CyCharacterPromptFields from '../../src/renderer/src/components/characters/CyCharacterPromptFields.vue'
import CyCharacterExamplesEditor from '../../src/renderer/src/components/characters/CyCharacterExamplesEditor.vue'

function draftFixture(): CharacterDraft {
  return {
    displayName: '测试角色',
    description: '',
    aliases: [],
    promptProfile: {
      corePersonality: '真诚', relationshipStyle: '朋友', emotionStyle: '细腻',
      speakingStyle: '自然', conversationInitiative: '适度',
      examples: [{ user: '你好', assistant: '你也好' }]
    },
    runtimeDefaults: {
      voice: {}, emotion: { idleExpressions: [] }, wakeWords: [],
      proactive: { enabled: false, intervalSeconds: 3600, triggers: [] }
    },
    presentation: {}
  }
}

function mountPromptFields(draft: CharacterDraft, attachTo?: HTMLElement) {
  return mount(CyCharacterPromptFields, {
    props: { draft },
    ...(attachTo ? { attachTo } : {})
  })
}

describe('CyCharacterPromptFields 人格与对话方式', () => {
  it('五个 authored 字段按 promptProfile 路径 emit，必填字段带 required 标记', async () => {
    const wrapper = mountPromptFields(draftFixture())
    const fields: Array<[string, string]> = [
      ['/promptProfile/corePersonality', 'promptProfile.corePersonality'],
      ['/promptProfile/relationshipStyle', 'promptProfile.relationshipStyle'],
      ['/promptProfile/emotionStyle', 'promptProfile.emotionStyle'],
      ['/promptProfile/speakingStyle', 'promptProfile.speakingStyle'],
      ['/promptProfile/conversationInitiative', 'promptProfile.conversationInitiative']
    ]
    for (const [selector, expectedPath] of fields) {
      const field = wrapper.get(`[data-field-path="${selector}"]`)
      await field.setValue(`新值-${expectedPath}`)
      const events = wrapper.emitted('update')!
      expect(events[events.length - 1]).toEqual([expectedPath, `新值-${expectedPath}`])
    }

    for (const path of ['/promptProfile/corePersonality', '/promptProfile/relationshipStyle', '/promptProfile/speakingStyle']) {
      expect(wrapper.get(`[data-field-path="${path}"]`).attributes('required')).toBeDefined()
    }
    for (const path of ['/promptProfile/emotionStyle', '/promptProfile/conversationInitiative']) {
      expect(wrapper.get(`[data-field-path="${path}"]`).attributes('required')).toBeUndefined()
    }
    expect(wrapper.get('.cy-help').text()).toContain('不是完整 system prompt')
    wrapper.unmount()
  })

  it('示例编辑器的更新归一为 promptProfile.examples，聚焦请求按 (index, field) 定位到具体输入框', async () => {
    const draft = draftFixture()
    draft.promptProfile.examples.push({ user: '再见', assistant: '再见啦' })
    const wrapper = mountPromptFields(draft, document.body)
    const examples = wrapper.findComponent(CyCharacterExamplesEditor)
    expect(examples.props('examples' as never)).toHaveLength(2)

    await wrapper.get('#character-example-0-user').setValue('改过的用户输入')
    const updates = wrapper.emitted('update')!
    expect(updates[updates.length - 1]).toEqual(['promptProfile.examples', [
      { user: '改过的用户输入', assistant: '你也好' },
      { user: '再见', assistant: '再见啦' }
    ]])

    ;(document.activeElement as HTMLElement | null)?.blur()
    examples.vm.$emit('focus', 1, 'assistant')
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(wrapper.get('#character-example-1-assistant').element)
    wrapper.unmount()
  })
})
