// @vitest-environment happy-dom
// tests/unit/live2d-panel.spec.ts
// Task 5（B6，spec §3.6 / D5B-09/D5B-10）：CyLive2DPanel 完整化——状态徽标（CharacterState 文案映射）、
// 缩放/偏移手柄（读 settings → setViewTransform，即时预览 + 持久化）、鼠标跟随/回正（mousemove 归一坐标 →
// setLookTarget；mouseleave → lerp 回正 → null；mouseTracking/reduceMotion 门控）、点击预设动作（priority=1）。
// 环境 happy-dom；fake controller（setLive2dControllerFactory 注入，全方法 mock）驱动真实 store；rAF 桩掉
// （返回 0 不调度循环），tween 经 defineExpose.applyLookTween 手动驱动。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// —— Core 全局桩（live2d.spec 同款：panel → live2dStore → controller → adapter → @framework 模块作用域枚举
//   在 import 时访问 Live2DCubismCore；node/happy-dom 无该全局）——
vi.hoisted(() => {
  const names = [
    'Normal', 'AddGlow', 'Add', 'Darken', 'Multiply', 'ColorBurn', 'LinearBurn', 'Lighten', 'Screen',
    'ColorDodge', 'Overlay', 'SoftLight', 'HardLight', 'LinearLight', 'Hue', 'Color',
    'AddCompatible', 'MultiplyCompatible'
  ] as const
  const ColorBlendType: Record<string, number> = {}
  names.forEach((n, i) => { ColorBlendType[`ColorBlendType_${n}`] = i })
  ;(globalThis as Record<string, unknown>).Live2DCubismCore = { ColorBlendType }
})

import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import CyLive2DPanel from '../../src/renderer/src/components/CyLive2DPanel.vue'
import { setLive2dControllerFactory, useLive2dStore } from '../../src/renderer/src/stores/live2d.store'
import { useSettingsStore } from '../../src/renderer/src/stores/settings.store'
import { useLayoutStore } from '../../src/renderer/src/stores/layout.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import type { Live2DController, Live2DControllerStatus } from '../../src/renderer/src/live2d/controller'
import type { Live2DModelSummary } from '@shared/contracts'

const mockApi = {
  settingsLoad: vi.fn(), settingsSave: vi.fn(), listLive2dModels: vi.fn()
}

const MODELS: Live2DModelSummary[] = [
  { id: 'haru', displayName: 'Haru', preview: 'preview.png', version: '1.0', available: true, licenseRef: 'LICENSE.txt', integrityState: 'verified' },
  { id: 'lil', displayName: 'Lil', preview: null, version: '0.9', available: true, licenseRef: 'LICENSE.txt', integrityState: 'unverified' }
]

/** 全方法 fake controller：status 恒 ready/modelId=haru；记录每方法调用 */
function makeFakeController() {
  const calls = {
    setAutoMotions: vi.fn(), setLipSync: vi.fn(), setPerformanceMode: vi.fn(),
    setViewTransform: vi.fn(), setLookTarget: vi.fn(), playTapMotion: vi.fn(),
    setMouthLevel: vi.fn(), // C1：口部接线（watch detach → setMouthLevel(0)）
    setVisibility: vi.fn(), // C2：store 可见性接线（D5C-05）
    setState: vi.fn(), init: vi.fn(async () => {}), switchModel: vi.fn(async (next: string) => next),
    tick: vi.fn(), unload: vi.fn()
  }
  const ctrl = {
    get status(): Live2DControllerStatus { return 'ready' },
    get modelId(): string | null { return 'haru' },
    on: vi.fn(() => () => {}),
    ...calls
  } as unknown as Live2DController
  return { ctrl, calls }
}

let fake: ReturnType<typeof makeFakeController>

