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
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { Message } from '@shared/contracts'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { useMessageStore } from '../../src/renderer/src/stores/message.store'
import { useConversationStore } from '../../src/renderer/src/stores/conversation.store'
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

// —— Prompt 5 后 CI 修复（2026-09-17）：把「自有贴底写入的余波」与「用户上翻」分开 ——
//
// 为什么必须另起一个 harness：上面的 describe 里列表是空的，**组件从不做程序性写入**
// （`noteWrite` 只在 `followBottomIfSticky`/`commitScrollHeights`/`restoreScrollFor`/`backToBottom` 里被调），
// 所以那些用例走的是"没有自有写入记账"的路径，永远落不到归因判定上。而 CI 上真正红的那条路径
// **必须先有一次自有贴底写入**——本轮修复判的就是"这次下移能不能归因到它"。
//
// 触发自有写入用的是**真实 UI 入口**（`.cy-back-bottom` → `backToBottom()`）：它走 `markWriteSite` +
// `noteWrite`，与 `commitScrollHeights/bottom`（CI 里那一次）同一套记账，不依赖任何测试专用后门。
describe('CyMessageList 跟随意图：自有贴底写入的余波 vs 用户上翻（Prompt 5 后 CI 修复）', () => {
  let wrapper: VueWrapper
  let g: Geometry

  function message(messageId: string, role: 'user' | 'assistant'): Message {
    return role === 'user'
      ? { messageId, conversationId: 'default', role, content: '你好', status: 'completed', createdAt: '2026-09-17T04:00:00.000Z' }
      : {
          messageId,
          conversationId: 'default',
          role,
          status: 'completed',
          createdAt: '2026-09-17T04:01:00.000Z',
          assistantSegments: [{ segmentId: `${messageId}-s0`, segmentIndex: 0, channel: 'public_reply', kind: 'text', text: '在的。', completed: true }]
        }
  }

  /** 每次 `scroll` 事件前先改几何量再派发——与浏览器里"位置变了才有事件"同序 */
  async function scrollTo(top: number, height: number): Promise<void> {
    g.scrollTop = top
    g.scrollHeight = height
    await wrapper.find('.cy-messages').trigger('scroll')
  }

  /** 「回到底部」按钮：真实的程序性贴底写入路径（`backToBottom` → `noteWrite`） */
  async function backToBottom(): Promise<void> {
    await wrapper.find('.cy-back-bottom').trigger('click')
    // 真实浏览器里程序性写入同样会派发 scroll 事件（d=0）——桩件必须补上，
    // 否则组件的 `scrollTop.value` 停在旧位置，下一次下移的"起点"就不是我们写入的值。
    const el = wrapper.find('.cy-messages').element as HTMLElement
    await scrollTo(el.scrollHeight - el.clientHeight, el.scrollHeight)
  }

  beforeEach(async () => {
    setActivePinia(createPinia())
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    setDesktopApi(createDesktopApiMock({}))
    // 非空列表：`.cy-back-bottom` 的 `v-if="!atBottom && !isEmpty"` 需要它
    useMessageStore().loadSnapshot('default', [message('m-user', 'user'), message('m-assistant', 'assistant')])
    useConversationStore().currentId = 'default'
    wrapper = mount(CyMessageList, { global: { stubs: { CyAttachmentMedia: true, CyToolCard: true } } })
    await nextTick()
    // 视口 600、内容 1600 ⇒ 可滚动上界 1000 = 贴底
    g = { scrollTop: 1000, scrollHeight: 1600, clientHeight: 600 }
    stubGeometry(wrapper.find('.cy-messages').element as HTMLElement, g)
  })

  // 7.1 Regression：自有写入之后的布局回退（CI 实测形态，> 门限）
  it('自有贴底写入之后回退 139px（CI 实测：写后 40ms、上界收缩、回退后距底 46px）：跟随意图保持', async () => {
    await scrollTo(600, 1600)   // 先离开底部（atBottom=false ⇒ 入口出现）；此处无自有写入记账
    await backToBottom()        // 自有贴底写入：top = max = 1000
    expect(intent(wrapper)).toBe('1')

    // CI run 35182407425 同形：写后回退 139px，且上界收缩 1000 → 907（我们写的位置已不可达），回退后距底 46px
    await scrollTo(861, 1507)

    expect(intent(wrapper)).toBe('1')          // ← 修复前：acc=139 ≥ 64 ⇒ 意图被永久清掉（缺口随后饱和在 5526px）
    const el = wrapper.find('.cy-messages').element as HTMLElement
    expect(el.dataset.followUpLast).toContain('d=139')
    expect(el.dataset.followUpLast).toContain('acc=0')            // 该 delta **未**计入用户累计
    expect(el.dataset.followUpLast).toContain('tail=own-write')   // 且被标注为自有写入的余波
    expect(el.dataset.followClearFlip).toBe('')                   // 没有发生清意图
  })

  it('自有写入后 31px 回退（X99 实测值，未发生上界收缩）：照旧不误清意图', async () => {
    await scrollTo(600, 1600)
    await backToBottom()
    // 实测读数同形：下移 31px、下移后距底 46px，但**上界没有收缩**（内容反而长了 15px）
    await scrollTo(969, 1615)

    expect(intent(wrapper)).toBe('1')
    const el = wrapper.find('.cy-messages').element as HTMLElement
    expect(el.dataset.followUpLast).toContain('d=31')
    expect(el.dataset.followUpLast).toContain('acc=31')           // 未被归因自有（收缩条件不成立）
    expect(el.dataset.followUpLast).not.toContain('tail=own-write')
  })

  // 7.2 Genuine user scroll：不得因为这次修复让用户无法退出贴底
  it('自有写入后用户立刻大幅上翻（远离底部，perf-gate ②b 同形）：照旧清意图', async () => {
    await scrollTo(600, 1600)
    await backToBottom()
    await scrollTo(700, 1600)   // 上翻 300px、距底 300px（远超底部带）

    expect(intent(wrapper)).toBe('0')
    expect((wrapper.find('.cy-messages').element as HTMLElement).dataset.followClearFlip).toContain('d=300')
  })

  it('上界同时收缩但用户确实离开了底部（距底 200px）：仍判用户上翻', async () => {
    await scrollTo(600, 1600)
    await backToBottom()
    await scrollTo(700, 1500)   // 上界收缩（1000 → 900）但已离开底部 200px ⇒ 不是"余波"

    expect(intent(wrapper)).toBe('0')
    expect((wrapper.find('.cy-messages').element as HTMLElement).dataset.followClearFlip).toContain('d=300')
  })

  it('自有写入后的小步上滑（无收缩）照旧累计过门限：触控板小步上滑仍能退出跟随', async () => {
    await scrollTo(600, 1600)
    await backToBottom()
    await scrollTo(950, 1600)   // 下移 50：带内但**没有收缩** ⇒ 不算自有余波
    expect(intent(wrapper)).toBe('1')
    await scrollTo(930, 1600)   // 再下移 20 ⇒ 累计 70 ≥ 64
    expect(intent(wrapper)).toBe('0')
  })

  // 7.3 归因不可永久持有
  it('旧的程序性写入已过归因窗：同形回退照旧计入用户意图并清意图', async () => {
    await scrollTo(600, 1600)
    await backToBottom()
    const base = performance.now()
    vi.spyOn(performance, 'now').mockReturnValue(base + 5000)   // 把探针时钟推过归因窗
    try {
      await scrollTo(861, 1507)   // 与 7.1 完全同形的回退，只是"写入"已是 5s 前的事
      expect(intent(wrapper)).toBe('0')
      expect((wrapper.find('.cy-messages').element as HTMLElement).dataset.followClearFlip).toContain('d=139')
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('回退起点不是我们写入的位置（用户先到下方再上翻）：不归因自有，照旧清意图', async () => {
    await scrollTo(600, 1600)
    await backToBottom()        // 我们写入 1000
    await scrollTo(1100, 1700)  // 内容变长、位置移到 1100：起点已不是我们写的位置
    // 上翻 150（1100 → 950）：上界收缩（995 < 1000，我们写的位置已不可达）、距底 45px
    //（> BOTTOM_EPS 故走"下移"分支、≤ 归因带故 ⑤ 成立）——归因条件除"起点"外**全部成立**，
    // 只有 ① 能挡住它 ⇒ 这条用例单独钉住 ① 的判别力。
    await scrollTo(950, 1595)

    expect(intent(wrapper)).toBe('0')
    expect((wrapper.find('.cy-messages').element as HTMLElement).dataset.followClearFlip).toContain('d=150')
  })
})
