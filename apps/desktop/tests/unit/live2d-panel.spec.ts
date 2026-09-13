// @vitest-environment happy-dom
// tests/unit/live2d-panel.spec.ts
// Task 5（B6，spec §3.6 / D5B-09/D5B-10）：CyLive2DPanel 完整化——状态徽标（CharacterState 文案映射）、
// 鼠标跟随/回正（mousemove 归一坐标 → setLookTarget；mouseleave → lerp 回正 → null；mouseTracking/reduceMotion 门控）、
// 点击预设动作（priority=1）。
// UII-Live2D 修缮：画布顶部滑块组（.cy-live-view-controls）移除，视图操作改为画布直接操作——左键拖动移动
// （阈值 4px、钳制 [-2,2]、DOM y 取反换算 *8/canvas 尺寸）、滚轮乘法缩放（钳制 [0.5,3]）、标题区「重置视图」
// （仅 scale/offset 归位）；并断言拖动与视线跟随/点击动作的冲突消解。
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
import { createDesktopApiMock } from './helpers/desktop-api'
import type { Live2DController, Live2DControllerStatus } from '../../src/renderer/src/live2d/controller'
import type { Live2DModelSummary } from '@shared/contracts'

// I-06 / P2-10：原为 4 键部分 mock 加双重 cast（`as unknown as Parameters<typeof setDesktopApi>[0]`）。
const mockApi = {
  settingsLoad: vi.fn(), settingsSave: vi.fn(), listLive2dModels: vi.fn(), readLive2dModelFile: vi.fn()
}

const MODELS: Live2DModelSummary[] = [
  { id: 'haru', displayName: 'Haru', preview: 'preview.png', version: '1.0', available: true, licenseRef: 'LICENSE.txt', integrityState: 'verified' },
  { id: 'lil', displayName: 'Lil', preview: null, version: '0.9', available: true, licenseRef: 'LICENSE.txt', integrityState: 'unverified' }
]

/** 全方法 fake controller：status 恒 ready/modelId=haru；记录每方法调用 */
function makeFakeController(status: Live2DControllerStatus = 'ready') {
  const calls = {
    setAutoMotions: vi.fn(), setLipSync: vi.fn(), setPerformanceMode: vi.fn(),
    setViewTransform: vi.fn(), setLookTarget: vi.fn(), playTapMotion: vi.fn(),
    setMouthLevel: vi.fn(), // C1：口部接线（watch detach → setMouthLevel(0)）
    setVisibility: vi.fn(), // C2：store 可见性接线（D5C-05）
    setState: vi.fn(), init: vi.fn(async () => {}), switchModel: vi.fn(async (next: string) => next),
    tick: vi.fn(), unload: vi.fn()
  }
  const ctrl = {
    get status(): Live2DControllerStatus { return status },
    get modelId(): string | null { return status === 'ready' ? 'haru' : null },
    on: vi.fn(() => () => {}),
    ...calls
  } as unknown as Live2DController
  return { ctrl, calls }
}

let fake: ReturnType<typeof makeFakeController>

