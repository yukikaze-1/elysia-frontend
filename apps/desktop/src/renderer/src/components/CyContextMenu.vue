<script setup lang="ts">
// CyContextMenu:通用右键菜单（doc 03 §5.1 会话右键菜单 + 消息右键；2026-09-13）。
//
// 为什么新建而不是复用既有浮层：仓库里没有任何 `Cy*Menu*`/`Cy*Popover*` 组件，最接近的
// `CyConnectionPanel` 是**锚定**浮层（位置写死在 CSS 里），而右键菜单必须按**指针坐标**定位——
// 全仓此前没有一处浮层做过坐标定位。故这里一次做对，供会话列表与消息列表共用（台账原话：
// "同一 context-menu 机制一次覆盖两处"）。
//
// 关键取舍：
// - **Teleport 到 body**：消息侧要挂在虚拟列表行内，而 `.cy-vlist-row` 的 DOM 与高度是
//   perf-gate 保护的契约（行高变化会牵动前缀和与 ②/③ 断言）。teleport 出去后菜单完全不在行的
//   DOM 子树里，也天然 `position: fixed` 脱离文档流，行高不受影响。
// - **role="menu" / role="menuitem" + 方向键**：仓库此前 `role="menu"` 与方向键导航都是 0 命中；
//   菜单若只支持鼠标，等于新增一个键盘不可达的交互面（doc 03 §14「所有主要按钮可以 Tab 聚焦」）。
// - **点外部/滚动/缩放/失焦即关**：菜单是瞬时浮层，留在屏幕上会与"它属于哪个对象"脱钩。
// - 关闭后**回焦触发元素**（若仍在文档内）：与既有模态（CyVoiceConsentDialog 等）同一口径。
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { ContextMenuItem } from '../utils/context-menu'

const props = defineProps<{ open: boolean; x: number; y: number; items: ContextMenuItem[] }>()
const emit = defineEmits<{ select: [id: string]; close: [] }>()

const root = ref<HTMLElement>()
/** 位置在落 DOM 前按视口夹取（菜单尺寸要等渲染后才知道，故用两段式：先粗放，nextTick 后精确修正） */
const pos = ref({ x: props.x, y: props.y })
const EDGE = 8

function clampToViewport(): void {
  const el = root.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const maxX = Math.max(EDGE, window.innerWidth - r.width - EDGE)
  const maxY = Math.max(EDGE, window.innerHeight - r.height - EDGE)
  pos.value = { x: Math.min(Math.max(EDGE, props.x), maxX), y: Math.min(Math.max(EDGE, props.y), maxY) }
}

let restoreTarget: HTMLElement | null = null

function focusableItems(): HTMLElement[] {
  return Array.from(root.value?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])
}

function focusFirst(): void {
  focusableItems()[0]?.focus()
}

function moveFocus(delta: number): void {
  const items = focusableItems()
  if (items.length === 0) return
  const active = document.activeElement as HTMLElement | null
  const idx = active ? items.indexOf(active) : -1
  const next = idx < 0 ? (delta > 0 ? 0 : items.length - 1) : (idx + delta + items.length) % items.length
  items[next]?.focus()
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.preventDefault(); close(); return }
  if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(1); return }
  if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(-1); return }
  if (e.key === 'Home') { e.preventDefault(); focusFirst(); return }
  if (e.key === 'End') { e.preventDefault(); focusableItems().at(-1)?.focus(); return }
  if (e.key === 'Tab') { close(); return }   // Tab 离开菜单即关闭（不困住焦点）
}

function close(): void {
  // 关键一步：菜单项此刻持有焦点，而它马上就要随菜单被卸载——**浏览器在"被聚焦元素被移除"时会把焦点
  // 落到 body**，从而清掉调用方在同一拍里设置的焦点（实测：选「重命名」后输入框的自动聚焦被这一步 blur，
  // activeElement 变回 BODY）。先主动 blur，卸载时就无焦点可失，后续 focus 才留得住。
  const active = document.activeElement
  if (active instanceof HTMLElement && root.value?.contains(active)) active.blur()
  emit('close')
}

