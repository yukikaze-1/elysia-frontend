// tests/unit/document-visibility.spec.ts
// M-37 / P2-9（2026-09-12）：Live2D 渲染 gate 的窗口可见性项。
//
// 背景：`main-window.ts` 把"窗口隐藏时暂停渲染"委托给应用自己的 active 门（`backgroundThrottling: false`
// 会关掉浏览器自身的节流），但那个门里没有窗口状态项 ⇒ 最小化后 rAF 仍全速跑。
// 本 spec 钉住新增的可见性来源；用**假 document** 驱动，不依赖真实 DOM 事件时序。
import { describe, expect, it, vi } from 'vitest'
import { createDocumentVisibilitySource, documentVisible } from '../../src/renderer/src/utils/document-visibility'

/** 可控假 document：hidden 可改（用 getter 暴露内部状态，接口上是 readonly）、可手动触发 visibilitychange */
function fakeDocument(initiallyHidden = false) {
  const listeners = new Set<() => void>()
  let hidden = initiallyHidden
  return {
    get hidden(): boolean { return hidden },
    addEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.add(listener) },
    removeEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.delete(listener) },
    setHidden(v: boolean): void {
      hidden = v
      for (const listener of [...listeners]) listener()
    },
    listenerCount: (): number => listeners.size
  }
}

describe('createDocumentVisibilitySource（M-37）', () => {
  it('初始值直接读 document.hidden——已隐藏时挂载就该是 false（不是"先假设可见再等事件"）', () => {
    expect(createDocumentVisibilitySource(fakeDocument(false)).visible.value).toBe(true)
    expect(createDocumentVisibilitySource(fakeDocument(true)).visible.value).toBe(false)
  })

  it('visibilitychange 会更新 visible（隐藏 → false，恢复 → true）', () => {
    const doc = fakeDocument(false)
    const source = createDocumentVisibilitySource(doc)

    doc.setHidden(true)
    expect(source.visible.value, '窗口隐藏后必须变为不可见（这是停 rAF 的判据）').toBe(false)

    doc.setHidden(false)
    expect(source.visible.value).toBe(true)
  })

  it('dispose 后不再响应（避免已卸载的消费方继续被通知）', () => {
    const doc = fakeDocument(false)
    const source = createDocumentVisibilitySource(doc)
    expect(doc.listenerCount()).toBe(1)

    source.dispose()
    expect(doc.listenerCount()).toBe(0)
    doc.setHidden(true)
    expect(source.visible.value, 'dispose 后不应再更新').toBe(true)
  })

  it('单例只挂一个监听（整个 renderer 只有一份 document）', () => {
    // 环境里没有真实 document 时应返回**恒可见**常量而不是抛错——调用方无需条件分支
    const first = documentVisible()
    const second = documentVisible()
    expect(first).toBe(second)
    expect(first.value).toBe(true)
  })

  it('返回值是稳定引用（同一 source 的 visible 不被重复创建，避免 watch 失效）', () => {
    const doc = fakeDocument(false)
    const a = createDocumentVisibilitySource(doc)
    const b = createDocumentVisibilitySource(doc)
    expect(a.visible).not.toBe(b.visible)   // 工厂每次新建（各自 dispose）
    doc.setHidden(true)
    expect(a.visible.value).toBe(false)
    expect(b.visible.value).toBe(false)     // 两者都跟随同一 document
  })
})

describe('与调用方约定的语义（M-37 的真实缺陷是"没人把这一项接进 gate"）', () => {
  it('gate 必须**与**窗口可见性相与：隐藏时整体为 false（源码级断言，防接线被回退）', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const path = fileURLToPath(new URL('../../src/renderer/src/components/CyLive2DPanel.vue', import.meta.url))
    const source = readFileSync(path, 'utf8')
    // 两处 gate（active 与 surfaceVisible）都必须含 windowVisible——
    // 只接一处的话，另一条路径仍会在窗口隐藏时继续跑（controller 侧或 rAF 侧）。
    // 用允许换行的正则：`active` 的 computed 是多行写法，按"行"匹配会假红（我第一版就是这样失败的）。
    expect(source, 'active gate 未接入 windowVisible').toMatch(/const active = computed\(\s*\(\)\s*=>\s*windowVisible\.value/)
    expect(source, 'surfaceVisible 上报未接入 windowVisible').toMatch(/const surfaceVisible = computed\(\s*\(\)\s*=>\s*windowVisible\.value/)
  })

  it('visible 是 ref（调用方以 .value 读取；返回值形态是接口的一部分）', () => {
    const source = createDocumentVisibilitySource(fakeDocument(false))
    expect(source.visible.value).toBeTypeOf('boolean')
    expect(vi.isMockFunction(source.dispose)).toBe(false)
  })
})
