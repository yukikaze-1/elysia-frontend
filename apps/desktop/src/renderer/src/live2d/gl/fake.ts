// apps/desktop/src/renderer/src/live2d/gl/fake.ts
// 阶段 5 批次 A（A2，spec §3.2/D5A-12）：可注错 fake GL 引擎——供单测/集成注入。
// 三个注入点：getMaxTextureSize 可配（纹理超限测试）、createContext 可返回 null（initialize 失败
// 测试）、isContextLost 可切 true / 可手动触发 webglcontextlost（GPU-lost 注入测试）。
// onContextLost 记录回调并经 fireContextLost() 手动触发，返回的注销函数计数供「无残留监听」断言。
import type { Live2DGLContextAttributes, Live2DGLEngine } from './types'

/** FakeEngine 可配置项（可选；缺省值对单测友好） */
export interface FakeLive2DEngineOptions {
  /** gl.MAX_TEXTURE_SIZE 返回值（缺省 2048） */
  maxTextureSize?: number
  /** createContext 返回值；undefined → 返回一个空对象假 GL（合法 context），null → 模拟创建失败 */
  contextResult?: WebGLRenderingContext | null
  /** isContextLost 初始值（缺省 false） */
  contextLost?: boolean
}

/**
 * 可注错 fake engine。记录 createContext 调用参数、unregister 调用次数；
 * fireContextLost() 手动触发已注册的 contextlost 回调。
 */
export class FakeLive2DEngine implements Live2DGLEngine {
  /** 记录每次 createContext 的入参（canvas/attrs） */
  readonly createContextCalls: Array<{ canvas: HTMLCanvasElement; attrs: Live2DGLContextAttributes }> = []
  /** onContextLost 返回的注销函数被调用的次数（销毁无残留断言用） */
  unregisterCount = 0
  /** 当前注册的 contextlost 回调（fireContextLost 触发） */
  private lostHandler: (() => void) | null = null
  private maxTex: number
  private ctxResult: WebGLRenderingContext | null
  private lost: boolean

  constructor(opts: FakeLive2DEngineOptions = {}) {
    this.maxTex = opts.maxTextureSize ?? 2048
    this.ctxResult = opts.contextResult !== undefined ? opts.contextResult : ({} as WebGLRenderingContext)
    this.lost = opts.contextLost ?? false
  }

  setMaxTextureSize(v: number): void {
    this.maxTex = v
  }

  setContextResult(v: WebGLRenderingContext | null): void {
    this.ctxResult = v
  }

  setContextLost(v: boolean): void {
    this.lost = v
  }

  /** 手动触发已注册的 contextlost 回调（模拟 webglcontextlost 事件） */
  fireContextLost(): void {
    this.lostHandler?.()
  }

  createContext(canvas: HTMLCanvasElement, attrs: Live2DGLContextAttributes): WebGLRenderingContext | null {
    this.createContextCalls.push({ canvas, attrs })
    return this.ctxResult
  }

  isContextLost(_gl: WebGLRenderingContext): boolean {
    return this.lost
  }

  getMaxTextureSize(_gl: WebGLRenderingContext): number {
    return this.maxTex
  }

  onContextLost(_canvas: HTMLCanvasElement, cb: () => void): () => void {
    this.lostHandler = cb
    return () => {
      this.unregisterCount++
      this.lostHandler = null
    }
  }
}