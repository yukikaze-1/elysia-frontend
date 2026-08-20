// tests/unit/live2d.spec.ts
// Task 6（A6，spec §3.6/D5A-10）：Live2DController + live2dStore 单测——fake adapter（可注错）+ fake list
// registry + fake GL。env=node（无 WebGL；fake adapter 不触 Framework，真实框架装配归 Task 5 adapter.spec/真机）。
//
// 覆盖（Controller）：状态机 unloaded→loading→ready/failed/fallback；device_lost（adapter.update 抛
// Live2DGpuLostError）→ failed → fallback；默认模型 = list 首个 available（前有 unavailable 跳过）；
// switchModel 失败保留原 modelId（fake adapter 抛错）+ 有旧 handle 回 ready / 无则 failed；unload 全量释放
// （adapter.destroy spy 无残留）；initialize 失败 → fallback；list 空 → fallback；no-op 占位方法可调不抛。
// 覆盖（live2dStore）：init 默认模型选择 + settings.modelId 覆盖；enabled=false 只取清单不 load；switchModel
// 成功持久化 settings.live2d.modelId；switchModel 失败保留原 modelId + error；device_lost → fallback 镜像；
// dispose 无残留（adapter.destroy spy）+ 状态复位。
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { Live2DController, type Live2DControllerStatus } from '../../src/renderer/src/live2d/controller'
import { Live2DGpuLostError, type Live2DAdapter } from '../../src/renderer/src/live2d/adapter'
import { setLive2dControllerFactory, setMouthSourceFactory, useLive2dStore } from '../../src/renderer/src/stores/live2d.store'
import { useSettingsStore } from '../../src/renderer/src/stores/settings.store'
import { useConnectionStore } from '../../src/renderer/src/stores/connection.store'
import { useMessageStore } from '../../src/renderer/src/stores/message.store'
import { useVoiceStore } from '../../src/renderer/src/stores/voice.store'
import { useLayoutStore } from '../../src/renderer/src/stores/layout.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import type { Live2DDirectiveEvent, Live2DModelSummary, RuntimeInfo } from '@shared/contracts'

// —— Core 全局桩（node 无 live2dcubismcore.min.js）——
// 经 live2d.store → adapter → @framework/model/cubismmoc → cubismmodel.ts 的模块作用域枚举初始化
// （CubismColorBlend = Live2DCubismCore.ColorBlendType_*）在 import 时访问全局；vi.hoisted 先于一切 import
// 执行，桩入 ControlBlendType 常量即可通过模块加载（其余 Framework 模块对 Core 的访问均在方法内/类型位）。
// 只提供本 spec 需要的枚举常量（声明序数值；真实装配/渲染走 renderer 全局 Core，归 Task 5/真机）。
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

// —— fixtures ——
const MODEL_HARU: Live2DModelSummary = {
  id: 'haru', displayName: 'Haru', preview: 'preview.png', version: '1.0',
  available: true, licenseRef: 'LICENSE.txt', integrityState: 'verified'
}
const MODEL_LIL: Live2DModelSummary = {
  id: 'lil', displayName: 'Lil', preview: null, version: '1.0',
  available: true, licenseRef: 'LICENSE.txt', integrityState: 'unverified'
}
const MODEL_BROKEN: Live2DModelSummary = {
  id: 'broken', displayName: 'Broken', preview: null, version: '0.9',
  available: false, reason: 'missing_file', licenseRef: 'LICENSE.txt', integrityState: 'failed'
}

// —— fake adapter（可注错；记录句柄供 destroy 追踪） ——
interface FakeHandleLike {
  update: ReturnType<typeof vi.fn>
  draw: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  getParameterIdList: ReturnType<typeof vi.fn>
  getMotionFileWhitelist: ReturnType<typeof vi.fn>
  getExpressionFileWhitelist: ReturnType<typeof vi.fn>
  setParam: ReturnType<typeof vi.fn>
  setViewTransform: ReturnType<typeof vi.fn>
  startMotion: ReturnType<typeof vi.fn>
  startExpression: ReturnType<typeof vi.fn>
  stopMotion: ReturnType<typeof vi.fn>
  stopAll: ReturnType<typeof vi.fn>
}
interface FakeAdapterLike {
  handles: FakeHandleLike[]
  initialize: ReturnType<typeof vi.fn<() => boolean>>
  createModel: ReturnType<typeof vi.fn<() => Promise<FakeHandleLike>>>
  update: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}

function makeFakeAdapter(): FakeAdapterLike {
  const handles: FakeHandleLike[] = []
  const adapter: FakeAdapterLike = {
    handles,
    initialize: vi.fn(() => true),
    createModel: vi.fn(async () => {
      const h: FakeHandleLike = {
        update: vi.fn(),
        draw: vi.fn(),
        destroy: vi.fn(),
        getParameterIdList: vi.fn(() => []),
        getMotionFileWhitelist: vi.fn(() => []),
        getExpressionFileWhitelist: vi.fn(() => []),
        setParam: vi.fn(),
        setViewTransform: vi.fn(),
        startMotion: vi.fn(async () => {}),
        startExpression: vi.fn(async () => {}),
        stopMotion: vi.fn(),
        stopAll: vi.fn()
      }
      handles.push(h)
      return h
    }),
    update: vi.fn(),
    destroy: vi.fn()
  }
  return adapter
}

function asAdapter(a: FakeAdapterLike): Live2DAdapter {
  return a as unknown as Live2DAdapter
}

const fakeCanvas = { width: 340, height: 680 } as HTMLCanvasElement

// —— desktopApi mock（store 消费 settingsLoad/settingsSave/listLive2dModels；缺省 undefined 返回） ——
const mockApi = {
  connect: vi.fn(), disconnect: vi.fn(), listConversations: vi.fn(), getMessages: vi.fn(),
  send: vi.fn(), cancel: vi.fn(), activate: vi.fn(), createConversation: vi.fn(),
  renameConversation: vi.fn(), deleteConversation: vi.fn(), getConnectionState: vi.fn(),
  getCredentialStatus: vi.fn(), setBackendToken: vi.fn(), clearBackendToken: vi.fn(),
  setEndpoint: vi.fn(), getEndpoint: vi.fn(), getRuntimeInfo: vi.fn(async (): Promise<RuntimeInfo> => ({ mode: 'mock', packaged: false })),
  onChatEvent: vi.fn(() => () => {}), onChatState: vi.fn(() => () => {}), onChatReplay: vi.fn(() => () => {}), onChatError: vi.fn(() => () => {}),
  hydratePersistence: vi.fn(), persistSession: vi.fn(), cacheMessages: vi.fn(), openExternal: vi.fn(),
  attachmentsValidate: vi.fn(), attachmentsUpload: vi.fn(), attachmentsCancel: vi.fn(), attachmentsCheck: vi.fn(),
  queryChatHistory: vi.fn(), getMessageContext: vi.fn(), listStickers: vi.fn(),
  listModelProfiles: vi.fn(), saveModelProfile: vi.fn(), deleteModelProfile: vi.fn(), testModelProfile: vi.fn(), activateModelProfile: vi.fn(), getActiveModelSelection: vi.fn(),
  listTtsVoices: vi.fn(), previewTts: vi.fn(), setTtsVoice: vi.fn(),
  voiceStartRecord: vi.fn(), voiceStopRecord: vi.fn(), voiceCommit: vi.fn(), voiceDiscard: vi.fn(),
  voiceStartRealtime: vi.fn(), voiceStopRealtime: vi.fn(), voiceCancelRealtime: vi.fn(),
  voiceStartDictation: vi.fn(), voiceStopDictation: vi.fn(), voiceCancelDictation: vi.fn(),
  audioCancel: vi.fn(), voiceSendAudio: vi.fn(),
  settingsLoad: vi.fn(), settingsSave: vi.fn(),
  listLive2dModels: vi.fn(),
  onToolEvent: vi.fn(() => () => {}), toolDecide: vi.fn(), toolCancel: vi.fn(), toolList: vi.fn(), toolPickSource: vi.fn(), toolConfirmUpload: vi.fn(), toolGrantDirectory: vi.fn(), toolListGrants: vi.fn(), toolRevokeGrant: vi.fn(), toolListHistory: vi.fn(),
}

