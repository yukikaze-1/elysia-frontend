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
import { Live2DController, type Live2DControllerStatus, type NormalizedPoint } from '../live2d/controller'
import type { CharacterState } from '../live2d/state-machine'
import { createLive2dStateSource } from '../live2d/state-source'
import { api } from './desktop-api'
import { useSettingsStore } from './settings.store'
import { useConnectionStore } from './connection.store'
import { useMessageStore } from './message.store'
import { useVoiceStore } from './voice.store'
import type { Live2DModelSummary, Message, PerformanceMode } from '@shared/contracts'

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
  /** 当前 CharacterState（Task 5 Panel 状态徽标）：经 controller 'state' 事件镜像；未接线前 'offline' */
  const characterState = ref<CharacterState>('offline')

  let controller: Live2DController | null = null
  let unsubDevice: (() => void) | null = null
  let unsubState: (() => void) | null = null
  let unsubStateSource: (() => void) | null = null
  // M1：init 完成（含已选模型覆盖 switch）前为 false，串行化用户 switch——init resolve 前不允许触发切换，
  // 避免 currentId null 时 controller 切换中守卫返回被丢弃目标的语义暧昧。
  let ready = false

  /** 最后**完成** assistant message 的 `.emotion`（I-3 修复：只读从末尾数第一条 `status==='completed'` 的
   *  消息；不再「扫到最近带 emotion 的消息」——emotion 只写入不清空，扫最近的带 emotion 会让几条消息前的
   *  happy/sad 永久残留、任意源变化触发情绪闪烁。其无 emotion → undefined；未知码由 source 忽略）。 */
  function lastCompletedEmotion(): string | undefined {
    const msg = useMessageStore()
    for (let i = msg.order.length - 1; i >= 0; i--) {
      const m: Message | undefined = msg.byId[msg.order[i]]
      if (!m || m.role !== 'assistant' || m.status !== 'completed') continue
      return m.emotion
    }
    return undefined
  }

  /** 当前生成是否已产出正文（speaking 判定第二路：voiceStore.tts.playing 或 active gen 已有 public 文本段）。
   *  M-3 修复：锚定当前生成的消息（唯一 streaming 态 assistant——activeGenerationId 为 generationId 非
   *  messageId，无 gen→msg 直查表，以 streaming 态锚定即可），不从 order 末尾找「第一个未 completed」——
   *  避免旧取消/失败消息（status!=completed）被误判为当前生成。 */
  function currentGenHasContent(): boolean {
    const msg = useMessageStore()
    if (!msg.activeGenerationId) return false
    for (let i = msg.order.length - 1; i >= 0; i--) {
      const m: Message | undefined = msg.byId[msg.order[i]]
      if (!m || m.role !== 'assistant' || m.status !== 'streaming') continue
      return (m.assistantSegments ?? []).some(
        // B7 集成修复（2026-08-18）：wire 上的 public_reply 正文 delta kind 为 `markdown`（默认夹具/真实后端均如此），
        // 仅认 `text` 会让默认流的「说话中」永不触发（isSpeaking 恒 false → 整段生成卡 thinking）。
        // 正文语义 = public_reply 且 text/markdown（非空）——两种 kind 都计为「已产出正文」。
        (seg) => seg.channel === 'public_reply' && (seg.kind === 'text' || seg.kind === 'markdown') && !!seg.text
      )
    }
    return false
  }

  /** 装配 live2dStateSource：组合 connection/message/voice 读值 → controller.setState。（D5B-04 薄编排层，
   *  Controller 无 Pinia；conversationStore 无「conversation→角色态」映射，本批不订阅，归阶段 6/后续。） */
  function setupStateSource(ctrl: Live2DController): void {
    if (unsubStateSource) return
    unsubStateSource = createLive2dStateSource(
      {
        connection: () => useConnectionStore().state,
        isGenerating: () => useMessageStore().activeGenerationId !== undefined,
        isSpeaking: () =>
          useVoiceStore().tts.playing || currentGenHasContent(),
        emotion: () => lastCompletedEmotion()
      },
      (s) => ctrl.setState(s)
    )
  }

  function ensureController(): Live2DController {
    if (controller) return controller
    const ctrl = buildController()
    controller = ctrl
    // device_lost（adapter 渲染 tick 抛 Live2DGpuLostError）→ 静态头像回退（同步镜像控制器 terminal 态）
    unsubDevice = ctrl.on('device_lost', () => {
      status.value = 'fallback'
    })
    // state（Task 5）：controller.setXxx 期间引出的状态变更经 'state' 事件镜像 characterState（Panel 状态徽标）
    unsubState = ctrl.on('state', (s) => {
      if (s) characterState.value = s as CharacterState
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
    // M1：init 完成（含已选覆盖 switch）后才放行用户 switch；此时装配状态编排（controller 已 ready）
    // Task 5：把当前 settings 表现字段一次性推给 controller（handle 已就绪；此后 Panel 对每次 setLive2d
    // 变更单独推送同款）。autoMotions/lipSync/performanceMode/scale/offset 的「设置→controller」接线落点。
    ctrl.setAutoMotions(l2d.autoMotions)
    ctrl.setLipSync(l2d.lipSync)
    ctrl.setPerformanceMode(l2d.performanceMode)
    ctrl.setViewTransform(l2d.scale, l2d.offsetX, l2d.offsetY)
    ready = true
    setupStateSource(ctrl)
  }

  async function switchModel(next: string): Promise<void> {
    // M1 串行化：init 完成前不允许用户触发 switch（避免 currentId null 时守卫返回被丢弃目标的语义暧昧）
    if (!ready) {
      error.value = 'Live2D 尚未就绪，无法切换模型'
      return
    }
    error.value = ''
    const ctrl = ensureController()
    try {
      const effective = await ctrl.switchModel(next)
      syncFromController()
      // D5B-10/T6：持久化「实际生效 id」而非无条件 next——守卫丢弃（切换中/同模型幂等）时持久化旧 id，消除
      // 「已加载 a 却持久化 b」窄竞态
      useSettingsStore().setLive2d({ modelId: effective })
    } catch (e) {
      // 失败保留原 modelId（controller 内部不动 currentId/handle）+ 置 error
      syncFromController()
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  function dispose(): void {
    unsubStateSource?.() // 退订 stateSource（停 watch + 清 N1 mood/error 回退 timers）
    unsubStateSource = null
    unsubDevice?.()
    unsubDevice = null
    unsubState?.() // 退订 'state' 事件镜像
    unsubState = null
    if (controller) {
      controller.unload() // 全量释放（含 adapter.destroy：unregister contextlost + 清 GL 引用）
      controller = null
    }
    ready = false
    models.value = []
    status.value = 'unloaded'
    modelId.value = null
    error.value = ''
    characterState.value = 'offline'
  }

  // —— Task 5（B5 UI + B6 Panel）：设置→controller 的窄转发（Panel/Pane 消费；无 controller 时 no-op）——

  /** 待机动画开关转发（settings.live2d.autoMotions） */
  function setAutoMotions(v: boolean): void {
    controller?.setAutoMotions(v)
  }

  /** 口型独立门转发（settings.live2d.lipSync，M5） */
  function setLipSync(v: boolean): void {
    controller?.setLipSync(v)
  }

  /** 性能模式转发（settings.live2d.performanceMode） */
  function setPerformanceMode(m: PerformanceMode): void {
    controller?.setPerformanceMode(m)
  }

  /** 视图变换转发（settings.live2d.scale/offsetX/offsetY，Panel 缩放/偏移手柄即时预览） */
  function setViewTransform(scale: number, offsetX: number, offsetY: number): void {
    controller?.setViewTransform(scale, offsetX, offsetY)
  }

  /** 视线目标转发（Panel 鼠标跟随/回正，D5B-09）：null = 回正 */
  function setLookTarget(target: NormalizedPoint | null): void {
    controller?.setLookTarget(target)
  }

  /** 点击预设动作转发（Panel 点击画布；priority=1 低优先，仲裁在 controller） */
  function playTapMotion(priority: number): void {
    controller?.playTapMotion(priority)
  }

  /** 渲染 tick（Panel rAF 循环驱动 → controller.tick → adapter.update+draw；GPU-lost 由 controller 捕获并
   *  emit device_lost → 本 store 镜像 fallback）。无 controller（未 init / disabled）时 no-op。 */
  function tick(): void {
    controller?.tick()
  }

  return {
    models, status, modelId, error, live2dSettings, characterState,
    init, switchModel, dispose, tick,
    setAutoMotions, setLipSync, setPerformanceMode, setViewTransform, setLookTarget, playTapMotion
  }
})