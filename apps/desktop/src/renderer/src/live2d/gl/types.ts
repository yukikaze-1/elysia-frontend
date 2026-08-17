// apps/desktop/src/renderer/src/live2d/gl/types.ts
// 阶段 5 批次 A（A2，spec §3.2/D5A-12/D5A-13）：CubismGL 极薄 GL 面——接口契约。
// 把「创建 WebGL context / 探测 context 丢失 / 查询 MAX_TEXTURE_SIZE / 订阅 webglcontextlost」
// 从 Live2DAdapter 中抽出成可注入的 Live2DGLEngine：真实 WebGL1 实现于 gl/webgl.ts（WebGL1
// baseline，D5A-13），单测/集成注入 fake（gl/fake.ts：maxTextureSize 可配、createContext 可返回
// null、isContextLost 可切 true，含 GPU-lost 注入）。
// 注：纹理上传/绘制等其余 GL 操作由 Adapter 直接持有 WebGLRenderingContext 完成（面保持极薄，
// 不将渲染管线全套虚拟化——spec 仅要求最小可测面 + GPU-lost/纹理上限两个失败注入点）。

/** getContext('webgl', attrs) 的属性子集（WebGL1 baseline 最小面） */
export interface Live2DGLContextAttributes {
  alpha?: boolean
  antialias?: boolean
  depth?: boolean
}

/**
 * 极薄 WebGL 引擎抽象：Live2DAdapter 依赖的最小可注入面。
 * - createContext：建立 WebGL1 context（失败返回 null，Adapter.initialize 据此返回 false）；
 * - isContextLost：查询 context 是否已丢失（Adapter 在渲染 tick 与 createModel 入口均检查）；
 * - getMaxTextureSize：着色器/纹理上限（超限 → Adapter 抛 Live2DTextureError，spec D5A-11）；
 * - onContextLost：订阅 webglcontextlost，返回注销函数（销毁时移除，防残留监听）。
 */
export interface Live2DGLEngine {
  createContext(canvas: HTMLCanvasElement, attrs: Live2DGLContextAttributes): WebGLRenderingContext | null
  isContextLost(gl: WebGLRenderingContext): boolean
  getMaxTextureSize(gl: WebGLRenderingContext): number
  onContextLost(canvas: HTMLCanvasElement, cb: () => void): () => void
}