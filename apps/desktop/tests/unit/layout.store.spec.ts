// tests/unit/layout.store.spec.ts
// Task 6:layoutStore（spec §4.5）——toggle 目标态（P1-2）、弹回 toast（dropped* 复核）、
// handleViewportChange 清 override、首帧 viewportWidth 播种（P2-2）、hydrate、防抖落盘。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { LAYOUT_CONSTANTS } from '../../src/renderer/src/layout/constants'
import { computeEffectiveLayout, gridTemplateFor } from '../../src/renderer/src/layout/effective-layout'
import { LAYOUT_STORAGE_KEY, setLayoutStorageForTest, type LayoutStorageLike } from '../../src/renderer/src/layout/layout-storage'
import { useLayoutStore } from '../../src/renderer/src/stores/layout.store'

interface MockStorage extends LayoutStorageLike { store: Map<string, string> }
let storage: MockStorage

beforeEach(() => {
  setActivePinia(createPinia())
  storage = {
    store: new Map(),
    getItem: vi.fn((k: string) => storage.store.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => { storage.store.set(k, v) })
  }
  setLayoutStorageForTest(storage)
  vi.useFakeTimers()
})
afterEach(() => {
  setLayoutStorageForTest(null)
  vi.useRealTimers()
})

describe('layoutStore', () => {
  it('首帧 viewportWidth 播种 = window.innerWidth（P2-2）；node 无 window 回退 0', () => {
    const original = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: unknown }).window = { innerWidth: 1180 }
    try {
      setActivePinia(createPinia())
      const store = useLayoutStore()
      expect(store.viewportWidth).toBe(1180)
    } finally {
      if (original === undefined) delete (globalThis as { window?: unknown }).window
      else (globalThis as { window?: unknown }).window = original
    }
    setActivePinia(createPinia())
    const store2 = useLayoutStore()
    expect(store2.viewportWidth).toBe(0)
  })

  it('默认偏好：live2dVisible=true（D5）、conversationCollapsed=false、宽度 340', () => {
    const store = useLayoutStore()
    expect(store.prefs).toEqual({ conversationCollapsed: false, live2dVisible: true, live2dWidth: 340 })
    expect(store.overrides).toEqual({ explicitOpenConversation: false, explicitOpenLive2d: false })
  })

  it('hydrate 从 storage 载入（含宽度 clamp）；无存储 → 默认', () => {
    const store = useLayoutStore()
    storage.store.set(LAYOUT_STORAGE_KEY, JSON.stringify({ version: 1, conversationCollapsed: true, live2dVisible: false, live2dWidth: 999 }))
    store.hydrate()
    expect(store.prefs).toEqual({ conversationCollapsed: true, live2dVisible: false, live2dWidth: 420 })
    storage.store.clear()
    store.hydrate()
    expect(store.prefs).toEqual({ conversationCollapsed: false, live2dVisible: true, live2dWidth: 340 })
  })

  it('toggleConversation 折叠目标态（W=1200 宽窗）：写回持久偏好 + 清 override + 防抖落盘', () => {
    const store = useLayoutStore()
    store.handleViewportChange(1200)
    expect(store.effective.conversationShown).toBe(true)
    store.toggleConversation()
    expect(store.prefs.conversationCollapsed).toBe(true)
    expect(store.overrides.explicitOpenConversation).toBe(false)
    expect(store.effective.conversationShown).toBe(false)
    vi.advanceTimersByTime(200)
    expect(JSON.parse(storage.store.get(LAYOUT_STORAGE_KEY)!)).toEqual({
      version: 1, conversationCollapsed: true, live2dVisible: true, live2dWidth: 340
    })
  })

  it('toggleConversation 展开目标态（W=1100 被保护折叠）：置 override（wouldBe 判据）→ 真实有效', () => {
    const store = useLayoutStore()
    store.handleViewportChange(1100)
    expect(store.effective.conversationShown).toBe(false)
    store.toggleConversation()
    expect(store.overrides.explicitOpenConversation).toBe(true)
    expect(store.effective.conversationShown).toBe(true)
    expect(store.effective.live2dShown).toBe(false) // 保护第2步自动关 Live2D
    expect(store.effective.chatWidth).toBe(780)
  })

  it('手动折叠→重开 序列在 1100 下重开真实有效（P1-2，不再翻转矛盾）', () => {
    const store = useLayoutStore()
    store.handleViewportChange(1100)
    store.toggleConversation()            // 显式打开（置 override）
    expect(store.effective.conversationShown).toBe(true)
    store.toggleConversation()            // 手动折叠（写 prefs + 清 override）
    expect(store.effective.conversationShown).toBe(false)
    expect(store.prefs.conversationCollapsed).toBe(true)
    expect(store.overrides.explicitOpenConversation).toBe(false)
    store.toggleConversation()            // 重开（目标态展开 + wouldBe 置 override）
    expect(store.effective.conversationShown).toBe(true)
    expect(store.overrides.explicitOpenConversation).toBe(true)
    expect(store.effective.chatWidth).toBe(780)
  })

  it('窄窗弹回 toast：空间不足展开会话栏（已有 Live2D override、W<NAV+CONV+liveDesired）→ 置位后被兜底回退 + notice', () => {
    const store = useLayoutStore()
    store.handleViewportChange(640)
    store.overrides.explicitOpenLive2d = true
    store.toggleConversation()
    expect(store.overrides.explicitOpenConversation).toBe(false) // 置位后 dropped 复核 → 清掉
    expect(store.notice).toBe('当前窗口过窄，无法同时显示会话列表与角色栏')
    expect(store.effective.conversationShown).toBe(false)
    expect(store.effective.live2dShown).toBe(true)  // Live2D 保留
  })

  it('toggleLive2d 展开时先置的会话栏 override 被双 override 兜底回退 → 同步清位 + notice（评审第二轮重验修复）', () => {
    const store = useLayoutStore()
    store.handleViewportChange(640)
    store.overrides.explicitOpenConversation = true
    store.toggleLive2d()
    expect(store.overrides.explicitOpenConversation).toBe(false)  // 残留 override 不得复活
    expect(store.overrides.explicitOpenLive2d).toBe(true)
    expect(store.notice).toBe('窗口过窄，会话栏暂不可同时显示')
    expect(store.effective.live2dShown).toBe(true)
  })

  it('toggleLive2d 折叠目标态：写回偏好 + 清 override', () => {
    const store = useLayoutStore()
    store.handleViewportChange(1200)
    store.toggleLive2d()
    expect(store.prefs.live2dVisible).toBe(false)
    expect(store.overrides.explicitOpenLive2d).toBe(false)
    expect(store.effective.live2dShown).toBe(false)
  })

  it('handleViewportChange 宽度恢复足够（≥1160）→ 清两个 override（D3 判据）', () => {
    const store = useLayoutStore()
    store.handleViewportChange(1100)
    store.toggleConversation()
    expect(store.overrides.explicitOpenConversation).toBe(true)
    store.handleViewportChange(1200)
    expect(store.overrides.explicitOpenConversation).toBe(false)
    expect(store.overrides.explicitOpenLive2d).toBe(false)
  })

  it('handleViewportChange 同步清位被兜底回退的 override（W=640→350 时 Live2D override 回退）', () => {
    const store = useLayoutStore()
    store.handleViewportChange(640)
    store.overrides.explicitOpenLive2d = true
    expect(store.overrides.explicitOpenLive2d).toBe(true)  // W=640 ≥ NAV+340=400，override 有效
    store.handleViewportChange(350)
    expect(store.overrides.explicitOpenLive2d).toBe(false) // W=350 < 400 → dropped 同步清位
  })

  it('setLive2dWidth clamp [300,420] + 防抖落盘', () => {
    const store = useLayoutStore()
    store.setLive2dWidth(500)
    expect(store.prefs.live2dWidth).toBe(420)
    store.setLive2dWidth(100)
    expect(store.prefs.live2dWidth).toBe(300)
    vi.advanceTimersByTime(200)
    expect(JSON.parse(storage.store.get(LAYOUT_STORAGE_KEY)!)).toEqual({
      version: 1, conversationCollapsed: false, live2dVisible: true, live2dWidth: 300
    })
  })

  it('effective 与 gridTemplateFor 一致（4 组合 columns/areas）', () => {
    const store = useLayoutStore()
    store.handleViewportChange(1200) // 全四区
    expect(gridTemplateFor(store.effective).gridTemplateAreas).toBe('"title title title title" "nav conv chat live"')
    store.handleViewportChange(1100) // 仅 Live2D（会话栏自动折叠）
    expect(gridTemplateFor(store.effective).gridTemplateAreas).toBe('"title title title" "nav chat live"')
    store.prefs.live2dVisible = false // 仅会话栏
    store.handleViewportChange(1200)
    expect(gridTemplateFor(store.effective).gridTemplateAreas).toBe('"title title title" "nav conv chat"')
    store.prefs.conversationCollapsed = true // 均隐藏
    store.handleViewportChange(1200)
    expect(gridTemplateFor(store.effective).gridTemplateAreas).toBe('"title title" "nav chat"')
    // store.effective 与同一输入纯函数推导一致
    expect(store.effective).toEqual(computeEffectiveLayout(1200, store.prefs, store.overrides, LAYOUT_CONSTANTS))
  })
})
