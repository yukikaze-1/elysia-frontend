<script setup lang="ts">
// 阶段 3 G1 角色栏：聊天右侧的布局列扩展（不覆盖聊天）；折叠按钮接线 toggleLive2d + 左缘拖拽手柄（role=separator）。
// 阶段 5 批次 A（A6，spec §3.6/D5A-10）：把 stage 占位替换为 live2d 渲染面——canvas + 模型下拉 + 状态文案；
// 保留 G1 的 resizer/折叠/状态栏与 grid-area: live（7D 起 App.vue 常驻挂载，不随 chat v-if 卸载——
// settings/tasks 打开时 v-show 隐藏但保留 ready 态，诊断页才能读到真实帧读数）。
// 渲染循环：chat 视图 + live2dShown（布局级可见）+ settings.live2d.enabled（设置级开关）+ status=ready 时跑 rAF →
// store.tick()（controller.tick → adapter.update+draw）；隐藏/切视图/关闭/回退即停（不渲染空白画布）；
// canvas 尺寸随 stage 变化（ResizeObserver 重设自缓冲）；onBeforeUnmount → store.dispose()（全量释放无残留）。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useLayoutStore } from '../stores/layout.store'
import { useLive2dStore } from '../stores/live2d.store'
import { useSettingsStore } from '../stores/settings.store'
import { useAppStore } from '../stores/app.store'
import { LIVE2D_MAX_WIDTH, LIVE2D_MIN_WIDTH } from '../layout/constants'
import type { CharacterState } from '../live2d/state-machine'
import type { PerformanceMode } from '@shared/contracts'
import { DEFAULT_LIVE2D } from '@shared/schemas'
import CyCharacterPublicState from './CyCharacterPublicState.vue'

const layout = useLayoutStore()
const store = useLive2dStore()
const settings = useSettingsStore()
const app = useAppStore()

const dragging = ref(false)

const stageRef = ref<HTMLElement>()
const canvasRef = ref<HTMLCanvasElement>()

// —— Task 5：本地 Live2D 呈现状态徽标（不是角色公开心情），经 store.characterState 镜像——
const CHARACTER_STATE_TEXT: Record<CharacterState, string> = {
  offline: '未连接',
  idle: '空闲',
  listening: '聆听中',
  thinking: '思考中',
  speaking: '说话中',
  waiting_permission: '等待授权',
  working: '工作中',
  happy: '开心',
  sad: '难过',
  surprised: '惊讶',
  error: '异常'
}
const charBadge = computed(() => CHARACTER_STATE_TEXT[store.characterState] ?? '空闲')
const badgeClass = computed(() => {
  const s = store.characterState
  if (s === 'error') return 'is-error'
  if (s === 'thinking' || s === 'speaking' || s === 'listening') return 'is-active'
  if (s === 'happy' || s === 'surprised') return 'is-mood'
  return ''
})

// 渲染循环 gate：chat 视图（7D：settings 打开时面板常驻挂载但 v-show 隐藏，必须停 rAF 防后台空转）
// + 布局级可见（v-show 折叠/窄窗）+ 设置级启用 + 已 ready（仅 ready 有可绘制帧；loading/failed/fallback 静态态不跑空循环）。
const active = computed(
  () => app.currentView === 'chat' && layout.effective.live2dShown && settings.live2d.enabled && store.status === 'ready'
)

const statusText = computed(() => {
  if (!settings.live2d.enabled) return 'Live2D 已关闭'
  switch (store.status) {
    case 'ready': return `Live2D 就绪${store.modelId ? ` · ${modelName(store.modelId)}` : ''}`
    case 'loading': return '正在加载模型…'
    case 'failed': return store.error || '模型加载失败'
    case 'fallback': return '静态头像回退（GPU 不可用）'
    case 'unloaded': return 'Live2D 未加载'
    default: return 'Live2D 未加载'
  }
})

function modelName(id: string | null): string {
  return store.models.find((m) => m.id === id)?.displayName ?? id ?? ''
}

