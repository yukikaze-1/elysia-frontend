// @vitest-environment happy-dom
// tests/unit/cy-character-presentation-fields.spec.ts
// CyCharacterPresentationFields：呈现/运行默认值分区的受控回填与 emit 路径契约——
// 可选字段缺省显示空串、逗号列表 trim + 去空、勾选框与数字框按字段名 emit，
// 供 CyCharacterEditor 的可选字段白名单（presentation.* / runtimeDefaults.voice.*）写入 draft。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { CharacterDraft } from '@shared/contracts'
import CyCharacterPresentationFields from '../../src/renderer/src/components/characters/CyCharacterPresentationFields.vue'

function draftFixture(patch: {
  voice?: CharacterDraft['runtimeDefaults']['voice']
  emotion?: string[]
  wakeWords?: string[]
  proactive?: CharacterDraft['runtimeDefaults']['proactive']
  presentation?: CharacterDraft['presentation']
} = {}): CharacterDraft {
  return {
    displayName: '测试角色',
    description: '',
    aliases: [],
    promptProfile: {
      corePersonality: '', relationshipStyle: '', emotionStyle: '', speakingStyle: '',
      conversationInitiative: '', examples: []
    },
    runtimeDefaults: {
      voice: patch.voice ?? {},
      emotion: { idleExpressions: patch.emotion ?? [] },
      wakeWords: patch.wakeWords ?? [],
      proactive: patch.proactive ?? { enabled: false, intervalSeconds: 3600, triggers: [] }
    },
    presentation: patch.presentation ?? {}
  }
}

function mountFields(draft: CharacterDraft) {
  return mount(CyCharacterPresentationFields, { props: { draft } })
}

function fieldValue(wrapper: ReturnType<typeof mountFields>, path: string): string {
  return (wrapper.get(`[data-field-path="${path}"]`).element as HTMLInputElement).value
}

function lastUpdate(wrapper: ReturnType<typeof mountFields>): [string, unknown] {
  const events = wrapper.emitted('update')!
  return events[events.length - 1] as [string, unknown]
}

