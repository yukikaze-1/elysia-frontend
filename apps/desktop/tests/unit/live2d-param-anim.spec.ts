// tests/unit/live2d-param-anim.spec.ts
// 阶段 5 批次 B（Task 3，B2 待机动画纯函数，spec §3.2 / D5B-02）：blink 序列（随机间隔/闭眼时长/平滑，
// 可注入时钟 + 存在性判定）；breath 纯正弦（存在性判定，不调 CubismBreath，C-1）；mouth 映射（钳制/存在性）。
import { describe, expect, it } from 'vitest'
import {
  blinkTarget,
  breathTarget,
  mouthLevelTarget,
  resetBlinkScheduleCache,
  blinkOpenLevelReference,
  PARAM_EYE_L_OPEN,
  PARAM_EYE_R_OPEN,
  PARAM_ANGLE_Z,
  PARAM_MOUTH_OPEN_Y,
  type AnimClock
} from '../../src/renderer/src/live2d/param-anim'

/** 固定随机源（确定性种子）：同一种子 → 同一眨眼序列 */
function fixedClock(fixed: number): AnimClock {
  return { random: () => fixed }
}

// L8（2026-09-15 Live2D 评审）：眨眼调度从「每帧从 t=0 重放整条时间轴」改为**增量展开 + 二分查询**。
// 这类改动最容易悄悄改掉动画语义（抽样次数错位、时间回退未重建），故用**逐点对拍**把等价性钉住：
// 同一种子/速率下，增量实现与朴素参照实现在整条时间轴上必须**逐点相同**。
describe('L8：眨眼调度增量化的等价性（与朴素参照实现逐点对拍）', () => {
  const SEED_CLOCK = 0.42
  const seed = Math.floor(SEED_CLOCK * 0xffffffff)
  const eyeParams = new Set([PARAM_EYE_R_OPEN])

  it('单调前进的时间轴上逐点一致（2 个速率 × 300s @0.05s 步长）', () => {
    for (const rate of [1, 2]) {
      resetBlinkScheduleCache()   // 两侧各自冷启动，序列从头比
      for (let i = 0; i <= 6000; i++) {
        const t = i * 0.05
        const inc = blinkTarget(t, eyeParams, fixedClock(SEED_CLOCK), rate)[PARAM_EYE_R_OPEN]
        const naive = blinkOpenLevelReference(t, seed, rate)
        expect(inc, `rate=${rate} t=${t}`).toBe(naive)
      }
    }
  })

  it('时间回退（reset/seek）后仍与朴素实现一致——缓存必须重建而不是继续用错位游标', () => {
    resetBlinkScheduleCache()
    // 先跑到 120s（缓存已展开一批窗口），再回退到 30s 逐点比对
    for (let i = 0; i <= 2400; i++) blinkTarget(i * 0.05, eyeParams, fixedClock(SEED_CLOCK), 1)
    for (let i = 0; i <= 600; i++) {
      const t = i * 0.05
      const inc = blinkTarget(t, eyeParams, fixedClock(SEED_CLOCK), 1)[PARAM_EYE_R_OPEN]
      expect(inc, `回退 t=${t}`).toBe(blinkOpenLevelReference(t, seed, 1))
    }
  })

  it('长时间运行（1 小时后）仍逐点一致——这正是修复的动机（旧实现每帧重放 t 秒）', () => {
    resetBlinkScheduleCache()
    // 以 1s 步长推进到 3600s，再在尾部逐点比对（旧实现在此处每帧要模拟约 758 次眨眼）
    for (let t = 0; t <= 3600; t += 1) blinkTarget(t, eyeParams, fixedClock(SEED_CLOCK), 1)
    for (let i = 0; i <= 200; i++) {
      const t = 3600 + i * 0.05
      const inc = blinkTarget(t, eyeParams, fixedClock(SEED_CLOCK), 1)[PARAM_EYE_R_OPEN]
      expect(inc, `长会话 t=${t}`).toBe(blinkOpenLevelReference(t, seed, 1))
    }
  })
})