// —— Task 5（B6）：鼠标跟随/回正/点击（spec §3.6 / D5B-09）——
// 视线跟随：mousemove → 画布相对坐标归一 [-1,1]（原点居中，NormalizedPoint）→ setLookTarget；
// mouseleave → 平滑回正（N3：本组件在 rAF 循环内自行 lerp 逼近 0 后喂给 controller，controller 只存静态
// 目标/null=回正）；回正过程逐帧 setLookTarget(中间值)，收敛后 setLookTarget(null)。
const LOOK_RETURN_LERP = 0.15 // 每次回正 lerp 系数（帧率 60 → ~100ms 内收敛）
const LOOK_RETURN_EPS = 0.01 // 收敛阈值
type LookMode = 'idle' | 'track' | 'return'
let lookMode: LookMode = 'idle'
let lookX = 0
let lookY = 0

/** 跟随/点击作用域门（D5B-09）：mouseTracking + !reduceMotion + 设置级启用 + 已 ready + 布局级可见 */
const lookAllowed = computed(
  () =>
    app.currentView === 'chat' &&   // 7D：settings/tasks 下面板 v-show 隐藏，视线跟随一并停
    settings.live2d.mouseTracking &&
    !settings.live2d.reduceMotion &&
    settings.live2d.enabled &&
    store.status === 'ready' &&
    layout.effective.live2dShown
)

function clampCoord(v: number): number {
  return Math.min(1, Math.max(-1, v))
}

function onLookMove(e: MouseEvent): void {
  if (!lookAllowed.value || viewPointerId !== null) return   // 按住/拖动期间视线目标冻结（UII-Live2D 修缮）
  const canvas = canvasRef.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return
  lookX = clampCoord(((e.clientX - rect.left) / rect.width) * 2 - 1)
  lookY = clampCoord(((e.clientY - rect.top) / rect.height) * 2 - 1)
  lookMode = 'track'
  store.setLookTarget({ x: lookX, y: lookY })
}

function onLookLeave(): void {
  if (lookMode === 'track') lookMode = 'return' // 进入平滑回正（逐帧 lerp 至 0）
}

/** 回正 lerp（rAF 循环内每帧调用）：逼近 0 → 收敛后 setLookTarget(null)。export 供单测驱动。 */
function applyLookTween(): void {
  if (lookMode !== 'return') return
  lookX += (0 - lookX) * LOOK_RETURN_LERP
  lookY += (0 - lookY) * LOOK_RETURN_LERP
  if (Math.abs(lookX) < LOOK_RETURN_EPS && Math.abs(lookY) < LOOK_RETURN_EPS) {
    lookMode = 'idle'
    store.setLookTarget(null)
  } else {
    store.setLookTarget({ x: lookX, y: lookY })
  }
}

/** 点击画布安全区 → 预设动作 priority=1（I-3：不打断 speaking/thinking(2)/error(3) 与 waiting_permission——
 *  仲裁在 controller.playTapMotion/playMotion 内部，Panel 只传 priority=1；无动作模型白名单不命中静默忽略） */
function onCanvasClick(e: MouseEvent): void {
  if (e.button !== 0) return
  if (!settings.live2d.enabled || store.status !== 'ready') return
  if (settings.live2d.reduceMotion) return // D5B-09：reduceMotion 时点击动作禁用
  if (viewClickSuppress) { viewClickSuppress = false; return }   // 有效拖动后的 click 不是点击动作（UII-Live2D 修缮）
  store.playTapMotion(1)
}

// —— UII-Live2D 修缮：画布直接视图操作（左键拖动移动 / 滚轮缩放 / 标题区重置），替换原顶部滑块组 ——
// 仍走既有链路：settings.setLive2d（本地即时 + 500ms 防抖持久化）→ watch → store.setViewTransform →
// controller → adapter，不引入第二套视图状态或持久化接口。adapter 将 offset 映射为 offset*0.25 clip，
// 换算系数 8/canvas 尺寸使模型基本跟随指针；DOM y 向下为正、渲染坐标向上为正 → deltaY 取反。
// reduceMotion 只门控角色动画/视线/点击，不拦手动视图操作；与视线跟随/点击动作的冲突经
// 按住门控（viewPointerId）+ 拖动阈值（DRAG_THRESHOLD_PX）+ click 抑制（viewClickSuppress）消解。
const DRAG_THRESHOLD_PX = 4

