// renderer/src/composer/dictation-hold.ts
// 「按住说话」手势的纯状态机（无 Vue / 无 DOM / 无 store）。
//
// 为什么单独存在：这条手势有三个入口（指针按住、键盘 Enter/Space、失焦兜底）与两条出口
// （提交 / 上滑取消），且每一条时间线都由 M-22 的真实缺陷钉住过：
//   · 系统按键自动重复的多次 keydown 不得重入；
//   · keydown 之后浏览器补发的 `click` 不得再起一次采集（模板用 `.prevent` 抑制默认激活，
//     但那只有配上"开始前同步置位"才成立）；
//   · 键盘按住期间被拿走焦点（Tab 走开 / 宿主重渲染）时 `keyup` 永远不会到达——采集会一直
//     留在 `dictating` 且没有任何 UI 能解释，故必须有失焦兜底；
//   · 上滑取消之后失焦**不得**再补一次 stop。
//
// 这些判据此前只存在于 `CyChatInput.vue` 的组件内，靠组件挂载 + 真实事件驱动才能触达。
// 下沉后可以按时间线直接驱动：同一次按住的全部事件序列都是纯输入 → 纯输出。
//
// 本模块只描述手势；「采集是否真的起来了」由调用方按 store 的 mode 判定后传入。

/** 一次按住的起点来源。指针路径带坐标（上滑判定），键盘路径没有坐标。 */
export type DictationHoldOrigin = 'pointer' | 'keyboard'

/** 上滑取消阈值（px）：按住后手指/指针上滑超过它即视为取消。 */
export const DICTATION_CANCEL_DISTANCE_PX = 60

interface HoldState {
  origin: DictationHoldOrigin
  /** 上滑基准：键盘路径没有坐标，取正无穷使任何坐标都不会误判为取消。 */
  startY: number
  cancel: boolean
}

export interface DictationHoldView {
  /** 当前有按住（指针路径带坐标、键盘路径带无穷基准）；null = 没有按住 */
  readonly hold: { startY: number; cancel: boolean } | null
  /** 键盘「按住中」门（与 hold 分离存放：hold 承载指针专属数据并驱动 .cancel 视觉） */
  readonly keyboardHolding: boolean
  /** 本次按住是否由键盘开始（失焦兜底据此分辨「键盘被拿走焦点」与「上滑取消后失焦」） */
  readonly startedByKeyboard: boolean
}

/** 手势机对外发出的动作。`undefined` = 什么都不做。 */
export type DictationHoldAction =
  | { kind: 'start' }
  | { kind: 'stop' }
  | { kind: 'cancel' }
  | { kind: 'noop' }

export interface DictationHoldInput {
  /** 起始是否被放行（语音开关 / 其它语音模式进行中 / 组件自身的禁用门） */
  startAllowed: boolean
}

/** 失焦兜底只需要「采集是否真的起来了」。 */
export interface DictationHoldContext {
  /** 当前 store 是否已进入 `dictating`（失焦兜底据此避免对没起来的采集补一次 stop） */
  dictating: boolean
}

export interface DictationHoldMachine extends DictationHoldView {
  /**
   * 指针按下。
   *
   * `pointerAllowed` 为 false 时返回 noop（例如录音态下主键是「停止录音」而非开始转写）。
   * 已有按住（键盘或指针）时返回 noop——两条路径不得同时起一次采集。
   */
  pointerDown(input: { pointerAllowed: boolean; startAllowed: boolean; y: number }): DictationHoldAction
  pointerMove(y: number): void
  /** 指针抬起：按 cancel 标记分流为取消或提交。 */
  pointerUp(): DictationHoldAction
  /** 指针被系统取消（来电/手势被接管）：一律取消。 */
  pointerCancel(): DictationHoldAction
  /**
   * 键盘按下（Enter / Space）。
   *
   * **同步**置位 `keyboardHolding`，故同一次按住的 auto-repeat keydown、以及 keydown 之后
   * 浏览器补发的 `click`，都不可能在采集建立之前再进入一次。
   */
  keyDown(input: { key: string; repeat: boolean; startAllowed: boolean }): DictationHoldAction
  keyUp(key: string): DictationHoldAction
  /** 失焦兜底：仅键盘按住路径补一次提交；上滑取消态不重复收尾。 */
  blur(context: DictationHoldContext): DictationHoldAction
  /** 组件卸载/复位：清掉全部手势态，不产生动作（收尾由 store 的收敛路径负责）。 */
  reset(): void
}

const NOOP: DictationHoldAction = { kind: 'noop' }

export function createDictationHoldMachine(): DictationHoldMachine {
  let hold: HoldState | null = null
  let keyboardHolding = false
  let startedByKeyboard = false

  /** 收尾即按住结束：键盘门一并复位，避免指针路径结束后残留导致下一次 keyup 被误判。 */
  function finishHold(): void {
    hold = null
    keyboardHolding = false
    startedByKeyboard = false
  }

  /** 抬起收尾（指针 / 键盘共用）：按 cancel 标记分流为取消或提交。 */
  function releaseHold(): DictationHoldAction {
    const current = hold
    finishHold()
    if (!current) return NOOP
    return current.cancel ? { kind: 'cancel' } : { kind: 'stop' }
  }

  function beginHold(origin: DictationHoldOrigin, startY: number): void {
    hold = { origin, startY, cancel: false }
  }

  return {
    get hold() {
      return hold ? { startY: hold.startY, cancel: hold.cancel } : null
    },
    get keyboardHolding() {
      return keyboardHolding
    },
    get startedByKeyboard() {
      return startedByKeyboard
    },

    pointerDown({ pointerAllowed, startAllowed, y }) {
      if (!pointerAllowed || !startAllowed) return NOOP
      if (hold) return NOOP   // 键盘已按住时忽略指针：两条路径不得同时起一次采集
      startedByKeyboard = false
      beginHold('pointer', y)
      return { kind: 'start' }
    },

    pointerMove(y) {
      // 只有指针起始的按住才有上滑语义。键盘路径没有坐标（基准为 +∞），若不按来源区分，
      // 一次无关的 pointermove 就能把键盘按住标成「取消」——那会让松手变成取消而非提交。
      if (hold?.origin !== 'pointer') return
      if (y < hold.startY - DICTATION_CANCEL_DISTANCE_PX) hold.cancel = true
    },

    pointerUp() {
      return releaseHold()
    },

    pointerCancel() {
      finishHold()
      return { kind: 'cancel' }
    },

    keyDown({ key, repeat, startAllowed }) {
      if (key !== 'Enter' && key !== ' ') return NOOP
      if (repeat || keyboardHolding) return NOOP   // 自动重复不得重入
      if (!startAllowed) return NOOP
      startedByKeyboard = true
      keyboardHolding = true
      // 同步置位：同一次按住的后续 keydown 与补发的 click 都到不了 store。
      beginHold('keyboard', Number.POSITIVE_INFINITY)
      return { kind: 'start' }
    },

    keyUp(key) {
      if (key !== 'Enter' && key !== ' ') return NOOP
      if (!keyboardHolding) return NOOP
      return releaseHold()
    },

    blur({ dictating }) {
      if (!keyboardHolding) return NOOP
      // keyup 永远不会到达（焦点被拿走）：仅键盘按住路径补一次提交。
      keyboardHolding = false
      startedByKeyboard = false
      if (!dictating) { hold = null; return NOOP }   // 采集没起来（被 guard 拒绝）→ 不误调 stop
      // 经与 pointerup 相同的收尾路径：上滑取消态不重复收尾。
      return hold ? releaseHold() : NOOP
    },

    reset() {
      finishHold()
    }
  }
}