describe('breathTarget（呼吸正弦）', () => {
  it('含 ParamAngleZ 时返回该参数的正弦（纯 sine，周期 ~2s；t 处与 CubismBreath 公式对齐）', () => {
    const set = new Set([PARAM_ANGLE_Z])
    // value = offset(0) + peak(0.5)*sin(2π·t / cycle(2))
    expect(breathTarget(0, set)[PARAM_ANGLE_Z]).toBeCloseTo(0.5 * Math.sin(0), 6) // t=0 → 0
    expect(breathTarget(0.5, set)[PARAM_ANGLE_Z]).toBeCloseTo(0.5 * Math.sin(Math.PI / 2), 6) // 峰值
    expect(breathTarget(1, set)[PARAM_ANGLE_Z]).toBeCloseTo(0.5 * Math.sin(Math.PI), 6) // 过零
    // 周期 ~2s：t=2 与 t=0 同相
    expect(breathTarget(2, set)[PARAM_ANGLE_Z]).toBeCloseTo(breathTarget(0, set)[PARAM_ANGLE_Z], 6)
    // 值域
    for (let t = 0; t < 10; t += 0.1) {
      expect(Math.abs(breathTarget(t, set)[PARAM_ANGLE_Z])).toBeLessThanOrEqual(0.5 + 1e-9)
    }
  })

  it('不含 ParamAngleZ → 空对象（不调 CubismBreath，C-1；不写未知参数）', () => {
    expect(breathTarget(1, new Set())).toEqual({})
    expect(breathTarget(1, new Set([PARAM_MOUTH_OPEN_Y]))).toEqual({})
  })
})

describe('mouthLevelTarget（口型映射）', () => {
  it('含 ParamMouthOpenY 时映射 level∈[0,1] → 值', () => {
    const set = new Set([PARAM_MOUTH_OPEN_Y])
    expect(mouthLevelTarget(0.5, set)[PARAM_MOUTH_OPEN_Y]).toBe(0.5)
    expect(mouthLevelTarget(0, set)[PARAM_MOUTH_OPEN_Y]).toBe(0)
    expect(mouthLevelTarget(1, set)[PARAM_MOUTH_OPEN_Y]).toBe(1)
  })

  it('越界钳制（level<0→0，level>1→1）', () => {
    const set = new Set([PARAM_MOUTH_OPEN_Y])
    expect(mouthLevelTarget(-0.3, set)[PARAM_MOUTH_OPEN_Y]).toBe(0)
    expect(mouthLevelTarget(1.4, set)[PARAM_MOUTH_OPEN_Y]).toBe(1)
  })

  it('不含 ParamMouthOpenY → 空对象', () => {
    expect(mouthLevelTarget(0.5, new Set())).toEqual({})
    expect(mouthLevelTarget(0.5, new Set([PARAM_ANGLE_Z]))).toEqual({})
  })
})

