// apps/desktop/src/renderer/src/live2d/param-anim.ts
// 阶段 5 批次 B（Task 3，B2 待机动画纯函数，spec §3.2 / D5B-02）：眨眼 / 呼吸正弦 / 口型映射。
//
// 全部为「纯函数」：给定 (tSec, 参数 Id 集, 可注入时钟)，返回「要写的参数→值」的 Record；模型中不含
// 对应参数时返回空对象（存在性判定在函数内完成，Controller 只按返回逐对 setParam）。不依赖 SDK 句柄、
// 不调 Framework `CubismBreath`（C-1：那是针对真实 CubismModel 的 addParameterValueById，且吃真实句柄；
// 本文件按 vendored `effect/cubismbreath.ts` 的正弦公式与数值自行实现纯正弦，经 setParam('ParamAngleZ')
// 由 Controller 写出）。参数 Id 为字符串（doc 05 §2：业务层不 import Cubism 常量）。
//
// 呼吸公式对齐 `effect/cubismbreath.ts:57-67`：value = offset + peak*sin(t/cycle)，其中
// t = currentTime*2π（period = cycle 秒）。本批待机呼吸周期 ~2s → cycle = 2；幅度取 Live2D 样例常用
// offset=0 / peak=0.5（轻微摆头，落在 ParamAngleZ 合法值域）。

/** 可注入时钟（控制待机动画的随机性，保证可复现）：random() 返回 [0,1) 的稳定随机源。
 *  Controller 传入每实例固定的确定性值（同会话稳定回放）；单测注入固定值断言眨眼序列。 */
export interface AnimClock {
  random(): number
}

/** 眨眼收敛时长占比（快关慢开，婴儿式）：前 20% 快闭眼、中段 60% 完全闭合、后 20% 慢睁眼 */
const CLOSE_FAST = 0.2
const OPEN_SLOW_END = 0.8

/** 呼吸正弦（对齐 CubismBreath 公式）：value = offset + peak*sin(t/cycle)，t = 2π*currentTime */
const BREATH_OFFSET = 0
const BREATH_PEAK = 0.5
const BREATH_CYCLE_SEC = 2 // 周期 ~2s

// —— 常用 Cubism 参数 Id（字符串跨层传递，doc 05 §2）——
export const PARAM_EYE_R_OPEN = 'ParamEyeROpen'
export const PARAM_EYE_L_OPEN = 'ParamEyeLOpen'
export const PARAM_ANGLE_Z = 'ParamAngleZ'
export const PARAM_ANGLE_X = 'ParamAngleX'
export const PARAM_MOUTH_OPEN_Y = 'ParamMouthOpenY'
export const PARAM_EYE_R_SMILE = 'ParamEyeRSmile'
export const PARAM_EYE_L_SMILE = 'ParamEyeLSmile'
export const PARAM_EYE_BALL_X = 'ParamEyeBallX'
export const PARAM_EYE_BALL_Y = 'ParamEyeBallY'

/** mulberry32：确定性伪随机（seeded PRNG）。使同一种子下的眨眼间隔/闭眼时长序列稳定可复现（单测注入固定
 *  seed 即断言「随机间隔 ~2.5-7s + 短闭眼 ~150-250ms」的确定序列）。 */
