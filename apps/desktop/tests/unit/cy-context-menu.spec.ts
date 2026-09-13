// @vitest-environment happy-dom
// tests/unit/cy-context-menu.spec.ts
// 通用右键菜单（doc 03 §5.1 会话右键菜单 / 消息右键；2026-09-13）。
//
// 本组件此前在仓库里**没有对应物**：没有任何 `Cy*Menu*`/`Cy*Popover*` 组件，`role="menu"` 与方向键
// 导航在 renderer 里都是 0 命中，且没有任何浮层做过坐标定位。故这里逐条钉住它新引入的交互契约：
//   ① teleport 到 body（消息侧要避开 `.cy-vlist-row` 的 perf-gate DOM 契约，见组件头注）
//   ② role=menu / role=menuitem + 初始焦点落在第一个**可用**项
//   ③ 方向键循环、Home/End、跳过禁用项
//   ④ Escape / 点外部 / 选中一项 都关闭（并 emit 对应事件）
//   ⑤ 坐标按视口夹取（贴边时不越界）
//   ⑥ 关闭后回焦触发元素（仍在文档内才回）
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import CyContextMenu from '../../src/renderer/src/components/CyContextMenu.vue'
import type { ContextMenuItem } from '../../src/renderer/src/utils/context-menu'

const ITEMS: ContextMenuItem[] = [
  { id: 'copy', label: '复制' },
  { id: 'locked', label: '不可用项', disabled: true },
  { id: 'delete', label: '删除', danger: true }
]

/** 挂到专用宿主 div（其父为 body）：teleport 的目标是 **body**，故宿主内必须没有菜单——
 *  这才是"菜单不在挂载点的 DOM 子树里"的可断言形态（`wrapper.element` 对 Teleport 根组件会解析成 body） */
function mountMenu(props: Partial<{ open: boolean; x: number; y: number; items: readonly ContextMenuItem[] }> = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const w = mount(CyContextMenu, {
    props: { open: true, x: 40, y: 60, items: ITEMS, ...props },
    attachTo: host
  })
  return { w, host }
}

afterEach(() => { document.body.innerHTML = '' })

describe('CyContextMenu：结构与定位', () => {
  it('teleport 到 body，渲染 role=menu 与 role=menuitem（禁用项保留但 disabled）', async () => {
    const { w, host } = mountMenu()
    await nextTick()
    const menu = document.querySelector('[data-testid="context-menu"]')
    expect(menu).not.toBeNull()
    expect(menu!.getAttribute('role')).toBe('menu')
    // 关键：菜单不在**挂载点**的 DOM 子树里（teleport），消息侧因此不污染 .cy-vlist-row 子树
    expect(host.contains(menu)).toBe(false)
    expect(document.body.contains(menu)).toBe(true)
    const items = document.querySelectorAll('[role="menuitem"]')
    expect(items).toHaveLength(3)
    expect((document.querySelector('[data-testid="context-menu-locked"]') as HTMLButtonElement).disabled).toBe(true)
    w.unmount()
  })

  it('初始焦点落在第一个**可用**项（跳过禁用的首项）', async () => {
    const disabledFirst: ContextMenuItem[] = [{ id: 'a', label: '甲', disabled: true }, { id: 'b', label: '乙' }]
    const { w } = mountMenu({ items: disabledFirst })
    await nextTick()
    expect(document.activeElement).toBe(document.querySelector('[data-testid="context-menu-b"]'))
    w.unmount()
  })

  it('坐标按视口夹取：越界不越出（贴右下角）', async () => {
    const { w } = mountMenu({ x: 99999, y: 99999 })
    await nextTick()
    const menu = document.querySelector<HTMLElement>('[data-testid="context-menu"]')!
    const left = Number.parseFloat(menu.style.left)
    const top = Number.parseFloat(menu.style.top)
    expect(left).toBeLessThan(window.innerWidth)
    expect(top).toBeLessThan(window.innerHeight)
    expect(left).toBeGreaterThanOrEqual(0)
    expect(top).toBeGreaterThanOrEqual(0)
    w.unmount()
  })

  it('负坐标同样被夹到边距内（右键点靠近左上角）', async () => {
    const { w } = mountMenu({ x: -50, y: -50 })
    await nextTick()
    const menu = document.querySelector<HTMLElement>('[data-testid="context-menu"]')!
    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(8)
    expect(Number.parseFloat(menu.style.top)).toBeGreaterThanOrEqual(8)
    w.unmount()
  })
})