/** 视图操作门：仅要求 enabled + ready（拖动/缩放/重置是手动视图操作，不受 reduceMotion 限制） */
const viewActive = computed(() => settings.live2d.enabled && store.status === 'ready')

const viewDragging = ref(false)   // 已过阈值、正在拖动（驱动 grabbing 光标）
let viewPointerId: number | null = null
let viewStartX = 0
let viewStartY = 0
let viewStartOffsetX = 0
let viewStartOffsetY = 0
let viewClickSuppress = false     // 有效拖动后武装，紧随的 click 消费掉（不触发点击动作）

function onCanvasPointerDown(e: PointerEvent): void {
  if (e.button !== 0 || !viewActive.value || viewPointerId !== null) return
  viewPointerId = e.pointerId
  viewStartX = e.clientX
  viewStartY = e.clientY
  viewStartOffsetX = settings.live2d.offsetX
  viewStartOffsetY = settings.live2d.offsetY
  viewDragging.value = false
  viewClickSuppress = false
  const canvas = e.currentTarget as HTMLElement
  if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId)
}

function onCanvasPointerMove(e: PointerEvent): void {
  if (e.pointerId !== viewPointerId) return
  const canvas = canvasRef.value
  if (!canvas) return
  const dx = e.clientX - viewStartX
  const dy = e.clientY - viewStartY
  if (!viewDragging.value) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return   // 阈值内不算拖动，松开仍是普通点击
    viewDragging.value = true
  }
  const rect = canvas.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return
  settings.setLive2d({
    offsetX: clampOffset(viewStartOffsetX + (dx * 8) / rect.width),
    offsetY: clampOffset(viewStartOffsetY - (dy * 8) / rect.height)
  })
}

