// apps/desktop/src/renderer/src/live2d/adapter.ts
// 阶段 5 批次 A（A2，spec §3.2/§4，D5A-04/D5A-11/D5A-12/D5A-13）：Live2DAdapter——Cubism Web SDK
// 5-r.5（asm.js Core 全局 + vendored Framework 源码）的最小封装。
//
// 职责：CubismFramework 生命周期（startUp→initialize 官方序列，spec I-1）→ cyrene:// 协议供给
// 模型文件（fetch cyrene://renderer/__cyrene-live2d/{modelId}/{relPath}）→ 装配 CubismModel +
// CubismRenderer_WebGL + 纹理 + 物理 → 渲染 tick（model.update + physics.evaluate + drawModel）→
// 单模型释放（renderer.release / moc.deleteModel 包装的 model.release / physics/setting 释放）。
//
// 约定：modelId 为 ASCII slug 不编码（D5A-04）；relPath 各段 encodeURIComponent 编码（中文文件名，
// 与 protocol/live2d-path.ts 的逐段 percent-decode 对齐）；FileReferences 以 model3.json 所在目录为
// base 解析；GL context 由注入的 Live2DGLEngine 创建（真实 webglEngine / 单测 fake）、纹理上限与
// GPU-lost 经 engine 探测（spec D5A-11/D5A-12）；shader 于首次 draw 前 loadShaders('/live2d/shaders/')
// （D5A-02b，renderer_webgl.ts:767 内部对 CubismShader_WebGL 实例 setShaderPath，勿直接调 setShaderPath）。
//
// Framework 释放语义：destroy() 释放「单模型」资源（组件/框架全局时序由 Controller 编排，不在适配器
// 内调 CubismFramework.dispose()——见报告偏离说明）。
//
// 信任边界（doc 07）：renderer 不解析本地路径，只经 cyrene:// 消费 Main 已校验供给的文件。
import { CubismFramework, LogLevel, Option } from '@framework/live2dcubismframework'
import { CubismModelSettingJson } from '@framework/cubismmodelsettingjson'
import { CubismMoc } from '@framework/model/cubismmoc'
import type { CubismModel } from '@framework/model/cubismmodel'
import { CubismPhysics } from '@framework/physics/cubismphysics'
import { CubismRenderer_WebGL } from '@framework/rendering/cubismrenderer_webgl'
// 批次 B（Task 2，B3 adapter 面）：motion/expression 加载播放 + Layout 装配。
// 这些模块经 framework.d.ts 的 `@framework/*` 通配 ambient 建模为 any（Framework 本体 excluded
// 于 strict vue-tsc），运行时时由 electron.vite resolve.alias `@framework` → vendored 源码交付。
import { CubismMotion } from '@framework/motion/cubismmotion'
import { CubismMotionManager } from '@framework/motion/cubismmotionmanager'
import { CubismExpressionMotion } from '@framework/motion/cubismexpressionmotion'
import { CubismExpressionMotionManager } from '@framework/motion/cubismexpressionmotionmanager'
import { CubismModelMatrix } from '@framework/math/cubismmodelmatrix'
import type { Live2DGLContextAttributes, Live2DGLEngine } from './gl/types'

/** cyrene:// live2d 供给分支前缀（与 Main 侧 protocol/live2d-path.ts 的 LIVE2D_PATH_PREFIX 对应） */
const LIVE2D_BASE = 'cyrene://renderer/__cyrene-live2d/'
/** vendored shader 的公开路径（Task 1：public/live2d/shaders/ → /live2d/shaders/） */
const SHADER_PATH = '/live2d/shaders/'
/** 单帧 dt 上限（秒）：防止切后台长时间挂起后物理爆参 */
const MAX_DELTA_SECONDS = 0.1

/**
 * model3 `Layout` 键 → `CubismModelMatrix.setupFromLayout` 期望的小写 snake_case 键（math/
 * cubismmodelmatrix.ts:160）归一表。官方 model3 用大写/驼峰键（`Width/Height/CenterX/CenterY/X/Y/
 * Top/Bottom/Left/Right`），setupFromLayout 却按小写 `width/height/center_x/center_y/x/y/...` 匹配——
 * 直接传入会全部不命中。此处对读出键 `toLowerCase()` 后经映射归一（`CenterX`→`centerx`→`center_x`），
 * 未列出的键保留原形（不影响其他键）。本仓模型 Layout 多为 None，fixture 测试用与实现一致的官方键。
 */
