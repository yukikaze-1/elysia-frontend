// apps/desktop/src/renderer/src/live2d/controller.ts
// 阶段 5 批次 A（A6，spec §3.6/D5A-10）：Live2DController——Live2DAdapter 的上层状态机收口。
// 状态机：unloaded → loading → ready | failed → fallback（device_lost(adapter 抛 Live2DGpuLostError)→
// failed → fallback，静态头像回退；重建策略归批 C）。init 用 adapter.initialize + 默认模型（list 里第一个
// available；settingsStore 已选 modelId 时 store 随后 switchModel 覆盖）；switchModel 停当前 → adapter.createModel
// → 成功原子替换（失败保留原 modelId 置 error，旧 handle 继续渲染）；unload 全量释放（含 adapter.destroy，
// 供 store.dispose 无残留）；reset 释放后重建默认模型。setState/setExpression/playMotion/setMouthLevel/
// setLookTarget 为批次 A no-op 占位（批次 B 落地，YAGNI）。
//
// 约定：adapter.createModel 的 model3Path 恒传 'model3.json'（Task 4 装配强制该文件存在且 manifest.modelFile
// 指向之；Controller 不读 summary.modelFile——Minor G）。事件极简：'device_lost'（GPU-lost → 上层回退）、
// 'status'（每次状态迁移广播）、'error'（switchModel 失败，载荷为 Error）。
import { Live2DGpuLostError, type Live2DAdapter, type Live2DModelHandle } from './adapter'
import { FrameBudget } from './perf'
import type { Live2DModelSummary, PerformanceMode } from '@shared/contracts'
import {
  CharacterStateMachine,
  type CharacterState
} from './state-machine'
import {
  blinkTarget,
  breathTarget,
  mouthLevelTarget,
  PARAM_ANGLE_X,
  PARAM_ANGLE_Z,
  PARAM_EYE_L_OPEN,
  PARAM_EYE_L_SMILE,
  PARAM_EYE_R_OPEN,
  PARAM_EYE_R_SMILE,
  PARAM_EYE_BALL_X,
  PARAM_EYE_BALL_Y,
  type AnimClock
} from './param-anim'

export type Live2DControllerStatus = 'unloaded' | 'loading' | 'ready' | 'failed' | 'fallback'

/** 归一化视线目标（doc 05 §11 / spec I-2）：画布相对坐标 ∈ [-1,1]（原点居中）；null = 回正 */
export interface NormalizedPoint {
  x: number
  y: number
}

// —— B4 无动作参数级回退（spec §3.4）值域常量（存在性判定由 controller 在 paramIds 上做，此处定义目标值）——
const B4_THINK_SWAY_AMP = 0.08 // thinking：ParamAngleX 轻微摇摆幅度（±0.08，轻微点头/摇摆）
const B4_SPEAK_TILT = 0.05 // speaking：ParamAngleZ 轻微头动作幅度（±0.05）
const B4_SMILE = 0.8 // happy：ParamEye{LR}Smile 笑眼（0.8，明显但不夸张）
const B4_SURPRISE_OPEN = 1 // surprised：ParamEye{LR}Open 瞪大（拉到 1）
const B4_ERROR_TILT = -0.15 // error：ParamAngleZ 轻微歪头（-0.15）

// —— Task 4（B3 动作调度仲裁，spec §3.3 / I-3 / I-1）——
const MOTION_DEBOUNCE_MS = 500 // 同动作短时重复合并去抖（~500ms）
const MOTION_MAX_MS = 15000 // 长动作最大时长上限（~15s 超时停，stopMotion 回退）
// 点击预设动作 priority=1（Task 5 Panel 触发；I-3：低优先级不打断 speaking/thinking 2 级与 error 3 级）