/** 装载 fake 控制器工厂（store 经 setLive2dControllerFactory 注入；adapter/list 均为 fake）。
 *  预创建 ctrl 并返回（device_lost 重建测试可 spy reset/settings 转发）。 */
function installFakes(opts: { models?: Live2DModelSummary[] } = {}) {
  const models = opts.models ?? [MODEL_HARU, MODEL_LIL, MODEL_BROKEN]
  const adapter = makeFakeAdapter()
  const list = vi.fn(async () => models)
  const ctrl = new Live2DController({ adapter: asAdapter(adapter), list: list as unknown as () => Promise<Live2DModelSummary[]> })
  setLive2dControllerFactory(() => ctrl)
  mockApi.listLive2dModels.mockResolvedValue(models)
  return { adapter, list, models, ctrl }
}

function freshStore() {
  setActivePinia(createPinia())
  setDesktopApi(mockApi)
  // C2（D5C-05）：布局宽度拉足 → live2dShown=true（store setVisibility 接线默认可见；默认 viewportWidth=0
  // 在 node 环境会让布局自动折叠 Live2D，setVisibility(false) 会停掉渲染循环破坏既有 tick 断言）
  useLayoutStore().viewportWidth = 2000
  const store = useLive2dStore()
  const settings = useSettingsStore()
  return { store, settings }
}

describe('Live2DController（fake adapter / fake list / fake GL）', () => {
  beforeEach(() => { setLive2dControllerFactory(undefined); setMouthSourceFactory(undefined); vi.clearAllMocks() })
  afterEach(() => { vi.useRealTimers() })

  it('init：list 首个 available 为默认模型（跳过 unavailable）；ready + modelId 设置', async () => {
    const adapter = makeFakeAdapter()
    const list = async () => [MODEL_BROKEN, MODEL_HARU, MODEL_LIL]
    const ctrl = new Live2DController({ adapter: asAdapter(adapter), list })
    expect(ctrl.status).toBe('unloaded')
    await ctrl.init(fakeCanvas)
    expect(ctrl.status).toBe('ready')
    expect(ctrl.modelId).toBe('haru') // 跳过 unavailable 的 broken
    expect(adapter.initialize).toHaveBeenCalledWith(fakeCanvas)
    expect(adapter.createModel).toHaveBeenCalledWith({ modelId: 'haru', model3Path: 'model3.json' }) // model3Path 恒 'model3.json'
  })

  it('init：adapter.initialize 返回 false（GL 创建失败）→ fallback，不 createModel', async () => {
    const adapter = makeFakeAdapter()
    adapter.initialize.mockReturnValue(false)
    const ctrl = new Live2DController({ adapter: asAdapter(adapter), list: async () => [MODEL_HARU] })
    await ctrl.init(fakeCanvas)
    expect(ctrl.status).toBe('fallback')
    expect(adapter.createModel).not.toHaveBeenCalled()
  })

  it('init：list 无可用模型 → fallback（静态头像回退，不悬置 loading）', async () => {
    const adapter = makeFakeAdapter()
    const ctrl = new Live2DController({ adapter: asAdapter(adapter), list: async () => [MODEL_BROKEN] })
    await ctrl.init(fakeCanvas)
    expect(ctrl.status).toBe('fallback')
    expect(adapter.createModel).not.toHaveBeenCalled()
  })

  it('init：已 ready 幂等（重复 init 不重复 load）', async () => {
    const adapter = makeFakeAdapter()
    const ctrl = new Live2DController({ adapter: asAdapter(adapter), list: async () => [MODEL_HARU] })
    await ctrl.init(fakeCanvas)
    await ctrl.init(fakeCanvas)
    expect(adapter.createModel).toHaveBeenCalledTimes(1)
    expect(ctrl.status).toBe('ready')
  })

  it('switchModel：成功原子替换（旧 handle 释放、新 handle 生效）', async () => {
    const adapter = makeFakeAdapter()
    const ctrl = new Live2DController({ adapter: asAdapter(adapter), list: async () => [MODEL_HARU, MODEL_LIL] })
    await ctrl.init(fakeCanvas)
    const oldHandle = adapter.handles[0]
    await ctrl.switchModel('lil')
    expect(ctrl.status).toBe('ready')
    expect(ctrl.modelId).toBe('lil')
    expect(adapter.createModel).toHaveBeenCalledWith({ modelId: 'lil', model3Path: 'model3.json' })
    expect(oldHandle.destroy).toHaveBeenCalledTimes(1) // 旧模型释放
  })

  it('switchModel：失败保留原 modelId + 旧 handle 继续有效；无旧 model 则 failed；rethrow', async () => {
    const adapter = makeFakeAdapter()
    const ctrl = new Live2DController({ adapter: asAdapter(adapter), list: async () => [MODEL_HARU, MODEL_LIL] })
    await ctrl.init(fakeCanvas) // ready on haru
    const haruHandle = adapter.handles[0]
    adapter.createModel.mockRejectedValueOnce(new Error('load failed'))
    await expect(ctrl.switchModel('lil')).rejects.toThrow('load failed')
    expect(ctrl.modelId).toBe('haru')   // 原 id 保留
    expect(ctrl.status).toBe('ready')   // 有旧 handle → 回到 ready
    expect(haruHandle.destroy).not.toHaveBeenCalled() // 旧模型不受影响
    // 无旧模型（从 unloaded 直切失败）→ failed
    const ctrl2 = new Live2DController({ adapter: asAdapter(adapter), list: async () => [MODEL_LIL] })
    adapter.createModel.mockRejectedValueOnce(new Error('never loaded'))
    await expect(ctrl2.switchModel('lil')).rejects.toThrow('never loaded')
    expect(ctrl2.status).toBe('failed')
  })

  it('device_lost：adapter.update 抛 Live2DGpuLostError → failed → emit device_lost → fallback', async () => {
    const adapter = makeFakeAdapter()
    const ctrl = new Live2DController({ adapter: asAdapter(adapter), list: async () => [MODEL_HARU] })
    const onDeviceLost = vi.fn()
    const off = ctrl.on('device_lost', onDeviceLost)
    await ctrl.init(fakeCanvas)
    adapter.update.mockImplementation(() => { throw new Live2DGpuLostError() })
    const statuses: Live2DControllerStatus[] = []
    ctrl.on('status', (s) => { if (typeof s === 'string') statuses.push(s as Live2DControllerStatus) })
    ctrl.tick()
    expect(adapter.update).toHaveBeenCalled()
    expect(onDeviceLost).toHaveBeenCalledTimes(1)
    expect(ctrl.status).toBe('fallback')
    expect(ctrl.modelId).toBe('haru') // 保留模型标识（重建归批 C）
    expect(statuses).toContain('failed') // 中间态 failed 已广播
    off() // 退订无残留
  })

  it('tick：非 ready / 隐藏时不驱动 adapter（不渲染空白帧）', async () => {
    const adapter = makeFakeAdapter()
    const ctrl = new Live2DController({ adapter: asAdapter(adapter), list: async () => [MODEL_HARU] })
    ctrl.tick() // unloaded
    expect(adapter.update).not.toHaveBeenCalled()
    await ctrl.init(fakeCanvas)
    ctrl.setVisibility(false)
    ctrl.tick()
    expect(adapter.update).not.toHaveBeenCalled() // 隐藏停环
  })

  it('unload：adapter.destroy 全量释放（无残留监听）+ 状态回 unloaded + modelId 清空；幂等', async () => {
    const adapter = makeFakeAdapter()
    const ctrl = new Live2DController({ adapter: asAdapter(adapter), list: async () => [MODEL_HARU] })
    await ctrl.init(fakeCanvas)
    ctrl.unload()
    expect(adapter.destroy).toHaveBeenCalledTimes(1)
    expect(ctrl.status).toBe('unloaded')
    expect(ctrl.modelId).toBeNull()
    ctrl.unload() // 幂等
    expect(adapter.destroy).toHaveBeenCalledTimes(2)
    expect(() => ctrl.tick()).not.toThrow()
  })

  it('reset：释放后重建默认模型', async () => {
    const adapter = makeFakeAdapter()
    const ctrl = new Live2DController({ adapter: asAdapter(adapter), list: async () => [MODEL_HARU, MODEL_LIL] })
    await ctrl.init(fakeCanvas)
    await ctrl.switchModel('lil')
    await ctrl.reset()
    expect(ctrl.status).toBe('ready')
    expect(ctrl.modelId).toBe('haru') // 重建回首个 available
    expect(adapter.destroy).toHaveBeenCalled() // unload 已 release
  })

  it('no-op 占位方法可调不抛（setState/setExpression/playMotion/setMouthLevel/setLookTarget）', () => {
    const ctrl = new Live2DController({ adapter: asAdapter(makeFakeAdapter()), list: async () => [] })
    expect(() => {
      ctrl.setState('idle')
      ctrl.setExpression('angry')
      ctrl.playMotion('tap_body', 0)
      ctrl.setMouthLevel(1.0)
      ctrl.setLookTarget(null) // 批次 B（spec I-2）：签名由 (x,y) 改为 NormalizedPoint|null（null=回正）
      ctrl.setPerformanceMode('auto')
    }).not.toThrow()
    expect(ctrl.status).toBe('unloaded')
  })
})

