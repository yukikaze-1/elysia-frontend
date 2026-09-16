// renderer/src/live2d/directive-rules.ts
// 后端 Live2D 表现指令的**校验与脱敏规则**（无 Vue / 无 Pinia / 无 controller）。
//
// 为什么单独存在：`handleDirective` 里「哪些载荷合法、越界怎么夹、拒绝时留什么痕」是一组纯规则
// （state 七值白名单、priority clamp、durationMs 区间、空载荷拒绝、日志只记 code 不记正文），
// 但它此前与 controller 调用、stateSource push 混在一个方法里，只有整棵 live2d store 集成用例
// 能到达。规则下沉后可以逐条独立钉住，尤其「越界值必须被夹而不是被透传」这类安全面。
//
// 依赖方向：本模块不 import controller / store，只产出**判定结果**，副作用仍由 store 执行。
import type { DirectiveState } from '@shared/contracts'

/** C3：DirectiveState 七值（剔除 error——error=3 必须 client 驱动，D5C-07）；越界（如 'error'/'working'）丢弃 */
export const DIRECTIVE_STATES: ReadonlySet<string> = new Set<DirectiveState>([
  'idle', 'listening', 'thinking', 'speaking', 'happy', 'sad', 'surprised'
])

/** 建议强度上界：指令永不覆盖 client 2/3 级现实态（D5C-07）。 */
export const DIRECTIVE_MAX_PRIORITY = 1

/** durationMs 上界（与后端建议范围一致）。 */
export const DIRECTIVE_MAX_DURATION_MS = 30_000

export type DirectiveRejection = 'directive_invalid'

/**
 * 拒绝原因：越界 `state`（契约漂移）与空载荷是两回事——运维侧要能分清该改谁，
 * 故判据把原因带出来，warn 文案由 store 决定（本模块不写日志、不碰控制台）。
 */
export type DirectiveRejectionReason = 'state-out-of-range' | 'empty-payload'

export type DirectiveDecision =
  | { accepted: false; code: DirectiveRejection; reason: DirectiveRejectionReason }
  | {
      accepted: true
      /** 校验后的指令态（缺省 = 本条不带 state）；已夹到 [0,1] */
      state: DirectiveState | undefined
      priority: number
      durationMs: number | undefined
      /** 白名单未命中的 expression 由 store 记 `directive_miss` 并跳过 */
      expression: string | undefined
      motion: string | undefined
    }

export interface DirectivePayload {
  state?: DirectiveState
  priority?: number
  durationMs?: number
  expression?: string
  motion?: string
}

/**
 * 校验一条后端指令建议。
 *
 * 三条拒绝/收敛规则：
 *   ① `state` 越界（'error' / 'working' / 未知串）→ **整条丢弃**（不是忽略该字段）：一条带着
 *      越界状态的指令说明后端与前端对「建议态」的定义已经漂移，按部分载荷执行会把漂移静默化；
 *   ② `priority` 夹到 ≤1、`durationMs` 夹到 [0, 30000]：越界值只夹不透传，避免一条建议长期占住画面；
 *   ③ 三个字段全缺 → 无有效载荷，丢弃。
 */
export function decideDirective(event: DirectivePayload): DirectiveDecision {
  const { state } = event
  if (state !== undefined && !DIRECTIVE_STATES.has(state)) {
    return { accepted: false, code: 'directive_invalid', reason: 'state-out-of-range' }
  }
  if (state === undefined && event.expression === undefined && event.motion === undefined) {
    return { accepted: false, code: 'directive_invalid', reason: 'empty-payload' }
  }
  return {
    accepted: true,
    state,
    priority: Math.min(DIRECTIVE_MAX_PRIORITY, event.priority ?? 0),
    durationMs: event.durationMs === undefined
      ? undefined
      : Math.min(DIRECTIVE_MAX_DURATION_MS, Math.max(0, event.durationMs)),
    expression: event.expression,
    motion: event.motion
  }
}
