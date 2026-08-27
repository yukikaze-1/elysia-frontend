// tests/unit/perf.spec.ts
// 阶段 5 批次 C（C2，spec §3.2/D5C-03）：FrameBudget 纯逻辑——四值降帧 + 首帧必画 + 迟滞 + setMode 热切换。
// 注入时钟（构造 now + shouldDraw(now) 显式时间），断言逐帧 skip/draw 语义。
import { describe, expect, it } from 'vitest'
import { FrameBudget } from '../../src/renderer/src/live2d/perf'

describe('FrameBudget（C2 四值降帧；首帧必画，lastDrawMs 初值=构造 now）', () => {
  it('quality 恒 draw', () => {
    const b = new FrameBudget('quality', 0)
    expect(b.shouldDraw(0)).toBe(true)
    expect(b.shouldDraw(16)).toBe(true)
  })

  it('low_power 30fps 封顶：首帧必画，之后 ≥33ms 才 draw', () => {
    const b = new FrameBudget('low_power', 0)
    expect(b.shouldDraw(0)).toBe(true)   // 首帧
    expect(b.shouldDraw(20)).toBe(false) // 距首帧 20ms < 33
    expect(b.shouldDraw(40)).toBe(true)  // ≥33ms
  })

  it('balanced 按 cost 在 60/30 间切（首帧后按目标间隔）', () => {
    const b = new FrameBudget('balanced', 0)
    expect(b.shouldDraw(0)).toBe(true)   // 首帧
    b.feedCost(12)                        // 高耗时 → 30fps
    expect(b.shouldDraw(20)).toBe(false)  // 距首帧 20ms < 33
    b.feedCost(3); b.feedCost(3); b.feedCost(3) // 低耗时 → 60fps
    expect(b.shouldDraw(50)).toBe(true)   // 距首帧 50ms ≥ 16.67
  })

  it('auto 迟滞升降档 + setMode 热切换', () => {
    const b = new FrameBudget('auto', 0)
    expect(b.shouldDraw(0)).toBe(true)
    for (let i = 0; i < 12; i++) b.feedCost(20) // 持续高耗时 → 降 30fps
    expect(b.shouldDraw(30)).toBe(false)
    b.setMode('quality')
    expect(b.shouldDraw(30)).toBe(true)
  })

  it('auto 迟滞：不足 12 帧高耗时不降档；低耗时累计 12 帧升回 60fps', () => {
    const b = new FrameBudget('auto', 0)
    expect(b.shouldDraw(0)).toBe(true)
    // 11 帧高耗时（< 12）→ 仍在 60fps（16.67ms 间隔）
    for (let i = 0; i < 11; i++) b.feedCost(20)
    expect(b.shouldDraw(30)).toBe(true) // 30ms ≥ 16.67（未降档），lastDrawMs=30
    // 第 12 帧高耗时 → 降 30fps
    b.feedCost(20)
    expect(b.shouldDraw(50)).toBe(false) // 50-30=20 < 33.33（已降档）
    // 连续低耗时（EMA 经一阶平滑前 4 帧仍 >8，第 5 帧起 <8 并累计 12 帧）→ 升回 60fps
    for (let i = 0; i < 16; i++) b.feedCost(2)
    expect(b.shouldDraw(100)).toBe(true) // 100-50=50 ≥ 16.67（升回 60fps）
  })

  it('EMA 初值 = 首样本（feedCost 首个 c 直接赋值）', () => {
    const b = new FrameBudget('balanced', 0)
    b.shouldDraw(0) // 首帧
    b.feedCost(20) // 首样本 → emaCost=20（非 20*0.8=16）
    expect(b.shouldDraw(20)).toBe(false) // 20<8? 否 → 30fps 间隔 33.33；20<33 → skip
    b.feedCost(1) // emaCost = 20*0.8 + 1*0.2 = 16.2
    b.feedCost(1) // emaCost = 16.2*0.8 + 0.2 = 13.16
    b.feedCost(1) // emaCost = 13.16*0.8 + 0.2 = 10.73
    b.feedCost(1) // emaCost = 10.73*0.8 + 0.2 = 8.78
    b.feedCost(1) // emaCost = 8.78*0.8 + 0.2 = 7.22 < 8 → 60fps
    expect(b.shouldDraw(40)).toBe(true) // 40-0=40 ≥ 16.67 → draw
  })

  it('首帧后 lastDrawMs 更新：low_power 40ms 画帧后再 33ms 内 skip', () => {
    const b = new FrameBudget('low_power', 0)
    b.shouldDraw(0) // 首帧 lastDrawMs=0
    expect(b.shouldDraw(40)).toBe(true) // draw，lastDrawMs=40
    expect(b.shouldDraw(60)).toBe(false) // 60-40=20 < 33.33
    expect(b.shouldDraw(74)).toBe(true) // 74-40=34 ≥ 33.33
  })

  it('getStats（7D）：暴露 emaCostMs/autoTargetFps/mode（auto 模式目标帧率；非 auto 为 null）', () => {
    const b = new FrameBudget('auto', 0)
    b.shouldDraw(0) // 首帧
    for (let i = 0; i < 12; i++) b.feedCost(20) // 持续高耗时 → 降 30fps
    const s = b.getStats()
    expect(s.mode).toBe('auto')
    expect(s.autoTargetFps).toBe(30)
    expect(s.emaCostMs).toBeGreaterThan(0)
    b.setMode('balanced')
    const s2 = b.getStats()
    expect(s2.mode).toBe('balanced')
    expect(s2.autoTargetFps).toBeNull() // 非 auto 为 null
  })
})