function onSelect(item: ContextMenuItem): void {
  if (item.disabled) return
  emit('select', item.id)
  close()
}

function onPointerDownOutside(e: PointerEvent): void {
  if (!root.value) return
  if (e.target instanceof Node && root.value.contains(e.target)) return
  close()
}

// 滚动/缩放时关闭：fixed 定位的菜单不会跟随内容滚动，留在原地会指向错误的对象
function onViewportChange(): void { close() }

function bind(): void {
  document.addEventListener('pointerdown', onPointerDownOutside, true)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('blur', onViewportChange)
}
function unbind(): void {
  document.removeEventListener('pointerdown', onPointerDownOutside, true)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('blur', onViewportChange)
}

// immediate：菜单可能在挂载时就已 open（父层先设坐标再渲染），此时 watch 不触发会漏掉
// bind/clamp/focusFirst——首版就是这么漏的（坐标不夹取、焦点不进菜单）。
watch(() => props.open, async (open) => {
  if (open) {
    pos.value = { x: props.x, y: props.y }
    restoreTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null
    bind()
    await nextTick()
    clampToViewport()
    focusFirst()
  } else {
    unbind()
    // 回焦触发元素：仍在文档内才回（与 CyVoiceConsentDialog 的 isConnected 守卫同款）。
    // **但 `body`/`documentElement` 例外**：给它们调 focus() 等于"清空焦点"——而调用方往往刚在
    // 关菜单的同一拍里把焦点放进某个新元素（如"重命名"后自动聚焦输入框）。实测踩到过：
    // 右键时页面本无焦点元素 ⇒ restoreTarget=body ⇒ 关菜单把刚聚焦的输入框 blur 掉（activeElement 变 BODY）。
    const canRestore = restoreTarget && restoreTarget !== document.body && restoreTarget !== document.documentElement
    if (canRestore && restoreTarget!.isConnected) restoreTarget!.focus()
    restoreTarget = null
  }
}, { immediate: true })

onBeforeUnmount(() => { unbind() })

const style = computed(() => ({ left: `${pos.value.x}px`, top: `${pos.value.y}px` }))
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="root"
      class="cy-context-menu"
      role="menu"
      data-testid="context-menu"
      :style="style"
      @keydown="onKeydown"
      @contextmenu.prevent
    >
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        role="menuitem"
        class="cy-context-item"
        :class="{ 'is-danger': item.danger }"
        :data-testid="`context-menu-${item.id}`"
        :disabled="item.disabled"
        @click="onSelect(item)"
      >{{ item.label }}</button>
    </div>
  </Teleport>
</template>

<style scoped>
/* z-index 90：高于既有全部浮层（拖拽覆盖 30 / 连接 popover 45 / 设置 50 / 向导 60 / 审批 80）。
   审批与语音同意是**模态**，它们出现时被覆盖的区域本就点不到，故不会出现"菜单压在模态上"。 */
.cy-context-menu {
  position: fixed;
  z-index: 90;
  display: flex;
  flex-direction: column;
  min-width: 132px;
  padding: var(--cy-space-1-5);
  border: 1px solid var(--cy-border);
  border-radius: var(--cy-radius-5);
  background: var(--cy-surface);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.18);
}
.cy-context-item {
  display: block;
  width: 100%;
  padding: var(--cy-space-2) var(--cy-space-5);
  border: 0;
  border-radius: var(--cy-radius-3);
  background: transparent;
  color: var(--cy-text);
  font-size: var(--cy-font-md);
  text-align: left;
  cursor: pointer;
}
.cy-context-item:hover:not(:disabled) { background: var(--cy-surface-hover); }
.cy-context-item:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: -2px; }
.cy-context-item:disabled { color: var(--cy-muted); cursor: default; }
.cy-context-item.is-danger:not(:disabled) { color: var(--cy-danger); }
</style>