function onCanvasPointerEnd(e: PointerEvent): void {
  if (e.pointerId !== viewPointerId) return
  if (viewDragging.value) viewClickSuppress = true
  viewPointerId = null
  viewDragging.value = false
  const canvas = e.currentTarget as HTMLElement
  if (canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
}

function clampOffset(v: number): number {
  return Math.min(2, Math.max(-2, v))
}

function clampScale(v: number): number {
  return Math.min(3, Math.max(0.5, v))
}

function onCanvasWheel(e: WheelEvent): void {
  if (!viewActive.value) return
  e.preventDefault()   // 操作角色时不滚动页面
  settings.setLive2d({ scale: clampScale(settings.live2d.scale * Math.exp(-e.deltaY * 0.0015)) })
}

/** 重置视图：仅恢复 scale/offset 默认值（DEFAULT_LIVE2D 常量；不走 restoreDefaults——那会连模型选择/动画/性能一并重置） */
function resetView(): void {
  settings.setLive2d({ scale: DEFAULT_LIVE2D.scale, offsetX: DEFAULT_LIVE2D.offsetX, offsetY: DEFAULT_LIVE2D.offsetY })
}

// —— Task 5（B5）：设置 → controller 窄转发（store 已接 controller；这里订阅 settings 变更推送）——
// 初始值由 store.init 在 handle 就绪后重放（本组件 setup 期 controller 尚为 null，immediate 先 no-op）。
function forwardView(): void {
  store.setViewTransform(settings.live2d.scale, settings.live2d.offsetX, settings.live2d.offsetY)
}
watch(() => settings.live2d.autoMotions, (v) => store.setAutoMotions(v), { immediate: true })
watch(() => settings.live2d.lipSync, (v) => store.setLipSync(v), { immediate: true })
watch(() => settings.live2d.performanceMode, (v) => store.setPerformanceMode(v as PerformanceMode), { immediate: true })
watch(() => settings.live2d.scale, () => forwardView(), { immediate: true })
watch(() => settings.live2d.offsetX, () => forwardView(), { immediate: true })
watch(() => settings.live2d.offsetY, () => forwardView(), { immediate: true })

/** 跟随/点击门变化：作用域失效 → 停止跟踪并回正（不残留静态视线目标） */
watch(lookAllowed, (v) => {
  if (!v && lookMode === 'track') lookMode = 'return'
})

defineExpose({ applyLookTween })

// —— G1 拖拽手柄（保留既有实现）——
function onResizeStart(e: PointerEvent): void {
  if (e.button !== 0) return
  dragging.value = true
  const el = e.currentTarget as HTMLElement
  if (el.setPointerCapture) el.setPointerCapture(e.pointerId)
  e.preventDefault()
}
function onResizeMove(e: PointerEvent): void {
  if (!dragging.value) return
  // 新宽 = 视口宽 − 指针 x（面板左缘跟随指针）；setLive2dWidth 内部 clamp [300,420]
  layout.setLive2dWidth(layout.viewportWidth - e.clientX)
}
function onResizeEnd(e: PointerEvent): void {
  dragging.value = false
  const el = e.currentTarget as HTMLElement
  if (el.hasPointerCapture && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
}

// —— 阶段 5：canvas 尺寸自缓冲 + 渲染循环 ——
function resizeCanvas(): void {
  const canvas = canvasRef.value
  if (!canvas) return
  // 取 canvas 实际渲染尺寸（CSS 100%×100% = stage 内容盒）；仅尺寸变化时写回（避免每帧重分配帧缓冲）
  const w = Math.max(1, Math.floor(canvas.clientWidth))
  const h = Math.max(1, Math.floor(canvas.clientHeight))
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
}

let rafId = 0
let disposed = false
let ro: ResizeObserver | undefined

function loop(): void {
  if (rafId === 0) return
  store.tick() // controller.tick：adapter.update+draw（GPU-lost → store 镜像 fallback → active 变 false 停环）
  // C2（D5C-03）：视线跟随回正 lerp 独立于 controller.tick——FrameBudget skip 帧仍执行（廉价、保平滑；
  // controller 侧 skip 只原子跳过动画+draw，不阻断本 lerp）
  applyLookTween()
  resizeCanvas()
  rafId = requestAnimationFrame(loop)
}

function startStop(activeNow: boolean): void {
  if (activeNow && rafId === 0 && !disposed && canvasRef.value) {
    resizeCanvas()
    rafId = requestAnimationFrame(loop)
  } else if (!activeNow && rafId !== 0) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
}

watch(active, startStop)

// 隐藏/折叠/关闭 → 停 rAF（startStop）+ 停鼠标跟随（回正并落到 setLookTarget(null)，不残留静态目标）
watch(active, (v) => {
  if (!v && lookMode !== 'idle') {
    lookMode = 'idle'
    lookX = 0
    lookY = 0
    store.setLookTarget(null)
  }
})

function onModelChange(e: Event): void {
  const id = (e.target as HTMLSelectElement).value
  const target = id || store.models.find((m) => m.available)?.id
  if (target) void store.switchModel(target)
}

onMounted(() => {
  const stage = stageRef.value
  if (stage && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => resizeCanvas())
    ro.observe(stage)
  }
  resizeCanvas()
  if (canvasRef.value) {
    // 装载：list + 读 settings.enabled/modelId → load（enabled=false 只取清单不 load）
    void store.init(canvasRef.value).then(resizeCanvas)
  }
  // 设置页统一开关（批次 B）：false → 立即释放模型/GL（7D 常驻挂载下补上原「settings 卸载即 dispose」语义，
  // 诊断页同步回到「未启动」）；true → 重新装载（面板隐藏时也能 init，回到 chat 由 startStop resize 并起 rAF）
  watch(() => settings.live2d.enabled, (enabled) => {
    if (!enabled && store.status !== 'unloaded') {
      store.dispose()
    } else if (enabled && canvasRef.value && store.status === 'unloaded') {
      void store.init(canvasRef.value)
    }
  })
})

onBeforeUnmount(() => {
  disposed = true
  if (rafId !== 0) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
  ro?.disconnect()
  store.dispose() // controller.unload（adapter.destroy：模型 + contextlost 监听 + GL 引用全清理）
})
</script>

<template>
  <aside class="cy-live">
    <div
      class="cy-live-resizer"
      role="separator"
      aria-orientation="vertical"
      :aria-valuenow="layout.effective.live2dWidth"
      :aria-valuemin="LIVE2D_MIN_WIDTH"
      :aria-valuemax="LIVE2D_MAX_WIDTH"
      tabindex="-1"
      @pointerdown="onResizeStart"
      @pointermove="onResizeMove"
      @pointerup="onResizeEnd"
      @pointercancel="onResizeEnd"
    />
    <div class="cy-live-head">
      <span class="cy-live-title">角色</span>
      <div class="cy-live-head-actions">
        <button
          class="cy-live-reset"
          :disabled="!viewActive"
          title="重置模型位置和缩放"
          aria-label="重置模型位置和缩放"
          @click="resetView"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
          </svg>
        </button>
        <button class="cy-live-min" :aria-pressed="layout.effective.live2dShown" title="折叠角色栏" aria-label="折叠角色栏" @click="layout.toggleLive2d()">›</button>
      </div>
    </div>
    <div ref="stageRef" class="cy-live-stage">
      <div class="cy-live-glow" aria-hidden="true" />
      <!-- UII-Live2D 修缮：视图操作改为画布直接操作（拖动移动/滚轮缩放，见脚本区）——原顶部滑块组已移除，
           精确滑块保留在设置中心 CyLive2DPane，双向同步走同一 settings.setLive2d 链路 -->
      <canvas
        ref="canvasRef"
        class="cy-live-canvas"
        :class="{ 'is-grab': viewActive && !viewDragging, 'is-grabbing': viewDragging }"
        :title="viewActive ? '拖动移动模型 · 滚轮缩放' : undefined"
        aria-hidden="true"
        @pointerdown="onCanvasPointerDown"
        @pointermove="onCanvasPointerMove"
        @pointerup="onCanvasPointerEnd"
        @pointercancel="onCanvasPointerEnd"
        @lostpointercapture="onCanvasPointerEnd"
        @mousemove="onLookMove"
        @mouseleave="onLookLeave"
        @click="onCanvasClick"
        @wheel="onCanvasWheel"
      />
      <!-- 覆盖态：禁用/加载/失败/回退时静态展示，不遮挡下拉 -->
      <div v-if="!settings.live2d.enabled" class="cy-live-overlay" role="status">Live2D 已关闭</div>
      <div v-else-if="store.status === 'loading'" class="cy-live-overlay" role="status">正在加载模型…</div>
      <div v-else-if="store.status === 'failed'" class="cy-live-overlay" role="status">模型加载失败</div>
      <div v-else-if="store.status === 'fallback'" class="cy-live-overlay" role="status">静态头像回退</div>
      <label class="cy-live-model-select" :class="{ 'is-disabled': !settings.live2d.enabled }">
        <span class="cy-live-model-label">模型</span>
        <select
          :value="store.modelId ?? ''"
          :disabled="!settings.live2d.enabled"
          aria-label="选择 Live2D 模型"
          @change="onModelChange"
        >
          <option value="">默认模型</option>
          <option v-for="m in store.models" :key="m.id" :value="m.id" :disabled="!m.available">
            {{ m.displayName }}{{ !m.available ? '（不可用）' : '' }}
          </option>
        </select>
      </label>
    </div>
    <div class="cy-live-status">
      <span class="cy-live-status-main">{{ statusText }}</span>
      <span v-if="settings.live2d.enabled && store.status === 'ready'" class="cy-live-badge" :class="badgeClass">
        本地呈现：{{ charBadge }}
      </span>
    </div>
    <CyCharacterPublicState />
  </aside>
</template>

<style scoped>
.cy-live {
  grid-area: live;
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  min-height: 0;
  overflow: hidden;
  background: linear-gradient(180deg, var(--cy-pane), var(--cy-titlebar));
  border-left: 1px solid var(--cy-border);
}

.cy-live-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
}

