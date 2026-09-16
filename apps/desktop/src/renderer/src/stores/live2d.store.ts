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
import { computed, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import { Live2DAdapter } from '../live2d/adapter'
import { createDevLive2dFetch, needsIpcResourceSupply } from '../live2d/dev-resource-fetch'
import { webglEngine } from '../live2d/gl/webgl'
import { Live2DController, type Live2DControllerStatus, type NormalizedPoint } from '../live2d/controller'
import { statePriority, type CharacterState } from '../live2d/state-machine'
import { createLive2dStateSource, type Live2dStateSource } from '../live2d/state-source'
import { createSineMouthSource, createStepMouthSource, createTtsMouthSource, type MouthLevelSource } from '../live2d/tts-mouth-source'
import { decideDirective } from '../live2d/directive-rules'
import { api } from './desktop-api'
import { useSettingsStore } from './settings.store'
import { useConnectionStore } from './connection.store'
import { useMessageStore } from './message.store'
import { useVoiceStore } from './voice.store'
import { useToolStore } from './tool.store'
import { DEFAULT_LIVE2D } from '@shared/schemas'
import type { Live2DDirectiveEvent, Live2dFrameStats, Live2DModelSummary, Message, PerformanceMode } from '@shared/contracts'

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
  const adapter = new Live2DAdapter({
    engine: webglEngine,
    // dev 形态（`pnpm dev`：页面在 http://localhost:<port>）模型文件在 cyrene:// 上属跨源，
    // 而 scheme 恒 corsEnabled:false（阶段 5 D-4 安全结论）→ 原生 fetch 必被 Chromium 拒绝
    // （界面只拿到原生 Failed to fetch）。此时改用 IPC 供给，见 dev-resource-fetch.ts。
    // 打包/preview 形态页面自身即 cyrene://renderer（同源）→ 不注入，走原生 fetch，与既有行为逐字节一致。
    ...(needsIpcResourceSupply() ? { fetchImpl: createDevLive2dFetch((id, rel) => api.readLive2dModelFile(id, rel)) } : {})
  })
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
  /** L3/L4（2026-09-15 Live2D 评审）：status 实时镜像 + 渲染期 error 订阅的退订句柄 */
  let unsubStatus: (() => void) | null = null
  let unsubError: (() => void) | null = null
  /**
   * L1（2026-09-15 Live2D 评审）：生命周期世代。`init` 开始时自增并记住自己的世代，每个 await 之后自查；
   * `dispose` 也自增使在途 init 立即失效。没有它时「加载中关开关/卸载面板」会让在途 `createModel`
   * 把模型装进已被丢弃的 controller —— 纹理永不释放、status 被置回 ready 形成僵尸态。
   */
  let lifecycleGeneration = 0
  let stateSourceHandle: Live2dStateSource | null = null
  // 渲染面可见性（多套 UI 基础，2026-09-10）：由 UI 层显式告知，而非本 store 去读 layout store。
  // 「面板是否可见」是 UI 布局决策；功能层只消费结果。此前 setupVisibilityWatch 直接
  // `useLayoutStore().effective.live2dShown`，使功能层反向依赖 UI 层——换一套布局/命名的 UI 就会断。
  // 现方向反转：UI（CyLive2DPanel）观察自己的可见条件后调用 setSurfaceVisible 告知。
  const surfaceVisible = ref(false)
  // TTS 播放宿主元素（UI 经 setTtsAudioElement 告知）。用 shallowRef：只关心元素身份更换，
  // 不需要 Vue 深度代理一个 DOM 节点（对 DOM 建响应式代理既是性能负担也无意义）。
  const ttsAudioElement = shallowRef<HTMLAudioElement | null>(null)
  // C2（D5C-05）：可见性接线 watch（「可见 ∧ enabled」→ controller.setVisibility），init 时装、dispose 退订
  let unsubVisibility: (() => void) | null = null
  // C2（D5C-04）：GPU 重建一次——rebuildGuard 防重入（「每次 lost 事件一次」，finally 复位非永久）；
  // lastLookTarget 记录最近视线目标（重建后重放，unload 会清 controller 侧目标）
  let rebuildGuard = false
  let lastLookTarget: NormalizedPoint | null = null
  // C-18（#37）：重复 GPU 崩溃降级——连续 device_lost 达 GPU_LOST_MAX 仍重建失败后，停止自动重建，固定 fallback
  //（静态头像，不阻塞聊天）；consecutiveLost 在重建成功/切模型/重启用/init 成功时清零，gpuDowngraded 为冻结态。
  const GPU_LOST_MAX = 3
  let consecutiveLost = 0
  let gpuDowngraded = false
  // C1：口部数据源 + 采样接线（TTS 播放时 attach，停止/取消 detach 归零）
  let mouthSource: MouthLevelSource | null = null
  let mouthAttached = false
  let mockMouthLevel: 'step' | 'sine' | undefined
  /** C1 集成诊断（2026-08-19）：口部数据源种类（'step'/'sine' = mockMouthLevel 水合生效 / 'real' = Analyser）。
   *  集成失败转储用——区分「合成包络源未水合（读静音 → 恒 0）」与「attach/播放断链」。 */
  const mouthSourceKind = ref<'step' | 'sine' | 'real' | 'degraded' | null>(null)
  /** C1 集成稳健化（2026-08-19）：口部运动持久标志——tick 采到非零置 `mouthMoved`；attach 时重置、detach
   *  （窗口结束归零）时若 moved 则置 `mouthSettled`。供集成测试轮询**持久状态**而非瞬态采样——CI 上 SwiftShader
   *  渲染饱和 renderer 主线程时，`page.evaluate`/timer 采样会被饿死（3.75s 一次），瞬态窗口抓不住；持久标志
   *  由 tick 写入（tick 即饱和源，恒运行），外部慢轮询几次即读到。 */
  const mouthMoved = ref(false)
  const mouthSettled = ref(false)
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
        toolWaiting: () => useToolStore().waitingForApproval, // 阶段 6（Task 7）：工具等待授权 → waiting_permission
        getCurrentPriority: () => (ctrl.characterState ? statePriority(ctrl.characterState) : 0),
        onDirectiveEnd: () => {
          directiveExpressionActive.value = false
        }
      },
      (s) => ctrl.setState(s)
    )
  }

  /** C1 口部接线：依据「TTS 正在播放 ∧ 已登记音频元素」→ attach/detach 口部数据源。
   *  playing∧有元素 → attach（tick 采样）；否则 detach + 归零（controller.setMouthLevel(0) 清电口，
   *  口部关闭不残留上一帧开合——doc 05 §10 静音/暂停/取消 → 归零）。
   *
   *  多套 UI 基础（2026-09-10）：音频元素此前由本 store 去读 `voiceStore.ttsAudioEl`（即功能层伸手
   *  取 UI 的 DOM 宿主）。现改为 UI（CyTtsPlayer）经 `setTtsAudioElement` 告知——与 setSurfaceVisible
   *  同向：UI 知道自己的元素，功能层只消费。本 store 不再触碰 voice store 的 DOM 字段。 */
  function setupMouthWatch(): void {
    if (unsubMouthWatch) return
    unsubMouthWatch = watch(
      [() => useVoiceStore().tts.playing, ttsAudioElement],
      ([playing, el]) => {
        if (playing && el && mouthSource) {
          // L6（2026-09-15 Live2D 评审）：按 attach 的**真实结果**置位，而不是无条件 true——
          // 无 AudioContext / 元素被占用时此前 store 认为"已挂载"，于是每帧 sample 恒 0、口型不动，
          // 而测试探针 `getMouthInfo()` 仍报 kind:'real'，把「attach 没成功」与「确实没在说话」压成同一读数。
          mouthAttached = mouthSource.attach(el)
          if (!mouthAttached) mouthSourceKind.value = 'degraded'   // 供诊断/探针区分"没挂上"
          mouthMoved.value = false // C1 稳健化：新 TTS 会话重置「曾非零/已归零」标志（集成测据此轮询持久态）
          mouthSettled.value = false
        } else {
          mouthSource?.detach()
          mouthAttached = false
          if (mouthMoved.value) mouthSettled.value = true // 窗口结束归零：若本会话曾动过 → 置 settled
          mouthLevel.value = 0
          controller?.setMouthLevel(0)
        }
      },
      { immediate: true }
    )
  }

  /**
   * UI 告知 TTS 播放宿主元素（`<audio>`）的挂载/卸载。
   * 传入 `null` 表示宿主已卸载。本 store 只把它当作播报目标句柄，不读取任何 DOM 属性。
   */
  function setTtsAudioElement(el: HTMLAudioElement | null): void {
    if (ttsAudioElement.value === el) return
    ttsAudioElement.value = el
  }

  function ensureController(): Live2DController {
    if (controller) return controller
    const ctrl = buildController()
    controller = ctrl
    // L1：先退掉可能残留的旧订阅再覆写句柄——旧实现在此处直接覆写 unsubDevice/unsubState，
    // 一旦走到这条路径（controller 被重建）旧订阅就永久泄漏且继续驱动已死的实例。
    unsubDevice?.(); unsubDevice = null
    unsubState?.(); unsubState = null
    unsubStatus?.(); unsubStatus = null
    unsubError?.(); unsubError = null
    // device_lost（adapter 渲染 tick 抛 Live2DGpuLostError）→ C2 重建一次（rebuildAfterLost；失败镜像 fallback）
    // C-18：连续 device_lost 达 GPU_LOST_MAX → 停止自动重建，固定 fallback（gpuDowngraded 冻结）。
    // 每次 lost 前检查——已降级则不再触发（用户切模型/重启用/init 成功清零 gpuDowngraded）。
    unsubDevice = ctrl.on('device_lost', () => {
      if (gpuDowngraded) {
        status.value = 'fallback' // 已降级冻结：不再自动重建，固定静态头像
        return
      }
      consecutiveLost++
      if (consecutiveLost >= GPU_LOST_MAX) {
        gpuDowngraded = true
        status.value = 'fallback' // 连续失败达阈值 → 停止自动重建（不阻塞聊天，静态头像兜底）
      } else {
        void rebuildAfterLost()
      }
    })
    // state（Task 5）：controller.setXxx 期间引出的状态变更经 'state' 事件镜像 characterState（Panel 状态徽标）
    unsubState = ctrl.on('state', (s) => {
      if (s) characterState.value = s as CharacterState
    })
    // L3（2026-09-15 Live2D 评审）：`status` 此前只在「每次 controller 调用的 await 之后」手工镜像
    // （`syncFromController`），于是 `loading` 态**在界面上永不可达**——init/切换期间面板仍宣称
    // 「就绪 · 旧模型」，而相关 UI 分支（`v-else-if="status === 'loading'"` 与两处 case 文案）是死代码；
    // 同时它是 L1 的使能条件（dispose 判断依赖 status）。controller 每次都 `emit('status')`，
    // 这里直接订阅即可让状态迁移实时可见（保留 syncFromController 作为兜底，重复写同值无副作用）。
    unsubStatus = ctrl.on('status', (s) => {
      if (s) status.value = s as Live2DControllerStatus
      if (controller) modelId.value = controller.modelId
    })

    // L4（同批评审）：controller 的 'error' 事件此前**没有任何订阅者** ⇒ 渲染 tick 内的非 GPU 异常
    // （`drawModel`/physics/动作解码抛错）每帧被 catch 后 emit 出去、无人接收，画布死了而徽标仍显示
    // 「就绪」，用户与诊断页都拿不到原因。这里接住并落到 `error`（与加载期失败同一展示面）。
    unsubError = ctrl.on('error', (e) => {
      error.value = e instanceof Error ? e.message : String(e)
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
        // C-18 设计修正：重建成功**不**重置 consecutiveLost——设备反复 GPU 丢失时每次 device_lost 都计数
        //（崩溃即计数，重建成功仅恢复渲染不重置「崩溃次数」），达 GPU_LOST_MAX 才冻结。若重建成功就清零，
        // 真实路径「每次重建成功→清零」使连续失败永远凑不够阈值；且重建失败一次 controller 非 ready，
        // tick 不再驱动 device_lost 也不自然产生。

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

  /** C2（D5C-05）：可见性接线——「渲染面可见 ∧ enabled」→ controller.setVisibility(v)。
   *  controller.tick 首行消费（!visible 提前 return），消除 Task5 M4 死面；Panel rAF 启停保持既有（双层门控无害）。
   *  可见性来源为本 store 的 surfaceVisible（由 UI 经 setSurfaceVisible 写入），不再读 layout store。 */
  function setupVisibilityWatch(): void {
    if (unsubVisibility) return
    unsubVisibility = watch(
      [surfaceVisible, () => live2dSettings.value.enabled],
      ([shown, enabled]) => {
        controller?.setVisibility(shown && enabled)
      },
      { immediate: true }
    )
  }

  /**
   * UI 告知「渲染面当前可见」。
   * 调用方（如 CyLive2DPanel）自行组合其可见条件（视图/布局折叠/窄窗等 UI 决策），
   * 本 store 不感知这些条件，只据此决定是否暂停绘制。
   */
  function setSurfaceVisible(visible: boolean): void {
    if (surfaceVisible.value === visible) return
    surfaceVisible.value = visible
  }

  /** 镜像控制器当前状态/modelId（每次 controller 调用的 await 后同步一次，事件只覆盖异步 device_lost） */
  function syncFromController(): void {
    if (!controller) return
    status.value = controller.status
    modelId.value = controller.modelId
  }

  async function init(c: HTMLCanvasElement): Promise<void> {
    // L1：本次 init 的世代。任何一次 dispose（或新的 init）都会使旧世代失效——见下方每个 await 后的自查。
    const gen = ++lifecycleGeneration
    const stale = (): boolean => gen !== lifecycleGeneration
    // 始终取模型清单（选单 options + 可用性判断）；list 失败 fail-open：空列表 + 静态头像回退，不阻塞启动。
    //
    // 2026-09-10：**不再静默吞掉失败**。此前是 `.catch(() => [])`，清单拉取失败与
    // 「确实一个模型都没装」在界面上完全同形（都是空下拉 + 加载失败），排查只能靠复现环境。
    // 现记录原因，使失败态面板能区分这两者（fail-open 语义不变：仍不阻塞启动）。
    models.value = await api.listLive2dModels().catch((e: unknown) => {
      error.value = `模型清单读取失败：${e instanceof Error ? e.message : String(e)}`
      return []
    })
    if (stale()) return // L1：清单回来前已被 dispose/新的 init 取代 → 不再继续装配
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
        ? (mouthSourceKind.value = 'step', createStepMouthSource())
        : mockMouthLevel === 'sine'
          ? (mouthSourceKind.value = 'sine', createSineMouthSource())
          : (mouthSourceKind.value = 'real', buildMouthSource())
    const ctrl = ensureController()
    setupVisibilityWatch() // C2：可见性接线（「布局可见 ∧ enabled」→ setVisibility；immediate 先推当前值）
    try {
      await ctrl.init(c)
      if (stale()) {
        // L1：加载在途被 dispose/新 init 取代 ⇒ **卸载刚建好的 controller**（释放纹理/GL 引用），
        // 绝不把 ready 置回去（旧实现会留下"画布已不在但仍报就绪"的僵尸态）。
        ctrl.unload()
        return
      }
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
        if (stale()) {
          ctrl.unload() // L1：同上——切换到一半被 dispose 取代，卸载而不是继续装配
          return
        }
        syncFromController()
      } catch (e) {
        // 已选模型加载失败：保留默认模型，记录 error（不静默回退）
        syncFromController()
        error.value = e instanceof Error ? e.message : String(e)
      }
    }
    // M1：init 完成（含已选覆盖 switch）后才放行用户 switch；此时装配状态编排（controller 已 ready）
    // L1：装配前后各查一次世代——上面两个 await 之间可能发生 dispose（`ready = true` 与口部/状态源装配
    // 都**不能**作用在已卸载的 controller 上）。
    if (stale()) { ctrl.unload(); return }
    // Task 5：把当前 settings 表现字段一次性推给 controller（handle 已就绪；此后 Panel 对每次 setLive2d
    // 变更单独推送同款）。autoMotions/lipSync/performanceMode/scale/offset 的「设置→controller」接线落点。
    ctrl.setAutoMotions(l2d.autoMotions)
    ctrl.setLipSync(l2d.lipSync)
    ctrl.setPerformanceMode(l2d.performanceMode)
    ctrl.setViewTransform(l2d.scale, l2d.offsetX, l2d.offsetY)
    ready = true
    consecutiveLost = 0; gpuDowngraded = false // C-18：init 成功（含重启用）→ 连续失败计数/降级冻结清零
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
      consecutiveLost = 0; gpuDowngraded = false // C-18：用户主动切模型成功 → 连续失败/降级清零（主动恢复入口）
      // L2（2026-09-15 Live2D 评审）：controller 的串行化守卫在「上一次切换仍在途」时**直接返回旧 id 且不抛错**，
      // 于是 store 走"成功"分支、用户点了 C 而界面停在 B，全程零提示（`restoreDefaults` 与在途切换相撞同理）。
      // 守卫本身是有意设计（仅持久化生效 id，见 D5B-10），所以不动判据，只把"这次选择没生效"说出来。
      if (effective !== next) {
        error.value = '切换进行中，本次选择未生效（已保留当前模型）'
      }
      // D5B-10/T6：持久化「实际生效 id」而非无条件 next——守卫丢弃（切换中/同模型幂等）时持久化旧 id，消除
      // 「已加载 a 却持久化 b」窄竞态
      useSettingsStore().setLive2d({ modelId: effective })
    } catch (e) {
      // 失败保留原 modelId（controller 内部不动 currentId/handle）+ 置 error
      syncFromController()
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  /** Task5 M2（批次 C 收口）：「恢复默认」——置回 DEFAULT_LIVE2D（modelId→null）后消除「设置已重置但画布仍显旧模型」分叉：
   *  面板存活（chat 视图挂载，controller/ready 就绪）且已加载 ≠ 首个可用 → `switchModel(首个 available)`
   *  （切换画布 + 持久化生效 id）；面板已 dispose（settings 全窗 overlay 卸载 chat 视图，controller 空/models 空——
   *  真实 UI restore 落在此路径）→ 无法即时切换，改**显式持久化首个可用**（重取模型清单），面板重挂载
   *  init 读 modelId 加载它 → 画布与持久化一致。当前已是首个可用（或 modelId 本就 null）→ 不重载。 */
  async function restoreDefaults(): Promise<void> {
    const prev = live2dSettings.value.modelId
    useSettingsStore().setLive2d({ ...DEFAULT_LIVE2D })
    if (prev === null) return // 本就默认（无显式选择）→ 无需处理
    const list = models.value.length > 0 ? models.value : await api.listLive2dModels().catch(() => [])
    const first = list.find((m) => m.available)
    if (!first) return // 无可用模型（恢复默认无可切目标）
    if (controller && ready) {
      if (controller.modelId !== first.id) await switchModel(first.id)
    } else {
      // 面板已 dispose：显式持久化首个可用（settings.modelId:null 语义 = 首次可用；重挂载 init 即加载它）
      useSettingsStore().setLive2d({ modelId: first.id })
    }
  }

  function dispose(): void {
    // L1（2026-09-15 Live2D 评审）：世代栅栏——dispose 使所有在途 init 失效。
    // 修复前 `init` 的每个 await 之后无条件继续（`ready = true` + 装口部/状态源），于是「加载中关闭开关 /
    // 卸载面板」会让在途 `createModel` 把模型装进**已被丢弃的 controller**：纹理永不释放（2048² 约 33MB VRAM），
    // 且 status 会被置回 ready 形成僵尸态。递增世代后，init 在 await 边界自查并中止 + unload。
    lifecycleGeneration++
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
    unsubStatus?.() // L3：退订 'status' 事件镜像
    unsubStatus = null
    unsubError?.() // L4：退订渲染期 'error'
    unsubError = null
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
      if (lvl > 0) mouthMoved.value = true // C1 稳健化：持久标志（外部慢采样也能读到「口部曾动」）
      controller.setMouthLevel(lvl)
    }
    controller.tick()
  }

  // —— Task 4（C3）：后端 Live2D 表现指令建议消费（live2d.directive，经 messageStore.applyEvent 分发路径）——

  /**
   * 校验/脱敏/指令>emotion：
   *   ① state ∈ 七值（越界丢弃整条 + 脱敏 warn）；priority clamp ≤1；durationMs ∈ [0,30000]（越界 clamp）；
   *      —— 规则本体在 `live2d/directive-rules.ts`（纯函数，可独立单测）
   *   ② state → stateSource.pushDirective（建议强度仲裁在 state-source 入口守卫——指令永不覆盖 client 2/3 级现实态）；
   *   ③ 指令 expression 优先发射（后置于 state push，使指令表达式为最终生效表达式）；白名单未命中 → 脱敏 warn
   *      （不记 payload 原文）；expression 成功 → 置 directiveExpressionActive 抑制 emotion→表情自动映射
   *      （仅指令瞬态实际置入时——拒绝路径无瞬态可清，不抑制）；
   *   ④ 指令 motion → controller.playMotion(file, clampedPriority, durationMs)；
   *   ⑤ 无有效载荷 → 忽略 + 脱敏 warn。
   */
  function handleDirective(event: Live2DDirectiveEvent): void {
    const ctrl = controller
    const decision = decideDirective(event)
    if (!decision.accepted) {
      // 两类拒绝分开留痕：越界 state 是**契约漂移**（后端与前端对「建议态」的定义不一致），
      // 空载荷只是这一帧没有可用内容。合并成一条会让诊断时无法区分该改谁。
      if (decision.reason === 'state-out-of-range') {
        console.warn('[live2d] directive state 无效', { modelId: ctrl?.modelId ?? null, code: decision.code })
      } else {
        console.warn('[live2d] directive 无有效载荷', { modelId: ctrl?.modelId ?? null, code: decision.code })
      }
      return
    }
    // ② 指令态 → pushDirective（返回是否实际置入——决定 ③ 是否抑制 emotion 自动映射）
    const accepted = decision.state !== undefined
      ? (stateSourceHandle?.pushDirective(decision.state, decision.priority, decision.durationMs) ?? false)
      : false
    // ③ 指令>emotion：指令 expression 优先发射（后置于 state push——last-writer-wins 使指令表达式为最终生效）
    if (decision.expression !== undefined) {
      const ok = ctrl?.setExpression(decision.expression) ?? false
      if (ok) {
        directiveExpressionActive.value = accepted
      } else {
        console.warn('[live2d] directive expression 未命中白名单', { modelId: ctrl?.modelId ?? null, code: 'directive_miss' })
      }
    }
    // ④ 指令 motion
    if (decision.motion !== undefined) {
      ctrl?.playMotion(decision.motion, decision.priority, decision.durationMs)
    }
  }

  /** 性能读数（7D）：仅在 ready 态返回（否则 null——诊断页无读数）。controller 缺失/未 ready → null（M-1：无读数判定唯一来源 = status）。 */
  function getStats(): Live2dFrameStats | null {
    if (status.value !== 'ready' || !controller) return null
    return controller.getStats()
  }

  return {
    models, status, modelId, error, live2dSettings, characterState, mouthLevel, mouthSourceKind, mouthMoved, mouthSettled,
    init, switchModel, restoreDefaults, dispose, tick, handleDirective, getStats,   // 7D getStats
    setAutoMotions, setLipSync, setPerformanceMode, setViewTransform, setLookTarget, playTapMotion,
    setSurfaceVisible,   // 多套 UI 基础：可见性由 UI 告知（功能层不再读 layout store）
    setTtsAudioElement   // 多套 UI 基础：TTS 宿主元素由 UI 告知（功能层不再读 voice store 的 DOM 字段）
  }
})