const LAYOUT_KEY_NORMALIZE: Record<string, string> = {
  width: 'width',
  height: 'height',
  x: 'x',
  y: 'y',
  centerx: 'center_x',
  centery: 'center_y',
  top: 'top',
  bottom: 'bottom',
  left: 'left',
  right: 'right'
}

/** GPU 上下文丢失错误（spec §3.2：上层据此回退静态头像，D5A-11/D5A-12） */
export class Live2DGpuLostError extends Error {
  constructor(message = 'Live2D WebGL context lost') {
    super(message)
    this.name = 'Live2DGpuLostError'
  }
}

/** 纹理错误：超 MAX_TEXTURE_SIZE 或创建失败（spec §3.2：上层走静态头像回退） */
export class Live2DTextureError extends Error {
  constructor(message = 'Live2D texture creation failed or exceeds MAX_TEXTURE_SIZE') {
    super(message)
    this.name = 'Live2DTextureError'
  }
}

/** 单个已加载模型的渲染句柄（Controller 持有一个；update/draw 每帧调用，destroy 释放单模型） */
export interface Live2DModelHandle {
  /** 应用物理（需 dt 秒）并推进 CubismModel 参数 */
  update(dt: number): void
  /** 设置视口/投影并绘制整帧 */
  draw(): void
  /** 释放本模型全部 Cubism 与 GL 资源（幂等） */
  destroy(): void
  // —— 批次 B（Task 2，B3 adapter 面）新增窄参数通道 + motion/expression 原语 ——
  /** 模型参数 Id 字符串列表（Controller 据此做参数存在性判定，B2/B4 路由） */
  getParameterIdList(): string[]
  // —— 批次 B（Task 3，Controller 白名单核查）handle 暴露摊平白名单读法（I-4：动作/表情唯一标识 = 文件相对路径；
  //    与 adapter 内部自据 model3 FileReferences 摊平的白名单同源，Controller 据此「先查白名单再发」）——
  /** 本模型 motion 摊平文件路径白名单（相对 model3.json 目录；无动作系统 → 空数组） */
  getMotionFileWhitelist(): ReadonlyArray<string>
  /** 本模型 expression 摊平文件路径白名单（相对 model3.json 目录；无表情系统 → 空数组） */
  getExpressionFileWhitelist(): ReadonlyArray<string>
  /** 写单个模型参数（未经 getLayoutMap 等查询；未知 Id 静默忽略，见 @framework/model/cubismmodel 注记） */
  setParam(id: string, value: number): void
  /** 视图变换（Task 5 Panel 缩放/偏移手柄，D5B-10/doc 05 §13）：scale∈[0.5,3]、offsetX/Y∈[-2,2]（钳制在
   *  computeMvp 内 applyViewTransform 统一做）；即时预览 = 设置后下一帧 draw 的 MVP 带新变换 */
  setViewTransform(scale: number, offsetX: number, offsetY: number): void
  /** 加载并播放一个 motion 文件（file 为相对 model3.json 目录的路径，∈ 白名单；priority 入队） */
  startMotion(modelId: string, file: string, priority: number): Promise<void>
  /** 加载并播放一个 expression 文件（file 相对路径 ∈ 白名单） */
  startExpression(modelId: string, file: string): Promise<void>
  /** 停止指定优先级动作（Controller 层仲裁占位：底层 SDK 无按优先级停原语，仲裁在 Task 4 调度） */
  stopMotion(priority?: number): void
  /** 停止全部 motion + expression */
  stopAll(): void
}

/** Adapter 构造依赖（engine 必传；fetchImpl 可注入，单测传入记录器） */
export interface Live2DAdapterDeps {
  engine: Live2DGLEngine
  fetchImpl?: typeof fetch
}

/** relPath（/ 分隔、modelId 之外的部分）各段 encodeURIComponent 编码（D5A-04：与协议层逐段
 * percent-decode 对齐；空段被丢弃——协议侧同样拒空段/'.'/'. ./'） */
