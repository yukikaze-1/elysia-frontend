import { describe, expect, it } from 'vitest'
import { computeMouthLevel } from '../../src/renderer/src/live2d/mouth-level'

describe('computeMouthLevel（C1 包络纯函数，硬门限语义）', () => {
  it('噪声门限：rms 低于 floor 直接归 0（硬门）', () => {
    expect(computeMouthLevel(0.005, 0.5, { noiseFloor: 0.02, dtMs: 16 })).toBe(0)
  })
  it('attack 快：单帧升幅 < 满幅且明显；多帧逼近 1', () => {
    const one = computeMouthLevel(1, 0, { dtMs: 16, attackMs: 50 })
    expect(one).toBeGreaterThan(0.2)
    expect(one).toBeLessThan(0.5) // 50ms attack 单帧 16ms 不可能满幅
    let l = 0
    for (let i = 0; i < 6; i++) l = computeMouthLevel(1, l, { dtMs: 16, attackMs: 50 })
    expect(l).toBeGreaterThan(0.8)
  })
  it('release 慢：单帧降幅小；多帧归零（rms 取 ==floor 使平滑可观测，硬门限下 rms<floor 直接归 0）', () => {
    const one = computeMouthLevel(0.02, 1, { dtMs: 16, releaseMs: 250 }) // 0.02==floor → 走平滑分支
    expect(one).toBeGreaterThan(0.85) // 0.937
    let l = 1
    for (let i = 0; i < 60; i++) l = computeMouthLevel(0.02, l, { dtMs: 16, releaseMs: 250 })
    expect(l).toBeLessThan(0.05) // ≈0.039
  })
  it('[0,1] 边界钳制', () => {
    expect(computeMouthLevel(2, 0.5, { dtMs: 16 })).toBeLessThanOrEqual(1)
    expect(computeMouthLevel(-1, 0.5, { dtMs: 16 })).toBeGreaterThanOrEqual(0)
  })
})
