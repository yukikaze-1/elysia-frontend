// tests/unit/live2d-state.spec.ts
// 阶段 5 批次 B（Task 3，B1 状态机，spec §3.1）：CharacterStateMachine 收敛表全转移——thinking→speaking→idle、
// error 打断、低不打断 3 级、同态幂等、结束回正确回退态（非一律 idle）、listening/working/waiting_permission
// 槽位存在但驱动源 null。纯逻辑（无 Pinia/SDK），node 直接驱动。
import { describe, expect, it } from 'vitest'
import { CharacterStateMachine, type CharacterState } from '../../src/renderer/src/live2d/state-machine'

const ALL_STATES: CharacterState[] = [
  'offline', 'idle', 'listening', 'thinking', 'speaking',
  'waiting_permission', 'working', 'happy', 'sad', 'surprised', 'error'
]

describe('CharacterStateMachine 优先级/业务态模型', () => {
  it('11 态枚举全定义 + priority 有界', () => {
    expect(ALL_STATES).toHaveLength(11)
    const seen = new Set(ALL_STATES)
    expect(seen.size).toBe(11)
    for (const s of ALL_STATES) {
      const mm = new CharacterStateMachine()
      mm.setState(s)
      expect([0, 1, 2, 3]).toContain(mm.priority)
    }
  })

  it('listening/working/waiting_permission 槽位存在且结束回退正确回退态（驱动源 null 归批次 B）', () => {
    // 槽位态可经 setState 落进（槽位 + 优先级/回退定义完备，本批无触发源，不接线不验收——D5B-04）
    const cases: Array<[CharacterState, (m: CharacterStateMachine) => void]> = [
      ['listening', (m) => m.setState('listening')],
      ['working', (m) => m.setState('working')],
      ['waiting_permission', (m) => m.setState('waiting_permission')]
    ]
    for (const [s, enter] of cases) {
      const m = new CharacterStateMachine('idle')
      enter(m)
      expect(m.state).toBe(s)
    }
    // 事件位（阶段6 驱动入口）亦定义：进入 + 结束回退
    const mw = new CharacterStateMachine('idle')
    mw.onEvent('working_start')
    expect(mw.state).toBe('working')
    mw.onEvent('working_end')
    expect(mw.state).toBe('idle')
    const mp = new CharacterStateMachine('idle')
    mp.onEvent('waiting_permission_start')
    expect(mp.state).toBe('waiting_permission')
    mp.onEvent('waiting_permission_end')
    expect(mp.state).toBe('idle')
    const ml = new CharacterStateMachine('idle')
    ml.onEvent('listening_start')
    expect(ml.state).toBe('listening')
    ml.onEvent('listening_end')
    expect(ml.state).toBe('idle')
  })
})