describe('live2dStore（fake controller factory + fake list + fake settings）', () => {
  beforeEach(() => { setLive2dControllerFactory(undefined); setMouthSourceFactory(undefined); vi.clearAllMocks() })
  afterEach(() => { vi.useRealTimers() })

  it('init：list 填充 models + 默认模型（首个 available）ready；enabled 缺省 true', async () => {
    installFakes({ models: [MODEL_BROKEN, MODEL_HARU] })
    const { store } = freshStore()
    await store.init(fakeCanvas)
    expect(store.models.map((m) => m.id)).toEqual(['broken', 'haru']) // 全量列表（含不可用）供下拉
    expect(store.status).toBe('ready')
    expect(store.modelId).toBe('haru')
  })

  it('init：settings.modelId（可用）→ 覆盖默认首个可用并 ready', async () => {
    installFakes({ models: [MODEL_HARU, MODEL_LIL] })
    const { store, settings } = freshStore()
    settings.$patch({ live2d: { modelId: 'lil' } })
    await store.init(fakeCanvas)
    expect(store.status).toBe('ready')
    expect(store.modelId).toBe('lil') // settings 优先于 list 顺序
  })

  it('init：settings.modelId 不可用 → 回退默认首个可用（不报错）', async () => {
    installFakes({ models: [MODEL_HARU] })
    const { store, settings } = freshStore()
    settings.$patch({ live2d: { modelId: 'missing-model' } })
    await store.init(fakeCanvas)
    expect(store.status).toBe('ready')
    expect(store.modelId).toBe('haru')
  })

  it('init：enabled=false 只取清单不 load（无 initialize/createModel、状态 unloaded）', async () => {
    const { adapter } = installFakes({ models: [MODEL_HARU] })
    const { store, settings } = freshStore()
    settings.$patch({ live2d: { enabled: false } })
    await store.init(fakeCanvas)
    expect(store.models.map((m) => m.id)).toEqual(['haru']) // 清单仍取（下拉可展示/禁用）
    expect(adapter.initialize).not.toHaveBeenCalled()
    expect(adapter.createModel).not.toHaveBeenCalled()
    expect(store.status).toBe('unloaded')
  })

  it('switchModel：成功 → modelId 更新 + settings.live2d.modelId 持久化 + ready', async () => {
    installFakes({ models: [MODEL_HARU, MODEL_LIL] })
    const { store, settings } = freshStore()
    await store.init(fakeCanvas) // ready on haru
    await store.switchModel('lil')
    expect(store.status).toBe('ready')
    expect(store.modelId).toBe('lil')
    expect(settings.live2d.modelId).toBe('lil') // 持久化（setLive2d）
  })

  it('switchModel：失败保留原 modelId + error 置位（settings 不持久化失败目标）', async () => {
    const { adapter } = installFakes({ models: [MODEL_HARU, MODEL_LIL] })
    const { store, settings } = freshStore()
    settings.$patch({ live2d: { modelId: 'haru' } }) // 已持久化选择：haru
    await store.init(fakeCanvas) // ready on haru
    adapter.createModel.mockRejectedValueOnce(new Error('load failed'))
    await store.switchModel('lil')
    expect(store.modelId).toBe('haru') // 原 id 保留
    expect(store.status).toBe('ready') // 旧模型继续渲染
    expect(store.error).toContain('load failed')
    expect(settings.live2d.modelId).toBe('haru') // 持久化值不改为失败目标
  })

  it('device_lost（store.tick 驱动 controller.tick）→ 状态镜像 fallback', async () => {
    const { adapter } = installFakes({ models: [MODEL_HARU] })
    const { store } = freshStore()
    await store.init(fakeCanvas)
    expect(store.status).toBe('ready')
    adapter.update.mockImplementation(() => { throw new Live2DGpuLostError() })
    store.tick()
    expect(store.status).toBe('fallback') // 订阅 device_lost 镜像
  })

  it('dispose：controller.unload 全量释放（adapter.destroy spy）+ 状态/模型清空', async () => {
    const { adapter } = installFakes({ models: [MODEL_HARU] })
    const { store } = freshStore()
    await store.init(fakeCanvas)
    expect(store.status).toBe('ready')
    store.dispose()
    expect(adapter.destroy).toHaveBeenCalledTimes(1) // 无残留监听/GL 引用
    expect(store.status).toBe('unloaded')
    expect(store.modelId).toBeNull()
    expect(store.models).toEqual([])
    expect(store.error).toBe('')
  })
})