.cy-live-title {
  font-size: 13px;
  font-weight: 500;
}

.cy-live-min {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--cy-border);
  border-radius: 9px;
  background: var(--cy-surface);
  color: var(--cy-muted);
}

.cy-live-min[aria-pressed='true'] {
  color: var(--cy-accent-text);
  background: var(--cy-accent);
}

.cy-live-head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* UII-Live2D 修缮：重置视图（紧凑次要按钮，与折叠按钮同规格） */
.cy-live-reset {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--cy-border);
  border-radius: 9px;
  background: var(--cy-surface);
  color: var(--cy-muted);
}

.cy-live-reset:disabled {
  opacity: 0.45;
  cursor: default;
}

.cy-live-reset:hover:not(:disabled) {
  color: var(--cy-text);
  background: var(--cy-surface-hover);
}

.cy-live-resizer {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 5px;
  cursor: col-resize;
  touch-action: none;
  /* G1 偏差修正：.cy-live-stage 也是 position:relative（DOM 序更后），会覆盖绝对定位的
     手柄使其不可交互（Playwright elementFromPoint 验证）；z-index 让手柄始终在最上层。 */
  z-index: 2;
}

.cy-live-resizer:hover {
  background: var(--cy-accent-strong);
  opacity: 0.35;
}

.cy-live-stage {
  position: relative;
  display: grid;
  flex: 1;
  grid-template-rows: 1fr auto; /* 画布区 + 底部模型下拉 */
  min-height: 0;
  padding: 8px;
  gap: 8px;
}

