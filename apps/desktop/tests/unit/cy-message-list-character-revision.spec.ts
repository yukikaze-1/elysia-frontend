// @vitest-environment happy-dom
// tests/unit/cy-message-list-character-revision.spec.ts
// 真机缺陷回归（发送第一条消息后消息列表消失、输入框被顶到聊天区顶部）：
// CyMessageList 渲染携带 character ref 的 assistant 消息时，模板调用
// revisionIdentityFor() → characterCatalogStore.revisionIdentity()
// → cloneValue(summary.presentation)。summary 来自 Pinia 响应式 Store，是 Vue Proxy，
// 未加守卫的 structuredClone 会抛 `DataCloneError: #<Object> could not be cloned`；
// 异常发生在渲染函数内 → 虚拟列表根元素 .cy-messages 坍缩 → 消息列表消失。
//
// 本文件锚定「组件真的渲染出来了」，而不只验证辅助函数：
// 断言 .cy-messages / .cy-vlist-row 存在、消息正文可见、控制台零 Vue 警告。
// 相关 store 层回归见 tests/unit/character-stores.spec.ts（响应式 Proxy + 独立副本 + 不反向污染）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import type { CharacterSummary, Message } from '@shared/contracts'
import { MockCharacterBackend } from '../../src/main/characters/mock-character-backend'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { useMessageStore } from '../../src/renderer/src/stores/message.store'
import { useConversationStore } from '../../src/renderer/src/stores/conversation.store'
import { useCharacterCatalogStore } from '../../src/renderer/src/stores/character-catalog.store'
import CyMessageList from '../../src/renderer/src/components/CyMessageList.vue'

const CREATED_AT = '2026-09-10T04:20:00.000Z'

/** Message.character 是完整三元组 {characterId, characterInstanceId, characterRevision}；
 *  instance id 推导口径与 MockCharacterBackend.getConversationBinding 一致。 */
function characterRef(characterId: string, characterRevision: number): NonNullable<Message['character']> {
  return {
    characterId,
    characterInstanceId: `instance-${characterId.replace(/[^A-Za-z0-9_-]/g, '-')}`,
    characterRevision
  }
}

function assistantMessage(character: Message['character']): Message {
  return {
    messageId: 'msg-assistant-1',
    conversationId: 'default',
    role: 'assistant',
    status: 'completed',
    createdAt: CREATED_AT,
    assistantSegments: [
      { segmentId: 'seg-1', segmentIndex: 0, channel: 'public_reply', kind: 'text', text: '你好，我是爱莉希雅。', completed: true }
    ],
    ...(character ? { character } : {})
  }
}

/** happy-dom 不提供 ResizeObserver；CyMessageList 在 onMounted 构造并 observe 容器。
 *  空实现即可覆盖“渲染不崩”这一回归目标（组件用默认 viewportHeight=600 切窗口，
 *  单行消息恒落在可视窗口内，不依赖实测高度）。 */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function userMessage(): Message {
  return {
    messageId: 'msg-user-1',
    conversationId: 'default',
    role: 'user',
    content: '你好',
    status: 'completed',
    createdAt: '2026-09-10T04:19:00.000Z'
  }
}

/** 只装配渲染路径需要的只读面；写命令不参与本回归。 */
function installApi(summaries: CharacterSummary[], detail: Awaited<ReturnType<MockCharacterBackend['getCharacter']>>): void {
  setDesktopApi({
    listCharacters: vi.fn(async () => ({ items: summaries, hasMore: false })),
    getCharacter: vi.fn(async () => detail),
    getMe: vi.fn(async () => { throw new Error('本回归不读取 identity') })
  } as never)
}

describe('CyMessageList 角色 revision identity 渲染（DataCloneError 真机回归）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  })

  it('携带 character ref 的 assistant 消息可正常渲染，列表不消失且不产生 Vue 警告', async () => {
    const backend = new MockCharacterBackend()
    const created = await backend.createCharacter({
      draft: {
        displayName: '渲染用角色',
        description: '',
        aliases: [],
        promptProfile: { corePersonality: '真诚', relationshipStyle: '朋友', emotionStyle: '', speakingStyle: '自然', conversationInitiative: '', examples: [] },
        runtimeDefaults: { voice: {}, emotion: { idleExpressions: [] }, wakeWords: [], proactive: { enabled: false, intervalSeconds: 3600, triggers: [] } },
        presentation: { themeColor: '#f2a7c6', live2dModelId: 'haru' }
      }
    })
    installApi([created.summary], created)

    const catalog = useCharacterCatalogStore()
    await catalog.loadList({})
    const summary = catalog.summaries[0]

    const messages = useMessageStore()
    messages.loadSnapshot('default', [
      userMessage(),
      assistantMessage(characterRef(summary.characterId, summary.currentRevision))
    ])

    const conversations = useConversationStore()
    conversations.currentId = 'default'

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const wrapper = mount(CyMessageList, {
      // CyMessageBubble 的子组件：附件/工具卡留桩，markdown 走真实渲染（正文可见性断言依赖它）
      global: { stubs: { CyAttachmentMedia: true, CyToolCard: true } }
    })
    await Promise.resolve()

    // 核心断言：渲染函数没有因 DataCloneError 中断——根元素与虚拟行都在，消息列表未坍缩
    expect(wrapper.find('.cy-messages').exists()).toBe(true)
    expect(wrapper.findAll('.cy-vlist-row').length).toBe(2)
    expect(wrapper.find('.cy-empty').exists()).toBe(false)
    // 用户消息与 assistant 正文都真实呈现
    expect(wrapper.text()).toContain('你好')
    expect(wrapper.text()).toContain('你好，我是爱莉希雅。')
    // 历史 revision identity 生效：气泡使用精确 revision 的 displayName
    expect(wrapper.text()).toContain('渲染用角色')
    // 无渲染层异常逃逸（Vue 把渲染错误同时记到 console.warn/error）
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('catalog 无该 revision 时不伪造历史身份，渲染仍不崩', async () => {
    const backend = new MockCharacterBackend()
    const created = await backend.createCharacter({
      draft: {
        displayName: '旧版本角色',
        description: '',
        aliases: [],
        promptProfile: { corePersonality: '真诚', relationshipStyle: '朋友', emotionStyle: '', speakingStyle: '自然', conversationInitiative: '', examples: [] },
        runtimeDefaults: { voice: {}, emotion: { idleExpressions: [] }, wakeWords: [], proactive: { enabled: false, intervalSeconds: 3600, triggers: [] } },
        presentation: {}
      }
    })
    installApi([created.summary], created)

    const catalog = useCharacterCatalogStore()
    await catalog.loadList({})

    const messages = useMessageStore()
    // 消息声明 revision 2，catalog 只有 revision 1 → revisionIdentity 返回 undefined（不降级猜身份）
    messages.loadSnapshot('default', [assistantMessage(characterRef(created.summary.characterId, 2))])

    const conversations = useConversationStore()
    conversations.currentId = 'default'

    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = mount(CyMessageList, {
      global: { stubs: { CyAttachmentMedia: true, CyToolCard: true } }
    })
    await Promise.resolve()

    expect(catalog.revisionIdentity(created.summary.characterId, 2)).toBeUndefined()
    expect(wrapper.find('.cy-messages').exists()).toBe(true)
    expect(wrapper.findAll('.cy-vlist-row').length).toBe(1)
    expect(wrapper.text()).toContain('你好，我是爱莉希雅。')
    expect(error).not.toHaveBeenCalled()

    wrapper.unmount()
  })
})
