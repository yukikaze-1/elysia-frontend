// @vitest-environment happy-dom
// tests/unit/live2d-pane.spec.ts
// Task 5（B5，spec §3.5 / doc 11 §7.1）：CyLive2DPane 设置子页——模型列表 available 过滤、enabled/互动开关、
// scale/offset 滑块、performanceMode 四值下拉、恢复默认。改动即 setLive2d(patch) → settingsStore 500ms 防抖持久化。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// —— Core 全局桩（live2d.spec 同款：pane → live2dStore → controller → adapter → @framework 模块作用域枚举
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
import { mount } from '@vue/test-utils'
import CyLive2DPane from '../../src/renderer/src/components/CyLive2DPane.vue'
import { useSettingsStore } from '../../src/renderer/src/stores/settings.store'
import { useLive2dStore } from '../../src/renderer/src/stores/live2d.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { DEFAULT_LIVE2D } from '@shared/schemas'
import type { Live2DModelSummary } from '@shared/contracts'

const mockApi = {
  settingsLoad: vi.fn(), settingsSave: vi.fn(), listLive2dModels: vi.fn(), readLive2dModelFile: vi.fn()
}

const MODEL_AVAILABLE: Live2DModelSummary = {
  id: 'haru', displayName: 'Haru', preview: 'preview.png', version: '1.0',
  available: true, licenseRef: 'LICENSE.txt', integrityState: 'verified'
}
const MODEL_AVAILABLE2: Live2DModelSummary = {
  id: 'lil', displayName: 'Lil', preview: null, version: '0.9',
  available: true, licenseRef: 'LICENSE.txt', integrityState: 'unverified'
}
const MODEL_BROKEN: Live2DModelSummary = {
  id: 'broken', displayName: 'Broken', preview: null, version: '0.8',
  available: false, reason: 'missing_file', licenseRef: 'LICENSE.txt', integrityState: 'failed'
}

