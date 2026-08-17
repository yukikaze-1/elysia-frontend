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
import type { Live2DGLContextAttributes, Live2DGLEngine } from './gl/types'

/** cyrene:// live2d 供给分支前缀（与 Main 侧 protocol/live2d-path.ts 的 LIVE2D_PATH_PREFIX 对应） */
const LIVE2D_BASE = 'cyrene://renderer/__cyrene-live2d/'
/** vendored shader 的公开路径（Task 1：public/live2d/shaders/ → /live2d/shaders/） */
const SHADER_PATH = '/live2d/shaders/'
/** 单帧 dt 上限（秒）：防止切后台长时间挂起后物理爆参 */
const MAX_DELTA_SECONDS = 0.1

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
  private readonly canvas: HTMLCanvasElement
  private readonly renderer: CubismRenderer_WebGL
  private readonly model: CubismModel
  private readonly moc: CubismMoc
  private readonly physics: CubismPhysics | null
  private readonly setting: CubismModelSettingJson
  private destroyed = false

  constructor(p: {
    canvas: HTMLCanvasElement
    renderer: CubismRenderer_WebGL
    model: CubismModel
    moc: CubismMoc
    physics: CubismPhysics | null
    setting: CubismModelSettingJson
  }) {
    this.canvas = p.canvas
    this.renderer = p.renderer
    this.model = p.model
    this.moc = p.moc
    this.physics = p.physics
    this.setting = p.setting
  }

  update(dt: number): void {
    if (this.destroyed) return
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
      .setMatrix(buildFitMvp(this.model.getCanvasWidth(), this.model.getCanvasHeight(), w, h))
    this.renderer.drawModel(SHADER_PATH)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    // 释放顺序对齐 CubismUserModel.release()：先 renderer（GL 资源），再 moc.deleteModel(model)
    // （内部调用 model.release()，cubismmodel.ts:1856）+ moc.release()（断言 modelCount==0），
    // 最后 physics 与 model3 设置。
    this.renderer.release()
    this.moc.deleteModel(this.model)
    this.moc.release()
    if (this.physics) {
      CubismPhysics.delete(this.physics)
    }
    this.setting.release()
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
    // fetch 可注入（单测记录器）；未注入时用全局 fetch（renderer/Chromium 内置）
    this.fetch = deps.fetchImpl ?? fetch
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

      // 首次 draw 前加载 shader（D5A-02b：内部对 CubismShader_WebGL 实例 setShaderPath，
      // 勿直接调 setShaderPath；cubismrenderer_webgl.ts:767）
      renderer.loadShaders(SHADER_PATH)

      const handle = new Live2DModelHandleImpl({
        canvas,
        renderer,
        model,
        moc,
        physics,
        setting
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