beforeEach(() => {
  setActivePinia(createPinia())
  setDesktopApi(createDesktopApiMock(mockApi))
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

// 2026-09-10：失败态此前只显示硬编码「模型加载失败」，把已捕获的 store.error 与「模型清单是否为空」
// 这两个最关键的线索都丢掉了（真机排查时无法区分「一个模型都没装」与「模型存在但加载失败」）。
describe('CyLive2DPanel：失败态诊断（模型清单 + 原因）', () => {
  it('模型清单为空 → 提示未发现已安装模型，并给出目录要求', async () => {
    fake = makeFakeController('failed')
    setLive2dControllerFactory(() => fake.ctrl)
    mockApi.listLive2dModels.mockResolvedValue([])
    const wrapper = await mountPanel()
    const overlay = wrapper.get('.cy-live-overlay.is-diagnostic')
    expect(overlay.text()).toContain('模型加载失败')
    expect(overlay.text()).toContain('未发现任何已安装模型')
    expect(overlay.text()).toContain('manifest.json')
    wrapper.unmount()
  })

  it('清单拉取失败 → 原因不被静默吞掉，且与「确实没装」可区分', async () => {
    fake = makeFakeController('failed')
    setLive2dControllerFactory(() => fake.ctrl)
    mockApi.listLive2dModels.mockRejectedValue(new Error('IPC 通道不可用'))
    const wrapper = await mountPanel()
    const overlay = wrapper.get('.cy-live-overlay.is-diagnostic')
    // 关键：错误原因必须出现在界面上（此前 .catch(() => []) 会把它丢掉）
    expect(overlay.text()).toContain('模型清单读取失败')
    expect(overlay.text()).toContain('IPC 通道不可用')
    wrapper.unmount()
  })

  it('清单有模型但均不可用 → 报出数量与可用数，便于区分完整性失败', async () => {
    fake = makeFakeController('failed')
    setLive2dControllerFactory(() => fake.ctrl)
    mockApi.listLive2dModels.mockResolvedValue([
      { ...MODELS[0], available: false },
      { ...MODELS[1], available: false }
    ])
    const wrapper = await mountPanel()
    const overlay = wrapper.get('.cy-live-overlay.is-diagnostic')
    expect(overlay.text()).toContain('已发现 2 个模型')
    expect(overlay.text()).toContain('可用 0 个')
    wrapper.unmount()
  })
})

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

describe('CyLive2DPanel：视图变换转发（settings → store.setViewTransform）', () => {
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
})

describe('CyLive2DPanel：画布直接视图操作（UII-Live2D 修缮）', () => {
  it('顶部滑块组已移除：.cy-live-view-controls 不存在（精确滑块只保留在设置中心）', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.find('.cy-live-view-controls').exists()).toBe(false)
    wrapper.unmount()
  })

  it('左键拖动：向右 offsetX 增大（+dx*8/W）、向下 offsetY 减小（−dy*8/H，DOM y 取反）', async () => {
    const settings = useSettingsStore()
    const wrapper = await mountPanel()
    const canvas = wrapper.find('canvas')
    Object.defineProperty(canvas.element, 'getBoundingClientRect', { value: () => canvasRect() })   // 340×680

    await canvas.trigger('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    await canvas.trigger('pointermove', { pointerId: 1, clientX: 134, clientY: 100 })   // dx=34 → +34*8/340=+0.8
    expect(settings.live2d.offsetX).toBeCloseTo(0.8, 5)
    await canvas.trigger('pointerup', { pointerId: 1, clientX: 134, clientY: 100 })

    await canvas.trigger('pointerdown', { button: 0, pointerId: 2, clientX: 100, clientY: 100 })
    await canvas.trigger('pointermove', { pointerId: 2, clientX: 100, clientY: 168 })   // dy=68 → −68*8/680=−0.8
    expect(settings.live2d.offsetY).toBeCloseTo(-0.8, 5)
    await canvas.trigger('pointerup', { pointerId: 2, clientX: 100, clientY: 168 })
    wrapper.unmount()
  })

  it('拖动结果钳制在 [-2, 2]', async () => {
    const settings = useSettingsStore()
    settings.live2d.offsetX = 1.5
    settings.live2d.offsetY = -1.5
    const wrapper = await mountPanel()
    const canvas = wrapper.find('canvas')
    Object.defineProperty(canvas.element, 'getBoundingClientRect', { value: () => canvasRect() })

    await canvas.trigger('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    await canvas.trigger('pointermove', { pointerId: 1, clientX: 300, clientY: 300 })
    // +200*8/340≈+4.7 → offsetX 钳 2；dy=200 → −1.5−200*8/680≈−3.85 → offsetY 钳 −2
    expect(settings.live2d.offsetX).toBe(2)
    expect(settings.live2d.offsetY).toBe(-2)
    await canvas.trigger('pointerup', { pointerId: 1, clientX: 300, clientY: 300 })

    await canvas.trigger('pointerdown', { button: 0, pointerId: 2, clientX: 100, clientY: 100 })
    await canvas.trigger('pointermove', { pointerId: 2, clientX: -200, clientY: 100 })   // dx=−300 → 2−300*8/340≈−5.1 → 钳 −2
    expect(settings.live2d.offsetX).toBe(-2)
    await canvas.trigger('pointerup', { pointerId: 2, clientX: -200, clientY: 100 })
    wrapper.unmount()
  })

  it('滚轮缩放：向上放大、向下缩小，钳制 [0.5, 3]', async () => {
    const settings = useSettingsStore()
    const wrapper = await mountPanel()
    const canvas = wrapper.find('canvas')

    await canvas.trigger('wheel', { deltaY: -100 })   // ×exp(100*0.0015)
    expect(settings.live2d.scale).toBeCloseTo(1 * Math.exp(100 * 0.0015), 5)
    for (let i = 0; i < 40; i++) await canvas.trigger('wheel', { deltaY: 300 })
    expect(settings.live2d.scale).toBe(0.5)
    for (let i = 0; i < 80; i++) await canvas.trigger('wheel', { deltaY: -300 })
    expect(settings.live2d.scale).toBe(3)
    wrapper.unmount()
  })

  it('冲突消解：有效拖动后的 click 不触发 playTapMotion；阈值内普通点击仍触发且不移动模型', async () => {
    const { calls } = fake
    const settings = useSettingsStore()
    const wrapper = await mountPanel()
    const canvas = wrapper.find('canvas')
    Object.defineProperty(canvas.element, 'getBoundingClientRect', { value: () => canvasRect() })

    // 有效拖动（>4px）→ 模型移动、紧随 click 被抑制
    await canvas.trigger('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    await canvas.trigger('pointermove', { pointerId: 1, clientX: 150, clientY: 100 })
    await canvas.trigger('pointerup', { pointerId: 1, clientX: 150, clientY: 100 })
    await canvas.trigger('click', { button: 0 })
    expect(calls.playTapMotion).not.toHaveBeenCalled()
    expect(settings.live2d.offsetX).toBeCloseTo((50 * 8) / 340, 5)

    // 阈值内移动（2px）→ 仍是普通点击：动作触发、模型未动
    await canvas.trigger('pointerdown', { button: 0, pointerId: 2, clientX: 100, clientY: 100 })
    await canvas.trigger('pointermove', { pointerId: 2, clientX: 102, clientY: 100 })
    await canvas.trigger('pointerup', { pointerId: 2, clientX: 102, clientY: 100 })
    await canvas.trigger('click', { button: 0 })
    expect(calls.playTapMotion).toHaveBeenCalledTimes(1)
    expect(settings.live2d.offsetX).toBeCloseTo((50 * 8) / 340, 5)   // 未变
    wrapper.unmount()
  })

  it('拖动期间视线目标冻结（setLookTarget 不调用），松开后恢复跟随', async () => {
    const { calls } = fake
    const wrapper = await mountPanel()
    const canvas = wrapper.find('canvas')
    Object.defineProperty(canvas.element, 'getBoundingClientRect', { value: () => canvasRect() })

    await canvas.trigger('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    await canvas.trigger('mousemove', { clientX: 170, clientY: 170 })   // 按住期间（含未过阈值）mousemove 不喂视线
    expect(calls.setLookTarget).not.toHaveBeenCalled()
    await canvas.trigger('pointermove', { pointerId: 1, clientX: 160, clientY: 160 })
    await canvas.trigger('pointerup', { pointerId: 1, clientX: 160, clientY: 160 })

    await canvas.trigger('mousemove', { clientX: 170, clientY: 170 })   // 松开恢复正常跟随
    expect(calls.setLookTarget).toHaveBeenCalledWith({ x: 0, y: -0.5 })
    wrapper.unmount()
  })

  it('重置视图：仅 scale/offsetX/offsetY 归位（DEFAULT_LIVE2D），其余 live2d 配置原样', async () => {
    const settings = useSettingsStore()
    settings.setLive2d({ scale: 2.2, offsetX: -1.3, offsetY: 1.7, modelId: 'lil', mouseTracking: false, autoMotions: false, lipSync: false, performanceMode: 'low_power', reduceMotion: true })
    const wrapper = await mountPanel()
    const btn = wrapper.find('.cy-live-reset')
    expect((btn.element as HTMLButtonElement).disabled).toBe(false)   // enabled + ready → 可用
    await btn.trigger('click')
    expect(settings.live2d.scale).toBe(1)
    expect(settings.live2d.offsetX).toBe(0)
    expect(settings.live2d.offsetY).toBe(0)
    // 其余字段不受影响（不得走 restoreDefaults 的全量重置）
    expect(settings.live2d.modelId).toBe('lil')
    expect(settings.live2d.mouseTracking).toBe(false)
    expect(settings.live2d.autoMotions).toBe(false)
    expect(settings.live2d.lipSync).toBe(false)
    expect(settings.live2d.performanceMode).toBe('low_power')
    expect(settings.live2d.reduceMotion).toBe(true)
    expect(settings.live2d.enabled).toBe(true)
    wrapper.unmount()
  })

  it('未启用 → 重置按钮禁用（视图操作门 viewActive）', async () => {
    useSettingsStore().live2d.enabled = false
    const wrapper = await mountPanel()
    expect((wrapper.find('.cy-live-reset').element as HTMLButtonElement).disabled).toBe(true)
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
