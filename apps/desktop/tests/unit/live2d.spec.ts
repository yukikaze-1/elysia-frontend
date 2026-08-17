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
import { Live2DController, type Live2DControllerStatus } from '../../src/renderer/src/live2d/controller'
import { Live2DGpuLostError, type Live2DAdapter } from '../../src/renderer/src/live2d/adapter'
import { setLive2dControllerFactory, useLive2dStore } from '../../src/renderer/src/stores/live2d.store'
import { useSettingsStore } from '../../src/renderer/src/stores/settings.store'
import { useConnectionStore } from '../../src/renderer/src/stores/connection.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import type { Live2DModelSummary } from '@shared/contracts'

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
  setEndpoint: vi.fn(), getEndpoint: vi.fn(), getRuntimeInfo: vi.fn(),
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
  listLive2dModels: vi.fn()
}

/** 装载 fake 控制器工厂（store 经 setLive2dControllerFactory 注入；adapter/list 均为 fake） */
function installFakes(opts: { models?: Live2DModelSummary[] } = {}) {
  const models = opts.models ?? [MODEL_HARU, MODEL_LIL, MODEL_BROKEN]
  const adapter = makeFakeAdapter()
  const list = vi.fn(async () => models)
  setLive2dControllerFactory(() => new Live2DController({ adapter: asAdapter(adapter), list: list as unknown as () => Promise<Live2DModelSummary[]> }))
  mockApi.listLive2dModels.mockResolvedValue(models)
  return { adapter, list, models }
}

function freshStore() {
  setActivePinia(createPinia())
  setDesktopApi(mockApi)
  const store = useLive2dStore()
  const settings = useSettingsStore()
  return { store, settings }
}

describe('Live2DController（fake adapter / fake list / fake GL）', () => {
  beforeEach(() => { setLive2dControllerFactory(undefined); vi.clearAllMocks() })
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
  beforeEach(() => { vi.clearAllMocks() })
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
  beforeEach(() => { vi.clearAllMocks() })
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

describe('live2dStore Task 4：switchModel 生效 id 持久化（D5B-10）+ M1 串行化 + stateSource 接线', () => {
  // 注入可配置生效 id 的 fake controller（store 消费 controller.switchModel 返回值）
  function installEffectiveController(effectiveFor: Record<string, string>) {
    const state = { id: 'haru' }
    const ctrl = {
      get status(): Live2DControllerStatus { return 'ready' },
      get modelId(): string | null { return state.id },
      on: vi.fn(() => () => {}),
      init: vi.fn(async () => {}),
      switchModel: vi.fn(async (next: string) => {
        const eff = effectiveFor[next] ?? next
        state.id = eff
        return eff
      }),
      setState: vi.fn(),
      unload: vi.fn(() => { state.id = 'haru' })
    }
    setLive2dControllerFactory(() => ctrl as unknown as Live2DController)
    return ctrl
  }

  beforeEach(() => { setLive2dControllerFactory(undefined); vi.clearAllMocks() })
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