describe('live2dStore：settings 契约面（enabled/modelId 接入 settingsStore 三处接线）', () => {
  beforeEach(() => { setLive2dControllerFactory(undefined); setMouthSourceFactory(undefined); vi.clearAllMocks() })
  afterEach(() => { vi.useRealTimers() })

  it('setLive2d（store.switchModel 触发）经 settingsStore 防抖持久化 live2d 子树', async () => {
    installFakes({ models: [MODEL_HARU, MODEL_LIL] })
    mockApi.settingsSave.mockImplementation(async (patch: { live2d?: Partial<{ modelId: string | null }> }) => {
      return { version: 1, voice: {}, dictation: { insertMode: 'append' }, live2d: { enabled: true, modelId: patch.live2d?.modelId ?? null } }
    })
    vi.useFakeTimers()
    const { store, settings } = freshStore()
    await store.init(fakeCanvas)
    await store.switchModel('lil')
    await vi.advanceTimersByTimeAsync(500)
    expect(mockApi.settingsSave).toHaveBeenCalledWith({ live2d: { modelId: 'lil' } })
    expect(settings.live2d.enabled).toBe(true) // 回写 merge 保留 enabled
    expect(settings.live2d.modelId).toBe('lil')
  })
})

/** 注入可配置生效 id 的 fake controller（store 消费 controller.switchModel 返回值；Task 4/5 共用） */
function installEffectiveController(effectiveFor: Record<string, string>) {
  const state = { id: 'haru' }
  const ctrl = {
    get status(): Live2DControllerStatus { return 'ready' },
    get modelId(): string | null { return state.id },
    on: vi.fn<(ev: string, cb: (s: unknown) => void) => () => void>(() => () => {}),
    init: vi.fn(async () => {}),
    switchModel: vi.fn(async (next: string) => {
      const eff = effectiveFor[next] ?? next
      state.id = eff
      return eff
    }),
    setState: vi.fn(),
    unload: vi.fn(() => { state.id = 'haru' }),
    // Task 5（B5/B6）：store 把设置/交互转发到 controller 的窄方法（store.init 也会重放当前设置）
    tick: vi.fn(),
    setAutoMotions: vi.fn(),
    setLipSync: vi.fn(),
    setPerformanceMode: vi.fn(),
    setViewTransform: vi.fn(),
    setLookTarget: vi.fn(),
    setMouthLevel: vi.fn(), // C1：口部采样接线（tick 采样 → setMouthLevel）
    playTapMotion: vi.fn(),
    // C3：指令消费——setExpression/playMotion 返回白名单命中 boolean（fake 缺省命中 true；未命中由用例覆写）
    setExpression: vi.fn(() => true),
    playMotion: vi.fn(() => true),
    // C2：可见性接线（D5C-05）与 GPU 重建 reset（D5C-04）
    setVisibility: vi.fn(),
    reset: vi.fn(async () => { state.id = 'haru' })
  }
  setLive2dControllerFactory(() => ctrl as unknown as Live2DController)
  return ctrl
}

describe('live2dStore Task 4：switchModel 生效 id 持久化（D5B-10）+ M1 串行化 + stateSource 接线', () => {
  beforeEach(() => { setLive2dControllerFactory(undefined); setMouthSourceFactory(undefined); vi.clearAllMocks() })
  afterEach(() => { vi.useRealTimers() })

  it('switchModel 用生效 id 持久化（成功 = 目标）', async () => {
    installEffectiveController({})
    const { store, settings } = freshStore()
    await store.init(fakeCanvas)
    await store.switchModel('lil')
    expect(store.modelId).toBe('lil')
    expect(settings.live2d.modelId).toBe('lil') // 持久化生效 id
  })

  it('switchModel 用生效 id 持久化（守卫丢弃 = 持久化旧 id，非请求目标）', async () => {
    installEffectiveController({ lil: 'haru' }) // 请求 lil，controller 判定生效为旧 id haru（守卫丢弃）
    const { store, settings } = freshStore()
    await store.init(fakeCanvas) // 初始 modelId=haru
    await store.switchModel('lil')
    expect(store.modelId).toBe('haru')
    expect(settings.live2d.modelId).toBe('haru') // 持久化生效 id 而非请求目标 lil
  })

  it('M1：init 完成前 switchModel 被串行化（不执行切换、置 error）', async () => {
    installFakes({ models: [MODEL_HARU, MODEL_LIL] })
    const { store, settings } = freshStore()
    await store.switchModel('lil') // 未 await init → ready 门 false
    expect(store.modelId).toBeNull()
    expect(store.error).toContain('尚未就绪')
    expect(settings.live2d.modelId).toBeNull()
  })

  it('M1：init 完成后 switchModel 恢复执行', async () => {
    installFakes({ models: [MODEL_HARU, MODEL_LIL] })
    const { store, settings } = freshStore()
    await store.init(fakeCanvas) // ready=true
    await store.switchModel('lil')
    expect(store.modelId).toBe('lil')
    expect(settings.live2d.modelId).toBe('lil')
  })

  it('dispose：退订 stateSource——源变化不再 push controller.setState（含 N1 timers 清理路径）', async () => {
    const ctrl = installEffectiveController({})
    const { store } = freshStore()
    await store.init(fakeCanvas) // stateSource 接线（初始 push idle）
    // 连接源变化 → stateSource → controller.setState('offline')
    useConnectionStore().setState({ status: 'disconnected' })
    expect(ctrl.setState).toHaveBeenCalledWith('offline')

    store.dispose() // 退订 stateSource + 清 timers
    ctrl.setState.mockClear()
    useConnectionStore().setState({ status: 'connected' })
    useConnectionStore().setState({ status: 'disconnected' })
    expect(ctrl.setState).not.toHaveBeenCalled() // 已退订不再 push
  })
})

