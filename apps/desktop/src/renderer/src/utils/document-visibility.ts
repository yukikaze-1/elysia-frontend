// src/renderer/src/utils/document-visibility.ts
// 文档可见性来源（M-37，P2-9，2026-09-12）。
//
// 为什么需要它：`main-window.ts` 把"窗口隐藏时暂停渲染"**明确委托**给应用自己的 active 门
// （`backgroundThrottling: false` 的注释如此声明），但那个门里**没有窗口状态项**——
// `CyLive2DPanel.vue` 的 gate 只看 `currentView === 'chat' && live2dShown && enabled && status === 'ready'`。
// 于是窗口最小化/被隐藏后 rAF 仍全速跑：GPU 持续唤醒、耗电，而画面上根本没人看。
// 全仓 `visibilitychange` / `document.hidden` / `IntersectionObserver` 此前 **0 命中**。
//
// 覆盖范围如实说明：`visibilitychange` 覆盖"最小化 / 切到别的应用 / 标签隐藏"这类
// **文档级隐藏**；它**不**覆盖"窗口被另一个窗口遮挡"（遮挡不触发该事件，需要 IntersectionObserver
// 且对 Electron 顶层窗口并不适用）。故本模块解决的是评审所指的"最小化/被遮挡时仍全速渲染"里
// 可被 Web API 观测的那一半——**不假装它解决了全部**。
import { ref, type Ref } from 'vue'

export interface DocumentVisibilitySource {
  readonly visible: Ref<boolean>
  dispose(): void
}

/** 最小的 document 依赖面（单测用假实现驱动，无需真实 DOM 事件） */
export interface VisibilityDocument {
  readonly hidden: boolean
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

/**
 * 可注入工厂：把 `document.hidden` 变成响应式 `visible`，并在 `visibilitychange` 时更新。
 * 初始值直接读 `hidden`（不是先假设可见再等事件）——若在文档已隐藏时才挂载，第一次就该是 false。
 */
export function createDocumentVisibilitySource(doc: VisibilityDocument): DocumentVisibilitySource {
  const visible = ref(!doc.hidden)
  const onChange = (): void => { visible.value = !doc.hidden }
  doc.addEventListener('visibilitychange', onChange)
  return {
    visible,
    dispose: () => { doc.removeEventListener('visibilitychange', onChange) }
  }
}

/** 无 document 环境（如 SSR/纯 node 单测）下的常量：恒可见，不引入条件分支到调用方 */
const ALWAYS_VISIBLE: Ref<boolean> = ref(true)

let singleton: DocumentVisibilitySource | undefined

/**
 * 应用级单例：整个 renderer 只有一份 document，故只挂一个监听（避免每个消费组件各挂一个）。
 * 监听随 renderer 生命周期存在，不做 dispose（与 document 同寿命）。
 */
export function documentVisible(): Ref<boolean> {
  if (!singleton && typeof document !== 'undefined') {
    singleton = createDocumentVisibilitySource(document as unknown as VisibilityDocument)
  }
  return singleton ? singleton.visible : ALWAYS_VISIBLE
}