describe('blinkTarget（眨眼序列）', () => {
  it('含 ParamEyeROpen/LOpen 时返回两眼的眨眼值（可注入固定时钟 → 确定性序列）', () => {
    const set = new Set([PARAM_EYE_R_OPEN, PARAM_EYE_L_OPEN])
    const clock = fixedClock(0.5)
    const out = blinkTarget(0.05, set, clock)
    expect(Object.keys(out).sort()).toEqual([PARAM_EYE_L_OPEN, PARAM_EYE_R_OPEN].sort())
    // 双眼同值（同闭同开）
    expect(out[PARAM_EYE_R_OPEN]).toBe(out[PARAM_EYE_L_OPEN])
  })

  it('不含眼参数 → 空对象', () => {
    expect(blinkTarget(5, new Set(), fixedClock(0.5))).toEqual({})
    expect(blinkTarget(5, new Set([PARAM_ANGLE_Z]), fixedClock(0.5))).toEqual({})
  })

  it('同种子序列稳定（可注入时钟：同 random 值回放一致）；异种子产生不同眨眼相位', () => {
    const set = new Set([PARAM_EYE_R_OPEN, PARAM_EYE_L_OPEN])
    const a1 = blinkTarget(1.23, set, fixedClock(0.5))
    const a2 = blinkTarget(1.23, set, fixedClock(0.5))
    expect(a1).toEqual(a2)
    // 异种子：扫描整段时间的闭眼时刻应不同（两序列选不同相位）
    const closedAt = (seed: number): number[] => {
      const times: number[] = []
      for (let t = 0; t < 15; t += 0.01) {
        if (blinkTarget(t, set, fixedClock(seed))[PARAM_EYE_R_OPEN] < 0.1) times.push(t)
      }
      return times
    }
    expect(closedAt(0.5)).not.toEqual(closedAt(0.9))
  })

  it('序列含睁眼期(1) 与闭眼期(<1)：某时间段扫描可见开/闭两种电平（婴儿式间隔 ~2.5-7s）', () => {
    const set = new Set([PARAM_EYE_R_OPEN, PARAM_EYE_L_OPEN])
    const clock = fixedClock(0.42)
    let sawOpen = false
    let sawClosed = false
    for (let t = 0; t < 20; t += 0.05) {
      const v = blinkTarget(t, set, clock)[PARAM_EYE_R_OPEN]
      if (v === 1) sawOpen = true
      if (v < 0.1) sawClosed = true
    }
    expect(sawOpen).toBe(true)
    expect(sawClosed).toBe(true)
  })

  it('闭眼为短窗口（~150-250ms）：同一次眨眼中 闭眼时长有限（<250ms 量级，连续 <1 不长于 ~250ms）', () => {
    // 逐 5ms 扫描，统计每一次「连读 <1」的持续时长，闭眼窗口应 ~[150,250]ms
    const set = new Set([PARAM_EYE_R_OPEN])
    const clock = fixedClock(0.31)
    let run = 0
    let maxRun = 0
    for (let t = 0; t < 20; t += 0.005) {
      const v = blinkTarget(t, set, clock)[PARAM_EYE_R_OPEN]
      if (v < 1) {
        run += 0.005
        if (run > maxRun) maxRun = run
      } else {
        run = 0
      }
    }
    // 最长连读 <1 的时长 ≲ 闭眼 250ms + 快关慢开过渡（~共 <0.4s 即可接受）
    expect(maxRun).toBeGreaterThan(0.14) // 确实出现闭眼
    expect(maxRun).toBeLessThan(0.45)
  })

  it('F2 rate=2 → 眨眼间隔减半（同 seed 同窗口 blink 触发次数约 2 倍；rate=1 行为不变）', () => {
    const set = new Set([PARAM_EYE_R_OPEN])
    const clock = fixedClock(0.5)
    // 统计窗口内闭眼事件（从睁眼转入 <1 的次数）
    const blinkCount = (rate: number): number => {
      let prev = 1
      let count = 0
      for (let t = 0; t < 24; t += 0.01) {
        const v = blinkTarget(t, set, clock, rate)[PARAM_EYE_R_OPEN]
        if (v < 1 && prev === 1) count++ // 进入闭眼期计一次 blink
        prev = v
      }
      return count
    }
    const c1 = blinkCount(1)
    const c2 = blinkCount(2)
    expect(c1).toBeGreaterThan(2) // 24s 内 rate=1 确有多次眨眼
    // rate=2 间隔等比减半 → 同窗口触发次数约 2 倍（边沿允许 ±1）
    expect(c2).toBeGreaterThanOrEqual(c1 * 2 - 1)
    // rate=1 缺省行为与显式 rate=1 一致（既有节奏不变）
    expect(blinkTarget(1.23, set, clock)).toEqual(blinkTarget(1.23, set, clock, 1))
  })
})
