// @vitest-environment happy-dom
// tests/unit/cy-message-list-follow-intent.spec.ts
//
// ④ `message-list-follow-bottom` 的**确定性**回归（2026-09-13，第三轮）。
//
// 为什么要单测而不只靠集成：④ 在 CI 上是**偶发**（约 1/5～1/8 轮），靠集成用例只能"多跑几轮看运气"。
// 而它的判别式是纯函数式的——`onScroll` 只看 `prevTop`、`el.scrollTop`、`scrollHeight`、`clientHeight`
// 四个数，与真实布局无关。故这里**直接给出几何量**（Object.defineProperty 桩掉三个只读属性），
// 把"浏览器在一次贴底写入之后自己回退了 31px"这一刻**变成可重复的输入**。
//
// 定数的依据是 X99 配方的实测读数（doc review §4bis.4）：
//   `d=31 acc=31 t=8139 max=8185 h=8758 c=573 w=own/+32ms` —— 下移 31px、紧跟在我们自己 32ms 前的
//   写入之后、下移后距底 46px（只比 BOTTOM_EPS=40 多 6px）。修复前这一下就把"跟随意图"永久清掉。
//
// 断言的是**用户可见语义**（还要不要跟随），不是内部变量：读的是组件反射到 DOM 上的
// `data-follow-intent`（与集成用例同一观测面）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount, type VueWrapper } from '@vue/test-utils'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import CyMessageList from '../../src/renderer/src/components/CyMessageList.vue'
import { createDesktopApiMock } from './helpers/desktop-api'

/** happy-dom 不做布局：三个几何量全部由用例给定（getter 返回用例的值，setter 记录程序性写入） */
interface Geometry {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

function stubGeometry(el: HTMLElement, g: Geometry): void {
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => g.scrollTop,
    set: (v: number) => {
      // 真实浏览器会夹到 [0, max]：桩件照做，否则"贴底写入"会被读成越界值
      g.scrollTop = Math.max(0, Math.min(v, Math.max(0, g.scrollHeight - g.clientHeight)))
    }
  })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => g.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => g.clientHeight })
}

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const intent = (wrapper: VueWrapper): string =>
  (wrapper.find('.cy-messages').element as HTMLElement).dataset.followIntent ?? '?'

describe('CyMessageList 跟随意图：什么才算"用户上翻"（④ 收口）', () => {
  let wrapper: VueWrapper
  let g: Geometry

  /** 每次 `scroll` 事件前都先改几何量，再派发事件——与浏览器里"位置变了才有事件"同序 */
  async function scrollTo(top: number, height?: number): Promise<void> {
    g.scrollTop = top
    if (height !== undefined) g.scrollHeight = height
    await wrapper.find('.cy-messages').trigger('scroll')
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    setDesktopApi(createDesktopApiMock({}))
    wrapper = mount(CyMessageList, { global: { stubs: { CyAttachmentMedia: true, CyToolCard: true } } })
    // 视口 600、内容 1600 ⇒ 可滚动上界 1000 = 贴底
    g = { scrollTop: 1000, scrollHeight: 1600, clientHeight: 600 }
    stubGeometry(wrapper.find('.cy-messages').element as HTMLElement, g)
  })

  it('浏览器在贴底写入之后自己回退 31px：**不算**用户上翻，跟随意图保持', async () => {
    await scrollTo(1000)                    // 贴底（gap=0）
    expect(intent(wrapper)).toBe('1')

    // 复现实测那一刻：下移 31px，且下移后距底 = 8185-8139 = 46px（比 BOTTOM_EPS 多 6px）
    await scrollTo(969, 1615)               // gap = 1615-969-600 = 46
    expect(intent(wrapper)).toBe('1')       // ← 修复前这里是 '0'（意图被永久清掉）
  })

  it('下移量超过门限（≥64px）仍判定为用户上翻', async () => {
    await scrollTo(1000)
    await scrollTo(880, 1600)               // 下移 120px，gap=120
    expect(intent(wrapper)).toBe('0')
  })

  it('小幅下移**累计**过门限后判定为用户上翻（触控板小步上滑）', async () => {
    await scrollTo(1000)
    await scrollTo(950, 1600)               // 下移 50（gap=50 > 40，不重置累计）
    expect(intent(wrapper)).toBe('1')
    await scrollTo(930, 1600)               // 再下移 20 ⇒ 累计 70 ≥ 64
    expect(intent(wrapper)).toBe('0')
  })

  it('回到底部会清空累计量：随后同样的 50px 下移不再清意图', async () => {
    await scrollTo(950, 1600)               // 累计 50
    await scrollTo(1000, 1600)              // 回到贴底 ⇒ 意图恢复、累计清零
    expect(intent(wrapper)).toBe('1')
    await scrollTo(950, 1600)               // 又下移 50：若累计没清零就会 100 ≥ 64 而误清
    expect(intent(wrapper)).toBe('1')
  })

  it('只读探针本身可用：位置下移事件被记录（含下移量与累计量）', async () => {
    await scrollTo(1000)
    await scrollTo(880, 1600)
    const el = wrapper.find('.cy-messages').element as HTMLElement
    expect(el.dataset.followUpCount).toBe('1')
    expect(el.dataset.followUpLast).toContain('d=120')
    expect(el.dataset.followUpLast).toContain('acc=120')
    expect(el.dataset.followClearFlip).toContain('d=120')
  })
})