// —— I-1 情绪→表情本地映射表——具体文件名以该模型 manifest 实际含有的（如 Haru F01-F08）为准：
//    优先按语义关键词命中（happy/sad/surprised），缺省退化到语义最接近的 F 编号；全部不命中 → 落 B4 参数级。
//    M-2 注：f01/f02/f06 为 Haru F 系列语义猜测（F01 待机/中性、F02 悲伤、F06 惊讶），批次 C/D 真实
//    联调时按目标模型 manifest 的 F 编号含义验证并按需调整映射。 */
/** 情绪态（本地映射命中 → setExpression；未知码/不命中落 B4） */
export type MoodEmotion = 'happy' | 'sad' | 'surprised'
const MOOD_EXPRESSION_KEYWORDS: Record<MoodEmotion, readonly string[]> = {
  happy: ['happy', 'f01'],
  sad: ['sad', 'f02'],
  surprised: ['surprised', 'f06']
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

export interface Live2DControllerDeps {
  /** 渲染适配器（真实 webglEngine 或单测 fake） */
  adapter: Live2DAdapter
  /** 模型摘要清单（真实走 preload live2d:list-models；单测注入 fake registry） */
  list: () => Promise<Live2DModelSummary[]>
}

export type Live2DControllerEvent = 'device_lost' | 'status' | 'error' | 'state'
type EventListener = (payload?: unknown) => void

/** 极简事件发射器（on/emit；on 返回退订函数） */
export class Live2DController {
  private readonly adapter: Live2DAdapter
  private readonly list: () => Promise<Live2DModelSummary[]>
  private handle: Live2DModelHandle | null = null
  private canvas: HTMLCanvasElement | null = null
  private currentId: string | null = null
  private currentStatus: Live2DControllerStatus = 'unloaded'
  private visible = true
  private perfMode: PerformanceMode = 'auto'
  // C2（批次 C，D5C-03）：FrameBudget 降帧门——按 perfMode 决定每帧是否推进整段 tick（动画+draw 原子跳过）。
  // 字段声明在 perfMode 之后（初始化依赖 perfMode 已赋值）；setPerformanceMode 热切换经 budget.setMode。
  private budget: FrameBudget = new FrameBudget(this.perfMode)
  private switching = false // switchModel 重入串行守卫（独立于 status：init 内部也置 loading 后调 switchModel）
  private listeners = new Map<Live2DControllerEvent, Set<EventListener>>()

  // —— 批次 B（Task 3，B1/B2/B4 controller 内核）——
  private readonly stateMachine = new CharacterStateMachine() // 服务状态机（收敛表）
  private paramIds = new Set<string>() // 当前模型参数 Id 集（getParameterIdList，存在性判定/路由）
  private motionWhitelist = new Set<string>() // 当前模型 motion 摊平白名单（I-4 唯一标识）
  private expressionWhitelist = new Set<string>() // 当前模型 expression 摊平白名单
  private mouthLevel = 0 // setMouthLevel 口型电平 [0,1]（数据源归批次 C，本批只落写入原语）
  private lookTarget: NormalizedPoint | null = null // setLookTarget 视线目标（null=回正）
  private autoMotions = true // 待机动画开关（Task 5 由 settingsStore.autoMotions 驱动）
  private lipSync = true // M5（Task 5）：口型独立门——与 autoMotions 正交：口型(mouthLevel→ParamMouthOpenY)
  // 仅受 autoMotions ∧ lipSync 共同控制；待机眨眼/呼吸仍仅受 autoMotions 控制。
  // —— Task 4（B3 调度仲裁状态）——
  private motionLastTs = new Map<string, number>() // file → 最近播放时间戳（同动作短时重复合并去抖）
  private motionTimeouts = new Map<string, ReturnType<typeof setTimeout>>() // file → 长动作最大时长超时 timer
  // 待机动画时钟：每实例采样一次确定性随机源（Math.random 在字段初始化时求值一次、此后稳定返回同一值），
  // → 同会话眨眼/呼吸序列逐帧稳定回放（避免每帧新 seed 造成眨眼闪烁）；单测可注入固定 AnimClock。 */
  private readonly animSeed: number = (Math.random() * 0xffffffff) >>> 0
  private readonly animClock: AnimClock = {
    random: (): number => this.animSeed / 0xffffffff
  }
  private animT0 = 0 // 待机动画时间基（秒）；tick 内以 performance.now() 折算

  constructor(deps: Live2DControllerDeps) {
    this.adapter = deps.adapter
    this.list = deps.list
  }

  get status(): Live2DControllerStatus {
    return this.currentStatus
  }

  get modelId(): string | null {
    return this.currentId
  }

  /** 初始化：adapter.initialize + 默认模型（list 里第一个 available）。GL 创建失败/无可用模型 → fallback
   *  （静态头像回退，不阻塞聊天）。已 ready/loading 时幂等返回。 */
  async init(canvas: HTMLCanvasElement): Promise<void> {
    if (this.currentStatus === 'ready' || this.currentStatus === 'loading') return
    if (!this.adapter.initialize(canvas)) {
      // context 创建失败 → 静态头像回退（A2 initialize 返回 false，不抛）
      this.canvas = canvas
      this.setStatus('fallback')
      return
    }
    this.canvas = canvas
    this.setStatus('loading')
    try {
      const models = await this.list()
      const first = models.find((m) => m.available)
      if (!first) {
        // 无可用的本地模型 → 静态头像回退（不放 loading 悬置）
        this.setStatus('fallback')
        return
      }
      await this.switchModel(first.id)
    } catch (e) {
      this.setStatus('failed')
      this.emit('error', e)
      throw e
    }
  }

  /** 切换模型：停当前（成功后原子替换）→ adapter.createModel → 成功替换 handle/id；失败保留原 modelId
   *  与旧 handle（继续渲染），置 status=failed 并 rethrow（store 捕获置 error）。model3Path 恒 'model3.json'。
   *  @returns 实际生效 id（D5B-10/T6 竞态硬化）：成功=目标 id；守卫丢弃（同模型幂等/切换中）= 旧 id（currentId）；
   *           失败 = 抛错（调用方照旧保留旧 id）。签名由批次 A `Promise<void>` 改为 `Promise<string>`——
   *           忽略返回值的既有调用（live2dStore 旧版）仍编译（Promise<string> 兼容 Promise<void> 消费位）。 */
  async switchModel(id: string): Promise<string> {
    if (this.currentId === id && this.currentStatus === 'ready') return id // 同模型幂等
    if (this.switching) return this.currentId ?? id // 切换中串行守卫（store 串行化，防重入；旧 id 丢弃）
    this.switching = true
    this.setStatus('loading')
    try {
      const next = await this.adapter.createModel({ modelId: id, model3Path: 'model3.json' })
      this.handle?.destroy()
      this.handle = next
      this.currentId = id
      this.cacheModelFacts() // 参数 Id 集 + motion/expression 白名单（B2/B4 路由与白名单核查的来源）
      next.stopAll() // 清队列（spec §3.3：模型快速切换时清队列，新模型无历史动作）
      this.clearMotionSchedule() // 切换清调度状态（去抖/超时 timer）
      this.setStatus('ready')
      return id
    } catch (e) {
      // 失败保留原模型：handle/currentId 不动（facts 缓存亦不动）；有旧 handle（切换前已 ready）回 ready，否则 failed
      this.setStatus(this.handle ? 'ready' : 'failed')
      this.emit('error', e)
      throw e
    } finally {
      this.switching = false
    }
  }

  /** 全量释放（store.dispose 调用）：释放当前模型 + adapter.destroy（unregister contextlost + 清 GL 引用），
   *  回到 unloaded。adapter 可随后 init 重建（重新创建 GL context）。幂等。 */
  unload(): void {
    this.adapter.destroy()
    this.handle = null
    this.currentId = null
    this.paramIds = new Set()
    this.motionWhitelist = new Set()
    this.expressionWhitelist = new Set()
    this.lookTarget = null
    this.mouthLevel = 0
    this.clearMotionSchedule()
    this.setStatus('unloaded')
  }

  /** 渲染 tick（Panel rAF 循环驱动）：ready 态先驱动待机动画参数（blink/breath + B4 参数级回退，经
   *  `handle.setParam` 写入——批次 A Panel rAF 循环经 store.tick()→controller.tick() 每帧调用，本批沿用该
   *  既有入口做动画驱动，无需新增独立 rAF），再 adapter.update（update 内喂 motion/expr → physics → model.update）。
   *  GPU-lost（adapter 抛 Live2DGpuLostError）→ failed → emit device_lost → fallback（静态头像，重建归批 C）；
   *  其他异常静默吞掉（不崩溃渲染循环）。隐藏/非 ready 时 no-op。 */
  tick(): void {
    if (this.currentStatus !== 'ready' || !this.visible) return
    // C2（批次 C，D5C-03）：FrameBudget 降帧门——skip 帧（shouldDraw false）时整段动画+draw 原子跳过
    // （不 updateAnimation、不 adapter.update、不产生 draw）。视线跟随 lerp 在 Panel 侧（CyLive2DPanel loop
    // 的 applyLookTween），skip 帧仍执行（廉价、保平滑，D5C-03）。
    const now = performance.now()
    if (!this.budget.shouldDraw(now)) return
    const t0 = performance.now()
    try {
      this.updateAnimation(now)
      this.adapter.update()
      this.budget.feedCost(performance.now() - t0) // 实际帧耗时喂 EMA（balanced 自适应/auto 迟滞依据；失败帧不计）
    } catch (e) {
      if (e instanceof Live2DGpuLostError) {
        this.handle?.destroy()
        this.handle = null
        this.setStatus('failed')
        this.emit('device_lost')
        this.setStatus('fallback')
      } else {
        // 其他渲染异常：记录但不崩循环（组件级错误态已覆盖）
        this.emit('error', e)
      }
    }
  }

  /** 重建：全量释放后按目标模型重新加载（D5C-04 扩展）。目标 = modelId 有值且仍 available ? modelId : 首个
   *  available；无 available → fallback（静态头像）。canvas 未持有（未 init）时仅复位。initialize 抛错
   *  （半初始化，Task5 P3）由 adapter 侧 try/finally 释放部分 context 后向上传播。
   *  @param modelId 目标模型 id（null/undefined 均视为「未指定」→ 首个 available；store 重建传当前 modelId）。 */
  async reset(modelId?: string | null): Promise<void> {
    const canvas = this.canvas
    this.unload()
    if (!canvas) return
    if (!this.adapter.initialize(canvas)) {
      this.setStatus('fallback')
      return
    }
    this.setStatus('loading')
    try {
      const models = await this.list()
      const target =
        modelId != null && models.some((m) => m.id === modelId && m.available)
          ? modelId
          : models.find((m) => m.available)?.id
      if (!target) {
        this.setStatus('fallback')
        return
      }
      await this.switchModel(target)
    } catch (e) {
      this.setStatus('failed')
      this.emit('error', e)
      throw e
    }
  }

  /** 可见性（布局级隐藏时停渲染循环，不产生帧；不销毁资源） */
  setVisibility(v: boolean): void {
    this.visible = v
  }

  /** 性能模式（批次 A 仅记录；批次 C 消费——FrameBudget 热切换 setMode：重置 autoTarget/streaks/first，
   *  下次 tick 首帧必画） */
  setPerformanceMode(m: PerformanceMode): void {
    this.perfMode = m
    this.budget?.setMode(m)
  }

  get performanceMode(): PerformanceMode {
    return this.perfMode
  }

  // —— 批次 B（Task 3，B1/B2/B4 真实实现；Task 4 接调度与 state source）——

  /** 服务状态机命令：喂 CharacterStateMachine（source/外部已仲裁的最终态，机器直接采纳，见 state-machine 注）。
   *  驱动 B4 参数级回退路由与状态徽标。无 handle（unloaded/loading）时仅更新机器状态，不写参数。
   *  进入情绪态（happy/sad/surprised）时经本地映射表发射表情（I-1：白名单命中 → setExpression；
   *  不命中落 B4 参数级，由 tick 内 b4Params 承担）。 */
  setState(s: CharacterState): void {
    const prev = this.stateMachine.state
    this.stateMachine.setState(s)
    if (s !== prev) {
      if (s === 'happy' || s === 'sad' || s === 'surprised') {
        this.emitMoodExpression(s)
      }
      this.emit('state', s) // 状态徽标订阅（Task 5：store 经 'state' 事件镜像 characterState）
    }
  }

  get characterState(): CharacterState {
    return this.stateMachine.state
  }

  /** 待机动画开关（Task 5 由 settingsStore.live2d.autoMotions 驱动；默认 true——P0 待机眨眼/呼吸成立）。 */
  setAutoMotions(v: boolean): void {
    this.autoMotions = v
  }

  get autoMotionsEnabled(): boolean {
    return this.autoMotions
  }

  /** 口型独立门（M5，Task 5，spec D5B-08 lipSync）——与 autoMotions 正交：口型电平写入仅受
   *  autoMotions ∧ lipSync 共同控制（updateAnimation 通用口部步骤按门开写 mouthLevel / 门关写 0 清态）。 */
  setLipSync(v: boolean): void {
    this.lipSync = v
  }

  get lipSyncEnabled(): boolean {
    return this.lipSync
  }

  /** 口型电平：[0,1] → 存口型电平（口型数据源 TtsMouthSource 归批次 C1，每帧经 updateAnimation 通用口部步骤
   *  把电平写进口部参数 ParamMouthOpenY——对所有 ready 模型生效，门 = autoMotions ∧ lipSync）。 */
  setMouthLevel(level: number): void {
    this.mouthLevel = Math.min(1, Math.max(0, level))
  }

  /** 视图变换（Task 5 Panel 缩放/偏移手柄，spec D5B-10/doc 05 §13）：scale∈[0.5,3]、offsetX/Y∈[-2,2] →
   *  转 handle 写 MVP 视图变换（computeMvp 内钳制），即时预览走下一帧 tick 重绘。无 handle（unloaded/
   *  loading）时 no-op——store.init 会在 handle 就绪后重放当前 settings 的 scale/offset。 */
  setViewTransform(scale: number, offsetX: number, offsetY: number): void {
    this.handle?.setViewTransform(scale, offsetX, offsetY)
  }

  /** 视线目标（spec I-2）：null = 回正（视线参数回 0）；非 null 经 ParamEyeBallX/Y 存在性判定写入。
   *  只存目标，逐帧驱动由 updateAnimation 完成（Task 5 Panel mouseleave → setLookTarget(null) 平滑回正）。 */
  setLookTarget(target: NormalizedPoint | null): void {
    this.lookTarget = target
  }

  /** 表情：文件路径 ∈ 当前模型 expression 白名单（I-4 唯一标识 = 摊平文件路径）→ `handle.startExpression`；
   *  白名单外/无 handle → 忽略（不抛错，spec §3.3）。完整情绪→表情映射（I-1）归 Task 4；本 task 落白名单核查分派。 */
  setExpression(file: string): void {
    const handle = this.handle
    if (!handle || !this.expressionWhitelist.has(file)) return
    const modelId = this.currentId
    if (!modelId) return
    void handle.startExpression(modelId, file)
  }

  /** 动作播放（spec §3.3 / I-3 / I-4）：文件路径 ∈ 当前模型 motion 白名单 →
   *  `handle.startMotion`（优先级入队）。仲裁：
   *   - 白名单外/无 handle → 忽略（不抛错）；
   *   - 低优先级不打断 3 级态；speaking/thinking（2 级）激活时不发点击（priority=1）动作（I-3）；
   *   - 模型未就绪（unloaded/loading）时只记最新状态不播放；
   *   - 同动作短时重复合并（去抖 ~500ms）；
   *   - 长动作最大时长上限（~15s 超时 stopMotion 回退）；
   *   - 会话/模型快速切换经 switchModel/unload 清队列 + 清调度状态。 */
  playMotion(file: string, priority: number): void {
    const handle = this.handle
    if (!handle || !this.motionWhitelist.has(file)) return // 白名单外忽略
    const modelId = this.currentId
    if (!modelId) return
    // I-3 优先级仲裁：当前 3 级态（error/waiting_permission）不被任何低优先级动作打断；
    // speaking/thinking（2 级）激活时不发点击（priority≤1）动作。
    const curP = this.stateMachine.priority
    if (priority < curP) return
    // 模型未就绪：return 直接丢弃本次 playMotion（业务态由 stateSource/setState 跟踪，动作不缓存）
    if (this.currentStatus !== 'ready') return
    // 同动作短时重复合并去抖
    const now = Date.now()
    const last = this.motionLastTs.get(file)
    if (last !== undefined && now - last < MOTION_DEBOUNCE_MS) return
    this.motionLastTs.set(file, now)
    // 长动作最大时长上限（超时停）
    const prev = this.motionTimeouts.get(file)
    if (prev) clearTimeout(prev)
    this.motionTimeouts.set(
      file,
      setTimeout(() => {
        this.motionTimeouts.delete(file)
        handle.stopMotion(priority) // 回退（Controller 层仲裁；底层按 stopAll 语义）
      }, MOTION_MAX_MS)
    )
    void handle.startMotion(modelId, file, priority)
  }

  /** 点击预设动作（Task 5 Panel 点击画布触发，spec §3.3 / I-3）：从当前模型 motion 白名单解析语义最接近
   *  「tap/greeting/touch/knock」的动作文件，经 playMotion 标准仲裁（priority=1 低优先——不打断
   *  speaking/thinking(2) 与 error/waiting_permission(3)；白名单不命中/无动作模型 → 静默忽略，不伪造）。 */
  playTapMotion(priority: number): void {
    const file = this.resolveTapMotion()
    if (file) this.playMotion(file, priority)
  }

  /** 订阅事件；返回退订函数 */
  on(event: Live2DControllerEvent, cb: EventListener): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(cb)
    return () => {
      set?.delete(cb)
    }
  }

  // —— 批次 B（B2/B4）内部：模型事实缓存 + 待机动画逐帧驱动 ——

  /** switchModel 成功后缓存当前模型的参数 Id 集 + motion/expression 摊平白名单（B2/B4 路由与白名单核查来源）。
   *  handle 暴露的白名单与本 adapter 内自据 model3 FileReferences 摊平的白名单同源（Task 2），Controller 据此
   *  先查后发（spec I-4）。 */
  private cacheModelFacts(): void {
    if (!this.handle) return
    this.paramIds = new Set(this.handle.getParameterIdList())
    this.motionWhitelist = new Set(this.handle.getMotionFileWhitelist())
    this.expressionWhitelist = new Set(this.handle.getExpressionFileWhitelist())
  }

  /** 待机动画逐帧驱动（每 tick 一次，ready 且 autoMotions 时）：把待机/参数级动画结果写成「要写的参数→值」，
   *  Controller 逐对 `handle.setParam`。存在性判定已由 param-anim 纯函数/B4 映射在内部完成（该模型不含的参数
   *  不写）。分层：
   *   - 待机基（B2，autoMotions 时）：blink（眨眼）+ breath（呼吸正弦）——与模型是否有动作系统无关（待机常态）。
   *   - B4 参数级回退（当前模型无动作系统 motionWhitelist 空时才写）：按当前 CharacterState 映射参数近似
   *     （spec §3.4 表：thinking→AngleX 摇摆；speaking→口型+轻微头；happy→眼笑+呼吸；surprise→眼瞪大；
   *     error→AngleZ 歪头）；有动作系统 → 走 B3 动作系统（Task 4 调度），不写参数级。
   *   - 视线（setLookTarget，spec I-2）：null→回正 0；非 null→ParamEyeBallX/Y。
   *  本批动画时间以 `performance.now()` 折算（tick 每帧推进，Panel rAF 循环驱动），无独立 rAF。 */
  private updateAnimation(nowMs: number): void {
    const handle = this.handle
    if (!handle) return
    if (this.animT0 === 0) this.animT0 = nowMs / 1000
    const tSec = (nowMs / 1000) - this.animT0

    const out: Record<string, number> = {}
    if (this.autoMotions) {
      // 待机基：眨眼 + 呼吸（存在性判定在纯函数内）
      Object.assign(out, blinkTarget(tSec, this.paramIds, this.animClock))
      Object.assign(out, breathTarget(tSec, this.paramIds))
      // B4 参数级回退（仅无动作系统模型）
      if (this.motionWhitelist.size === 0) {
        Object.assign(out, this.b4Params(this.stateMachine.state))
      }
    }
    // C1（批次 C，D5C-02 通用口部步骤）：对所有 ready 模型写 ParamMouthOpenY——不再限于 b4Params no-motion
    // 分支（主验收模型 Haru 有动作，电口同样必须写）。门 = autoMotions ∧ lipSync（M5）：门开写 mouthLevel
    // 电平、门关写 0 清态（不残留上一帧开合）。B3 动作后写（adapter.update 内 motion manager 写同参）在本步骤
    // 之后执行 → 自然覆盖电口（相同口部参数动作值赢）；本步骤替换批次 B 旧 M5 门块（不叠加双写）。
    Object.assign(out, mouthLevelTarget(this.lipSync && this.autoMotions ? this.mouthLevel : 0, this.paramIds))
    // 视线（独立于 autoMotions：鼠标跟随/回正不受待机开关约束）
    if (this.lookTarget) {
      if (this.paramIds.has(PARAM_EYE_BALL_X)) out[PARAM_EYE_BALL_X] = clamp(this.lookTarget.x, -1, 1)
      if (this.paramIds.has(PARAM_EYE_BALL_Y)) out[PARAM_EYE_BALL_Y] = clamp(this.lookTarget.y, -1, 1)
    } else {
      if (this.paramIds.has(PARAM_EYE_BALL_X)) out[PARAM_EYE_BALL_X] = 0 // 回正
      if (this.paramIds.has(PARAM_EYE_BALL_Y)) out[PARAM_EYE_BALL_Y] = 0
    }

    for (const [id, value] of Object.entries(out)) {
      handle.setParam(id, value)
    }
  }

  /** B4 无动作参数级回退（spec §3.4 表）：状态→参数近似。全部存在性判定（不在 paramIds 就不写），不记错误。
   *  口部电平由 updateAnimation 通用口部步骤写出（C1，D5C-02），不在本分支写（避免叠加双写）。 */
  private b4Params(state: CharacterState): Record<string, number> {
    const out: Record<string, number> = {}
    switch (state) {
      case 'thinking':
        // 轻微 AngleX 摇摆 + 眨眼加快（眨眼加快由 B2 待机眨眼承担，此处额外给头轻微左右摆）
        if (this.paramIds.has(PARAM_ANGLE_X)) out[PARAM_ANGLE_X] = B4_THINK_SWAY_AMP * Math.sin(this.wobbleT())
        break
      case 'speaking':
        // 头轻微动作属待机动画（仅 autoMotions）。口部电平由 updateAnimation 通用口部步骤写出（C1，D5C-02），
        // 不再在本分支写口部（避免与通用步骤叠加双写）。
        if (this.paramIds.has(PARAM_ANGLE_Z)) out[PARAM_ANGLE_Z] = B4_SPEAK_TILT * Math.sin(this.wobbleT())
        break
      case 'happy':
        // 眼睛笑 + 呼吸（呼吸由 B2 承担，这里给笑眼）
        if (this.paramIds.has(PARAM_EYE_R_SMILE)) out[PARAM_EYE_R_SMILE] = B4_SMILE
        if (this.paramIds.has(PARAM_EYE_L_SMILE)) out[PARAM_EYE_L_SMILE] = B4_SMILE
        break
      case 'surprised':
        // 眼睛睁大（拉大）
        if (this.paramIds.has(PARAM_EYE_R_OPEN)) out[PARAM_EYE_R_OPEN] = B4_SURPRISE_OPEN
        if (this.paramIds.has(PARAM_EYE_L_OPEN)) out[PARAM_EYE_L_OPEN] = B4_SURPRISE_OPEN
        break
      case 'error':
        // AngleZ 轻微歪头
        if (this.paramIds.has(PARAM_ANGLE_Z)) out[PARAM_ANGLE_Z] = B4_ERROR_TILT
        break
      default:
        // idle/offline/listening/working/waiting_permission/happy/sad 等无需额外参数级近似
        break
    }
    return out
  }

  /** B4 轻微摆头的慢摆时间基（复用待机动画时间，周期 ~4s） */
  private wobbleT(): number {
    const tSec = Math.max(0, (this.animT0 === 0 ? 0 : performance.now() / 1000 - this.animT0))
    return tSec * Math.PI * 0.5 // 周期 ~4s
  }

  // —— Task 4（B3 调度 + I-1 情绪→表情）内部 ——

  /** 清空动作调度状态（切换模型/卸载时调用，spec §3.3「会话/模型快速切换时清队列」）：停掉所有长动作超时
   *  timer + 清去抖时间戳（防「上个模型的去抖时间戳残留导致新模型同路径动作被误合并」）。 */
  private clearMotionSchedule(): void {
    for (const t of this.motionTimeouts.values()) clearTimeout(t)
    this.motionTimeouts.clear()
    this.motionLastTs.clear()
  }

  /** I-1：情绪态（happy/sad/surprised）经本地映射表 → 白名单内表情文件路径 → setExpression；
   *  不命中 → 落 B4（tick 内 b4Params 对 happy/surprised 做参数级近似；sad 无近似为正常）。 */
  private emitMoodExpression(mood: MoodEmotion): void {
    const file = this.emotionToExpression(mood)
    if (file) this.setExpression(file)
  }

  /** 本地映射表解析：语义关键词命中 → 白名单内表情路径（如 Haru F01-F08 语义最接近的 F 编号）；无则 undefined。 */
  private emotionToExpression(mood: MoodEmotion): string | undefined {
    const keywords = MOOD_EXPRESSION_KEYWORDS[mood]
    if (!keywords) return undefined
    for (const kw of keywords) {
      for (const f of this.expressionWhitelist) {
        if (f.toLowerCase().includes(kw)) return f
      }
    }
    return undefined
  }

  /** 点击预设动作文件解析（I-4：动作唯一标识 = 摊平文件相对路径）：依次按 tap/greeting/touch/knock 语义
   *  关键词在 motionWhitelist 中找第一个命中；无 → undefined（调用方 playTapMotion 静默忽略）。 */
  private resolveTapMotion(): string | undefined {
    const KEYWORDS = ['tap', 'greeting', 'touch', 'knock']
    for (const kw of KEYWORDS) {
      for (const f of this.motionWhitelist) {
        if (f.toLowerCase().includes(kw)) return f
      }
    }
    return undefined
  }

  private emit(event: Live2DControllerEvent, payload?: unknown): void {
    const set = this.listeners.get(event)
    if (set) for (const cb of Array.from(set)) cb(payload)
  }

  private setStatus(s: Live2DControllerStatus): void {
    if (this.currentStatus === s) return
    this.currentStatus = s
    this.emit('status', s)
  }
}