describe('CyCharacterPresentationFields 声音与呈现分区', () => {
  it('按 draft 回填全部字段：缺省可选值为空串，列表以逗号连接，勾选框/数字框取实际值', () => {
    const wrapper = mountFields(draftFixture({
      voice: { providerId: 'provider-1', voiceId: 'voice-1' },
      emotion: ['calm', 'happy'],
      wakeWords: ['你好', '嗨'],
      proactive: { enabled: true, intervalSeconds: 1800, triggers: ['提醒我'] },
      presentation: { themeColor: '#8db7f2', avatarAssetId: 'asset-1', live2dModelId: 'model-1' }
    }))
    expect(fieldValue(wrapper, '/runtimeDefaults/voice/providerId')).toBe('provider-1')
    expect(fieldValue(wrapper, '/runtimeDefaults/voice/voiceId')).toBe('voice-1')
    expect(fieldValue(wrapper, '/presentation/themeColor')).toBe('#8db7f2')
    expect(fieldValue(wrapper, '/presentation/avatarAssetId')).toBe('asset-1')
    expect(fieldValue(wrapper, '/presentation/live2dModelId')).toBe('model-1')
    expect(fieldValue(wrapper, '/runtimeDefaults/emotion/idleExpressions')).toBe('calm, happy')
    expect(fieldValue(wrapper, '/runtimeDefaults/wakeWords')).toBe('你好, 嗨')
    expect(fieldValue(wrapper, '/runtimeDefaults/proactive/triggers')).toBe('提醒我')
    expect((wrapper.get('[data-field-path="/runtimeDefaults/proactive/enabled"]').element as HTMLInputElement).checked).toBe(true)
    expect(fieldValue(wrapper, '/runtimeDefaults/proactive/intervalSeconds')).toBe('1800')
    wrapper.unmount()

    // 空 draft：可选字段渲染为空串而不是 undefined 文本；主动对话默认关闭
    const empty = mountFields(draftFixture())
    expect(fieldValue(empty, '/runtimeDefaults/voice/providerId')).toBe('')
    expect(fieldValue(empty, '/presentation/themeColor')).toBe('')
    expect(fieldValue(empty, '/runtimeDefaults/emotion/idleExpressions')).toBe('')
    expect((empty.get('[data-field-path="/runtimeDefaults/proactive/enabled"]').element as HTMLInputElement).checked).toBe(false)
    empty.unmount()
  })

  it('文本输入 emit 精确的点分路径（presentation.* 与 runtimeDefaults.voice.* 由编辑器白名单承接）', async () => {
    const wrapper = mountFields(draftFixture())
    const cases: Array<[string, string]> = [
      ['/runtimeDefaults/voice/providerId', 'runtimeDefaults.voice.providerId'],
      ['/runtimeDefaults/voice/voiceId', 'runtimeDefaults.voice.voiceId'],
      ['/presentation/themeColor', 'presentation.themeColor'],
      ['/presentation/avatarAssetId', 'presentation.avatarAssetId'],
      ['/presentation/live2dModelId', 'presentation.live2dModelId']
    ]
    for (const [path, expectedPath] of cases) {
      await wrapper.get(`[data-field-path="${path}"]`).setValue(`值-${expectedPath}`)
      expect(lastUpdate(wrapper)).toEqual([expectedPath, `值-${expectedPath}`])
    }
    wrapper.unmount()
  })

  it('逗号分隔列表统一 trim 并丢弃空项，覆盖待机表情/唤醒词/主动触发词', async () => {
    const wrapper = mountFields(draftFixture())
    await wrapper.get('[data-field-path="/runtimeDefaults/emotion/idleExpressions"]').setValue(' 平静 , 开心 ,, ')
    expect(lastUpdate(wrapper)).toEqual(['runtimeDefaults.emotion.idleExpressions', ['平静', '开心']])

    await wrapper.get('[data-field-path="/runtimeDefaults/wakeWords"]').setValue('你好,,  嗨 ')
    expect(lastUpdate(wrapper)).toEqual(['runtimeDefaults.wakeWords', ['你好', '嗨']])

    await wrapper.get('[data-field-path="/runtimeDefaults/proactive/triggers"]').setValue(' , ')
    expect(lastUpdate(wrapper)).toEqual(['runtimeDefaults.proactive.triggers', []])
    wrapper.unmount()
  })

  it('主动对话开关 emit 布尔值，间隔输入 emit 数字', async () => {
    const wrapper = mountFields(draftFixture())
    await wrapper.get('[data-field-path="/runtimeDefaults/proactive/enabled"]').setValue(true)
    expect(lastUpdate(wrapper)).toEqual(['runtimeDefaults.proactive.enabled', true])
    await wrapper.get('[data-field-path="/runtimeDefaults/proactive/enabled"]').setValue(false)
    expect(lastUpdate(wrapper)).toEqual(['runtimeDefaults.proactive.enabled', false])

    await wrapper.get('[data-field-path="/runtimeDefaults/proactive/intervalSeconds"]').setValue('7200')
    expect(lastUpdate(wrapper)).toEqual(['runtimeDefaults.proactive.intervalSeconds', 7200])
    wrapper.unmount()
  })

  // 2026-09-10 修复：原实现用 `Number.isFinite(Number(value))` 判定，而 `Number('') === 0`
  // 属于有限数 → 清空输入框 emit 了 intervalSeconds=0，与输入框 min=60 冲突。原生 rangeUnderflow
  // 会拦住整个表单提交，且该字段藏在折叠的「高级：主动对话」内，用户只看到「点保存没反应」。
  // 现在清空/非数值/超界一律回退 3600（与输入框 min/max 同源常量）。
  it('清空或非法主动间隔一律回退 3600，不再 emit 0 或 NaN', async () => {
    const wrapper = mountFields(draftFixture())
    const interval = wrapper.get('[data-field-path="/runtimeDefaults/proactive/intervalSeconds"]')

    await interval.setValue('')
    expect(lastUpdate(wrapper)).toEqual(['runtimeDefaults.proactive.intervalSeconds', 3600])

    // 超界值不夹取到边界（不静默改写用户输入），同样回退默认值
    await interval.setValue('59')
    expect(lastUpdate(wrapper)).toEqual(['runtimeDefaults.proactive.intervalSeconds', 3600])
    await interval.setValue('86401')
    expect(lastUpdate(wrapper)).toEqual(['runtimeDefaults.proactive.intervalSeconds', 3600])

    // 合法值仍按原样 emit
    await interval.setValue('60')
    expect(lastUpdate(wrapper)).toEqual(['runtimeDefaults.proactive.intervalSeconds', 60])
    await interval.setValue('86400')
    expect(lastUpdate(wrapper)).toEqual(['runtimeDefaults.proactive.intervalSeconds', 86400])
    wrapper.unmount()
  })

  // min/max 与脚本内的回退边界同源（模板绑定常量），防止「脚本回退 3600、输入框却仍是 min=60 的裸字面量」再次漂移
  it('主动间隔输入框的 min/max 来自与回退逻辑同一组常量', () => {
    const wrapper = mountFields(draftFixture())
    const interval = wrapper.get('[data-field-path="/runtimeDefaults/proactive/intervalSeconds"]')
    expect(interval.attributes('min')).toBe('60')
    expect(interval.attributes('max')).toBe('86400')
    wrapper.unmount()
  })

  it('高级区默认折叠，并说明主动对话仍受权限/连接/后端策略约束', () => {
    const wrapper = mountFields(draftFixture())
    const advanced = wrapper.get('details.cy-advanced-fields')
    expect(advanced.attributes('open')).toBeUndefined()
    expect(advanced.get('summary').text()).toBe('高级：主动对话')
    expect(advanced.get('.cy-help').text()).toContain('主动对话仍受应用权限、连接状态和后端策略约束')
    wrapper.unmount()
  })
})