function encodePath(relPath: string): string {
  return relPath
    .split('/')
    .filter(seg => seg.length > 0)
    .map(seg => encodeURIComponent(seg))
    .join('/')
}

/** 取 relPath 所在目录（'' = 根目录）。FileReferences 均以 model3.json 目录为 base 解析（spec §3.2） */
function dirOf(relPath: string): string {
  const i = relPath.lastIndexOf('/')
  return i < 0 ? '' : relPath.slice(0, i)
}

/** 组装模型目录内某文件的供给 URL：modelId 不编码（ASCII slug），相对路径逐段编码 */
function modelFileUrl(modelId: string, baseDir: string, fileRef: string): string {
  const rel = baseDir.length > 0 ? `${baseDir}/${fileRef}` : fileRef
  return `${LIVE2D_BASE}${modelId}/${encodePath(rel)}`
}

/** 将模型画布（原点居中，宽高为模型单位）等比映射到视口 (viewW x viewH) 像素的 MVP 列主矩阵。
 * 模型顶点以画布中心为原点（Haru.moc3 实测顶点对称于原点：X∈[-0.410,+0.409]、Y∈[-0.825,+0.849]），
 * 等比缩放即自然居中，无需平移——与官方 Demo 对无 Layout 模型用 scale-only（modelMatrix.setHeight +
 * 投影 aspect scale）一致；故 m[12]=m[13]=0（P1 审查修复：此前的 -(sx*W)/2 平移基于角原点假定，
 * 会把居中空间模型推出视口）。 */
function buildFitMvp(modelW: number, modelH: number, viewW: number, viewH: number): Float32Array {
  const scale = Math.min(viewW / modelW, viewH / modelH)
  const sx = (2 * scale) / viewW
  const sy = (2 * scale) / viewH
  const m = new Float32Array(16)
  m[0] = sx // a11：等比正向缩放
  m[5] = sy // a22：等比正向缩放（视口非方形时 sy≠sx，保持模型宽高比不变）
  m[10] = 1 // a33
  m[12] = 0 // a41：原点居中空间免平移
  m[13] = 0 // a42：原点居中空间免平移
  m[15] = 1 // a44
  return m
}

/** 视图变换（Task 5 Panel 缩放/偏移手柄，doc 05 §13 / D5B-10）：在基 MVP 上叠加用户 scale/offset。
 *  安全钳制：scale∈[0.5,3]、offsetX/Y∈[-2,2]（防模型完全移出画布）。缩放按列乘（scale 各基向量 s 倍，
 *  同 layout combine 的对角前置），平移 offset*0.25 clip 单位（offset=±2 → 平移 ±0.5 clip = 半个视口宽，
 *  配合 scale≥0.5 仍保留可见部分）。返回列主矩阵（不改入参）。 */
export function applyViewTransform(base: Float32Array, scale: number, offsetX: number, offsetY: number): Float32Array {
  const s = Math.min(3, Math.max(0.5, scale))
  const ox = Math.min(2, Math.max(-2, offsetX))
  const oy = Math.min(2, Math.max(-2, offsetY))
  const m = new Float32Array(base)
  for (let c = 0; c < 4; c++) {
    m[c * 4] *= s
    m[c * 4 + 1] *= s
  }
  m[12] += ox * 0.25
  m[13] += oy * 0.25
  return m
}

/** 释放一批可能只创建了一部分的目标资源（createModel 中途失败时兜底防泄漏） */
function releasePartial(p: {
  renderer: CubismRenderer_WebGL | null
  moc: CubismMoc | null
  model: CubismModel | null
  physics: CubismPhysics | null
  setting: CubismModelSettingJson | null
}): void {
  try {
    p.renderer?.release()
  } catch {
    /* 释放期异常不掩盖原始错误 */
  }
  if (p.moc && p.model) {
    try {
      p.moc.deleteModel(p.model)
    } catch {
      /* 同上 */
    }
  }
  if (p.moc) {
    try {
      p.moc.release()
    } catch {
      /* 同上 */
    }
  }
  if (p.physics) {
    try {
      CubismPhysics.delete(p.physics)
    } catch {
      /* 同上 */
    }
  }
  if (p.setting) {
    try {
      p.setting.release()
    } catch {
      /* 同上 */
    }
  }
}

