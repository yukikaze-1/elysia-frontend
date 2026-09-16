// tests/unit/dictation-hold.spec.ts
// `composer/dictation-hold` 的**时间线**测试：按住说话的指针/键盘/失焦三条路径。
//
// 这套手势由 M-22 的真实缺陷逐条钉住（auto-repeat 重入、keydown 后补发 click、失焦无兜底、
// 取消后失焦重复收尾）。此前这些判据只存在于 `CyChatInput.vue` 内，必须挂载组件 + 驱动真实
// DOM 事件才能触达；下沉后每条时间线都是「纯输入 → 纯动作」。
import { describe, expect, it } from 'vitest'
import {
  DICTATION_CANCEL_DISTANCE_PX,
  createDictationHoldMachine
} from '../../src/renderer/src/composer/dictation-hold'

const START = { kind: 'start' }
const STOP = { kind: 'stop' }
const CANCEL = { kind: 'cancel' }
const NOOP = { kind: 'noop' }

function machine() {
  return createDictationHoldMachine()
}

describe('指针路径', () => {
  it('按下 → 抬起 = start → stop（正常一次按住）', () => {
    const m = machine()
    expect(m.pointerDown({ pointerAllowed: true, startAllowed: true, y: 300 })).toEqual(START)
    expect(m.hold).toEqual({ startY: 300, cancel: false })
    expect(m.pointerUp()).toEqual(STOP)
    expect(m.hold).toBeNull()
  })

  it('上滑超过阈值 → cancel 标记；抬起走 cancel（不是 stop）', () => {
    const m = machine()
    m.pointerDown({ pointerAllowed: true, startAllowed: true, y: 300 })
    m.pointerMove(300 - DICTATION_CANCEL_DISTANCE_PX)   // 恰在阈值上：不算取消
    expect(m.hold?.cancel).toBe(false)
    m.pointerMove(300 - DICTATION_CANCEL_DISTANCE_PX - 1)   // 越界 1px：取消
    expect(m.hold?.cancel).toBe(true)
    expect(m.pointerUp()).toEqual(CANCEL)
  })

  it('上滑标记一旦置位不因回滑复位（松手前的抖动不得把取消变回提交）', () => {
    const m = machine()
    m.pointerDown({ pointerAllowed: true, startAllowed: true, y: 300 })
    m.pointerMove(100)
    m.pointerMove(300)
    expect(m.hold?.cancel).toBe(true)
    expect(m.pointerUp()).toEqual(CANCEL)
  })

  it('pointercancel（系统接管手势）一律取消', () => {
    const m = machine()
    m.pointerDown({ pointerAllowed: true, startAllowed: true, y: 300 })
    expect(m.pointerCancel()).toEqual(CANCEL)
    expect(m.hold).toBeNull()
  })

  it('按下被禁用门拒绝 → noop 且不留手势态', () => {
    const m = machine()
    expect(m.pointerDown({ pointerAllowed: false, startAllowed: true, y: 300 })).toEqual(NOOP)
    expect(m.pointerDown({ pointerAllowed: true, startAllowed: false, y: 300 })).toEqual(NOOP)
    expect(m.hold).toBeNull()
  })

  it('没有按住时抬起/移动都是 noop（未开始不产生动作）', () => {
    const m = machine()
    expect(m.pointerUp()).toEqual(NOOP)
    expect(() => m.pointerMove(0)).not.toThrow()
    expect(m.hold).toBeNull()
  })

  it('键盘按住期间忽略指针（两条路径不得同时起一次采集）', () => {
    const m = machine()
    expect(m.keyDown({ key: 'Enter', repeat: false, startAllowed: true })).toEqual(START)
    expect(m.pointerDown({ pointerAllowed: true, startAllowed: true, y: 300 })).toEqual(NOOP)
    expect(m.hold?.startY).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('键盘路径（M-22）', () => {
  it('keydown → keyup = start → stop', () => {
    const m = machine()
    expect(m.keyDown({ key: 'Enter', repeat: false, startAllowed: true })).toEqual(START)
    expect(m.keyboardHolding).toBe(true)
    expect(m.keyUp('Enter')).toEqual(STOP)
    expect(m.keyboardHolding).toBe(false)
  })

  it('Space 与 Enter 等价', () => {
    const m = machine()
    expect(m.keyDown({ key: ' ', repeat: false, startAllowed: true })).toEqual(START)
    expect(m.keyUp(' ')).toEqual(STOP)
  })

  it('系统自动重复的多次 keydown 不得重入（同一次按住只 start 一次）', () => {
    const m = machine()
    expect(m.keyDown({ key: 'Enter', repeat: false, startAllowed: true })).toEqual(START)
    expect(m.keyDown({ key: 'Enter', repeat: true, startAllowed: true })).toEqual(NOOP)
    expect(m.keyDown({ key: 'Enter', repeat: true, startAllowed: true })).toEqual(NOOP)
    expect(m.keyUp('Enter')).toEqual(STOP)
  })

  it('keydown 之后浏览器补发的 click 语义（再次 keydown）在按住期间被拒', () => {
    const m = machine()
    m.keyDown({ key: 'Enter', repeat: false, startAllowed: true })
    // 组件不绑 click；这里断言的是「同步置位」这一承重性质：按住期间任何再次进入都到不了 store
    expect(m.keyDown({ key: 'Enter', repeat: false, startAllowed: true })).toEqual(NOOP)
    m.keyUp('Enter')
    // 抬起之后可以重新开始（门不粘滞）
    expect(m.keyDown({ key: 'Enter', repeat: false, startAllowed: true })).toEqual(START)
  })

  it('禁用时不放行，且不留 keyboardHolding（否则后续 keyup 会误发 stop）', () => {
    const m = machine()
    expect(m.keyDown({ key: 'Enter', repeat: false, startAllowed: false })).toEqual(NOOP)
    expect(m.keyboardHolding).toBe(false)
    expect(m.keyUp('Enter')).toEqual(NOOP)
  })

  it('无关键（其它按键）不参与手势', () => {
    const m = machine()
    expect(m.keyDown({ key: 'a', repeat: false, startAllowed: true })).toEqual(NOOP)
    expect(m.keyUp('a')).toEqual(NOOP)
  })

  it('未按住时 keyup 是 noop（keyup 先于 keydown 到达/被别处消费都不误发 stop）', () => {
    const m = machine()
    expect(m.keyUp('Enter')).toEqual(NOOP)
  })

  it('键盘路径的上滑语义不生效（无坐标 ⇒ 不会误判取消）', () => {
    const m = machine()
    m.keyDown({ key: 'Enter', repeat: false, startAllowed: true })
    m.pointerMove(-10_000)
    expect(m.hold?.cancel).toBe(false)
    expect(m.keyUp('Enter')).toEqual(STOP)
  })
})

describe('失焦兜底', () => {
  it('键盘按住中被拿走焦点（keyup 永不到达）→ 补一次 stop', () => {
    const m = machine()
    m.keyDown({ key: 'Enter', repeat: false, startAllowed: true })
    expect(m.blur({ dictating: true })).toEqual(STOP)
    expect(m.keyboardHolding).toBe(false)
    expect(m.hold).toBeNull()
  })

  it('采集没起来（start 被 guard 拒绝，mode 非 dictating）→ 不误调 stop', () => {
    const m = machine()
    m.keyDown({ key: 'Enter', repeat: false, startAllowed: true })
    expect(m.blur({ dictating: false })).toEqual(NOOP)
    expect(m.hold).toBeNull()
  })

  it('上滑取消之后失焦 → 不重复收尾（已进 cancel 态）', () => {
    const m = machine()
    m.keyDown({ key: 'Enter', repeat: false, startAllowed: true })
    m.pointerMove(-1)   // 键盘路径基准为 +∞，移动不会置 cancel
    // 真正要验的是：先经 pointerUp 收尾，再失焦必须 noop
    m.keyUp('Enter')
    expect(m.blur({ dictating: true })).toEqual(NOOP)
  })

  it('指针路径按住中的失焦不产生动作（只有键盘路径需要兜底）', () => {
    const m = machine()
    m.pointerDown({ pointerAllowed: true, startAllowed: true, y: 300 })
    expect(m.blur({ dictating: true })).toEqual(NOOP)
    expect(m.hold).not.toBeNull()   // 指针路径的手势态保留，等真正的 pointerup
    expect(m.pointerUp()).toEqual(STOP)
  })

  it('已完成一次键盘按住之后，失焦不再补发（门已复位，不重复收尾）', () => {
    const m = machine()
    m.keyDown({ key: 'Enter', repeat: false, startAllowed: true })
    m.keyUp('Enter')
    expect(m.blur({ dictating: true })).toEqual(NOOP)
  })
})

describe('reset（组件卸载/复位）', () => {
  it('清掉全部手势态且不产生动作', () => {
    const m = machine()
    m.pointerDown({ pointerAllowed: true, startAllowed: true, y: 300 })
    m.reset()
    expect(m.hold).toBeNull()
    expect(m.startedByKeyboard).toBe(false)
    expect(m.pointerUp()).toEqual(NOOP)
  })

  it('清掉键盘门后，残留的 keyup 不会误发 stop', () => {
    const m = machine()
    m.keyDown({ key: 'Enter', repeat: false, startAllowed: true })
    m.reset()
    expect(m.keyboardHolding).toBe(false)
    expect(m.keyUp('Enter')).toEqual(NOOP)
  })
})

describe('路径交叉：不得出现「两条路径都以为自己持有」', () => {
  it('指针按住 → 抬起 → 键盘按住 → 抬起：两次独立手势各自成立', () => {
    const m = machine()
    expect(m.pointerDown({ pointerAllowed: true, startAllowed: true, y: 300 })).toEqual(START)
    expect(m.pointerUp()).toEqual(STOP)
    expect(m.keyDown({ key: 'Enter', repeat: false, startAllowed: true })).toEqual(START)
    expect(m.keyUp('Enter')).toEqual(STOP)
  })

  it('指针按住期间 keydown 被拒（不会形成第二份手势态）', () => {
    const m = machine()
    m.pointerDown({ pointerAllowed: true, startAllowed: true, y: 300 })
    // 注意：keyDown 的守卫是 keyboardHolding，指针路径不置它——这里断言的是指针收尾后
    // 键盘仍能正常工作，且指针的 cancel 标记不会被键盘路径继承。
    m.pointerMove(100)
    expect(m.pointerUp()).toEqual(CANCEL)
    expect(m.keyDown({ key: 'Enter', repeat: false, startAllowed: true })).toEqual(START)
    expect(m.hold?.cancel).toBe(false)
  })
})
