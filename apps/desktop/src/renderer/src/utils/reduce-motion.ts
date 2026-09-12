// src/renderer/src/utils/reduce-motion.ts
//
// M-24（2026-09-12，全量评审）：`prefers-reduced-motion` 此前**零支持**，且项目自有的
// 「减少动态」开关只门控 Live2D（`settings.live2d.reduceMotion` → 鼠标跟随/点击动作），
// 而 renderer 里有 6 处 `animation: … infinite` 的持续动画**完全不受任何门控**。
// doc 03 §14 的「动画提供减少动态效果选项」因此长期未被满足。
//
// 判据：**操作系统偏好 ∨ 应用自有开关** ⇒ 根元素带 `cy-reduce-motion` 类，
// 由 `reduced-motion.css` 用 `html.cy-reduce-motion …` 前缀（特异性高于组件 scoped 规则）
// 把这些持续动画关掉。两个来源都走同一个类，是为了让 CSS 只有一处、且不依赖 `!important`。
//
// 为什么不用纯 CSS 的 `@media (prefers-reduced-motion: reduce)`：组件 scoped 样式会给选择器
// 加 `[data-v-xxx]` 属性选择器，媒体查询里的规则若不带类前缀，特异性必然低于它（例如
// `.cy-tool-status.is-running .cy-tool-dot[data-v-x]` 是 4 个类级），要压过就只能上 `!important`。
// 故媒体查询只作**输入**，由本模块折算成根类。
//
// 本模块刻意**不 import 任何 store**：它保持纯函数 + 注入依赖，便于单测（也避免 utils→stores
// 的反向依赖，见 store-graph 门禁）。store 接线放在组合根 `main.ts`。

/** 根元素上的门控类名（`reduced-motion.css` 以此为选择器前缀） */
export const REDUCE_MOTION_CLASS = 'cy-reduce-motion'

/** 操作系统「减少动态效果」偏好的媒体查询 */
export const REDUCE_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/**
 * 两个来源任一为真即减少动态。
 * 纯函数，便于直接断言真值表——不把"或"的关系藏在 DOM 副作用里。
 */
export function shouldReduceMotion(osPrefersReduced: boolean, settingEnabled: boolean): boolean {
  return osPrefersReduced || settingEnabled
}

/** 只依赖用得到的那一点 DOM 面，便于注入假对象（与 document-visibility 同款做法） */
export interface ReduceMotionRoot {
  classList: { toggle(token: string, force: boolean): void }
}

/** `MediaQueryList` 的最小面（老实现只有 addListener/removeListener，故两者都接受） */
export interface ReduceMotionMedia {
  matches: boolean
  addEventListener?(type: 'change', listener: () => void): void
  removeEventListener?(type: 'change', listener: () => void): void
  addListener?(listener: () => void): void
  removeListener?(listener: () => void): void
}

export interface ReduceMotionGate {
  /** 按当前两个来源重算并落类；返回本次是否处于"减少动态"（供断言与探针） */
  sync(): boolean
  /** 退订媒体查询监听（幂等）。单测与热重载用 */
  dispose(): void
  /** 是否已退订（供断言，避免"dispose 了但监听还在"这类静默泄漏） */
  isDisposed(): boolean
}

/**
 * 建立门控：读一次媒体查询 + `readSetting()`，落根类，并订阅媒体查询变化。
 *
 * `readSetting` 是函数而不是值，因为设置是异步水合的（fail-open）：水合完成后由调用方
 * 再调 `sync()`（`main.ts` 用 `watch` 做），本模块不关心时序。
 */
export function createReduceMotionGate(options: {
  root: ReduceMotionRoot
  media: ReduceMotionMedia
  readSetting: () => boolean
}): ReduceMotionGate {
  const { root, media, readSetting } = options
  let disposed = false
  const onChange = (): void => { if (!disposed) sync() }
  const sync = (): boolean => {
    const reduce = shouldReduceMotion(media.matches === true, readSetting() === true)
    root.classList.toggle(REDUCE_MOTION_CLASS, reduce)
    return reduce
  }
  // 媒体查询变化 → 重算（用箭头函数保持 this 无关；两种订阅 API 都兼容）
  if (typeof media.addEventListener === 'function') media.addEventListener('change', onChange)
  else if (typeof media.addListener === 'function') media.addListener(onChange)
  return {
    sync,
    isDisposed: () => disposed,
    dispose: () => {
      if (disposed) return
      disposed = true
      if (typeof media.removeEventListener === 'function') media.removeEventListener('change', onChange)
      else if (typeof media.removeListener === 'function') media.removeListener(onChange)
    }
  }
}