.cy-live-glow {
  position: absolute;
  width: 150px;
  height: 150px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--cy-glow), transparent 70%);
  opacity: 0.45;
  filter: blur(12px);
  pointer-events: none;
}

.cy-live-canvas {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: block;
  /* 角色画布：仅 ready 时可见（loading 期 canvas 已挂载准备上下文） */
  background: transparent;
  /* UII-Live2D 修缮：画布直接操作（拖动/滚轮）——禁触摸手势与选区，避免与视图拖动冲突 */
  touch-action: none;
  user-select: none;
}

.cy-live-canvas.is-grab {
  cursor: grab;
}

.cy-live-canvas.is-grabbing {
  cursor: grabbing;
}

.cy-live-overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--cy-muted);
  font-size: 13px;
  pointer-events: none;
}

.cy-live-model-select {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
  padding: 4px 8px;
  border: 1px solid var(--cy-border);
  border-radius: 10px;
  background: var(--cy-surface);
  color: var(--cy-muted);
  font-size: 12px;
}

.cy-live-model-select select {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--cy-text);
  font-size: 12px;
}

.cy-live-model-select.is-disabled select {
  cursor: not-allowed;
}

.cy-live-model-label {
  flex: none;
  color: var(--cy-muted);
  font-size: 11px;
}

.cy-live-status {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0 12px 14px;
  min-width: 0;
  padding: 10px;
  text-align: center;
  color: var(--cy-accent-text);
  background: var(--cy-accent);
  border: 1px solid var(--cy-border);
  border-radius: 12px;
  font-size: 12px;
}

.cy-live-status-main {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
  font-size: 12px;
  word-break: break-word;
}

.cy-live-badge {
  align-self: center;
  padding: 2px 10px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.16);
  font-size: 11px;
  font-weight: 600;
}

.cy-live-badge.is-error {
  background: var(--cy-danger);
  color: #fff;
}

.cy-live-badge.is-active {
  background: rgba(255, 255, 255, 0.28);
  color: var(--cy-accent-text);
}

.cy-live-badge.is-mood {
  background: rgba(255, 255, 255, 0.2);
  color: var(--cy-accent-text);
}
</style>
