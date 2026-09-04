// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { CharacterBindingSnapshot, CharacterPublicState, ConnectionState } from '@shared/contracts'
import CyCharacterPublicState from '../../src/renderer/src/components/CyCharacterPublicState.vue'
import {
  formatRelativeTime,
  resolveRecentInteractionAt
} from '../../src/renderer/src/components/character-public-state'

const NOW = Date.parse('2026-09-04T12:00:00.000Z')

function binding(revision = 1): CharacterBindingSnapshot {
  return {
    characterId: 'custom/quiet-companion',
    characterInstanceId: 'instance-shared',
    characterRevision: revision,
    displayName: '安静伙伴',
    presentation: {}
  }
}

function state(revision = 1, overrides: Partial<CharacterPublicState> = {}): CharacterPublicState {
  return {
    characterId: 'custom/quiet-companion',
    characterInstanceId: 'instance-shared',
    characterRevision: revision,
    stateVersion: 4,
    proactiveEnabled: false,
    updatedAt: '2026-09-04T11:55:00.000Z',
    ...overrides
  }
}

function view(options: {
  binding?: CharacterBindingSnapshot
  state?: CharacterPublicState
  status?: 'idle' | 'loading' | 'ready' | 'stale' | 'error'
  error?: { code: string; message: string }
  connection?: ConnectionState
} = {}) {
  const runtime = {
    activeBinding: options.binding,
    activeState: options.state,
    activeStatus: options.status ?? (options.state ? 'ready' : 'idle'),
    activeError: options.error,
    loadState: vi.fn(async () => {})
  }
  const connection = {
    state: options.connection ?? {
      status: 'connected' as const,
      connectionId: 'connection-1',
      features: { characterProfiles: true, characterStateStream: false }
    }
  }
  const wrapper = mount(CyCharacterPublicState, {
    props: { runtime, connection, now: NOW }
  })
  return { wrapper, runtime, connection }
}