describe('CharacterStateMachine 收敛表（spec §3.1）', () => {
  it('thinking→speaking→idle（生成开始→首个正文→生成完成）', () => {
    const m = new CharacterStateMachine('idle')
    m.onEvent('generation_started')
    expect(m.state).toBe('thinking')
    m.onEvent('first_content')
    expect(m.state).toBe('speaking')
    m.onEvent('generation_completed')
    expect(m.state).toBe('idle')
  })

  it('tts_start 进入 speaking；tts_stop 回 idle', () => {
    const m = new CharacterStateMachine('idle')
    m.onEvent('tts_start')
    expect(m.state).toBe('speaking')
    m.onEvent('tts_stop')
    expect(m.state).toBe('idle')
  })

  it('error 打断（3 级可打断 2 级）；error_clear 回正确回退态（speaking，非一律 idle）', () => {
    const m = new CharacterStateMachine('idle')
    m.onEvent('generation_started')
    m.onEvent('first_content') // speaking
    expect(m.state).toBe('speaking')
    m.onEvent('error')
    expect(m.state).toBe('error')
    m.onEvent('error_clear')
    expect(m.state).toBe('speaking') // 回原业务态，非一律 idle
  })

  it('error 打断情绪态（happy→error→error_clear 回 idle 基底——happy 下无更深业务态）', () => {
    const m = new CharacterStateMachine('idle')
    m.onEvent('mood_happy')
    expect(m.state).toBe('happy')
    m.onEvent('error')
    expect(m.state).toBe('error')
    m.onEvent('error_clear')
    expect(m.state).toBe('idle') // happy 的业务基底是 idle
  })

  it('低不打断 3 级：speaking/thinking(2) 激活时 mood(1) 丢弃', () => {
    const m = new CharacterStateMachine('idle')
    m.onEvent('generation_started') // thinking (2)
    m.onEvent('mood_happy') // 1 < 2 → 丢弃
    expect(m.state).toBe('thinking')
    m.onEvent('first_content') // speaking (2)
    m.onEvent('mood_surprised') // 1 < 2 → 丢弃
    expect(m.state).toBe('speaking')
  })

  it('低不打断 3 级：error(3) 激活时 speaking(2)/mood(1)/thinking(2) 均不打断', () => {
    const m = new CharacterStateMachine('idle')
    m.onEvent('error')
    expect(m.state).toBe('error')
    m.onEvent('generation_started')
    m.onEvent('first_content')
    m.onEvent('mood_happy')
    expect(m.state).toBe('error') // 全部被 3 级拦下
    m.onEvent('error_clear')
    expect(m.state).toBe('idle') // 回到 error 前业务基底
  })

  it('同态幂等：同态重复事件不重触发（状态保持、无异常）', () => {
    const m = new CharacterStateMachine('idle')
    m.onEvent('generation_started')
    m.onEvent('generation_started')
    expect(m.state).toBe('thinking')
    m.onEvent('first_content')
    m.onEvent('first_content')
    expect(m.state).toBe('speaking')
    // 情绪同态幂等
    const m2 = new CharacterStateMachine('idle')
    m2.onEvent('mood_happy')
    m2.onEvent('mood_happy')
    expect(m2.state).toBe('happy')
  })

  it('同/更高优先级可打断：mood(1) 同优先互转（happy→sad）、低优先态被高优先打断（idle→thinking）', () => {
    const m = new CharacterStateMachine('idle')
    m.onEvent('mood_happy')
    m.onEvent('mood_sad') // 同优先 1 == 1 → 可打断
    expect(m.state).toBe('sad')
    const m2 = new CharacterStateMachine('idle')
    m2.onEvent('first_content') // 0→2 可打断
    expect(m2.state).toBe('speaking')
  })

  it('disconnect→offline；reconnect→idle', () => {
    const m = new CharacterStateMachine('idle')
    m.onEvent('disconnect')
    expect(m.state).toBe('offline')
    m.onEvent('reconnect')
    expect(m.state).toBe('idle')
  })

  it('disconnect 可打断一切（含 3 级 error）→ offline', () => {
    const m = new CharacterStateMachine('idle')
    m.onEvent('generation_started')
    m.onEvent('error')
    m.onEvent('disconnect')
    expect(m.state).toBe('offline')
  })

  it('endif 回正确回退态链：speaking(2) 被 error(3) 打断 → working(阶段6 槽位) 不打断 error → error_clear 回 speaking', () => {
    const m = new CharacterStateMachine('idle')
    m.onEvent('first_content') // speaking
    m.onEvent('error')
    m.onEvent('working_start') // 2 < 3 → 丢弃
    expect(m.state).toBe('error')
    m.onEvent('error_clear')
    expect(m.state).toBe('speaking')
  })

  it('generation_completed 从 thinking 结束回 idle（思维态直接结束）', () => {
    const m = new CharacterStateMachine('idle')
    m.onEvent('generation_started')
    expect(m.state).toBe('thinking')
    m.onEvent('generation_completed')
    expect(m.state).toBe('idle')
  })

  it('working/waiting_permission 槽位事件定义（阶段6 驱动位）：进入与结束回退', () => {
    const m = new CharacterStateMachine('idle')
    m.onEvent('working_start')
    expect(m.state).toBe('working')
    m.onEvent('working_end')
    expect(m.state).toBe('idle')
    const m2 = new CharacterStateMachine('idle')
    m2.onEvent('waiting_permission_start')
    expect(m2.state).toBe('waiting_permission')
    m2.onEvent('waiting_permission_end')
    expect(m2.state).toBe('idle')
  })

  it('setState（Controller 入口）直接落进状态源已仲裁态；从 error 切回 speaking 自然清除', () => {
    const m = new CharacterStateMachine('idle')
    m.setState('thinking')
    expect(m.state).toBe('thinking')
    m.setState('error')
    expect(m.state).toBe('error')
    m.setState('speaking')
    expect(m.state).toBe('speaking') // source 已仲裁，直接采纳
    // 同态幂等
    m.setState('speaking')
    expect(m.state).toBe('speaking')
  })
})
