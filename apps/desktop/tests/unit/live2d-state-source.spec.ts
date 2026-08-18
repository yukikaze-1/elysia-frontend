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
  normalizeEmotionCode,
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
  it('F-1：中文 mood 归一——开心→happy / 难过→sad / 惊讶→surprised；平静/未知→idle；ASCII 大小写不敏感', () => {
    expect(composeCharacterState({ connection: { status: 'connected' }, isGenerating: false, isSpeaking: false, emotion: '开心' })).toBe('happy')
    expect(composeCharacterState({ connection: { status: 'connected' }, isGenerating: false, isSpeaking: false, emotion: '难过' })).toBe('sad')
    expect(composeCharacterState({ connection: { status: 'connected' }, isGenerating: false, isSpeaking: false, emotion: '惊讶' })).toBe('surprised')
    expect(composeCharacterState({ connection: { status: 'connected' }, isGenerating: false, isSpeaking: false, emotion: '平静' })).toBe('idle')
    expect(composeCharacterState({ connection: { status: 'connected' }, isGenerating: false, isSpeaking: false, emotion: 'pride' })).toBe('idle')
    expect(composeCharacterState({ connection: { status: 'connected' }, isGenerating: false, isSpeaking: false, emotion: 'HAPPY' })).toBe('happy')
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

describe('normalizeEmotionCode（F-1：后端 mood 自由文本 → MoodEmotion）', () => {
  it('英文码原样命中（ASCII 大小写不敏感）', () => {
    expect(normalizeEmotionCode('happy')).toBe('happy')
    expect(normalizeEmotionCode('SAD')).toBe('sad')
    expect(normalizeEmotionCode('Surprised')).toBe('surprised')
  })
  it('中文别名命中', () => {
    expect(normalizeEmotionCode('开心')).toBe('happy')
    expect(normalizeEmotionCode('高兴')).toBe('happy')
    expect(normalizeEmotionCode('悲伤')).toBe('sad')
    expect(normalizeEmotionCode('沮丧')).toBe('sad')
    expect(normalizeEmotionCode('吃惊')).toBe('surprised')
    expect(normalizeEmotionCode('诧异')).toBe('surprised')
  })
  it('未命中/undefined → undefined', () => {
    expect(normalizeEmotionCode(undefined)).toBeUndefined()
    expect(normalizeEmotionCode('平静')).toBeUndefined()
    expect(normalizeEmotionCode('neutral')).toBeUndefined()
    expect(normalizeEmotionCode('')).toBeUndefined()
  })
})

describe('createLive2dStateSource（注入 getter + Vue reactive，flush sync）', () => {
  afterEach(() => { vi.useRealTimers() })

  it('首次组合即 push 当前态（idle）', () => {
    const s = makeSources({})
    const push = vi.fn()
    const handle = createLive2dStateSource(s.input, push)
    expect(push).toHaveBeenCalledTimes(1)
    expect(push.mock.calls[0][0]).toBe('idle')
    handle.unsub()
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
    const handle = createLive2dStateSource(s.input, push)
    push.mockClear()
    s.emo.value = 'sad'
    expect(push).toHaveBeenLastCalledWith('sad')
    handle.unsub()
    vi.advanceTimersByTime(5000)
    // 只保留进入 sad 的一次 push，回退被清理不触发
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('C2 recompose：按当前业务源重组合并 push（瞬态重启 timer、同态不重推）；退订后 recompose no-op', () => {
    vi.useFakeTimers()
    const s = makeSources({})
    const push = vi.fn()
    const handle = createLive2dStateSource(s.input, push)
    push.mockClear()
    // 当前业务态 idle；recompose → 重推 idle（同态不重推：push 无新调用）
    handle.recompose()
    expect(push).not.toHaveBeenCalled()
    // 源变化到 happy（瞬态，mood timer 启动）；recompose 保持 happy（不重推，timer 仍在）
    s.emo.value = 'happy'
    push.mockClear()
    handle.recompose()
    expect(push).not.toHaveBeenCalled() // 同态（currentState=happy）不重推
    // 2s 后 mood timer 正常回退（recompose 未破坏 timer 管理）
    vi.advanceTimersByTime(2000)
    expect(push).toHaveBeenLastCalledWith('idle')
    // 退订后 recompose no-op（不抛错、不 push）
    handle.unsub()
    push.mockClear()
    handle.recompose()
    expect(push).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})

describe('createLive2dStateSource 批次 C（C3）：pushDirective 指令建议（建议强度仲裁 + 瞬态 + 覆盖）', () => {
  afterEach(() => { vi.useRealTimers() })

  it('pushDirective 建议强度仲裁：speaking(2) 时 happy(1) 不覆盖；idle(0) 时 happy(1) push', () => {
    const pushes: string[] = []
    const priority = ref(0) // 模拟机器当前优先级（getCurrentPriority 注入）
    const s = makeSources({})
    const src = createLive2dStateSource({ ...s.input, getCurrentPriority: () => priority.value }, (p) => pushes.push(p))
    priority.value = 2
    src.pushDirective('happy', 1, 500)
    expect(pushes).not.toContain('happy')
    priority.value = 0
    src.pushDirective('happy', 1, 500)
    expect(pushes).toContain('happy')
  })

  it('client 2/3 级现实态经 watch 重组合覆盖指令瞬态（真实组合路径）', () => {
    const speaking = ref(false)
    const pushes: string[] = []
    const s = makeSources({})
    const src = createLive2dStateSource(
      { ...s.input, isSpeaking: () => speaking.value, getCurrentPriority: () => (speaking.value ? 2 : 0) },
      (p) => pushes.push(p)
    )
    src.pushDirective('happy', 1, 2000)
    expect(pushes).toContain('happy')
    speaking.value = true // client 进入 speaking → watch 重组合覆盖指令瞬态
    expect(pushes.at(-1)).toBe('speaking')
  })

  it('pushDirective 超时回业务态 + 清既有 emotion timer（fake timers）', () => {
    vi.useFakeTimers()
    const pushes: string[] = []
    const s = makeSources({})
    const src = createLive2dStateSource({ ...s.input, getCurrentPriority: () => 0 }, (p) => pushes.push(p))
    src.pushDirective('happy', 1, 2000)
    expect(pushes).toContain('happy')
    vi.advanceTimersByTime(2100)
    expect(pushes.at(-1)).toBe('idle') // 超时回组合业务态
    vi.useRealTimers()
  })

  it('pushDirective 置入前清既有 mood timer：emotion 先入 happy（mood timer 挂起）→ 指令后旧 timer 不提前打断', () => {
    vi.useFakeTimers()
    const pushes: string[] = []
    const s = makeSources({ emo: 'happy' }) // emotion happy → 初始组合 happy + mood timer(2000) 挂起
    const src = createLive2dStateSource({ ...s.input, getCurrentPriority: () => 0 }, (p) => pushes.push(p))
    expect(pushes.at(-1)).toBe('happy')
    src.pushDirective('sad', 1, 5000) // 指令 sad 5s——置入前清 mood timer
    expect(pushes.at(-1)).toBe('sad')
    vi.advanceTimersByTime(2100) // 若旧 mood timer 未清，此处已 pushRecomposed 打断；实际保持 sad
    expect(pushes.at(-1)).toBe('sad')
    vi.advanceTimersByTime(2900) // 累计 5000 → 指令超时回业务态
    expect(pushes.at(-1)).toBe('idle')
    vi.useRealTimers()
  })

  it('指令瞬态存活期间低优先组合不覆盖：emotion 变 sad（1 级）不覆盖指令 happy；pushDirective 返回置入 boolean', () => {
    vi.useFakeTimers()
    const pushes: string[] = []
    const s = makeSources({})
    const src = createLive2dStateSource({ ...s.input, getCurrentPriority: () => 0 }, (p) => pushes.push(p))
    expect(src.pushDirective('happy', 1, 5000)).toBe(true) // 置入 → true
    expect(pushes.at(-1)).toBe('happy')
    s.emo.value = 'sad' // 低优先(1) mood 源变化 → 组合 sad → 指令瞬态存活 → 不覆盖
    expect(pushes.at(-1)).toBe('happy')
    expect(src.pushDirective('happy', 0.5, 5000)).toBe(true) // strength 0.5 ≥ cur 0 → 仍置入
    vi.useRealTimers()
  })

  it('建议强度不足 pushDirective 返回 false（丢弃）；onDirectiveEnd 在指令超时/2-3 级覆盖时回调', () => {
    vi.useFakeTimers()
    const pushes: string[] = []
    let ended = 0
    const priority = ref(0)
    const s = makeSources({})
    const src = createLive2dStateSource(
      { ...s.input, getCurrentPriority: () => priority.value, onDirectiveEnd: () => { ended++ } },
      (p) => pushes.push(p)
    )
    priority.value = 2 // client speaking
    expect(src.pushDirective('happy', 1, 500)).toBe(false) // 强度不足 → false
    expect(pushes).not.toContain('happy')
    priority.value = 0
    expect(src.pushDirective('happy', 1, 2000)).toBe(true) // 置入
    expect(ended).toBe(0)
    vi.advanceTimersByTime(2100) // 超时 → onDirectiveEnd 回调 + 回业务态
    expect(ended).toBe(1)
    expect(pushes.at(-1)).toBe('idle')
    vi.useRealTimers()
  })
})
