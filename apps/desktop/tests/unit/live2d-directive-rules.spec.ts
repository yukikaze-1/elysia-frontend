// tests/unit/live2d-directive-rules.spec.ts
// `live2d/directive-rules` 的判别力测试：后端 Live2D 表现指令的校验与夹取规则。
//
// 这批规则决定「后端的建议有多大的权限」——state 七值白名单把 `error` 挡在客户端之外（D5C-07），
// priority 夹到 ≤1 保证指令永不覆盖 client 2/3 级现实态，durationMs 夹到 [0,30000] 防一条建议长期占画面。
// 此前它们混在 store.handleDirective 里，只能经整棵 live2d store 集成用例到达。
import { describe, expect, it } from 'vitest'
import type { DirectiveState } from '../../src/shared/contracts'
import {
  DIRECTIVE_MAX_DURATION_MS,
  DIRECTIVE_MAX_PRIORITY,
  DIRECTIVE_STATES,
  decideDirective
} from '../../src/renderer/src/live2d/directive-rules'

describe('DIRECTIVE_STATES：七值白名单不含 error', () => {
  it('恰好七个值，且不含 error（error=3 必须 client 驱动）', () => {
    expect([...DIRECTIVE_STATES].sort()).toEqual(
      ['happy', 'idle', 'listening', 'sad', 'speaking', 'surprised', 'thinking']
    )
    expect(DIRECTIVE_STATES.has('error')).toBe(false)
  })
})

describe('decideDirective：拒绝路径', () => {
  it.each([
    ['error（必须 client 驱动）', { state: 'error' as unknown as DirectiveState }],
    ['working（不在七值内）', { state: 'working' as unknown as DirectiveState }],
    ['未知字符串', { state: 'dancing' as unknown as DirectiveState }],
    ['空串', { state: '' as unknown as DirectiveState }]
  ])('越界 state 丢弃**整条**（不是忽略该字段）：%s', (_label, event) => {
    // 同时带合法 expression：仍必须整条拒绝——带着越界状态的指令说明双方定义已漂移。
    // `reason` 把「契约漂移」与「空载荷」分开，供 store 留不同的痕（诊断时能分清该改谁）。
    expect(decideDirective({ ...event, expression: 'smile' }))
      .toEqual({ accepted: false, code: 'directive_invalid', reason: 'state-out-of-range' })
  })

  it('三个字段全缺 → 无有效载荷，丢弃', () => {
    expect(decideDirective({})).toEqual({ accepted: false, code: 'directive_invalid', reason: 'empty-payload' })
  })

  it('只有 priority（无 state/expression/motion）→ 丢弃（priority 本身不是载荷）', () => {
    expect(decideDirective({ priority: 1 })).toEqual({ accepted: false, code: 'directive_invalid', reason: 'empty-payload' })
  })
})

describe('decideDirective：接受路径与夹取', () => {
  it('合法 state 原样通过，priority 缺省为 0', () => {
    expect(decideDirective({ state: 'listening' })).toMatchObject({
      accepted: true,
      state: 'listening',
      priority: 0,
      durationMs: undefined
    })
  })

  it('priority 夹到 ≤1：越界（含负数）只夹不透传', () => {
    expect(decideDirective({ state: 'happy', priority: 3 })).toMatchObject({ accepted: true, priority: DIRECTIVE_MAX_PRIORITY })
    expect(decideDirective({ state: 'happy', priority: 1 })).toMatchObject({ accepted: true, priority: 1 })
    expect(decideDirective({ state: 'happy', priority: -5 })).toMatchObject({ accepted: true, priority: -5 })
    expect(decideDirective({ state: 'happy', priority: 0.5 })).toMatchObject({ accepted: true, priority: 0.5 })
  })

  it('durationMs 夹到 [0, 30000]', () => {
    expect(decideDirective({ state: 'happy', durationMs: 99_999 })).toMatchObject({ durationMs: DIRECTIVE_MAX_DURATION_MS })
    expect(decideDirective({ state: 'happy', durationMs: -1 })).toMatchObject({ durationMs: 0 })
    expect(decideDirective({ state: 'happy', durationMs: 0 })).toMatchObject({ durationMs: 0 })
    expect(decideDirective({ state: 'happy', durationMs: 1500 })).toMatchObject({ durationMs: 1500 })
  })

  it('只有 expression 也接受（无 state ⇒ state 为 undefined，不参与 pushDirective）', () => {
    expect(decideDirective({ expression: 'smile' })).toMatchObject({
      accepted: true,
      state: undefined,
      expression: 'smile',
      priority: 0
    })
  })

  it('只有 motion 也接受', () => {
    expect(decideDirective({ motion: 'tap_body.motion3.json' })).toMatchObject({
      accepted: true,
      state: undefined,
      motion: 'tap_body.motion3.json'
    })
  })

  it('state + expression + motion 同时给出时全部通过（顺序由 store 决定，不改写载荷）', () => {
    expect(decideDirective({ state: 'speaking', expression: 'happy', motion: 'm.json', priority: 2, durationMs: 40000 }))
      .toMatchObject({
        accepted: true,
        state: 'speaking',
        expression: 'happy',
        motion: 'm.json',
        priority: 1,
        durationMs: 30000
      })
  })

  it('判定是纯函数：同一输入两次结果相同，且不修改入参', () => {
    const event = { state: 'happy' as DirectiveState, priority: 9, durationMs: 999_999 }
    const snapshot = { ...event }
    expect(decideDirective(event)).toEqual(decideDirective(event))
    expect(event).toEqual(snapshot)
  })
})
