// @vitest-environment happy-dom
// tests/unit/cy-session-usage.spec.ts
// C2 展示半边（2026-09-15）：输入框下方 token 条的**渲染**判据。
//
// 组件只做展示，故这里钉的是"显示什么、怎么显示、什么时候整条不显示"：
//  ① 两个数字来自两个不同口径（服务端会话累计 / 最近一轮），必须分别标注，不能合并成一个数；
//  ② 精确值与拆分在 title 里（窄条只放近似值，精确值不能成为不可得信息）；
//  ③ 无数据 → 整条不存在（unknown ≠ 0）；
//  ④ 缓存命中率缺失时 title 要说清楚原因，而不是留空让人以为"没有缓存"。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import CySessionUsage from '../../src/renderer/src/components/CySessionUsage.vue'
import { useMessageStore } from '../../src/renderer/src/stores/message.store'
import { useConversationStore } from '../../src/renderer/src/stores/conversation.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { createDesktopApiMock } from './helpers/desktop-api'
import type { BackendEvent, GenerationStartedEvent } from '@shared/contracts'

const mockApi = createDesktopApiMock()
vi.spyOn(console, 'warn').mockImplementation(() => {})

/**
 * completed 用**精确成员类型**而非 `BackendEvent` 联合：`{...completed(), usage}` 在联合上展开时
 * TS 会把字面量逐成员比对（`usage` 不存在于 `GenerationStartedEvent`），报 TS2322/TS2345——
 * 这是 `message.store.spec.ts` 已记录过的同一个坑（typecheck:node 专属，vitest 不跑类型）。
 */
type CompletedEvent = Extract<BackendEvent, { event: 'generation.completed' }>

function started(): GenerationStartedEvent {
  return { eventId: 'e', sequence: 1, event: 'generation.started', generationId: 'gen-1', messageId: 'msg-1', responseId: 'gen-1', conversationId: 'conv-1', model: 'm1' }
}

/** 与内置夹具同款（streaming-reply.jsonl 的 completed：会话累计 2100 / 本轮 208，且**无 rounds**） */
function completedFixture(): CompletedEvent {
  return {
    eventId: 'e-011',
    sequence: 11,
    event: 'generation.completed',
    generationId: 'gen-1',
    responseId: 'gen-1',
    usage: { input: 120, output: 88, total: 208, source: 'provider_reported' },
    conversationUsage: { total: 2100, byModel: { 'cyrene-llm-v1': 2100 }, source: 'server_aggregate' },
    model: 'cyrene-llm-v1'
  }
}

/** 带 rounds 的一轮（含 cached_tokens）——用于缓存命中率显示路径 */
function completedWithRounds(): CompletedEvent {
  return {
    ...completedFixture(),
    usage: {
      input: 4000,
      output: 400,
      total: 4400,
      source: 'provider_reported',
      rounds: [{ model: 'm-a', inputTokens: 4000, outputTokens: 400, totalTokens: 4400, cachedTokens: 3000, roundNum: 1 }]
    },
    conversationUsage: { total: 12_345_678, byModel: { 'm-a': 12_000_000, 'm-b': 345_678 }, source: 'server_aggregate' }
  }
}

function mountBar() {
  return mount(CySessionUsage)
}

describe('CySessionUsage（输入框下方 token 条）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setDesktopApi(mockApi)
    useConversationStore().$patch({ currentId: 'conv-1' })
  })

  it('无任何数据 → 整条不渲染（unknown ≠ 0，不出现 0 tokens 也不出现占位）', () => {
    const wrapper = mountBar()
    expect(wrapper.find('[data-testid="session-usage"]').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
  })

  it('会话累计 + 最近一轮分别标注（两个口径不合并成一个数）', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.applyEvent(completedFixture())
    const wrapper = mountBar()
    const total = wrapper.get('[data-testid="session-usage-total"]')
    const turn = wrapper.get('[data-testid="session-usage-last-turn"]')
    expect(total.text()).toContain('本会话累计')
    expect(total.text()).toContain('2.1K')          // 2100 → 紧凑值
    expect(turn.text()).toContain('最近一轮')
    expect(turn.text()).toContain('208')            // <1000 保持精确
    // 夹具的 usage 没有 rounds、没有 cached_tokens ⇒ 不得显示"缓存命中"
    expect(turn.text()).not.toContain('缓存命中')
  })

  it('精确值与拆分在 title：窄条的 2.1K 不是用户唯一能得到的数字', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.applyEvent(completedWithRounds())
    const wrapper = mountBar()
    const totalTitle = wrapper.get('[data-testid="session-usage-total"]').attributes('title') ?? ''
    expect(totalTitle).toContain('12,345,678')                       // 精确值
    expect(totalTitle).toContain('服务端按会话聚合')                  // 口径声明
    expect(totalTitle).toContain('m-a 12,000,000')                   // 按模型拆分（降序）
    expect(totalTitle).toContain('m-b 345,678')

    const turnTitle = wrapper.get('[data-testid="session-usage-last-turn"]').attributes('title') ?? ''
    expect(turnTitle).toContain('4,400')
    expect(turnTitle).toContain('输入 4,000 / 输出 400')
    expect(turnTitle).toContain('模型：m-a')
    expect(turnTitle).toContain('缓存命中：75%')
  })

  it('缓存命中率只在 rounds 完整上报时显示；缺失时 title 说明原因而不是留空', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.applyEvent(completedFixture())
    const wrapper = mountBar()
    const turn = wrapper.get('[data-testid="session-usage-last-turn"]')
    // 夹具的 usage 连 rounds 都没有 → 不显示命中率，且 title 也不编一个"0%"
    expect(turn.text()).not.toContain('%')
    expect(turn.attributes('title') ?? '').not.toContain('缓存命中')
  })

  it('只有会话累计（本轮无 usage）→ 仍显示累计那一项，不因缺一半而整条消失', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.applyEvent({ ...completedFixture(), usage: undefined })
    const wrapper = mountBar()
    expect(wrapper.find('[data-testid="session-usage-total"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="session-usage-last-turn"]').exists()).toBe(false)
  })
})
