// tests/unit/gl-webgl.spec.ts
// C2-2 真机回归：webglcontextlost 监听器必须调用 event.preventDefault()——否则 Chromium 把 context
// 标记为不可恢复，后续 WEBGL_lose_context.restoreContext() 恒无效（真实 Windows Electron + AMD 实测）。
import { describe, expect, it, vi } from 'vitest'
import { webglEngine } from '../../src/renderer/src/live2d/gl/webgl'

describe('webglEngine.onContextLost（C2-2 preventDefault 恢复前提）', () => {
  it('监听 webglcontextlost 并先 preventDefault 再回调', () => {
    const state: { handler: ((event: Event) => void) | null } = { handler: null }
    const canvas = {
      addEventListener: vi.fn((type: string, h: (event: Event) => void) => {
        if (type === 'webglcontextlost') state.handler = h
      }),
      removeEventListener: vi.fn((type: string, _h: (event: Event) => void) => {
        if (type === 'webglcontextlost') state.handler = null
      })
    } as unknown as HTMLCanvasElement
    const cb = vi.fn()
    const unregister = webglEngine.onContextLost(canvas, cb)
    expect(state.handler).not.toBeNull()
    const preventDefault = vi.fn()
    state.handler?.({ preventDefault } as unknown as Event)
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledTimes(1)
    unregister()
    expect(state.handler).toBeNull()
  })
})