describe('live2dStore Task 5（B5/B6）：设置→controller 窄转发 + characterState 事件镜像', () => {
  beforeEach(() => { setLive2dControllerFactory(undefined); setMouthSourceFactory(undefined); vi.clearAllMocks() })
  afterEach(() => { vi.useRealTimers() })

  it('store.init 把当前 settings 表现字段一次性推到 controller（autoMotions/lipSync/performanceMode/scale/offset）', async () => {
    const ctrl = installEffectiveController({})
    const { store, settings } = freshStore()
    settings.$patch({
      live2d: { autoMotions: false, lipSync: false, performanceMode: 'quality', scale: 2, offsetX: 1, offsetY: -1 }
    })
    await store.init(fakeCanvas)
    expect(ctrl.setAutoMotions).toHaveBeenCalledWith(false)
    expect(ctrl.setLipSync).toHaveBeenCalledWith(false)
    expect(ctrl.setPerformanceMode).toHaveBeenCalledWith('quality')
    expect(ctrl.setViewTransform).toHaveBeenCalledWith(2, 1, -1)
  })

  it('store 窄转发：setAutoMotions/setLipSync/setPerformanceMode/setViewTransform/setLookTarget/playTapMotion → controller', async () => {
    const ctrl = installEffectiveController({})
    const { store } = freshStore()
    await store.init(fakeCanvas)
    store.setAutoMotions(true)
    store.setLipSync(false)
    store.setPerformanceMode('low_power')
    store.setViewTransform(0.5, -2, 2)
    store.setLookTarget({ x: 0.4, y: -0.2 })
    store.setLookTarget(null)
    store.playTapMotion(1)
    expect(ctrl.setAutoMotions).toHaveBeenCalledWith(true)
    expect(ctrl.setLipSync).toHaveBeenCalledWith(false)
    expect(ctrl.setPerformanceMode).toHaveBeenCalledWith('low_power')
    expect(ctrl.setViewTransform).toHaveBeenCalledWith(0.5, -2, 2)
    expect(ctrl.setLookTarget).toHaveBeenCalledWith({ x: 0.4, y: -0.2 })
    expect(ctrl.setLookTarget).toHaveBeenCalledWith(null)
    expect(ctrl.playTapMotion).toHaveBeenCalledWith(1)
  })

  it('store.characterState 经 controller state 事件镜像（Panel 状态徽标数据源）；dispose 复位 + 退订', async () => {
    const stateCallbacks: Array<(s: unknown) => void> = []
    const unsubs: Array<ReturnType<typeof vi.fn>> = []
    const ctrl = installEffectiveController({})
    ctrl.on.mockImplementation((ev: string, cb: (s: unknown) => void) => {
      if (ev === 'state') stateCallbacks.push(cb)
      const unsub = vi.fn()
      unsubs.push(unsub)
      return unsub
    })
    const { store } = freshStore()
    await store.init(fakeCanvas)
    expect(store.characterState).toBe('offline') // 初始（无事件发出）

    stateCallbacks.forEach((cb) => cb('thinking'))
    expect(store.characterState).toBe('thinking')
    stateCallbacks.forEach((cb) => cb('speaking'))
    expect(store.characterState).toBe('speaking')

    store.dispose()
    expect(store.characterState).toBe('offline') // dispose 复位
    // 订阅已退订（store 逐一调用 on 返回的退订函数——真实 controller 此后不再推送 state 事件）
    expect(unsubs.length).toBeGreaterThan(0)
    for (const u of unsubs) expect(u).toHaveBeenCalled()
  })
})

describe('live2dStore Task5 M2（批次 C 收口）：restore 默认分叉', () => {
  beforeEach(() => { setLive2dControllerFactory(undefined); setMouthSourceFactory(undefined); vi.clearAllMocks() })
  afterEach(() => { vi.useRealTimers() })

  it('restore 默认：modelId 非 null → null 且已加载 ≠ 首个可用 → switchModel 首个可用（画布与持久化一致）', async () => {
    mockApi.listLive2dModels.mockResolvedValue([MODEL_HARU, MODEL_LIL])
    installEffectiveController({})
    const { store, settings } = freshStore()
    await store.init(fakeCanvas) // ready on haru
    await store.switchModel('lil') // 加载非首个 lil
    expect(store.modelId).toBe('lil')
    await store.restoreDefaults()
    // 置回 DEFAULT（modelId:null）+ 已加载 lil ≠ 首个 haru → switchModel(haru)
    expect(store.modelId).toBe('haru')
    expect(settings.live2d.modelId).toBe('haru') // 持久化实际生效 id（画布与持久化一致）
    expect(settings.live2d.performanceMode).toBe('auto') // DEFAULT_LIVE2D 其余字段已复位
    expect(settings.live2d.scale).toBe(1)
    expect(settings.live2d.enabled).toBe(true)
  })

  it('restore 默认：当前已是首个可用（或 modelId 本就 null）→ 不重载（controller.switchModel 不被调）', async () => {
    mockApi.listLive2dModels.mockResolvedValue([MODEL_HARU, MODEL_LIL])
    const ctrl = installEffectiveController({})
    const { store, settings } = freshStore()
    await store.init(fakeCanvas) // ready on haru（首个可用即当前）
    ctrl.switchModel.mockClear()
    await store.restoreDefaults()
    expect(ctrl.switchModel).not.toHaveBeenCalled() // 已加载 == 首个可用 → 不重载
    expect(settings.live2d.modelId).toBeNull()
    expect(store.modelId).toBe('haru')
  })

  it('restore 默认（面板已 dispose，settings overlay 卸载 chat 视图）：controller/models 空 → 显式持久化首个可用', async () => {
    mockApi.listLive2dModels.mockResolvedValue([MODEL_HARU, MODEL_LIL])
    installEffectiveController({})
    const { store, settings } = freshStore()
    await store.init(fakeCanvas)
    await store.switchModel('lil')
    expect(settings.live2d.modelId).toBe('lil')
    store.dispose() // panel onBeforeUnmount → store.dispose：controller 空、models 清空、ready=false
    expect(store.models).toEqual([])
    await store.restoreDefaults()
    // dispose 态无法即时切换 → 显式持久化首个可用（haru）；面板重挂载 init 读 modelId=haru 加载 → 画布与持久化一致
    expect(settings.live2d.modelId).toBe('haru')
    expect(settings.live2d.performanceMode).toBe('auto') // DEFAULT_LIVE2D 其余字段仍复位
  })
})

describe('live2dStore 批次 C（C1）：口部采样接线 + setMouthSourceFactory + mockMouthLevel 选源', () => {
  beforeEach(() => { setLive2dControllerFactory(undefined); setMouthSourceFactory(undefined); vi.clearAllMocks() })
  afterEach(() => { vi.useRealTimers() })

  it('tick 采样：attach（tts.playing ∧ ttsAudioEl）→ controller.setMouthLevel 收到源采样值；detach 归 0', async () => {
    const ctrl = installEffectiveController({})
    const fakeEl = {} as HTMLAudioElement
    const seq = [0.2, 0.4, 0.6, 0.8]
    let i = 0
    setMouthSourceFactory(() => ({
      attach: vi.fn(),
      detach: vi.fn(),
      sample: vi.fn(() => seq[i++ % seq.length]),
      dispose: vi.fn()
    }))
    const { store } = freshStore()
    await store.init(fakeCanvas)
    const voice = useVoiceStore()
    voice.tts.playing = true
    voice.ttsAudioEl = fakeEl
    await nextTick() // watch 触发 attach
    store.tick()
    expect(ctrl.setMouthLevel).toHaveBeenLastCalledWith(0.2)
    store.tick()
    expect(ctrl.setMouthLevel).toHaveBeenLastCalledWith(0.4)
    expect(store.mouthLevel).toBe(0.4) // 探针读值同步（集成 window.__cyreneTest.getMouthLevel 同源）
    // detach（停止播放）→ 归 0（watch else 分支 setMouthLevel(0)）
    ctrl.setMouthLevel.mockClear()
    voice.tts.playing = false
    await nextTick()
    expect(ctrl.setMouthLevel).toHaveBeenCalledWith(0)
    expect(store.mouthLevel).toBe(0)
    // detach 后 tick 不再采样（setMouthLevel 无新调用）
    ctrl.setMouthLevel.mockClear()
    store.tick()
    expect(ctrl.setMouthLevel).not.toHaveBeenCalled()
  })

  it('mockMouthLevel=step 时选合成源（不调用注入工厂）；未设时用注入工厂源', async () => {
    installFakes({ models: [MODEL_HARU] })
    let factoryCalled = false
    const fakeSrc = { attach: vi.fn(), detach: vi.fn(), sample: vi.fn(() => 0), dispose: vi.fn() }
    setMouthSourceFactory(() => { factoryCalled = true; return fakeSrc })
    // case 1：runtime 水合 step → 合成 step 源胜（工厂不调用）
    mockApi.getRuntimeInfo.mockResolvedValueOnce({ mode: 'mock', packaged: false, mockMouthLevel: 'step' })
    const { store } = freshStore()
    await store.init(fakeCanvas)
    expect(factoryCalled).toBe(false)
    store.dispose()
    // case 2：runtime 无 mockMouthLevel → 注入工厂源
    factoryCalled = false
    mockApi.getRuntimeInfo.mockResolvedValueOnce({ mode: 'mock', packaged: false })
    const { store: s2 } = freshStore()
    await s2.init(fakeCanvas)
    expect(factoryCalled).toBe(true)
  })
})