beforeEach(() => {
  setActivePinia(createPinia())
  setDesktopApi(mockApi as unknown as Parameters<typeof setDesktopApi>[0])
  vi.clearAllMocks()
  fake = makeFakeController()
  setLive2dControllerFactory(() => fake.ctrl)
  mockApi.listLive2dModels.mockResolvedValue(MODELS)
  // 布局：拉宽视口防自动折叠（live2dShown 保持 true）
  useLayoutStore().viewportWidth = 1400
  // rAF 桩掉：不调度真实渲染循环（loop/tween 手动驱动），避免后台 rAF 干扰断言
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

afterEach(() => {
  setLive2dControllerFactory(undefined)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function mountPanel(): Promise<ReturnType<typeof mount>> {
  const wrapper = mount(CyLive2DPanel)
  await flushPromises() // onMounted → store.init（list + fake init + settings 重放）完成
  return wrapper
}

function canvasRect(): Partial<DOMRect> {
  return { left: 0, top: 0, width: 340, height: 680, right: 340, bottom: 680, x: 0, y: 0, toJSON: () => ({}) }
}

describe('CyLive2DPanel：状态徽标（CharacterState 文案映射）', () => {
  it('ready + 各 CharacterState → 对应中文文案；badge 仅 ready 展示', async () => {
    const store = useLive2dStore()
    const wrapper = await mountPanel()
    const badge = () => wrapper.find('.cy-live-badge')
    expect(badge().exists()).toBe(true) // ready → badge 展示
    expect(badge().text()).toContain('未连接') // 初始 characterState=offline（fake 未发事件）→ 未连接

    store.characterState = 'thinking'
    await wrapper.vm.$nextTick()
    expect(badge().text()).toContain('思考中')

    store.characterState = 'speaking'
    await wrapper.vm.$nextTick()
    expect(badge().text()).toContain('说话中')

    store.characterState = 'error'
    await wrapper.vm.$nextTick()
    expect(badge().text()).toContain('异常')
    expect(badge().classes()).toContain('is-error')

    // enabled=false → badge 隐藏（关闭态只显示开启/状态主线）
    useSettingsStore().live2d.enabled = false
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.cy-live-badge').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('CyLive2DPanel：缩放/偏移手柄 → setViewTransform（读写转换）', () => {
  it('settings 变化（即使经设置子页改）→ store.setViewTransform 转发（scale/offsetX/offsetY）', async () => {
    const { calls } = fake
    const settings = useSettingsStore()
    const wrapper = await mountPanel()

    settings.live2d.scale = 2
    await wrapper.vm.$nextTick()
    expect(calls.setViewTransform).toHaveBeenLastCalledWith(2, 0, 0)

    settings.live2d.offsetX = 1
    await wrapper.vm.$nextTick()
    expect(calls.setViewTransform).toHaveBeenLastCalledWith(2, 1, 0)

    settings.live2d.offsetY = -1
    await wrapper.vm.$nextTick()
    expect(calls.setViewTransform).toHaveBeenLastCalledWith(2, 1, -1)
    wrapper.unmount()
  })

  it('画布内叠加手柄（ready 展示）读写 settings：滑块 input → setLive2d patch（即时设置，持久化防抖）', async () => {
    const settings = useSettingsStore()
    const wrapper = await mountPanel()
    const ranges = wrapper.findAll('.cy-live-view-controls input[type="range"]')
    expect(ranges).toHaveLength(3)

    await ranges[0].setValue('2.5')
    expect(settings.live2d.scale).toBe(2.5)
    await ranges[1].setValue('-1.5')
    expect(settings.live2d.offsetX).toBe(-1.5)
    await ranges[2].setValue('0.75')
    expect(settings.live2d.offsetY).toBe(0.75)
    wrapper.unmount()
  })
})

describe('CyLive2DPanel：鼠标跟随/点击（D5B-09）', () => {
  it('mousemove → setLookTarget(画布相对坐标归一 [-1,1])；mouseleave → lerp 回正 → 最终 setLookTarget(null)', async () => {
    const { calls } = fake
    const wrapper = await mountPanel()
    const canvas = wrapper.find('canvas')
    Object.defineProperty(canvas.element, 'getBoundingClientRect', { value: () => canvasRect() })

    // 中心点：x=(170/340)*2-1=0、y=(170/680)*2-1=-0.5
    await canvas.trigger('mousemove', { clientX: 170, clientY: 170 })
    expect(calls.setLookTarget).toHaveBeenLastCalledWith({ x: 0, y: -0.5 })

    // 左上角：x=(0/340)*2-1=-1、y=(0/680)*2-1=-1
    await canvas.trigger('mousemove', { clientX: 0, clientY: 0 })
    expect(calls.setLookTarget).toHaveBeenLastCalledWith({ x: -1, y: -1 })

    // mouseleave → 进入回正；手动驱动 tween（rAF 已被桩掉）。先清空 mousemove 记录，
    // 使后续调用纯为 tween 序列（验证收敛即回正 null + 中间目标幅值递减）。
    await canvas.trigger('mouseleave')
    calls.setLookTarget.mockClear()
    const vm = wrapper.vm as unknown as { applyLookTween: () => void }
    for (let i = 0; i < 200; i++) vm.applyLookTween()
    const lookCalls = calls.setLookTarget.mock.calls as Array<[unknown]>
    expect(lookCalls[lookCalls.length - 1][0]).toBeNull() // 收敛后回正 null
    // tween 中间目标幅值单调递减（lerp 逼近 0）
    const mid = lookCalls.slice(0, -1).map((c) => c[0] as { x: number; y: number })
    expect(mid.length).toBeGreaterThan(0)
    for (let i = 1; i < mid.length; i++) {
      expect(Math.abs(mid[i].x)).toBeLessThanOrEqual(Math.abs(mid[i - 1].x) + 1e-9)
    }
    wrapper.unmount()
  })

  it('mouseTracking=false 门控：mousemove 不驱动 setLookTarget', async () => {
    const { calls } = fake
    const settings = useSettingsStore()
    settings.live2d.mouseTracking = false
    const wrapper = await mountPanel()
    const canvas = wrapper.find('canvas')
    Object.defineProperty(canvas.element, 'getBoundingClientRect', { value: () => canvasRect() })
    await canvas.trigger('mousemove', { clientX: 170, clientY: 170 })
    expect(calls.setLookTarget).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('reduceMotion=true 门控：点击不触发预设动作（D5B-09）', async () => {
    const { calls } = fake
    const settings = useSettingsStore()
    settings.live2d.reduceMotion = true
    const wrapper = await mountPanel()
    await wrapper.find('canvas').trigger('click')
    expect(calls.playTapMotion).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('点击画布安全区 → store.playTapMotion(priority=1)（低优先；仲裁在 controller）', async () => {
    const { calls } = fake
    const wrapper = await mountPanel()
    await wrapper.find('canvas').trigger('click')
    expect(calls.playTapMotion).toHaveBeenCalledWith(1)
    wrapper.unmount()
  })
})

describe('CyLive2DPanel：设置→controller 窄转发（autoMotions/lipSync/performanceMode）', () => {
  it('autoMotions/lipSync/performanceMode 变更 → 转发到 controller；初始值由 store.init 重放', async () => {
    const { calls } = fake
    const settings = useSettingsStore()
    const wrapper = await mountPanel()

    // 初始值经 store.init 已重放一次
    expect(calls.setAutoMotions).toHaveBeenCalledWith(true) // DEFAULT: autoMotions true
    expect(calls.setLipSync).toHaveBeenCalledWith(true)

    settings.live2d.autoMotions = false
    await wrapper.vm.$nextTick()
    expect(calls.setAutoMotions).toHaveBeenLastCalledWith(false)

    settings.live2d.lipSync = false
    await wrapper.vm.$nextTick()
    expect(calls.setLipSync).toHaveBeenLastCalledWith(false)

    settings.live2d.performanceMode = 'low_power'
    await wrapper.vm.$nextTick()
    expect(calls.setPerformanceMode).toHaveBeenLastCalledWith('low_power')
    wrapper.unmount()
  })
})