/** 单个模型的内部实现（公开面仅 Live2DModelHandle） */
class Live2DModelHandleImpl implements Live2DModelHandle {
  // Framework motion/expression manager 的最小消费面（vendored 源码在 node/web tsconfig 中 exclude，
  // 类经 `@framework/*` 通配 ambient 建模为 any —— 此处用结构化接口收紧本 adapter 消费的方法面）
  private readonly motionManager: {
    updateMotion(model: CubismModel, dt: number): boolean
    startMotionPriority(motion: unknown, autoDelete: boolean, priority: number): unknown
    stopAllMotions(): void
  }
  private readonly expressionManager: {
    updateMotion(model: CubismModel, dt: number): boolean
    startMotion(motion: unknown, autoDelete: boolean): unknown
    stopAllMotions(): void
  }
  private readonly layoutMvp: { getArray(): Float32Array } | null
  private readonly canvas: HTMLCanvasElement
  private readonly renderer: CubismRenderer_WebGL
  private readonly model: CubismModel
  private readonly moc: CubismMoc
  private readonly physics: CubismPhysics | null
  private readonly setting: CubismModelSettingJson
  private readonly modelId: string
  private readonly baseDir: string
  private readonly fetch: typeof fetch
  private readonly motionWhitelist: ReadonlySet<string>
  private readonly expressionWhitelist: ReadonlySet<string>
  // Task 5（Panel 缩放/偏移手柄）：视图变换目标（computeMvp 内经 applyViewTransform 钳制，默认无变换）
  private viewScale = 1
  private viewOffsetX = 0
  private viewOffsetY = 0
  private destroyed = false

  constructor(p: {
    canvas: HTMLCanvasElement
    renderer: CubismRenderer_WebGL
    model: CubismModel
    moc: CubismMoc
    physics: CubismPhysics | null
    setting: CubismModelSettingJson
    modelId: string
    baseDir: string
    fetch: typeof fetch
    motionWhitelist: string[]
    expressionWhitelist: string[]
    layoutMvp: { getArray(): Float32Array } | null
  }) {
    this.canvas = p.canvas
    this.renderer = p.renderer
    this.model = p.model
    this.moc = p.moc
    this.physics = p.physics
    this.setting = p.setting
    this.modelId = p.modelId
    this.baseDir = p.baseDir
    this.fetch = p.fetch
    this.motionWhitelist = new Set(p.motionWhitelist)
    this.expressionWhitelist = new Set(p.expressionWhitelist)
    this.layoutMvp = p.layoutMvp
    // 播放原语：独立 motion 与 expression 两个队列管理器（Framework 官方区分），构造不触 Core（node 单测安全）
    this.motionManager = new CubismMotionManager()
    this.expressionManager = new CubismExpressionMotionManager()
  }

  getParameterIdList(): string[] {
    if (this.destroyed) return []
    const list: string[] = []
    const count = this.model.getParameterCount()
    for (let i = 0; i < count; i++) {
      list.push(this.model.getParameterId(i).getString())
    }
    return list
  }

  getMotionFileWhitelist(): ReadonlyArray<string> {
    return [...this.motionWhitelist]
  }

  getExpressionFileWhitelist(): ReadonlyArray<string> {
    return [...this.expressionWhitelist]
  }

  setParam(id: string, value: number): void {
    if (this.destroyed) return
    // 存在性判定必须用真域：getParameterIndex 对未知 Id 会把 not-exist 索引合成进 [getParameterCount(), …)
    // （cubismmodel.ts:627-634），永不为 -1——用 `idx < 0 || idx >= count` 才能真正拦截未知 Id。
    const idManager = CubismFramework.getIdManager() as { getId(id: string): unknown }
    const paramId = idManager.getId(id)
    const idx = this.model.getParameterIndex(paramId)
    if (idx < 0 || idx >= this.model.getParameterCount()) return // 未知参数 Id 静默忽略
    this.model.setParameterValueById(paramId, value)
  }

  /** 视图变换目标（Panel 缩放/偏移手柄）：钳制在 computeMvp 内 applyViewTransform 统一做（本 setter 只存值，
   *  跨帧一致；destroy 后 no-op）。 */
  setViewTransform(scale: number, offsetX: number, offsetY: number): void {
    if (this.destroyed) return
    this.viewScale = scale
    this.viewOffsetX = offsetX
    this.viewOffsetY = offsetY
  }

