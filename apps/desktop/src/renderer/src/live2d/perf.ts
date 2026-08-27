// apps/desktop/src/renderer/src/live2d/perf.ts
// 阶段 5 批次 C（C2，spec §3.2/D5C-03）：FrameBudget——四值性能模式的帧预算门（纯逻辑类，注入时钟）。
// 语义：controller.tick 内先过 budget.shouldDraw(now)，skip 帧（返回 false）时整段动画+draw 原子跳过
// （不 updateAnimation、不 adapter.update、不产生 draw）。
// 首帧必画：lastDrawMs 构造时初始化为 now，首次 shouldDraw 恒 true；EMA 初值 = 首样本。
// 规则：quality=恒 draw（满帧）；low_power=距上次 draw ≥33.33ms（30fps 封顶）；balanced=按 EMA 帧耗时在
// 60/30 间切换（cost<8 → 16.67ms 间隔，否则 33.33ms）；auto=带迟滞自选（emaCost>16 连续 ≥12 帧 → 30fps；
// emaCost<8 连续 ≥12 帧 → 60fps；初 60fps）。窗口可见性因子由 store setVisibility 门覆盖（D5C-05），本类
// 只做帧耗时维度。
import type { PerformanceMode } from '@shared/contracts'

/** 阈值与窗口常数（spec 缺省；批次 C 定案） */
const LOW_POWER_INTERVAL_MS = 33.33 // low_power 30fps 封顶
const BALANCED_FAST_MS = 16.67 // 60fps 帧间隔
const BALANCED_SLOW_MS = 33.33 // 30fps 帧间隔
const BALANCED_COST_FAST_THRESHOLD = 8 // balanced：cost < 8ms → 60fps
const AUTO_SLOW_COST = 16 // auto：emaCost > 16ms → 降 30fps
const AUTO_FAST_COST = 8 // auto：emaCost < 8ms → 升 60fps
const AUTO_STREAK_FRAMES = 12 // auto：连续 N 帧（feedCost 统计）满足阈值才升降档（迟滞防抖）

/** C2 四值降帧：纯逻辑状态机（注入时钟可单测确定性驱动）。 */
export class FrameBudget {
  private mode: PerformanceMode
  private lastDrawMs: number
  private emaCost = 0
  private first = true
  private autoTarget = 60 // auto 当前目标帧率（60|30）
  private slowStreak = 0 // auto：连续高耗时帧计数（经 feedCost 统计）
  private fastStreak = 0 // auto：连续低耗时帧计数

  constructor(mode: PerformanceMode, now?: number) {
    this.mode = mode
    this.lastDrawMs = now ?? performance.now() // 首帧必画：lastDrawMs 构造时初始化为 now
  }

  /** 是否应画本帧：false = skip（controller.tick 内原子跳过动画+draw）。首帧恒 true；命中 draw 更新 lastDrawMs。 */
  shouldDraw(now: number): boolean {
    if (this.first) {
      this.first = false
      this.lastDrawMs = now
      return true
    }
    const interval = this.targetIntervalMs()
    const draw = interval === 0 || now - this.lastDrawMs >= interval
    if (draw) this.lastDrawMs = now
    return draw
  }

  /** 当前目标帧间隔（ms）；quality = 0（恒 draw）。 */
  private targetIntervalMs(): number {
    switch (this.mode) {
      case 'quality':
        return 0
      case 'low_power':
        return LOW_POWER_INTERVAL_MS
      case 'balanced':
        return this.emaCost < BALANCED_COST_FAST_THRESHOLD ? BALANCED_FAST_MS : BALANCED_SLOW_MS
      case 'auto':
        return this.autoTarget === 60 ? BALANCED_FAST_MS : BALANCED_SLOW_MS
    }
  }

  /** 喂实际帧耗时（controller.tick 每 draw 帧调用一次）：EMA 一阶平滑（初值 = 首样本）；auto 按 EMA 计数迟滞升降档。 */
  feedCost(costMs: number): void {
    this.emaCost = this.emaCost === 0 ? costMs : this.emaCost * 0.8 + costMs * 0.2
    if (this.mode !== 'auto') return
    if (this.emaCost > AUTO_SLOW_COST) {
      this.slowStreak++
      this.fastStreak = 0
    } else if (this.emaCost < AUTO_FAST_COST) {
      this.fastStreak++
      this.slowStreak = 0
    } else {
      this.slowStreak = 0
      this.fastStreak = 0
    }
    if (this.slowStreak >= AUTO_STREAK_FRAMES) {
      this.autoTarget = 30
      this.slowStreak = 0
    } else if (this.fastStreak >= AUTO_STREAK_FRAMES) {
      this.autoTarget = 60
      this.fastStreak = 0
    }
  }

  /** 热切换模式：重置 autoTarget/streaks/first（下次 shouldDraw 必画——首帧语义）。 */
  setMode(mode: PerformanceMode): void {
    this.mode = mode
    this.autoTarget = 60
    this.slowStreak = 0
    this.fastStreak = 0
    this.first = true
  }

  /** 性能读数（7D）：暴露帧耗时 EMA + 目标帧率 + 模式——诊断页「Live2D 性能」数据源。 */
  getStats(): { emaCostMs: number; autoTargetFps: number | null; mode: PerformanceMode } {
    return { emaCostMs: this.emaCost, autoTargetFps: this.mode === 'auto' ? this.autoTarget : null, mode: this.mode }
  }
}
