// @vitest-environment happy-dom
// tests/unit/cy-renderer-crash-banner.spec.ts
// 阶段 7 批次 B（Task 3）：CyRendererCrashBanner——reload 后 getLastCrash 读 crashMarker 提示「页面已重启」。
// 崩恢复语义 D7B-05 修正：renderer 崩溃时收不到 push——改 bootstrap 经 getLastCrash 读 marker（读后 Main 清空）。
// 环境 happy-dom：Vue Test Utils 挂载 banner 组件渲染需 DOM（先例 cy-diagnostics-pane.spec.ts）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import CyRendererCrashBanner from '../../src/renderer/src/components/CyRendererCrashBanner.vue'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'

// 注入 mock api.getLastCrash——先例 cy-diagnostics-pane.spec.ts:11/80（setDesktopApi 注入 + cast）
function setupApi(lastCrash: { reason: string; exitCode: number } | null): void {
  setDesktopApi({ getLastCrash: vi.fn(async () => lastCrash) } as unknown as Parameters<typeof setDesktopApi>[0])
}
beforeEach(() => { vi.resetModules() })
afterEach(() => { vi.unstubAllGlobals() })

describe('CyRendererCrashBanner', () => {
  it('getLastCrash 返回 marker → 显示「页面已重启」', async () => {
    setupApi({ reason: 'crashed', exitCode: 1 })
    const wrapper = mount(CyRendererCrashBanner)
    await vi.waitFor(() => { expect(wrapper.find('.cy-crash-banner').exists()).toBe(true) })
    expect(wrapper.text()).toContain('页面已重启')
  })
  // 2026-09-10 审查修复：原写法在 mount() 之后立刻断言「不存在」——此时 onMounted 的异步续体与 Vue 渲染队列
  // 都还没跑，任何组件都「不存在 banner」，断言恒真（探针实测：强制显示 banner 仍然 2 passed）。
  // 必须先 flush 异步链再断言，让该用例真正能对「null → 不显示」这条分支失败。
  it('getLastCrash 返回 null → 不显示 banner', async () => {
    setupApi(null)
    const wrapper = mount(CyRendererCrashBanner)
    await flushPromises()
    await nextTick()
    expect(wrapper.find('.cy-crash-banner').exists()).toBe(false)
  })
})