  async startMotion(_modelId: string, file: string, priority: number): Promise<void> {
    if (this.destroyed) return
    this.assertMotionAllowed(file) // 深度防御：白名单外抛错（Controller 亦先查，此处 belt-and-suspenders）
    const buffer = await this.fetchResource(file)
    const motion = CubismMotion.create(buffer, buffer.byteLength)
    this.motionManager.startMotionPriority(motion, true, priority)
  }

  async startExpression(_modelId: string, file: string): Promise<void> {
    if (this.destroyed) return
    this.assertExpressionAllowed(file)
    const buffer = await this.fetchResource(file)
    const expr = CubismExpressionMotion.create(buffer, buffer.byteLength)
    this.expressionManager.startMotion(expr, true)
  }

  stopMotion(_priority?: number): void {
    // Controller 层仲裁动作（I-2 修复：Task 4 的 ~15s 长动作上限消费此实现）。底层 SDK 只有
    // `CubismMotionQueueManager.stopAllMotions()`，无按优先级停原语——故退化实现为「停全部动作」
    // （保守停当前队内全部 motion；expression 队列不受影响）。精确按 priority 停需按 (priority→file)
    // 跟踪各句柄分别停，属增强（本批未做，注释如实）。
    if (this.destroyed) return
    this.motionManager.stopAllMotions()
  }

  stopAll(): void {
    if (this.destroyed) return
    this.motionManager.stopAllMotions()
    this.expressionManager.stopAllMotions()
  }

  update(dt: number): void {
    if (this.destroyed) return
    // 帧推进序（批次 B §3.3）：先喂 motion/expression 参数 → 物理 → model.update（后 draw 由 adapter 编排）
    this.motionManager.updateMotion(this.model, dt)
    this.expressionManager.updateMotion(this.model, dt)
    if (this.physics) {
      this.physics.evaluate(this.model, dt)
    }
    this.model.update()
  }

  draw(): void {
    if (this.destroyed) return
    const w = this.canvas.width
    const h = this.canvas.height
    if (w <= 0 || h <= 0) return // 未布局/隐藏时不绘制空白帧
    this.renderer.setRenderState(null, [0, 0, w, h])
    this.renderer
      .getMvpMatrix()
      .setMatrix(this.computeMvp(w, h))
    this.renderer.drawModel(SHADER_PATH)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    // 释放顺序对齐 CubismUserModel.release()：先 renderer（GL 资源），再 moc.deleteModel(model)
    // （内部调用 model.release()，cubismmodel.ts:1856）+ moc.release()（断言 modelCount==0），
    // 最后 physics 与 model3 设置。motion/expression 队列随 model 生命周期一并回收（autoDelete 已开启）。
    this.renderer.release()
    this.moc.deleteModel(this.model)
    this.moc.release()
    if (this.physics) {
      CubismPhysics.delete(this.physics)
    }
    this.setting.release()
  }

  // —— 内部 ——

  private assertMotionAllowed(file: string): void {
    if (this.motionWhitelist.has(file)) return
    throw new Error(`motion file not in whitelist for model ${this.modelId}: ${file}`)
  }

  private assertExpressionAllowed(file: string): void {
    if (this.expressionWhitelist.has(file)) return
    throw new Error(`expression file not in whitelist for model ${this.modelId}: ${file}`)
  }

  /** 组装模型目录内某文件（相对 model3.json 目录）的供给 URL：modelId 不编码、relPath 逐段编码 */
  private modelFileUrl(relPath: string): string {
    const rel = this.baseDir.length > 0 ? `${this.baseDir}/${relPath}` : relPath
    return `${LIVE2D_BASE}${this.modelId}/${encodePath(rel)}`
  }

  private async fetchResource(relPath: string): Promise<ArrayBuffer> {
    const url = this.modelFileUrl(relPath)
    const res = await this.fetch(url)
    if (!res.ok) throw new Error(`Failed to fetch Live2D resource (HTTP ${res.status}): ${url}`)
    return res.arrayBuffer()
  }

