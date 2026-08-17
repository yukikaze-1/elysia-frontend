// apps/desktop/src/renderer/src/live2d/gl/webgl.ts
// 阶段 5 批次 A（A2，spec §3.2/D5A-13）：真实 WebGL1 引擎实现（Electron renderer / Chromium）。
// WebGL1 baseline：`canvas.getContext('webgl', { alpha: true, antialias: false, depth: false })`
// （spec §3.2 原文）；isContextLost 直接查询；getMaxTextureSize 读 gl.MAX_TEXTURE_SIZE；
// onContextLost 经 canvas.addEventListener('webglcontextlost') 注册并返回注销函数。
import type { Live2DGLContextAttributes, Live2DGLEngine } from './types'

/** WebGL1 baseline 上下文属性（spec §3.2 固定值） */
export const LIVE2D_GL_ATTRIBUTES: Live2DGLContextAttributes = Object.freeze({
  alpha: true,
  antialias: false,
  depth: false
})

/** 真实 WebGL1 引擎单例（无状态闭包集合） */
export const webglEngine: Live2DGLEngine = {
  createContext(canvas, _attrs): WebGLRenderingContext | null {
    // 属性取 fixed 常量（spec §3.2 硬编码这三个值）；attrs 参数仅保留签名位
    return canvas.getContext('webgl', LIVE2D_GL_ATTRIBUTES) as WebGLRenderingContext | null
  },
  isContextLost(gl) {
    return gl.isContextLost()
  },
  getMaxTextureSize(gl) {
    return gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
  },
  onContextLost(canvas, cb) {
    canvas.addEventListener('webglcontextlost', cb, false)
    return () => {
      canvas.removeEventListener('webglcontextlost', cb, false)
    }
  }
}