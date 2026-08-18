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
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { Live2DAdapter } from '../live2d/adapter'
import { webglEngine } from '../live2d/gl/webgl'
import { Live2DController, type Live2DControllerStatus, type NormalizedPoint } from '../live2d/controller'
import { statePriority, type CharacterState } from '../live2d/state-machine'
import { createLive2dStateSource, type Live2dStateSource } from '../live2d/state-source'
import { createSineMouthSource, createStepMouthSource, createTtsMouthSource, type MouthLevelSource } from '../live2d/tts-mouth-source'
import { api } from './desktop-api'
import { useSettingsStore } from './settings.store'
import { useConnectionStore } from './connection.store'
import { useMessageStore } from './message.store'
import { useVoiceStore } from './voice.store'
import { useLayoutStore } from './layout.store'
import type { DirectiveState, Live2DDirectiveEvent, Live2DModelSummary, Message, PerformanceMode } from '@shared/contracts'

/** C3：DirectiveState 七值（剔除 error——error=3 必须 client 驱动，D5C-07）；越界（如 'error'/'working'）丢弃 */
const DIRECTIVE_STATES: ReadonlySet<string> = new Set<DirectiveState>([
  'idle', 'listening', 'thinking', 'speaking', 'happy', 'sad', 'surprised'
])

/** 控制器工厂注入点（默认为真实装配；单测注入 fake controller 以在 node 环境驱动状态机） */
type ControllerFactory = () => Live2DController
let controllerFactory: ControllerFactory | undefined
export function setLive2dControllerFactory(f: ControllerFactory | undefined): void {
  controllerFactory = f
}

/** 口部数据源工厂注入点（C1，对齐 controllerFactory 先例）：默认真实 TtsMouthSource（MediaElementSource→
 *  Analyser）；单测/集成注入确定性合成源断言采样接线。 */
type MouthSourceFactory = () => MouthLevelSource
let mouthSourceFactory: MouthSourceFactory | undefined
export function setMouthSourceFactory(f: MouthSourceFactory | undefined): void {
  mouthSourceFactory = f
}

function buildController(): Live2DController {
  if (controllerFactory) return controllerFactory()
  const adapter = new Live2DAdapter({ engine: webglEngine })
  // list 走注入的 desktopApi（preload live2d:list-models）；真实 + mock 覆盖
  return new Live2DController({ adapter, list: () => api.listLive2dModels() })
}

function buildMouthSource(): MouthLevelSource {
  if (mouthSourceFactory) return mouthSourceFactory()
  return createTtsMouthSource()
}