  /** 计算 MVP：无 Layout → 沿用批次 A scale-only `buildFitMvp`；有 Layout → 先经 layout 模型矩阵（model
   *  空间缩放/平移，番「官方 CubismModelMatrix 拟合」）再以 fit 投影（等比、原点居中）映射进 clip 空间。
   *  layout 矩阵为 column-major，fit 投影为纯对角缩放 diag(sx, sy, 1, 1)，故 combined = diag*M 即对每列
   *  行0/行1 乘 sx/sy——保证非退化（sx/sy 有限）。 */
  private computeMvp(viewW: number, viewH: number): Float32Array {
    const modelW = this.model.getCanvasWidth()
    const modelH = this.model.getCanvasHeight()
    const base = this.layoutMvp
      ? (() => {
          const scale = Math.min(viewW / modelW, viewH / modelH)
          const sx = (2 * scale) / viewW
          const sy = (2 * scale) / viewH
          const m = new Float32Array(this.layoutMvp.getArray())
          for (let c = 0; c < 4; c++) {
            m[c * 4] *= sx
            m[c * 4 + 1] *= sy
          }
          return m
        })()
      : buildFitMvp(modelW, modelH, viewW, viewH)
    // Task 5 视图变换（Panel scale/offset；钳制在 applyViewTransform 内）
    return applyViewTransform(base, this.viewScale, this.viewOffsetX, this.viewOffsetY)
  }
}

/** Live2D 渲染适配器（单例由 Controller 持有） */
export class Live2DAdapter {
  private readonly engine: Live2DGLEngine
  private readonly fetch: typeof fetch
  private gl: WebGLRenderingContext | null = null
  private canvas: HTMLCanvasElement | null = null
  private handle: Live2DModelHandleImpl | null = null
  private unregisterContextLost: (() => void) | null = null
  private gpuLost = false
  private lastTick = 0

  constructor(deps: Live2DAdapterDeps) {
    this.engine = deps.engine
    // fetch 可注入（单测记录器）；未注入时用全局 fetch 且绑定全局（this.fetch 方法调用会以 adapter 实例为
    // receiver → Chromium「Illegal invocation」——集成首帧捕获，Task7 修复）
    this.fetch = deps.fetchImpl ?? fetch.bind(globalThis)
  }

  /**
   * 初始化：创建 WebGL1 context + 订阅 webglcontextlost + CubismFramework 官方启动序列
   * （startUp(option) → initialize()，spec I-1 已验证、r.5 无 getInstance().reinitialize）。
   * context 创建失败 → false（调用方据此回退静态头像，不抛异常）。
   * 幂等：已初始化直接 true，不重复创建 context / 不重复 startUp。
   */
  initialize(canvas: HTMLCanvasElement): boolean {
    if (this.gl) return true
    const attrs: Live2DGLContextAttributes = { alpha: true, antialias: false, depth: false }
    const gl = this.engine.createContext(canvas, attrs)
    if (!gl) return false
    this.gl = gl
    this.canvas = canvas
    this.gpuLost = false
    this.lastTick = 0
    try {
      // 半初始化兜底（批次 A Task5 P3，批次 C D5C-04 随重建核查）：startUp/initialize/监听注册抛错 →
      // 释放已建 context/监听（destroy 清 gl/监听），不留部分状态；调用方（controller init/reset）据此可
      // 再次 initialize 重建，不因 this.gl 残留而误判已初始化。
      this.unregisterContextLost = this.engine.onContextLost(canvas, () => {
        this.gpuLost = true // 事件置位；渲染 tick 抛 Live2DGpuLostError
      })
      const option = new Option()
      option.loggingLevel = LogLevel.LogLevel_Off
      option.logFunction = () => {
        /* 无操作日志钩子：抑制 Core 底层日志，保持静默（本应用不向前端暴露 SDK 日志） */
      }
      CubismFramework.startUp(option)
      CubismFramework.initialize()
    } catch (e) {
      this.destroy()
      throw e
    }
    return true
  }