describe('live2dStore 批次 C（C2）：setVisibility 接线（D5C-05，消除 Task5 M4 死面）', () => {
  beforeEach(() => { setLive2dControllerFactory(undefined); setMouthSourceFactory(undefined); vi.clearAllMocks() })
  afterEach(() => { vi.useRealTimers() })

  it('init 把「布局可见 ∧ enabled」→ controller.setVisibility(true)；布局隐藏 → false（tick 不驱动 adapter）；恢复 → true', async () => {
    const { adapter, ctrl } = installFakes({ models: [MODEL_HARU] })
    const { store } = freshStore() // viewportWidth=2000 → live2dShown=true
    const visSpy = vi.spyOn(ctrl, 'setVisibility')
    await store.init(fakeCanvas)
    expect(visSpy).toHaveBeenLastCalledWith(true) // init immediate：布局可见 ∧ enabled
    // 布局隐藏（toggleLive2d → prefs.live2dVisible=false → live2dShown=false）→ setVisibility(false)
    useLayoutStore().toggleLive2d()
    await nextTick()
    expect(visSpy).toHaveBeenLastCalledWith(false)
    // controller 级门：隐藏态 tick 不驱动 adapter（不渲染空白帧）
    adapter.update.mockClear()
    store.tick()
    expect(adapter.update).not.toHaveBeenCalled()
    // 布局恢复 → setVisibility(true) → tick 恢复驱动
    useLayoutStore().toggleLive2d()
    await nextTick()
    expect(visSpy).toHaveBeenLastCalledWith(true)
    store.tick()
    expect(adapter.update).toHaveBeenCalledTimes(1)
  })

  it('enabled=false → setVisibility(false)；enabled 恢复 → true', async () => {
    const { ctrl } = installFakes({ models: [MODEL_HARU] })
    const { store, settings } = freshStore()
    const visSpy = vi.spyOn(ctrl, 'setVisibility')
    await store.init(fakeCanvas)
    expect(visSpy).toHaveBeenLastCalledWith(true)
    settings.$patch({ live2d: { enabled: false } })
    await nextTick()
    expect(visSpy).toHaveBeenLastCalledWith(false)
    settings.$patch({ live2d: { enabled: true } })
    await nextTick()
    expect(visSpy).toHaveBeenLastCalledWith(true)
  })

  it('dispose 退订可见性接线（布局变化不再推送 setVisibility）', async () => {
    const { ctrl } = installFakes({ models: [MODEL_HARU] })
    const { store } = freshStore()
    const visSpy = vi.spyOn(ctrl, 'setVisibility')
    await store.init(fakeCanvas)
    store.dispose()
    visSpy.mockClear()
    useLayoutStore().toggleLive2d()
    await nextTick()
    expect(visSpy).not.toHaveBeenCalled() // 已退订
  })
})