export const useLive2dStore = defineStore('live2d', () => {
  const models = ref<Live2DModelSummary[]>([])
  const status = ref<Live2DControllerStatus>('unloaded')
  const modelId = ref<string | null>(null)
  const error = ref<string>('')
  const live2dSettings = computed(() => useSettingsStore().live2d)
  /** 当前 CharacterState（Task 5 Panel 状态徽标）：经 controller 'state' 事件镜像；未接线前 'offline' */
  const characterState = ref<CharacterState>('offline')
  /** C1（批次 C）：当前口型电平 [0,1]（tick 采样源喂 controller 时记录；集成探针 window.__cyreneTest.getMouthLevel 读） */
  const mouthLevel = ref(0)
  /** C3（指令>emotion）：指令 expression 存活期标记——指令瞬态存活（stateSource pushDirective 超时回调或
   *  client 2/3 级 watch 覆盖）期间置 true，抑制 emotion→表情自动映射；指令瞬态结束（onDirectiveEnd）清除 */
  const directiveExpressionActive = ref(false)

  let controller: Live2DController | null = null
  let unsubDevice: (() => void) | null = null
  let unsubState: (() => void) | null = null
  let stateSourceHandle: Live2dStateSource | null = null
  // C2（D5C-05）：可见性接线 watch（「布局可见 ∧ enabled」→ controller.setVisibility），init 时装、dispose 退订
  let unsubVisibility: (() => void) | null = null
  // C2（D5C-04）：GPU 重建一次——rebuildGuard 防重入（「每次 lost 事件一次」，finally 复位非永久）；
  // lastLookTarget 记录最近视线目标（重建后重放，unload 会清 controller 侧目标）
  let rebuildGuard = false
  let lastLookTarget: NormalizedPoint | null = null
  // C1：口部数据源 + 采样接线（TTS 播放时 attach，停止/取消 detach 归零）
  let mouthSource: MouthLevelSource | null = null
  let mouthAttached = false
  let mockMouthLevel: 'step' | 'sine' | undefined
  let unsubMouthWatch: (() => void) | null = null
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
   *  Controller 无 Pinia；conversationStore 无「conversation→角色态」映射，本批不订阅，归阶段 6/后续。）
   *  持句柄供 C2 GPU 重建后 recompose 恢复 CharacterState。
   *  C3：注入 getCurrentPriority（建议强度仲裁基准 = 真实 controller 优先级）+ onDirectiveEnd（指令瞬态结束
   *  清 directiveExpressionActive）+ emotion getter 指令抑制（指令 expression 存活期不重发 emotion 表情）。 */
  function setupStateSource(ctrl: Live2DController): void {
    if (stateSourceHandle) return
    stateSourceHandle = createLive2dStateSource(
      {
        connection: () => useConnectionStore().state,
        isGenerating: () => useMessageStore().activeGenerationId !== undefined,
        isSpeaking: () =>
          useVoiceStore().tts.playing || currentGenHasContent(),
        emotion: () => (directiveExpressionActive.value ? undefined : lastCompletedEmotion()),
        getCurrentPriority: () => (ctrl.characterState ? statePriority(ctrl.characterState) : 0),
        onDirectiveEnd: () => {
          directiveExpressionActive.value = false
        }
      },
      (s) => ctrl.setState(s)
    )
  }

  /** C1 口部接线：watch voiceStore（tts.playing ∧ ttsAudioEl）→ attach/detach 口部数据源。
   *  playing∧有元素 → attach（tick 采样）；否则 detach + 归零（controller.setMouthLevel(0) 清电口，
   *  口部关闭不残留上一帧开合——doc 05 §10 静音/暂停/取消 → 归零）。 */
  function setupMouthWatch(): void {
    if (unsubMouthWatch) return
    const voice = useVoiceStore()
    unsubMouthWatch = watch(
      [() => voice.tts.playing, () => voice.ttsAudioEl],
      ([playing, el]) => {
        if (playing && el && mouthSource) {
          mouthSource.attach(el)
          mouthAttached = true
        } else {
          mouthSource?.detach()
          mouthAttached = false
          mouthLevel.value = 0
          controller?.setMouthLevel(0)
        }
      },
      { immediate: true }
    )
  }

  function ensureController(): Live2DController {
    if (controller) return controller
    const ctrl = buildController()
    controller = ctrl
    // device_lost（adapter 渲染 tick 抛 Live2DGpuLostError）→ C2 重建一次（rebuildAfterLost；失败镜像 fallback）
    unsubDevice = ctrl.on('device_lost', () => {
      void rebuildAfterLost()
    })
    // state（Task 5）：controller.setXxx 期间引出的状态变更经 'state' 事件镜像 characterState（Panel 状态徽标）
    unsubState = ctrl.on('state', (s) => {
      if (s) characterState.value = s as CharacterState
    })
    return ctrl
  }

  /** C2（D5C-04）：GPU 丢失重建一次——device_lost → `reset(当前 modelId)` 一次（rebuildGuard 防重入，
   *  finally 复位「每次 lost 事件一次」非永久，与 reset 内部 switchModel 无关）；重建成功恢复 ready +
   *  重放 settings（autoMotions/lipSync/performanceMode/scale/offset/lookTarget，复用 init 重放点）+
   *  stateSource 重组合恢复当前 CharacterState；失败 → fallback（静态头像，批次 A 既有路径）。重建期间
   *  status 非 ready → Panel active watcher 停 rAF；成功后 status→ready 自动重启渲染循环（无需额外通知）。 */
  async function rebuildAfterLost(): Promise<void> {
    const ctrl = controller
    if (!ctrl) {
      status.value = 'fallback'
      return
    }
    if (rebuildGuard) {
      status.value = 'fallback' // 重建中再 device_lost → 镜像 fallback，不二次触发
      return
    }
    rebuildGuard = true
    status.value = 'fallback' // 重建期间静态头像（同步镜像；loading 由 reset 内部置）
    try {
      await ctrl.reset(ctrl.modelId)
      syncFromController()
      if (ctrl.status === 'ready') {
        // 重放 settings（与 init 尾部重放点同款）+ 视线目标 + CharacterState
        const l2d = useSettingsStore().live2d
        ctrl.setAutoMotions(l2d.autoMotions)
        ctrl.setLipSync(l2d.lipSync)
        ctrl.setPerformanceMode(l2d.performanceMode)
        ctrl.setViewTransform(l2d.scale, l2d.offsetX, l2d.offsetY)
        ctrl.setLookTarget(lastLookTarget)
        stateSourceHandle?.recompose() // 恢复当前 CharacterState（含 N1 瞬态 timer 管理）
      } else {
        status.value = 'fallback'
      }
    } catch {
      syncFromController()
      status.value = 'fallback' // 重建失败 → 静态头像（不向上传播，不阻塞聊天）
    } finally {
      rebuildGuard = false
    }
  }

  /** C2（D5C-05）：可见性接线——「布局可见（live2dShown）∧ enabled」→ controller.setVisibility(v)。
   *  controller.tick 首行消费（!visible 提前 return），消除 Task5 M4 死面；Panel rAF 启停保持既有（双层门控无害）。 */
  function setupVisibilityWatch(): void {
    if (unsubVisibility) return
    unsubVisibility = watch(
      [() => useLayoutStore().effective.live2dShown, () => live2dSettings.value.enabled],
      ([shown, enabled]) => {
        controller?.setVisibility(shown && enabled)
      },
      { immediate: true }
    )
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
    // C1（批次 C）：mock 合成包络源选择——CYRENE_MOCK_MOUTH_LEVEL 经 Main 水合（getRuntimeInfo）下发，仅 mock
    // 模式填充；renderer 不读 env（sandbox）。Minor-14 守卫：getRuntimeInfo 未实现（panel 单测 mockApi 无该方法）
    // /抛错/返回 undefined → 用真实 Analyser 源（TtsMouthSource 无 AudioContext 时静默降级 sample 恒 0，不崩既有用例）。
    const rt = await Promise.resolve(
      typeof api.getRuntimeInfo === 'function' ? api.getRuntimeInfo() : undefined
    ).catch(() => undefined)
    mockMouthLevel = rt?.mockMouthLevel
    mouthSource?.dispose() // 防御：重复 init 不泄漏旧源（正常路径 dispose 已清，此处兜底）
    mouthSource =
      mockMouthLevel === 'step'
        ? createStepMouthSource()
        : mockMouthLevel === 'sine'
          ? createSineMouthSource()
          : buildMouthSource()
    const ctrl = ensureController()
    setupVisibilityWatch() // C2：可见性接线（「布局可见 ∧ enabled」→ setVisibility；immediate 先推当前值）
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
    setupMouthWatch() // C1：口部接线（TTS 播放 → attach → tick 采样）
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
    stateSourceHandle?.unsub() // 退订 stateSource（停 watch + 清 N1 mood/error 回退 timers）
    stateSourceHandle = null
    unsubMouthWatch?.() // C1：退订口部接线（停 watch）
    unsubMouthWatch = null
    mouthSource?.dispose() // C1：释放口部数据源（断开 graph + close AudioContext，无残留）
    mouthSource = null
    mouthAttached = false
    mockMouthLevel = undefined
    mouthLevel.value = 0
    unsubVisibility?.() // C2：退订可见性接线
    unsubVisibility = null
    unsubDevice?.()
    unsubDevice = null
    unsubState?.() // 退订 'state' 事件镜像
    unsubState = null
    if (controller) {
      controller.unload() // 全量释放（含 adapter.destroy：unregister contextlost + 清 GL 引用）
      controller = null
    }
    ready = false
    rebuildGuard = false // C2：重建守卫复位（dispose 后重建不可能再触发）
    lastLookTarget = null // C2：视线目标复位
    models.value = []
    status.value = 'unloaded'
    modelId.value = null
    error.value = ''
    characterState.value = 'offline'
    directiveExpressionActive.value = false // C3：指令瞬态复位（stateSource 退订后无 onDirectiveEnd 可清）
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

  /** 视线目标转发（Panel 鼠标跟随/回正，D5B-09）：null = 回正。C2：记录 lastLookTarget——GPU 重建后
   *  unload 会清 controller 侧目标，重建成功经 setLookTarget 重放（D5C-04）。 */
  function setLookTarget(target: NormalizedPoint | null): void {
    lastLookTarget = target
    controller?.setLookTarget(target)
  }

  /** 点击预设动作转发（Panel 点击画布；priority=1 低优先，仲裁在 controller） */
  function playTapMotion(priority: number): void {
    controller?.playTapMotion(priority)
  }

  /** 渲染 tick（Panel rAF 循环驱动 → controller.tick → adapter.update+draw；GPU-lost 由 controller 捕获并
   *  emit device_lost → 本 store 镜像 fallback）。无 controller（未 init / disabled）时 no-op。
   *  C1：attach 态下先把口部源采样电平喂 controller（setMouthLevel）；detach 后不再采样（归 0 由 watch 完成）。 */
  function tick(): void {
    if (!controller) return
    if (mouthAttached && mouthSource) {
      const lvl = mouthSource.sample()
      mouthLevel.value = lvl
      controller.setMouthLevel(lvl)
    }
    controller.tick()
  }

  // —— Task 4（C3）：后端 Live2D 表现指令建议消费（live2d.directive，经 messageStore.applyEvent 分发路径）——

  /** 校验/脱敏/指令>emotion：
   *   ① state ∈ 七值（越界丢弃整条 + 脱敏 warn）；priority clamp ≤1；durationMs ∈ [0,30000]（越界 clamp）；
   *   ② state → stateSource.pushDirective（建议强度仲裁在 state-source 入口守卫——指令永不覆盖 client 2/3 级现实态）；
   *   ③ 指令 expression 优先发射（后置于 state push，使指令表达式为最终生效表达式）；白名单未命中 → 脱敏 warn
   *      （不记 payload 原文）；expression 成功 → 置 directiveExpressionActive 抑制 emotion→表情自动映射
   *      （仅指令瞬态实际置入时——拒绝路径无瞬态可清，不抑制）；
   *   ④ 指令 motion → controller.playMotion(file, clampedPriority, durationMs)；
   *   ⑤ 无有效载荷 → 忽略 + 脱敏 warn。 */
  function handleDirective(event: Live2DDirectiveEvent): void {
    const ctrl = controller
    const state = event.state
    // ① 校验：state ∈ 七值（越界丢弃整条）
    if (state !== undefined && !DIRECTIVE_STATES.has(state)) {
      console.warn('[live2d] directive state 无效', { modelId: ctrl?.modelId ?? null, code: 'directive_invalid' })
      return
    }
    // ⑤ 无有效载荷 → 忽略 + 脱敏 warn
    if (state === undefined && event.expression === undefined && event.motion === undefined) {
      console.warn('[live2d] directive 无有效载荷', { modelId: ctrl?.modelId ?? null, code: 'directive_invalid' })
      return
    }
    const clampedPriority = Math.min(1, event.priority ?? 0) // priority clamp ≤1（不覆盖 client 2/3 级现实态）
    const durationMs = event.durationMs === undefined ? undefined : Math.min(30000, Math.max(0, event.durationMs))
    // ② 指令态 → pushDirective（返回是否实际置入——决定 ③ 是否抑制 emotion 自动映射）
    const accepted = state !== undefined
      ? (stateSourceHandle?.pushDirective(state, clampedPriority, durationMs) ?? false)
      : false
    // ③ 指令>emotion：指令 expression 优先发射（后置于 state push——last-writer-wins 使指令表达式为最终生效）
    if (event.expression !== undefined) {
      const ok = ctrl?.setExpression(event.expression) ?? false
      if (ok) {
        directiveExpressionActive.value = accepted
      } else {
        console.warn('[live2d] directive expression 未命中白名单', { modelId: ctrl?.modelId ?? null, code: 'directive_miss' })
      }
    }
    // ④ 指令 motion
    if (event.motion !== undefined) {
      ctrl?.playMotion(event.motion, clampedPriority, durationMs)
    }
  }

  return {
    models, status, modelId, error, live2dSettings, characterState, mouthLevel,
    init, switchModel, dispose, tick, handleDirective,
    setAutoMotions, setLipSync, setPerformanceMode, setViewTransform, setLookTarget, playTapMotion
  }
})