describe('CyCharacterPublicState FE-F1b', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('无 binding 显示中性不可用态，不请求重试', () => {
    const { wrapper } = view()
    expect(wrapper.attributes('data-status')).toBe('unavailable')
    expect(wrapper.text()).toContain('暂无角色绑定')
    expect(wrapper.find('button').exists()).toBe(false)
    wrapper.unmount()
  })

  it('legacy/能力不可用显示中性文案且不提供 retry', () => {
    const { wrapper } = view({
      binding: binding(),
      connection: { status: 'connected', features: { characterProfiles: false, characterStateStream: false } }
    })
    expect(wrapper.attributes('data-status')).toBe('unavailable')
    expect(wrapper.text()).toContain('当前连接不支持角色公开状态')
    expect(wrapper.find('button').exists()).toBe(false)
    wrapper.unmount()
  })

  it('loading 无快照显示读取态；有快照刷新时不清空原内容', async () => {
    const first = view({ binding: binding(), status: 'loading' })
    expect(first.wrapper.attributes('data-status')).toBe('loading')
    expect(first.wrapper.text()).toContain('正在读取角色状态')
    first.wrapper.unmount()

    const second = view({ binding: binding(), state: state(), status: 'loading' })
    expect(second.wrapper.text()).toContain('安静伙伴')
    expect(second.wrapper.text()).toContain('最近互动')
    expect(second.wrapper.text()).toContain('正在更新角色状态')
    second.wrapper.unmount()
    await flushPromises()
  })

  it('ready 只显示允许的公开字段、非空 activity 和 lastInteractionAt 优先时间', () => {
    const { wrapper } = view({
      binding: binding(),
      state: state(1, {
        mood: { label: '专注', intensity: 0.8, updatedAt: '2026-09-04T11:50:00.000Z' },
        currentActivity: '整理今天的想法',
        lastInteractionAt: '2026-09-04T11:58:00.000Z',
        // Test-only foreign keys: the component must never project them.
        ...({ reflection: 'forbidden', memory: 'forbidden', relationship: 'forbidden', internalState: 'forbidden' } as unknown as Partial<CharacterPublicState>)
      }),
      status: 'ready'
    })
    expect(wrapper.attributes('data-status')).toBe('ready')
    expect(wrapper.text()).toContain('专注')
    expect(wrapper.text()).toContain('整理今天的想法')
    expect(wrapper.text()).toContain('2 分钟前')
    expect(wrapper.text()).not.toContain('forbidden')
    expect(wrapper.text()).not.toContain('%')
    expect(wrapper.text()).not.toMatch(/reflection|memory|relationship|internal state/i)
    wrapper.unmount()
  })

  it('公开 mood/activity 允许普通内容词与括号；附加内部字段仍不投影', () => {
    const { wrapper } = view({
      binding: binding(),
      state: state(1, {
        mood: { label: '整理共同记忆', intensity: 0.5, updatedAt: '2026-09-04T11:50:00.000Z' },
        currentActivity: '聊聊我们的关系 [计划]',
        ...({ reflection: '不得显示', memory: '不得显示', relationship: '不得显示' } as unknown as Partial<CharacterPublicState>)
      }),
      status: 'ready'
    })
    expect(wrapper.text()).toContain('整理共同记忆')
    expect(wrapper.text()).toContain('聊聊我们的关系 [计划]')
    expect(wrapper.text()).not.toContain('不得显示')
    wrapper.unmount()
  })

  it('空 activity 不渲染，updatedAt 作为最近互动回退', () => {
    const current = state(1, { currentActivity: '   ', updatedAt: '2026-09-04T11:00:00.000Z' })
    const { wrapper } = view({ binding: binding(), state: current, status: 'ready' })
    expect(wrapper.text()).not.toContain('正在做')
    expect(wrapper.text()).toContain('1 小时前')
    expect(resolveRecentInteractionAt(current)).toBe(current.updatedAt)
    wrapper.unmount()
  })

  it('离线/stale 保留快照并标记可能过期，不显示 retry', () => {
    const { wrapper } = view({
      binding: binding(),
      state: state(1, { currentActivity: '离线也可看的活动' }),
      status: 'ready',
      connection: { status: 'disconnected' }
    })
    expect(wrapper.attributes('data-status')).toBe('stale')
    expect(wrapper.text()).toContain('离线 · 可能过期')
    expect(wrapper.text()).toContain('离线也可看的活动')
    expect(wrapper.find('button').exists()).toBe(false)
    wrapper.unmount()
  })

  it('error 显示安全错误与 retry；retry 只传当前 exact binding expectation', async () => {
    const first = view({
      binding: binding(2),
      status: 'error',
      error: { code: 'BACKEND_REJECTED', message: '状态读取暂时失败' }
    })
    expect(first.wrapper.text()).toContain('状态读取暂时失败')
    await first.wrapper.get('button').trigger('click')
    expect(first.runtime.loadState).toHaveBeenCalledWith('instance-shared', expect.objectContaining({
      characterId: 'custom/quiet-companion', characterRevision: 2, characterInstanceId: 'instance-shared'
    }))
    first.wrapper.unmount()

    const unsafe = view({
      binding: binding(),
      status: 'error',
      error: { code: 'BACKEND_REJECTED', message: 'reflection memory relationship L2 {"raw":true}' }
    })
    expect(unsafe.wrapper.text()).toContain('暂时无法读取角色状态')
    expect(unsafe.wrapper.text()).not.toContain('reflection')
    unsafe.wrapper.unmount()
  })

  it('retry 中按钮保持可见但 disabled，并显示进行中文案', async () => {
    let resolvePending!: () => void
    const pending = new Promise<void>((resolve) => { resolvePending = resolve })
    const { wrapper, runtime } = view({
      binding: binding(),
      status: 'error',
      error: { code: 'BACKEND_REJECTED', message: '暂时失败' }
    })
    runtime.loadState.mockImplementation(() => pending)
    await wrapper.get('button').trigger('click')
    expect(wrapper.find('button').exists()).toBe(true)
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
    expect(wrapper.get('button').text()).toContain('正在重试')
    resolvePending()
    await flushPromises()
    wrapper.unmount()
  })

  it('retry 在断线或 legacy 能力下不可见/不生效', async () => {
    const offline = view({ binding: binding(), status: 'error', connection: { status: 'reconnecting' } })
    expect(offline.wrapper.find('button').exists()).toBe(false)
    offline.wrapper.unmount()

    const legacy = view({
      binding: binding(),
      status: 'error',
      connection: { status: 'connected', features: { characterProfiles: false, characterStateStream: true } }
    })
    expect(legacy.wrapper.find('button').exists()).toBe(false)
    legacy.wrapper.unmount()
    await flushPromises()
  })

  it('activeState 不是 active exact revision 时 fail-closed，不串显示', () => {
    const { wrapper } = view({ binding: binding(2), state: state(1, { currentActivity: '旧 revision' }), status: 'ready' })
    expect(wrapper.text()).toContain('暂无可展示的公开状态')
    expect(wrapper.text()).not.toContain('旧 revision')
    wrapper.unmount()
  })

  it('relative time 使用粗粒度稳定输出，timer 按分钟刷新并卸载清理', () => {
    expect(formatRelativeTime('2026-09-04T11:59:40.000Z', NOW)).toBe('刚刚')
    expect(formatRelativeTime('2026-09-04T11:55:00.000Z', NOW)).toBe('5 分钟前')
    expect(formatRelativeTime('2026-09-03T12:00:00.000Z', NOW)).toBe('昨天')
    expect(formatRelativeTime('not-a-date', NOW)).toBe('时间未知')

    const clear = vi.spyOn(globalThis, 'clearInterval')
    const { wrapper } = view({ binding: binding(), state: state(), status: 'ready' })
    vi.advanceTimersByTime(60_000)
    expect(wrapper.vm).toBeTruthy()
    wrapper.unmount()
    expect(clear).toHaveBeenCalled()
    clear.mockRestore()
  })
})