describe('live2dStore 批次 C（C2）：GPU 重建一次（D5C-04，reset(当前 modelId) + 重放 + guard finally 复位）', () => {
  beforeEach(() => { setLive2dControllerFactory(undefined); setMouthSourceFactory(undefined); vi.clearAllMocks() })
  afterEach(() => { vi.useRealTimers() })

  it('device_lost → reset(当前 modelId) 一次 + 重放 settings/lookTarget → 恢复 ready', async () => {
    const { adapter, ctrl } = installFakes({ models: [MODEL_HARU, MODEL_LIL] })
    const { store, settings } = freshStore()
    settings.$patch({ live2d: { autoMotions: false, lipSync: false, performanceMode: 'quality', scale: 2, offsetX: 1, offsetY: -1 } })
    await store.init(fakeCanvas) // ready on haru
    store.setLookTarget({ x: 0.5, y: -0.2 }) // 记录最近视线目标（重建后重放）
    const resetSpy = vi.spyOn(ctrl, 'reset')
    const autoSpy = vi.spyOn(ctrl, 'setAutoMotions')
    const lipSpy = vi.spyOn(ctrl, 'setLipSync')
    const perfSpy = vi.spyOn(ctrl, 'setPerformanceMode')
    const viewSpy = vi.spyOn(ctrl, 'setViewTransform')
    const lookSpy = vi.spyOn(ctrl, 'setLookTarget')
    adapter.update.mockImplementation(() => { throw new Live2DGpuLostError() })
    store.tick() // device_lost → 同步镜像 fallback + 异步 reset
    expect(store.status).toBe('fallback') // 重建期间静态头像
    expect(resetSpy).toHaveBeenCalledWith('haru') // reset 一次（当前 modelId）
    expect(resetSpy).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(store.status).toBe('ready')) // 重建成功
    // 重放 settings + lookTarget（复用 init 重放点）+ CharacterState（stateSource recompose）
    expect(autoSpy).toHaveBeenLastCalledWith(false)
    expect(lipSpy).toHaveBeenLastCalledWith(false)
    expect(perfSpy).toHaveBeenLastCalledWith('quality')
    expect(viewSpy).toHaveBeenLastCalledWith(2, 1, -1)
    expect(lookSpy).toHaveBeenLastCalledWith({ x: 0.5, y: -0.2 }) // 视线目标重放
    expect(store.modelId).toBe('haru')
  })

  it('重建 await 中再 device_lost → 不二次触发（rebuildGuard；direct emit 测试 seam）', async () => {
    const { adapter, ctrl } = installFakes({ models: [MODEL_HARU] })
    const { store } = freshStore()
    await store.init(fakeCanvas)
    // 让首次重建悬置：reset 的 createModel 永不 resolve（重建 await 中）
    adapter.createModel.mockImplementation(async () => new Promise(() => {}))
    const resetSpy = vi.spyOn(ctrl, 'reset')
    adapter.update.mockImplementation(() => { throw new Live2DGpuLostError() })
    store.tick() // 第一次 device_lost → 重建开始（createModel 悬置，rebuildGuard 已置位）
    await Promise.resolve() // 让 reset 进入 createModel await
    // 重建中再 device_lost（controller emit 私有，测试 seam 直调）→ guard 拦截不二次触发
    ;(ctrl as unknown as { emit: (e: string, p?: unknown) => void }).emit('device_lost')
    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(store.status).toBe('fallback') // 镜像 fallback（重建进行中）
  })

  it('device_lost 重建失败（createModel 抛）→ fallback；guard finally 复位（再次 device_lost 再重建）', async () => {
    const { adapter, ctrl } = installFakes({ models: [MODEL_HARU] })
    const { store } = freshStore()
    await store.init(fakeCanvas)
    const resetSpy = vi.spyOn(ctrl, 'reset')
    adapter.update.mockImplementation(() => { throw new Live2DGpuLostError() })
    adapter.createModel.mockRejectedValueOnce(new Error('reload failed')) // 仅重建这一次 createModel 失败
    store.tick()
    await vi.waitFor(() => expect(resetSpy).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 0)) // flush 失败链（createModel reject → reset/rebuildAfterLost catch）
    expect(store.status).toBe('fallback') // 重建失败 → 静态头像
    // guard finally 复位：再次 device_lost（direct emit——controller 失败态 tick 不再驱动）→ 重建成功
    ;(ctrl as unknown as { emit: (e: string, p?: unknown) => void }).emit('device_lost')
    await vi.waitFor(() => expect(store.status).toBe('ready'))
    expect(resetSpy).toHaveBeenCalledTimes(2)
  })

  it('重建成功后再次 device_lost → 再次重建（guard 非永久，finally 复位）', async () => {
    const { adapter, ctrl } = installFakes({ models: [MODEL_HARU] })
    const { store } = freshStore()
    await store.init(fakeCanvas)
    const resetSpy = vi.spyOn(ctrl, 'reset')
    adapter.update.mockImplementation(() => { throw new Live2DGpuLostError() })
    store.tick() // 第一次 device_lost → 重建
    await vi.waitFor(() => expect(store.status).toBe('ready'))
    expect(resetSpy).toHaveBeenCalledTimes(1)
    store.tick() // 第二次 device_lost → 再次重建（adapter.update 仍抛）
    await vi.waitFor(() => expect(store.status).toBe('ready'))
    expect(resetSpy).toHaveBeenCalledTimes(2)
  })

  it('重建后 stateSource 接线仍有效：重建成功后续源变化仍 push controller.setState（CharacterState 编排不中断）', async () => {
    const { adapter, ctrl } = installFakes({ models: [MODEL_HARU] })
    const { store } = freshStore()
    await store.init(fakeCanvas) // stateSource 接线（connection 缺省 disconnected → 'offline'）
    useConnectionStore().setState({ status: 'connected' }) // → 'idle'
    await nextTick()
    adapter.update.mockImplementation(() => { throw new Live2DGpuLostError() })
    store.tick() // device_lost → 重建（含重放 settings + stateSource recompose 恢复 CharacterState）
    await vi.waitFor(() => expect(store.status).toBe('ready'))
    const setStateSpy = vi.spyOn(ctrl, 'setState')
    // 重建后续源变化 → stateSource watch 仍驱动 controller.setState（重建未断开局编排）
    useConnectionStore().setState({ status: 'disconnected' })
    await nextTick()
    expect(setStateSpy).toHaveBeenCalledWith('offline')
    // recompose 本身（重组合/去重/瞬态 timer）由 live2d-state-source.spec 的 C2 用例覆盖
  })
})

// —— 阶段 5 批次 C（C3）：live2dStore.handleDirective（校验/脱敏/指令>emotion/建议强度 clamp）——

/** 带白名单的 fake handle（真实 controller 自动映射可命中不同表达式） */
function installWhitelistedHandle(adapter: { createModel: ReturnType<typeof vi.fn>; handles: Array<{ startExpression: ReturnType<typeof vi.fn> }> }): { handle: { startExpression: ReturnType<typeof vi.fn> } } {
  adapter.createModel.mockImplementation(async () => {
    const h = {
      update: vi.fn(), draw: vi.fn(), destroy: vi.fn(),
      getParameterIdList: vi.fn(() => []),
      getMotionFileWhitelist: vi.fn(() => []),
      getExpressionFileWhitelist: vi.fn(() => ['expressions/F01.exp3.json', 'expressions/f01_happy.exp3.json']),
      setParam: vi.fn(), setViewTransform: vi.fn(),
      startMotion: vi.fn(async () => {}),
      startExpression: vi.fn(async () => {}),
      stopMotion: vi.fn(), stopAll: vi.fn()
    }
    adapter.handles.push(h)
    return h
  })
  return { handle: adapter.handles[0] }
}

/** 注入一条已完成带 emotion 的 assistant 消息（live2dStore.lastCompletedEmotion 数据源） */
function injectCompletedMessage(emotion: string | undefined): void {
  const msg = useMessageStore()
  msg.byId['m-1'] = {
    messageId: 'm-1', conversationId: 'conv-1', role: 'assistant', status: 'completed',
    emotion, createdAt: '2026-08-18T00:00:00.000Z', assistantSegments: []
  }
  msg.order.push('m-1')
}

