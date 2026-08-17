// apps/desktop/src/renderer/src/stores/live2d.store.ts
// 阶段 5 批次 A（A6，spec §3.6/D5A-10）：live2dStore——Live2DController + Live2DModelSummary + settings.live2d
// 的三方收口。
// init(canvas)：list 模型摘要（供面板下拉）→ 读 settingsStore.live2d（enabled/modelId）→ enabled 时 controller.init
//   （默认首个可用）→ 若已选 modelId 且 available → switchModel 覆盖并持久化；enabled=false → 不创建渲染循环、
//   不 load（面板显示「Live2D 已关闭」）。
// switchModel(next)：controller.switchModel + setLive2d({ modelId }) 持久化；失败保留原 modelId + error。
// dispose()：controller.unload（全量释放含 adapter.destroy，无残留）→ 状态复位（面板 onBeforeUnmount 调用）。
// 可测性：buildController 默认建真实 adapter（webglEngine）；单测经 setLive2dControllerFactory 注入 fake
// controller（fake adapter + fake list），与 live2d-adapter.spec 同款 fake GL 纪律（node 无 WebGL）。
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { Live2DAdapter } from '../live2d/adapter'
import { webglEngine } from '../live2d/gl/webgl'
import { Live2DController, type Live2DControllerStatus } from '../live2d/controller'
import { api } from './desktop-api'
import { useSettingsStore } from './settings.store'
import type { Live2DModelSummary } from '@shared/contracts'

/** 控制器工厂注入点（默认为真实装配；单测注入 fake controller 以在 node 环境驱动状态机） */
type ControllerFactory = () => Live2DController
let controllerFactory: ControllerFactory | undefined
export function setLive2dControllerFactory(f: ControllerFactory | undefined): void {
  controllerFactory = f
}

function buildController(): Live2DController {
  if (controllerFactory) return controllerFactory()
  const adapter = new Live2DAdapter({ engine: webglEngine })
  // list 走注入的 desktopApi（preload live2d:list-models）；真实 + mock 覆盖
  return new Live2DController({ adapter, list: () => api.listLive2dModels() })
}

export const useLive2dStore = defineStore('live2d', () => {
  const models = ref<Live2DModelSummary[]>([])
  const status = ref<Live2DControllerStatus>('unloaded')
  const modelId = ref<string | null>(null)
  const error = ref<string>('')
  const live2dSettings = computed(() => useSettingsStore().live2d)

  let controller: Live2DController | null = null
  let unsubDevice: (() => void) | null = null

  function ensureController(): Live2DController {
    if (controller) return controller
    const ctrl = buildController()
    controller = ctrl
    // device_lost（adapter 渲染 tick 抛 Live2DGpuLostError）→ 静态头像回退（同步镜像控制器 terminal 态）
    unsubDevice = ctrl.on('device_lost', () => {
      status.value = 'fallback'
    })
    return ctrl
  }

  /** 镜像控制器当前状态/modelId（每次 controller 调用的 await 后同步一次，事件只覆盖异步 device_lost） */
  function syncFromController(): void {
    if (!controller) return
    status.value = controller.status
    modelId.value = controller.modelId
  }

  async function init(c: HTMLCanvasElement): Promise<void> {
    // 始终取模型清单（选单 options + 可用性判断）；list 失败 fail-open：空列表 + 静态头像回退，不阻塞启动
    models.value = await api.listLive2dModels().catch(() => [])
    const l2d = useSettingsStore().live2d
    if (!l2d.enabled) {
      // 关闭态：不创建渲染循环、不 load（面板显示「Live2D 已关闭」）；status 保持 unloaded
      return
    }
    const ctrl = ensureController()
    try {
      await ctrl.init(c)
      syncFromController()
    } catch (e) {
      // 控制器初始化异常（list/adapter 抛）：镜像其状态 + 记录 error，不向上传播（不阻塞启动/不 unhandled）
      syncFromController()
      error.value = e instanceof Error ? e.message : String(e)
    }
    // 已选 modelId（可用）→ 覆盖默认首个可用（settings 优先于 list 顺序）
    const chosen = l2d.modelId
    if (chosen && models.value.some((m) => m.id === chosen && m.available) && ctrl.modelId !== chosen) {
      try {
        await ctrl.switchModel(chosen)
        syncFromController()
      } catch (e) {
        // 已选模型加载失败：保留默认模型，记录 error（不静默回退）
        syncFromController()
        error.value = e instanceof Error ? e.message : String(e)
      }
    }
  }

  async function switchModel(next: string): Promise<void> {
    error.value = ''
    const ctrl = ensureController()
    try {
      await ctrl.switchModel(next)
      syncFromController()
      useSettingsStore().setLive2d({ modelId: next }) // 持久化：切换即落模型选择
    } catch (e) {
      // 失败保留原 modelId（controller 内部不动 currentId/handle）+ 置 error
      syncFromController()
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  function dispose(): void {
    unsubDevice?.()
    unsubDevice = null
    if (controller) {
      controller.unload() // 全量释放（含 adapter.destroy：unregister contextlost + 清 GL 引用）
      controller = null
    }
    models.value = []
    status.value = 'unloaded'
    modelId.value = null
    error.value = ''
  }

  /** 渲染 tick（Panel rAF 循环驱动 → controller.tick → adapter.update+draw；GPU-lost 由 controller 捕获并
   *  emit device_lost → 本 store 镜像 fallback）。无 controller（未 init / disabled）时 no-op。 */
  function tick(): void {
    controller?.tick()
  }

  return {
    models, status, modelId, error, live2dSettings,
    init, switchModel, dispose, tick
  }
})