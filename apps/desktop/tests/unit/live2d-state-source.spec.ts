// tests/unit/live2d-state-source.spec.ts
// 阶段 5 批次 B（Task 4，B4 wiring，D5B-04）：live2dStateSource 状态编排单测。
// Vue reactive ref（flush:'sync' 即时）+ 注入 getter 读取 → 断言 push 组合；fake timers 断言 N1 mood/error
// 超时回退；退订清理。
import { describe, expect, it, afterEach, vi } from 'vitest'
import { ref, type Ref } from 'vue'
import type { ConnectionState } from '@shared/contracts'
import {
  createLive2dStateSource,
  composeCharacterState,
  type Live2dStateSourceInputs
} from '../../src/renderer/src/live2d/state-source'

interface Sources {
  conn: Ref<ConnectionState>
  gen: Ref<boolean>
  speak: Ref<boolean>
  emo: Ref<string | undefined>
  input: Live2dStateSourceInputs
}

function makeSources(init: {
  conn?: ConnectionState
  gen?: boolean
  speak?: boolean
  emo?: string | undefined
}): Sources {
  const conn = ref<ConnectionState>(init.conn ?? { status: 'connected' })
  const gen = ref(init.gen ?? false)
  const speak = ref(init.speak ?? false)
  const emo = ref<string | undefined>(init.emo)
  return {
    conn, gen, speak, emo,
    input: {
      connection: () => conn.value,
      isGenerating: () => gen.value,
      isSpeaking: () => speak.value,
      emotion: () => emo.value
    }
  }
}

describe('composeCharacterState（纯组合，优先级收敛）', () => {
  it('disconnected → offline（最高优先于其他业务态）', () => {
    expect(composeCharacterState({ connection: { status: 'disconnected' }, isGenerating: true, isSpeaking: false, emotion: 'happy' })).toBe('offline')
  })
  it('isGenerating && !isSpeaking → thinking', () => {
    expect(composeCharacterState({ connection: { status: 'connected' }, isGenerating: true, isSpeaking: false, emotion: undefined })).toBe('thinking')
  })
  it('isSpeaking → speaking（覆盖 thinking/emotion）', () => {
    expect(composeCharacterState({ connection: { status: 'connected' }, isGenerating: true, isSpeaking: true, emotion: 'happy' })).toBe('speaking')
  })
  it('emotion 命中已知码 → 对应情绪态；未知码忽略 → idle', () => {
    expect(composeCharacterState({ connection: { status: 'connected' }, isGenerating: false, isSpeaking: false, emotion: 'sad' })).toBe('sad')
    expect(composeCharacterState({ connection: { status: 'connected' }, isGenerating: false, isSpeaking: false, emotion: 'pride' })).toBe('idle')
    expect(composeCharacterState({ connection: { status: 'connected' }, isGenerating: false, isSpeaking: false, emotion: 'surprised' })).toBe('surprised')
  })
  it('connection.status error → error；否则 idle', () => {
    expect(composeCharacterState({ connection: { status: 'error' }, isGenerating: false, isSpeaking: false, emotion: undefined })).toBe('error')
    expect(composeCharacterState({ connection: { status: 'connected' }, isGenerating: false, isSpeaking: false, emotion: undefined })).toBe('idle')
  })

  it('I-4：connection error（3 级）优先于 thinking/speaking(2) 与 emotion(1)（spec §3.1 binding）', () => {
    expect(composeCharacterState({ connection: { status: 'error' }, isGenerating: false, isSpeaking: false, emotion: 'happy' })).toBe('error')
    expect(composeCharacterState({ connection: { status: 'error' }, isGenerating: true, isSpeaking: false, emotion: 'happy' })).toBe('error')
    expect(composeCharacterState({ connection: { status: 'error' }, isGenerating: true, isSpeaking: true, emotion: 'happy' })).toBe('error')
    expect(composeCharacterState({ connection: { status: 'disconnected' }, isGenerating: false, isSpeaking: false, emotion: 'happy' })).toBe('offline')
  })
})