beforeEach(() => {
  setActivePinia(createPinia())
  setDesktopApi(mockApi as unknown as Parameters<typeof setDesktopApi>[0])
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

function mountPane(): ReturnType<typeof mount> {
  return mount(CyLive2DPane)
}

describe('CyLive2DPane：模型列表 + available 过滤', () => {
  it('只列 available 模型；preview 缩略图存在时渲染 img（cyrene:// URL），无则占位', () => {
    useLive2dStore().models = [MODEL_AVAILABLE, MODEL_AVAILABLE2, MODEL_BROKEN]
    const wrapper = mountPane()
    const items = wrapper.findAll('.cy-l2d-model')
    expect(items).toHaveLength(2) // broken 不可用不渲染
    expect(wrapper.text()).toContain('Haru')
    expect(wrapper.text()).toContain('Lil')
    expect(wrapper.text()).not.toContain('Broken')

    const imgs = wrapper.findAll('.cy-l2d-model-preview')
    const img = imgs.find((el) => el.element.tagName === 'IMG')
    expect(img).toBeTruthy()
    expect(img?.attributes('src')).toBe('cyrene://renderer/__cyrene-live2d/haru/preview.png')
    expect(imgs.some((el) => el.text() === '无预览')).toBe(true) // lil 无 preview → 占位
    wrapper.unmount()
  })

  it('点击可选模型 → store.switchModel(id)', async () => {
    const store = useLive2dStore()
    store.models = [MODEL_AVAILABLE, MODEL_AVAILABLE2]
    const switchSpy = vi.spyOn(store, 'switchModel').mockResolvedValue(undefined)
    const wrapper = mountPane()
    await wrapper.findAll('.cy-l2d-model')[1].trigger('click')
    expect(switchSpy).toHaveBeenCalledWith('lil')
    wrapper.unmount()
    switchSpy.mockRestore()
  })
})

describe('CyLive2DPane：enabled/互动开关 → setLive2d patch + 防抖持久化', () => {
  it('enabled 开关 → setLive2d patch；500ms 防抖后 settingsSave 收到 live2d 子树 patch', async () => {
    vi.useFakeTimers()
    mockApi.settingsSave.mockImplementation(async (patch: { live2d?: Partial<{ enabled: boolean }> }) => {
      return { version: 1, voice: {}, dictation: { insertMode: 'append' }, live2d: { ...DEFAULT_LIVE2D, ...patch.live2d } }
    })
    const settings = useSettingsStore()
    const wrapper = mountPane()
    const checkbox = wrapper.findAll('input[type="checkbox"]')[0] // enabled
    expect((checkbox.element as HTMLInputElement).checked).toBe(true)
    await checkbox.setValue(false)
    expect(settings.live2d.enabled).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(mockApi.settingsSave).toHaveBeenCalledWith({ live2d: { enabled: false } })
    wrapper.unmount()
  })

  it('互动开关（mouseTracking/autoMotions/lipSync/reduceMotion）→ 写回 settings.live2d', async () => {
    const settings = useSettingsStore()
    const wrapper = mountPane()
    const boxes = wrapper.findAll('input[type="checkbox"]')
    expect(boxes).toHaveLength(5) // enabled + mouseTracking/autoMotions/lipSync/reduceMotion

    // mouseTracking
    await boxes[1].setValue(false)
    expect(settings.live2d.mouseTracking).toBe(false)
    // autoMotions
    await boxes[2].setValue(false)
    expect(settings.live2d.autoMotions).toBe(false)
    // lipSync
    await boxes[3].setValue(false)
    expect(settings.live2d.lipSync).toBe(false)
    // reduceMotion
    await boxes[4].setValue(true)
    expect(settings.live2d.reduceMotion).toBe(true)
    wrapper.unmount()
  })
})

describe('CyLive2DPane：scale/offset 滑块 + performanceMode 下拉', () => {
  it('scale/offsetX/offsetY 滑块 → setLive2d patch（range min/max 即安全钳制）', async () => {
    const settings = useSettingsStore()
    const wrapper = mountPane()
    const ranges = wrapper.findAll('input[type="range"]')
    expect(ranges).toHaveLength(3)

    await ranges[0].setValue('2.5')
    expect(settings.live2d.scale).toBe(2.5)

    await ranges[1].setValue('-1.5')
    expect(settings.live2d.offsetX).toBe(-1.5)

    await ranges[2].setValue('0.75')
    expect(settings.live2d.offsetY).toBe(0.75)

    // 控件 min/max 即 D5B-08 钳制（scale∈[0.5,3]、offset∈[-2,2]）
    expect((ranges[0].element as HTMLInputElement).min).toBe('0.5')
    expect((ranges[0].element as HTMLInputElement).max).toBe('3')
    expect((ranges[1].element as HTMLInputElement).min).toBe('-2')
    expect((ranges[2].element as HTMLInputElement).max).toBe('2')
    wrapper.unmount()
  })

  it('performanceMode 四值下拉（auto/quality/balanced/low_power）→ 选择写回 settings', async () => {
    const settings = useSettingsStore()
    const wrapper = mountPane()
    const select = wrapper.find('select')
    const options = select.findAll('option')
    expect(options.map((o) => o.attributes('value'))).toEqual(['auto', 'quality', 'balanced', 'low_power'])

    await select.setValue('low_power')
    expect(settings.live2d.performanceMode).toBe('low_power')
    await select.setValue('quality')
    expect(settings.live2d.performanceMode).toBe('quality')
    wrapper.unmount()
  })
})

describe('CyLive2DPane：恢复默认 + 状态/错误展示', () => {
  it('恢复默认 → setLive2d(DEFAULT_LIVE2D) 全字段回默认', async () => {
    const settings = useSettingsStore()
    settings.live2d.scale = 2
    settings.live2d.offsetX = 1
    settings.live2d.autoMotions = false
    settings.live2d.reduceMotion = true
    settings.live2d.performanceMode = 'quality'
    const wrapper = mountPane()
    await wrapper.findAll('button').find((b) => b.text().includes('恢复默认'))?.trigger('click')
    expect(settings.live2d).toEqual({ ...DEFAULT_LIVE2D })
    wrapper.unmount()
  })

  it('store.error → 错误提示渲染；store.status 非 ready → 状态文案渲染', () => {
    const store = useLive2dStore()
    store.error = '模型加载失败'
    store.status = 'failed'
    const wrapper = mountPane()
    expect(wrapper.text()).toContain('模型加载失败')
    wrapper.unmount()
  })
})

describe('CyLive2DPane：enabled=false 禁用交互', () => {
  it('enabled 关闭 → 滑块/下拉/模型选择禁用（模型仍列但不可点）', async () => {
    useLive2dStore().models = [MODEL_AVAILABLE]
    const settings = useSettingsStore()
    settings.live2d.enabled = false
    const wrapper = mountPane()
    expect((wrapper.findAll('input[type="range"]')[0].element as HTMLInputElement).disabled).toBe(true)
    expect((wrapper.find('select').element as HTMLSelectElement).disabled).toBe(true)
    expect((wrapper.findAll('.cy-l2d-model')[0].element as HTMLButtonElement).disabled).toBe(true)
    wrapper.unmount()
  })
})