  /**
   * 加载一个模型并返回渲染句柄。
   * 流程：fetch model3.json（URL = cyrene://renderer/__cyrene-live2d/{modelId}/{model3Path}）→
   * 解析 FileReferences（以 model3.json 目录为 base）→ fetch moc3 → CubismMoc.create → model →
   * CubismRenderer_WebGL（initialize/startUp/首次 draw 前 loadShaders）→ 纹理逐一 fetch 并创建
   * GL 纹理（超 maxTextureSize 或创建失败 → Live2DTextureError）→ 物理（可选）→ 返回句柄。
   * GPU-lost（事件或 isContextLost 轮询）→ Live2DGpuLostError。中途失败释放已创建的部分资源。
   */
  async createModel({ modelId, model3Path }: { modelId: string; model3Path: string }): Promise<Live2DModelHandle> {
    const gl = this.gl
    const canvas = this.canvas
    if (!gl || !canvas) throw new Error('Live2DAdapter must be initialized before createModel')
    if (this.gpuLost || this.engine.isContextLost(gl)) throw new Live2DGpuLostError()

    const baseDir = dirOf(model3Path)
    const settingUrl = `${LIVE2D_BASE}${modelId}/${encodePath(model3Path)}`
    const settingBuffer = await this.fetchBytes(settingUrl)
    const setting = new CubismModelSettingJson(settingBuffer, settingBuffer.byteLength)

    let moc: CubismMoc | null = null
    let model: CubismModel | null = null
    let renderer: CubismRenderer_WebGL | null = null
    let physics: CubismPhysics | null = null

    try {
      const modelFileName = setting.getModelFileName()
      if (!modelFileName) throw new Error(`model3.json for ${modelId} declares no Moc file`)
      const mocBuffer = await this.fetchBytes(modelFileUrl(modelId, baseDir, modelFileName))
      moc = CubismMoc.create(mocBuffer, false)
      if (!moc) throw new Error(`Failed to create CubismMoc for model ${modelId}`)
      model = moc.createModel()
      if (!model) throw new Error(`Failed to create CubismModel for model ${modelId}`)

      renderer = new CubismRenderer_WebGL(canvas.width, canvas.height)
      renderer.initialize(model, 1)
      renderer.startUp(gl)
      // 纹理按官方 Demo（lappmodel.ts setupTextures）以 premultiplied alpha 上载/渲染
      renderer.setIsPremultipliedAlpha(true)

      const maxTexSize = this.engine.getMaxTextureSize(gl)
      const texCount = setting.getTextureCount()
      for (let i = 0; i < texCount; i++) {
        const texName = setting.getTextureFileName(i)
        if (!texName) continue
        const tex = await this.loadTexture(gl, modelFileUrl(modelId, baseDir, texName), maxTexSize)
        renderer.bindTexture(i, tex)
      }

      const physicsName = setting.getPhysicsFileName()
      if (physicsName) {
        const physBuffer = await this.fetchBytes(modelFileUrl(modelId, baseDir, physicsName))
        physics = CubismPhysics.create(physBuffer, physBuffer.byteLength)
      }

      // —— 批次 B（Task 2）：motion/expression 白名单（摊平文件路径数组，I-4）+ Layout 装配 ——
      // 白名单从 model3.json 的 FileReferences.Motions/Expressions 直接摊平读出（以 model3.json 目录为
      // base 的相对路径，与纹理/物理一致），作为 startMotion/startExpression 的深度防御（Controller 亦先查）。
      const motionWhitelist: string[] = []
      const motionGroupCount = setting.getMotionGroupCount()
      for (let g = 0; g < motionGroupCount; g++) {
        const group = setting.getMotionGroupName(g)
        const cnt = setting.getMotionCount(group)
        for (let m = 0; m < cnt; m++) {
          const fn = setting.getMotionFileName(group, m)
          if (fn) motionWhitelist.push(fn)
        }
      }
      const expressionWhitelist: string[] = []
      const expressionCount = setting.getExpressionCount()
      for (let e = 0; e < expressionCount; e++) {
        const fn = setting.getExpressionFileName(e)
        if (fn) expressionWhitelist.push(fn)
      }

      // Layout：model3 `Layout` 非空 → 官方 CubismModelMatrix 装配（传真实画布维度，防无参构造 2/0=Infinity）；
      // 空 → 沿用批次 A scale-only `buildFitMvp`（本仓模型 Layout 多为 None）。
      let layoutMvp: { getArray(): Float32Array } | null = null
      const layoutMap = new Map<string, number>()
      const hasLayout = setting.getLayoutMap(layoutMap)
      if (hasLayout && layoutMap.size > 0) {
        const normalized = new Map<string, number>()
        for (const [key, value] of layoutMap) {
          normalized.set(LAYOUT_KEY_NORMALIZE[key.toLowerCase()] ?? key.toLowerCase(), value)
        }
        const mvp = new CubismModelMatrix(model.getCanvasWidth(), model.getCanvasHeight())
        mvp.setupFromLayout(normalized)
        layoutMvp = mvp
      }

      // 首次 draw 前加载 shader（D5A-02b：内部对 CubismShader_WebGL 实例 setShaderPath，
      // 勿直接调 setShaderPath；cubismrenderer_webgl.ts:767）
      renderer.loadShaders(SHADER_PATH)

      const handle = new Live2DModelHandleImpl({
        canvas,
        renderer,
        model,
        moc,
        physics,
        setting,
        modelId,
        baseDir,
        fetch: this.fetch,
        motionWhitelist,
        expressionWhitelist,
        layoutMvp
      })
      this.handle = handle
      this.lastTick = 0
      return handle
    } catch (err) {
      releasePartial({ renderer, moc, model, physics, setting })
      this.handle = null
      this.lastTick = 0
      throw err
    }
  }