describe('createLive2dStateSource（注入 getter + Vue reactive，flush sync）', () => {
  afterEach(() => { vi.useRealTimers() })

  it('首次组合即 push 当前态（idle）', () => {
    const s = makeSources({})
    const push = vi.fn()
    const unsub = createLive2dStateSource(s.input, push)
    expect(push).toHaveBeenCalledTimes(1)
    expect(push.mock.calls[0][0]).toBe('idle')
    unsub()
  })

  it('disconnected → offline；重连 + 空活动 → idle', () => {
    const s = makeSources({})
    const push = vi.fn()
    createLive2dStateSource(s.input, push)
    push.mockClear()
    s.conn.value = { status: 'disconnected' }
    expect(push).toHaveBeenLastCalledWith('offline')
    s.conn.value = { status: 'connected' }
    expect(push).toHaveBeenLastCalledWith('idle')
  })

  it('isGenerating → thinking；出现内容（isSpeaking）→ speaking；结束后 → idle', () => {
    const s = makeSources({})
    const push = vi.fn()
    createLive2dStateSource(s.input, push)
    push.mockClear()
    s.gen.value = true
    expect(push).toHaveBeenLastCalledWith('thinking')
    s.speak.value = true
    expect(push).toHaveBeenLastCalledWith('speaking')
    s.gen.value = false
    s.speak.value = false
    expect(push).toHaveBeenLastCalledWith('idle')
  })

  it('emotion 命中 → 情绪态；未知码忽略（保持业务态 idle）', () => {
    const s = makeSources({})
    const push = vi.fn()
    createLive2dStateSource(s.input, push)
    push.mockClear()
    s.emo.value = 'happy'
    expect(push).toHaveBeenLastCalledWith('happy')
    s.emo.value = 'unknown-emotion-code'
    expect(push).toHaveBeenLastCalledWith('idle') // 未知码忽略 → 回业务态
  })

  it('N1：happy 进入后 ~2s 超时回退到进入前业务态；thinking 激活时 emotion 不压过；业务态替换清 timer', () => {
    vi.useFakeTimers()
    const s = makeSources({})
    const push = vi.fn()
    createLive2dStateSource(s.input, push)
    push.mockClear()

    // 业务基底：idle（默认态）；进入 happy（瞬态，~2s 超时）
    s.emo.value = 'happy'
    expect(push).toHaveBeenLastCalledWith('happy')

    // 2s 后回退到 idle（进入前业务态）
    vi.advanceTimersByTime(2000)
    expect(push).toHaveBeenLastCalledWith('idle')

    // thinking 激活时 emotion 不压过（组合：isGenerating&&!isSpeaking 优先于 emotion）
    s.gen.value = true
    expect(push).toHaveBeenLastCalledWith('thinking')
    s.emo.value = 'sad'
    expect(push).toHaveBeenLastCalledWith('thinking') // 未进入 sad

    // 回到 idle（清 gen + emo）
    s.gen.value = false
    s.emo.value = undefined
    expect(push).toHaveBeenLastCalledWith('idle')

    // 再次进入 happy，进入后 1s 有更高业务态（thinking 置回）→ 清 timer，不回退到被替换前状态
    s.emo.value = 'happy'
    expect(push).toHaveBeenLastCalledWith('happy')
    s.gen.value = true
    expect(push).toHaveBeenLastCalledWith('thinking') // 业务态替换清 mood timer
    vi.advanceTimersByTime(5000)
    expect(push).toHaveBeenLastCalledWith('thinking') // 未再回退
  })

  it('N1：error 进入后 ~3s 超时回退到进入前业务态', () => {
    vi.useFakeTimers()
    const s = makeSources({})
    const push = vi.fn()
    createLive2dStateSource(s.input, push)
    push.mockClear()

    // 进入 error（connection.status=error）
    s.conn.value = { status: 'error' }
    expect(push).toHaveBeenLastCalledWith('error')

    // 3s 后回退到 idle（进入前业务态）
    vi.advanceTimersByTime(3000)
    expect(push).toHaveBeenLastCalledWith('idle')
  })

  it('N1 修复（I-1）：inner-voice 完成带 emotion → 超时后落 idle（非 stale thinking，生成已清）', () => {
    vi.useFakeTimers()
    const s = makeSources({})
    const push = vi.fn()
    createLive2dStateSource(s.input, push)
    push.mockClear()

    // 生成开始（inner-voice 无 public 文本 → isSpeaking 全程 false）→ thinking
    s.gen.value = true
    expect(push).toHaveBeenLastCalledWith('thinking')

    // 生成完成（activeGenerationId 已清 → gen=false）带 emotion → happy（fallbackTarget 记忆的 thinking）
    s.gen.value = false
    s.emo.value = 'happy'
    expect(push).toHaveBeenLastCalledWith('happy')

    // 2s 超时：重组合当前业务态（emotion 置空，生成已清）→ idle，而非卡 stale thinking
    vi.advanceTimersByTime(2000)
    expect(push).toHaveBeenLastCalledWith('idle')
  })

  it('退订：清 N1 timers（回退不再触发）', () => {
    vi.useFakeTimers()
    const s = makeSources({})
    const push = vi.fn()
    const unsub = createLive2dStateSource(s.input, push)
    push.mockClear()
    s.emo.value = 'sad'
    expect(push).toHaveBeenLastCalledWith('sad')
    unsub()
    vi.advanceTimersByTime(5000)
    // 只保留进入 sad 的一次 push，回退被清理不触发
    expect(push).toHaveBeenCalledTimes(1)
  })
})