describe('CyContextMenu：键盘与关闭', () => {
  it('方向键在可用项之间循环（跳过禁用项）', async () => {
    const { w } = mountMenu()
    await nextTick()
    const menu = document.querySelector<HTMLElement>('[data-testid="context-menu"]')!
    const key = (k: string): void => { menu.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) }

    expect(document.activeElement).toBe(document.querySelector('[data-testid="context-menu-copy"]'))
    key('ArrowDown')   // 跳过 locked
    expect(document.activeElement).toBe(document.querySelector('[data-testid="context-menu-delete"]'))
    key('ArrowDown')   // 循环回第一项
    expect(document.activeElement).toBe(document.querySelector('[data-testid="context-menu-copy"]'))
    key('ArrowUp')
    expect(document.activeElement).toBe(document.querySelector('[data-testid="context-menu-delete"]'))
    key('Home')
    expect(document.activeElement).toBe(document.querySelector('[data-testid="context-menu-copy"]'))
    key('End')
    expect(document.activeElement).toBe(document.querySelector('[data-testid="context-menu-delete"]'))
    w.unmount()
  })

  it('Escape 关闭；点外部关闭；两者都不 emit select', async () => {
    const { w } = mountMenu()
    await nextTick()
    const menu = document.querySelector<HTMLElement>('[data-testid="context-menu"]')!
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(w.emitted('close')).toHaveLength(1)
    expect(w.emitted('select')).toBeUndefined()

    const outside = document.createElement('div')
    document.body.appendChild(outside)
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(w.emitted('close')).toHaveLength(2)
    w.unmount()
  })

  it('选中一项 → emit select(id) 且关闭', async () => {
    const { w } = mountMenu()
    await nextTick()
    ;(document.querySelector('[data-testid="context-menu-delete"]') as HTMLButtonElement).click()
    expect(w.emitted('select')).toEqual([['delete']])
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })

  it('点击禁用项：不 emit select（也不关闭）', async () => {
    const { w } = mountMenu()
    await nextTick()
    ;(document.querySelector('[data-testid="context-menu-locked"]') as HTMLButtonElement).click()
    expect(w.emitted('select')).toBeUndefined()
    w.unmount()
  })

  it('关闭后回焦触发元素；触发元素已脱离文档则不回焦（不抛错）', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    const first = mountMenu()
    await nextTick()
    expect(document.activeElement).not.toBe(trigger)   // 菜单抢走焦点
    // `as never`：本仓库既有 4 个 spec（cy-markdown / cy-character-* 等）在 setProps 上都这么写——
    // 测试项目（tsconfig.node.json）解析不出 `<script setup>` SFC 的 props 类型，非本组件特有。
    await first.w.setProps({ open: false } as never)
    await nextTick()
    expect(document.activeElement, '关闭后必须回到触发它的元素').toBe(trigger)
    first.w.unmount()

    trigger.focus()
    const second = mountMenu()
    await nextTick()
    trigger.remove()                                    // 触发元素在菜单打开期间消失
    await expect(second.w.setProps({ open: false } as never)).resolves.toBeUndefined()
    second.w.unmount()
  })

  it('打开时页面本无焦点元素（activeElement=body）→ 关闭**不得**回焦 body（那会清掉调用方刚设的焦点）', async () => {
    // 真实场景（集成层实测踩到）：右键会话行不聚焦行本身 ⇒ restoreTarget=body；
    // 而"重命名"会在同一拍里聚焦输入框——若这里再 body.focus()，输入框立刻被 blur。
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(document.activeElement).toBe(document.body)

    const { w } = mountMenu()
    await nextTick()
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()                                       // 模拟"调用方刚把焦点放进新元素"
    expect(document.activeElement).toBe(input)

    await w.setProps({ open: false } as never)
    await nextTick()
    expect(document.activeElement, 'body 不是有效的回焦目标').toBe(input)
    w.unmount()
  })

  it('open=false 时不渲染任何菜单 DOM', async () => {
    const { w } = mountMenu({ open: false })
    await nextTick()
    expect(document.querySelector('[data-testid="context-menu"]')).toBeNull()
    w.unmount()
  })

  it('卸载时移除全局监听（不残留 pointerdown/resize 订阅）', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const { w } = mountMenu()
    await nextTick()
    w.unmount()
    const added = addSpy.mock.calls.filter((c) => c[0] === 'resize').length
    const removed = removeSpy.mock.calls.filter((c) => c[0] === 'resize').length
    expect(added).toBeGreaterThan(0)
    expect(removed).toBe(added)
    addSpy.mockRestore(); removeSpy.mockRestore()
  })
})