  /**
   * 每帧驱动当前模型：CubismModel.update() + 物理 + drawModel（spec §3.2 update 语义）。
   * 无当前模型 → no-op。contextlost（事件置位或轮询探测）→ 抛 Live2DGpuLostError。
   */
  update(): void {
    const h = this.handle
    if (!h) return
    if (this.gpuLost || (this.gl !== null && this.engine.isContextLost(this.gl))) {
      throw new Live2DGpuLostError()
    }
    const now = performance.now()
    const dt = this.lastTick === 0 ? 0 : Math.min(Math.max((now - this.lastTick) / 1000, 0), MAX_DELTA_SECONDS)
    this.lastTick = now
    h.update(dt)
    h.draw()
  }

  /** 释放当前模型 + 取消 contextlost 监听 + 清空 context 引用（组件销毁时序由 Controller 编排） */
  destroy(): void {
    if (this.handle) {
      this.handle.destroy()
      this.handle = null
    }
    if (this.unregisterContextLost) {
      this.unregisterContextLost()
      this.unregisterContextLost = null
    }
    this.gl = null
    this.canvas = null
    this.gpuLost = false
    this.lastTick = 0
  }

  /** 可注入 fetch 的字节读取（model3/moc3/physics 二进制资源） */
  private async fetchBytes(url: string): Promise<ArrayBuffer> {
    const res = await this.fetch(url)
    if (!res.ok) throw new Error(`Failed to fetch Live2D resource (HTTP ${res.status}): ${url}`)
    return res.arrayBuffer()
  }

  /** 抓取纹理图片 → 解码（createImageBitmap）→ 校验尺寸上限 → 上传 GL 纹理。失败抛 Live2DTextureError */
  private async loadTexture(
    gl: WebGLRenderingContext,
    url: string,
    maxTexSize: number
  ): Promise<WebGLTexture> {
    const res = await this.fetch(url)
    if (!res.ok) throw new Error(`Failed to fetch Live2D texture (HTTP ${res.status}): ${url}`)
    const blob = await res.blob()
    const createBitmap = globalThis.createImageBitmap
    if (typeof createBitmap !== 'function') {
      throw new Live2DTextureError(`createImageBitmap unavailable for Live2D texture: ${url}`)
    }
    const bitmap = await createBitmap(blob)
    try {
      if (bitmap.width > maxTexSize || bitmap.height > maxTexSize) {
        throw new Live2DTextureError(
          `Live2D texture ${url} is ${bitmap.width}x${bitmap.height}, exceeds MAX_TEXTURE_SIZE=${maxTexSize}`
        )
      }
      const texture = gl.createTexture()
      if (!texture) throw new Live2DTextureError(`gl.createTexture() failed for Live2D texture: ${url}`)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.bindTexture(gl.TEXTURE_2D, null)
      return texture
    } finally {
      bitmap.close()
    }
  }
}