// @vitest-environment happy-dom
// tests/unit/cy-markdown.spec.ts —— CyMarkdown 流式渲染节流（H-03）。
//
// 为什么必须有这条：报告指出「没有测试覆盖 token 速率的流式渲染」，而旧 util 的
// `debounce-trailing.spec.ts` 反而把纯防抖语义钉成了正确行为。本文件在**组件层**断言
// 「流进行中就必须已经渲染出内容」——纯防抖下该断言为 0（定时器被无限后移），
// 节流下才是渐进的。这条同时是 util 单测的端到端补充：util 测语义，这里测真的进了 DOM。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import CyMarkdown from '../../src/renderer/src/components/CyMarkdown.vue'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import type { DesktopApiLike } from '../../src/renderer/src/stores/desktop-api.types'

beforeEach(() => {
  setDesktopApi({ openExternal: vi.fn() } as unknown as DesktopApiLike)
})

describe('CyMarkdown 流式渲染（H-03：真节流，非防抖）', () => {
  it('token 间隔小于节流窗口时，流进行中持续渲染中间态', async () => {
    vi.useFakeTimers()
    const w = mount(CyMarkdown, { props: { source: '' } })

    // 模拟 25 delta/s（40ms 间隔）：首沿立即，随后每 80ms 至少补一次
    // tsconfig.node 下 .vue 为 ambient shim（DefineComponent<object,...>），setProps 参数无类型信息——
    // 按仓库先例（cy-tool-approval.spec.ts:36 / history-viewer.store.spec `as never`）断言为 never
    await w.setProps({ source: 'x' } as never)
    await nextTick()
    const samples: string[] = [w.text()]
    for (const s of ['xx', 'xxx', 'xxxx', 'xxxxx', 'xxxxxx']) {
      vi.advanceTimersByTime(40)
      await w.setProps({ source: s } as never)
      await nextTick()
      samples.push(w.text())
    }

    // 判别点：纯防抖下这 6 次采样**全为空**（定时器被每次新 delta 后移，回调从未触发），
    // 助手气泡会在流结束时整段蹦出。节流下应有多次渐进渲染。
    const nonEmpty = samples.filter((s) => s.trim().length > 0).length
    expect(nonEmpty, '流进行中即应有内容（纯防抖时为 0）').toBeGreaterThanOrEqual(3)

    // 尾沿必达：停顿后终态一定落 DOM
    vi.advanceTimersByTime(80)
    await nextTick()
    expect(w.text()).toContain('xxxxxx')

    w.unmount()
    vi.useRealTimers()
  })
})