function mulberry32(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 眨眼序列（婴儿式）：驱动全部在 `paramIds` 中暴露的 `ParamEye{R,L}Open`。
 * 随机间隔 ~[2.5,7)s + 短闭眼 ~[150,250)ms + 快关慢开（fast close / slow open）。
 * 返回 { ParamEyeROpen?: v, ParamEyeLOpen?: v }（存在者）；双眼同闭同开。`paramIds` 不含任何眼参数 → {}。
 * F2（批次 C 收口）：扩 `rate`（缺省 1）——thinking/speaking 由 Controller 传 >1（如 2），睁眼间隔等比
 * 缩短（rate=2 → 间隔 ~[1.25,3.5)s，代批次 B 固定 2.5-7s；批次 B F2「thinking 眨眼加快」落地）。
 * @param tSec 当前时间（秒）
 * @param paramIds 模型参数 Id 集（getParameterIdList）
 * @param clock 随机源（同种子 → 同序列；单测注入固定值）
 * @param rate 眨眼速率倍数（>1 加快；缺省 1 保持批次 B 既有节奏）
 */
export function blinkTarget(tSec: number, paramIds: ReadonlySet<string>, clock: AnimClock, rate = 1): Record<string, number> {
  const eyeParams: string[] = []
  if (paramIds.has(PARAM_EYE_R_OPEN)) eyeParams.push(PARAM_EYE_R_OPEN)
  if (paramIds.has(PARAM_EYE_L_OPEN)) eyeParams.push(PARAM_EYE_L_OPEN)
  if (eyeParams.length === 0) return {}
  const open = blinkOpenLevel(tSec, Math.floor(clock.random() * 0xffffffff), rate)
  const out: Record<string, number> = {}
  for (const p of eyeParams) out[p] = open
  return out
}

/**
 * 呼吸正弦：仅当 `paramIds` 含 `ParamAngleZ` 时返回 { ParamAngleZ: offset + peak*sin(2π·t/cycle) }；
 * 否则 {}（纯 sine，不调 CubismBreath，C-1）。周期 ~2s（cycle=2）。
 */
export function breathTarget(tSec: number, paramIds: ReadonlySet<string>): Record<string, number> {
  if (!paramIds.has(PARAM_ANGLE_Z)) return {}
  const t = (2 * Math.PI * tSec) / BREATH_CYCLE_SEC
  return { [PARAM_ANGLE_Z]: BREATH_OFFSET + BREATH_PEAK * Math.sin(t) }
}

/**
 * 口型映射：level∈[0,1] → 钳制后写 `ParamMouthOpenY`（存在时）；否则 {}。
 * 平滑由参数写层（Controller 逐帧 setParam 自然累计）处理，本函数只做数值映射与钳制。
 */
export function mouthLevelTarget(level: number, paramIds: ReadonlySet<string>): Record<string, number> {
  if (!paramIds.has(PARAM_MOUTH_OPEN_Y)) return {}
  const v = Math.min(1, Math.max(0, level))
  return { [PARAM_MOUTH_OPEN_Y]: v }
}

/** 眨眼处于闭眼序列时的「睁开程度」（0=闭合，1=全开）：快关慢开。 */
function closedLevel(progress: number): number {
  if (progress < CLOSE_FAST) {
    return Math.max(0, 1 - progress / CLOSE_FAST) // 前 20% 快闭眼（1→0）
  }
  if (progress < OPEN_SLOW_END) {
    return 0 // 中段 60% 完全闭合
  }
  return Math.min(1, (progress - OPEN_SLOW_END) / (1 - OPEN_SLOW_END)) // 后 20% 慢睁眼（0→1）
}

/**
 * 由确定种子随时间回放眨眼调度：从 t=0 步进（随机间隔 ~[2.5,7)s、闭眼 ~[150,250)ms），
 * 给定 tSec 落在睁眼期 → 1；落在闭眼窗口 → closedLevel(progress)（快关慢开）。同一 seed 任意 tSec 复现一致。
 * F2（批次 C）：`rate` 等比缩短睁眼间隔（闭眼时长不变——眨一次的实际闭眼时间不因频率变化）。
 */
function blinkOpenLevel(tSec: number, seed: number, rate: number): number {
  const rng = mulberry32(seed)
  let time = 0
  // 第一步为睁眼期：随机睁眼间隔后进入第一次闭眼
  while (true) {
    const interval = (2.5 + rng() * 4.5) / rate // rate=1 保持 ~[2.5, 7)s；rate=2 → ~[1.25, 3.5)s
    time += interval
    if (time > tSec) return 1 // 落在睁眼期
    const closed = 0.15 + rng() * 0.1 // ~[150, 250)ms
    if (tSec <= time + closed) {
      return closedLevel((tSec - time) / closed)
    }
    time += closed // 已完成本次眨眼，回到睁眼期继续
  }
}