describe('live2dStore 批次 C（C3）：handleDirective 指令消费（live2d.directive）', () => {
  beforeEach(() => { setLive2dControllerFactory(undefined); setMouthSourceFactory(undefined); vi.clearAllMocks() })
  afterEach(() => { vi.useRealTimers() })

  it('happy 指令 → pushDirective（stateSource）被调 → controller.setState(happy)', async () => {
    const ctrl = installEffectiveController({})
    const { store } = freshStore()
    await store.init(fakeCanvas)
    ctrl.setState.mockClear()
    store.handleDirective({ event: 'live2d.directive', eventId: 'd1', sequence: 1, state: 'happy', priority: 1, durationMs: 5000 })
    expect(ctrl.setState).toHaveBeenCalledWith('happy') // pushDirective → stateSource → controller.setState
  })

  it('expression 白名单未命中 → 脱敏 warn（含 modelId、不含 payload 原文）', async () => {
    const ctrl = installEffectiveController({})
    ctrl.setExpression.mockReturnValue(false) // 白名单未命中 → false → directive_miss
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store } = freshStore()
    await store.init(fakeCanvas)
    store.handleDirective({ event: 'live2d.directive', eventId: 'd1', sequence: 1, state: 'happy', expression: 'expressions/evil.exp3.json', priority: 1 })
    // 脱敏载荷：warn 第二参为 { modelId, code } 对象——断言含 code/modelId、不含 payload 原文
    const warnObjects = warnSpy.mock.calls.map((c) => c[1] as { modelId?: string; code?: string } | undefined)
    expect(warnObjects.some((o) => o?.code === 'directive_miss')).toBe(true)
    expect(warnObjects.some((o) => o?.modelId === 'haru')).toBe(true)
    expect(warnSpy.mock.calls.some((c) => JSON.stringify(c).includes('expressions/evil.exp3.json'))).toBe(false)
    warnSpy.mockRestore()
  })

  it("state='error'（非七值）→ 丢弃整条 + 脱敏 warn（不 push 不 setExpression）", async () => {
    const ctrl = installEffectiveController({})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store } = freshStore()
    await store.init(fakeCanvas)
    ctrl.setState.mockClear()
    // 'error' 非七值（wire schema 在 preload 已拒；此处直接调用 handleDirective 测 store 运行时防御）
    store.handleDirective({ event: 'live2d.directive', eventId: 'd1', sequence: 1, state: 'error', priority: 1 } as unknown as Live2DDirectiveEvent)
    expect(ctrl.setState).not.toHaveBeenCalled()
    expect(warnSpy.mock.calls.map((c) => c[1] as { code?: string } | undefined).some((o) => o?.code === 'directive_invalid')).toBe(true)
    warnSpy.mockRestore()
  })

  it('priority=2 → clamp 1（指令永不覆盖 client 2/3 级现实态 speaking）', async () => {
    const { ctrl } = installFakes({ models: [MODEL_HARU] })
    const { store } = freshStore()
    await store.init(fakeCanvas)
    ctrl.setState('speaking') // 机器当前 speaking（2 级）
    const setStateSpy = vi.spyOn(ctrl, 'setState')
    store.handleDirective({ event: 'live2d.directive', eventId: 'd1', sequence: 1, state: 'happy', priority: 2, durationMs: 5000 })
    // priority 2 被 clamp 到 1 → 1 < speaking(2) → pushDirective 丢弃（不覆盖 client 现实态）
    expect(setStateSpy).not.toHaveBeenCalled()
  })

  it('指令 motion → controller.playMotion(file, clampedPriority, durationMs)', async () => {
    const ctrl = installEffectiveController({})
    const { store } = freshStore()
    await store.init(fakeCanvas)
    store.handleDirective({ event: 'live2d.directive', eventId: 'd1', sequence: 1, state: 'happy', motion: 'motions/wave.motion3.json', priority: 1, durationMs: 3000 })
    expect(ctrl.playMotion).toHaveBeenCalledWith('motions/wave.motion3.json', 1, 3000)
  })

  it('指令>emotion：generation.completed emotion + 同帧 directive expression → 最终生效表达式 = 指令的', async () => {
    const { adapter } = installFakes({ models: [MODEL_HARU] })
    installWhitelistedHandle(adapter) // 白名单含「指令目标 F01」与「情绪 happy 自动映射目标 f01_happy」（不同文件）
    const { store } = freshStore()
    await store.init(fakeCanvas)
    // 连接 + 已完成带 emotion=happy 的消息 → 情绪态 happy（自动映射 f01_happy，startExpression 被调）
    useConnectionStore().setState({ status: 'connected' })
    injectCompletedMessage('happy')
    await nextTick()
    const handle = adapter.handles[0]
    handle.startExpression.mockClear()
    // 同帧指令：expression=F01（≠ 情绪自动映射 f01_happy）
    store.handleDirective({ event: 'live2d.directive', eventId: 'd1', sequence: 1, state: 'happy', expression: 'expressions/F01.exp3.json', priority: 1, durationMs: 5000 })
    // 最终生效表达式 = 指令的（最后一次 startExpression 是 F01；情绪自动映射 f01_happy 不覆盖）
    expect(handle.startExpression).toHaveBeenLastCalledWith('haru', 'expressions/F01.exp3.json')
  })

  it('directiveExpressionActive 指令瞬态存活期抑制 emotion 自动映射；超时后恢复（真实组合路径）', async () => {
    vi.useFakeTimers()
    const { adapter, ctrl } = installFakes({ models: [MODEL_HARU] })
    installWhitelistedHandle(adapter)
    const { store } = freshStore()
    await store.init(fakeCanvas)
    useConnectionStore().setState({ status: 'connected' })
    injectCompletedMessage('happy') // → 情绪态 happy（自动映射 f01_happy）
    await nextTick()
    const handle = adapter.handles[0]
    handle.startExpression.mockClear()
    // 指令带 expression（F01，命中）→ directiveExpressionActive=true（最终生效 F01）
    store.handleDirective({ event: 'live2d.directive', eventId: 'd1', sequence: 1, state: 'happy', expression: 'expressions/F01.exp3.json', priority: 1, durationMs: 2000 })
    expect(handle.startExpression).toHaveBeenLastCalledWith('haru', 'expressions/F01.exp3.json')
    // 指令瞬态存活期间：emotion 源再变化（surprised）→ 组合被指令瞬态保护（低优先不覆盖）→ controller.setState 无新调
    const setStateSpy = vi.spyOn(ctrl, 'setState')
    const msg = useMessageStore()
    msg.byId['m-1'].emotion = 'surprised'
    await nextTick()
    expect(setStateSpy).not.toHaveBeenCalled()
    // 指令超时 → onDirectiveEnd 清 directiveExpressionActive → emotion 路径恢复（再变化 → 组合 mood → push）
    vi.advanceTimersByTime(2100)
    setStateSpy.mockClear()
    msg.byId['m-1'].emotion = 'happy'
    await nextTick()
    expect(setStateSpy).toHaveBeenCalledWith('happy') // 恢复后 emotion→情绪态→表情自动映射
  })
})

describe('live2dStore F-1（联调前整改）：真实后端中文 mood 归一 → 情绪态', () => {
  beforeEach(() => { setLive2dControllerFactory(undefined); setMouthSourceFactory(undefined); vi.clearAllMocks() })
  afterEach(() => { vi.useRealTimers() })

  it('injectCompletedMessage("开心") → 归一 happy → controller.setState(happy)', async () => {
    const ctrl = installEffectiveController({})
    const { store } = freshStore()
    await store.init(fakeCanvas)
    useConnectionStore().setState({ status: 'connected' })
    ctrl.setState.mockClear()
    injectCompletedMessage('开心')
    await nextTick()
    expect(ctrl.setState).toHaveBeenCalledWith('happy')
  })

  it('injectCompletedMessage("难过"/"惊讶") → sad / surprised', async () => {
    const ctrl = installEffectiveController({})
    const { store } = freshStore()
    await store.init(fakeCanvas)
    useConnectionStore().setState({ status: 'connected' })
    ctrl.setState.mockClear()
    injectCompletedMessage('难过')
    await nextTick()
    expect(ctrl.setState).toHaveBeenCalledWith('sad')
    ctrl.setState.mockClear()
    injectCompletedMessage('惊讶')
    await nextTick()
    expect(ctrl.setState).toHaveBeenCalledWith('surprised')
  })

  it('injectCompletedMessage("平静") → 未命中 → 从 happy 回业务态 idle（未知码不成为动作/表达式名）', async () => {
    const ctrl = installEffectiveController({})
    const { store } = freshStore()
    await store.init(fakeCanvas)
    useConnectionStore().setState({ status: 'connected' })
    injectCompletedMessage('开心') // 归一命中 → 情绪态 happy
    await nextTick()
    expect(ctrl.setState).toHaveBeenCalledWith('happy')
    ctrl.setState.mockClear()
    injectCompletedMessage('平静') // 归一 undefined → 回业务态 idle（而非残留 happy）
    await nextTick()
    expect(ctrl.setState).toHaveBeenCalledWith('idle')
  })
})