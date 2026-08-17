// tests/unit/live2d-controller.spec.ts
// 阶段 5 批次 B（Task 3，B1/B2/B4 controller 内核）：fake adapter（可配置参数集/白名单）+ fake list 驱动
// Live2DController 真实实现——setState 驱动状态机；playMotion/setExpression 白名单内/外；B4 无动作模型各态写对
// 参数；setLookTarget(null) 回正；setMouthLevel 驱口型；switchModel 返回生效 id（成功/守卫/失败）。
import { describe, expect, it, beforeEach, vi } from 'vitest'

// —— Core 全局桩（live2d.spec 同款：node 无 live2dcubismcore.min.js；controller→adapter→cubismmoc→
//   cubismmodel 模块作用域枚举初始化在 import 时访问全局；vi.hoisted 先于一切 import 执行）——
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

import { Live2DController, type NormalizedPoint } from '../../src/renderer/src/live2d/controller'
import type { Live2DAdapter } from '../../src/renderer/src/live2d/adapter'
import type { Live2DModelSummary } from '@shared/contracts'

// —— fixtures ——
const MODEL_A: Live2DModelSummary = {
  id: 'a', displayName: 'A', preview: null, version: '1.0',
  available: true, licenseRef: 'LICENSE.txt', integrityState: 'verified'
}
const MODEL_B: Live2DModelSummary = {
  id: 'b', displayName: 'B', preview: null, version: '1.0',
  available: true, licenseRef: 'LICENSE.txt', integrityState: 'verified'
}

// —— fake handle（可配置参数集 / motion / expression 白名单；setParam/startMotion/startExpression 记录 spy）——
type MockFn = ReturnType<typeof vi.fn>
interface FakeHandle {
  update: MockFn
  draw: MockFn
  destroy: MockFn
  getParameterIdList: MockFn
  getMotionFileWhitelist: MockFn
  getExpressionFileWhitelist: MockFn
  setParam: MockFn
  setViewTransform: MockFn
  startMotion: MockFn
  startExpression: MockFn
  stopMotion: MockFn
  stopAll: MockFn
}

function makeHandle(opts: { params?: string[]; motions?: string[]; expressions?: string[] }): FakeHandle {
  return {
    update: vi.fn(),
    draw: vi.fn(),
    destroy: vi.fn(),
    getParameterIdList: vi.fn(() => opts.params ?? []),
    getMotionFileWhitelist: vi.fn(() => opts.motions ?? []),
    getExpressionFileWhitelist: vi.fn(() => opts.expressions ?? []),
    setParam: vi.fn(),
    setViewTransform: vi.fn(),
    startMotion: vi.fn(async () => {}),
    startExpression: vi.fn(async () => {}),
    stopMotion: vi.fn(),
    stopAll: vi.fn()
  }
}

/** 装配默认适配器：createModel 由各用例 mockImplementation 覆盖（返回带目标参数集/白名单的 handle） */
function makeHarness(): {
  adapter: {
    handles: FakeHandle[]
    initialize: MockFn
    createModel: MockFn
    update: MockFn
    destroy: MockFn
  }
  ctrl: Live2DController
  getHandle: (a?: { handles: FakeHandle[] }) => FakeHandle
} {
  const handles: FakeHandle[] = []
  const adapter = {
    handles,
    initialize: vi.fn(() => true),
    createModel: vi.fn(async () => {
      const h = makeHandle({})
      handles.push(h)
      return h
    }),
    update: vi.fn(),
    destroy: vi.fn()
  }
  const ctrl = new Live2DController({ adapter: adapter as unknown as Live2DAdapter, list: async () => [MODEL_A, MODEL_B] })
  return { adapter, ctrl, getHandle: () => handles[handles.length - 1] }
}

const fakeCanvas = { width: 340, height: 680 } as HTMLCanvasElement

const FULL_PARAMS = [
  'ParamAngleX', 'ParamAngleZ', 'ParamEyeLOpen', 'ParamEyeROpen',
  'ParamMouthOpenY', 'ParamEyeLSmile', 'ParamEyeRSmile', 'ParamEyeBallX', 'ParamEyeBallY'
]

function writtenIds(h: FakeHandle): string[] {
  return h.setParam.mock.calls.map((c: unknown[]) => c[0] as string)
}

/** 公共：把 createModel 装配为返回带指定规格的 handle */
function stubHandle(adapter: { createModel: MockFn; handles: FakeHandle[] }, spec: { params?: string[]; motions?: string[]; expressions?: string[] }): void {
  adapter.createModel.mockImplementation(async () => {
    const h = makeHandle(spec)
    adapter.handles.push(h)
    return h
  })
}

describe('Live2DController 批次 B 内核', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('setState 驱动状态机：characterState 反应当前态', async () => {
    const { ctrl } = makeHarness()
    await ctrl.init(fakeCanvas)
    ctrl.setState('thinking')
    expect(ctrl.characterState).toBe('thinking')
    ctrl.setState('speaking')
    expect(ctrl.characterState).toBe('speaking')
    ctrl.setState('idle')
    expect(ctrl.characterState).toBe('idle')
  })

  it('playMotion：白名单内 → startMotion(modelId, file, priority)；白名单外 → 忽略不抛错', async () => {
    const h = makeHarness()
    stubHandle(h.adapter, { motions: ['motions/idle.motion3.json'] })
    await h.ctrl.init(fakeCanvas)
    const handle = h.getHandle()

    h.ctrl.playMotion('motions/idle.motion3.json', 2)
    expect(handle.startMotion).toHaveBeenCalledWith('a', 'motions/idle.motion3.json', 2)

    h.ctrl.playMotion('motions/evil.motion3.json', 1) // 白名单外 → 忽略
    expect(handle.startMotion).toHaveBeenCalledTimes(1)
  })

  it('setExpression：白名单内 → startExpression；白名单外 → 忽略', async () => {
    const h = makeHarness()
    stubHandle(h.adapter, { expressions: ['expressions/happy.exp3.json'] })
    await h.ctrl.init(fakeCanvas)
    const handle = h.getHandle()

    h.ctrl.setExpression('expressions/happy.exp3.json')
    expect(handle.startExpression).toHaveBeenCalledWith('a', 'expressions/happy.exp3.json')

    h.ctrl.setExpression('expressions/evil.exp3.json')
    expect(handle.startExpression).toHaveBeenCalledTimes(1)
  })

  it('B4 路由：无动作模型写参数级(ParamAngleX)；有动作模型不写参数级(走 B3)', async () => {
    const h1 = makeHarness()
    stubHandle(h1.adapter, { params: [...FULL_PARAMS], motions: [], expressions: [] })
    await h1.ctrl.init(fakeCanvas)
    h1.ctrl.setState('thinking')
    h1.ctrl.tick()
    expect(writtenIds(h1.getHandle())).toContain('ParamAngleX')

    const h2 = makeHarness()
    stubHandle(h2.adapter, { params: [...FULL_PARAMS], motions: ['motions/idle.motion3.json'] })
    await h2.ctrl.init(fakeCanvas)
    h2.ctrl.setState('thinking')
    h2.ctrl.tick()
    expect(writtenIds(h2.getHandle())).not.toContain('ParamAngleX')
  })

  it('B4 无动作模型各态参数级回退（存在性判定：不在参数集不写）', async () => {
    const h = makeHarness()
    stubHandle(h.adapter, {
      params: ['ParamAngleZ', 'ParamAngleX', 'ParamMouthOpenY', 'ParamEyeLSmile', 'ParamEyeRSmile', 'ParamEyeLOpen', 'ParamEyeROpen'],
      motions: [], expressions: []
    })
    await h.ctrl.init(fakeCanvas)
    const handle = h.getHandle()

    // speaking → ParamMouthOpenY（电平经 setMouthLevel 注入）
    h.ctrl.setMouthLevel(0.8)
    h.ctrl.setState('speaking')
    h.ctrl.tick()
    expect(writtenIds(handle)).toContain('ParamMouthOpenY')

    // happy → EyeLSmile/RSmile
    h.ctrl.setState('happy')
    h.ctrl.tick()
    const idsHappy = writtenIds(handle)
    expect(idsHappy).toContain('ParamEyeLSmile')
    expect(idsHappy).toContain('ParamEyeRSmile')

    // surprised → EyeLOpen/ROpen（瞪大）
    h.ctrl.setState('surprised')
    h.ctrl.tick()
    const idsSur = writtenIds(handle)
    expect(idsSur).toContain('ParamEyeLOpen')
    expect(idsSur).toContain('ParamEyeROpen')

    // error → ParamAngleZ（歪头）
    h.ctrl.setState('error')
    h.ctrl.tick()
    expect(writtenIds(handle)).toContain('ParamAngleZ')

    // 存在性判定：ParamEyeBall 不在参数集 → setLookTarget 仍不写
    h.ctrl.setLookTarget({ x: 0.5, y: -0.2 })
    h.ctrl.tick()
    expect(writtenIds(handle)).not.toContain('ParamEyeBallX')
    expect(writtenIds(handle)).not.toContain('ParamEyeBallY')
  })

  it('setMouthLevel 驱口型：speaking 无动作模型 → ParamMouthOpenY 写 0.8；越界钳制到 1', async () => {
    const h = makeHarness()
    stubHandle(h.adapter, { params: [...FULL_PARAMS], motions: [], expressions: [] })
    await h.ctrl.init(fakeCanvas)
    const handle = h.getHandle()
    const mouthCalls = () => handle.setParam.mock.calls.filter((c: unknown[]) => c[0] === 'ParamMouthOpenY')

    h.ctrl.setMouthLevel(0.8)
    h.ctrl.setState('speaking')
    h.ctrl.tick()
    const last = mouthCalls()[mouthCalls().length - 1] as unknown[]
    expect(last[1]).toBeCloseTo(0.8)

    h.ctrl.setMouthLevel(1.4)
    h.ctrl.tick()
    const last2 = mouthCalls()[mouthCalls().length - 1] as unknown[]
    expect(last2[1]).toBe(1)
  })

  it('setLookTarget(null) 回正：写 0；非 null 写目标值（存在性判定）', async () => {
    const h = makeHarness()
    stubHandle(h.adapter, { params: [...FULL_PARAMS], motions: [], expressions: [] })
    await h.ctrl.init(fakeCanvas)
    const handle = h.getHandle()
    const ball = (id: string) => handle.setParam.mock.calls.find((c: unknown[]) => c[0] === id) as unknown[] | undefined

    const target: NormalizedPoint = { x: 0.6, y: -0.3 }
    h.ctrl.setLookTarget(target)
    h.ctrl.tick()
    expect(ball('ParamEyeBallX')?.[1]).toBeCloseTo(0.6)
    expect(ball('ParamEyeBallY')?.[1]).toBeCloseTo(-0.3)

    handle.setParam.mockClear()
    h.ctrl.setLookTarget(null)
    h.ctrl.tick()
    expect(ball('ParamEyeBallX')?.[1]).toBe(0)
    expect(ball('ParamEyeBallY')?.[1]).toBe(0)
  })

  it('switchModel 返回生效 id：成功 = 目标 id', async () => {
    const { ctrl } = makeHarness()
    await ctrl.init(fakeCanvas)
    expect(await ctrl.switchModel('b')).toBe('b')
    expect(ctrl.modelId).toBe('b')
  })

  it('switchModel 失败：抛错保留旧 id', async () => {
    const { ctrl, adapter } = makeHarness()
    await ctrl.init(fakeCanvas) // ready on 'a'
    adapter.createModel.mockRejectedValueOnce(new Error('load failed'))
    await expect(ctrl.switchModel('b')).rejects.toThrow('load failed')
    expect(ctrl.modelId).toBe('a')
  })

  it('switchModel 守卫：切换中重入返回旧 id（丢弃新目标）', async () => {
    const { ctrl } = makeHarness()
    await ctrl.init(fakeCanvas) // ready on 'a'
    const p1 = ctrl.switchModel('b')
    const eff = await ctrl.switchModel('c') // 切换中 → 返回旧 id
    expect(eff).toBe('a')
    await p1
    expect(ctrl.modelId).toBe('b')
  })

  it('switchModel 同模型幂等返回目标 id（= 当前），不重复加载', async () => {
    const { ctrl, adapter } = makeHarness()
    await ctrl.init(fakeCanvas) // 'a'
    const before = adapter.createModel.mock.calls.length
    expect(await ctrl.switchModel('a')).toBe('a')
    expect(adapter.createModel.mock.calls.length).toBe(before)
  })

  it('setAutoMotions(false) 停待机动画：无动作模型 state=thinking 不再写 ParamAngleX', async () => {
    const h = makeHarness()
    stubHandle(h.adapter, { params: [...FULL_PARAMS], motions: [], expressions: [] })
    await h.ctrl.init(fakeCanvas)
    const handle = h.getHandle()
    h.ctrl.setAutoMotions(false)
    h.ctrl.setState('thinking')
    h.ctrl.tick()
    expect(writtenIds(handle)).not.toContain('ParamAngleX')
    expect(h.ctrl.autoMotionsEnabled).toBe(false)
  })

  it('setLipSync(false)（M5 口型独立门）：speaking 无动作模型不再写口型电平，门关时写 0 清态；眨眼仍在（autoMotions 管）', async () => {
    const h = makeHarness()
    stubHandle(h.adapter, { params: [...FULL_PARAMS], motions: [], expressions: [] })
    await h.ctrl.init(fakeCanvas)
    const handle = h.getHandle()
    const mouthValue = () => {
      const c = handle.setParam.mock.calls.find((call: unknown[]) => call[0] === 'ParamMouthOpenY')
      return c ? (c[1] as number) : undefined
    }

    // 门开（默认）：speaking 写 0.8
    h.ctrl.setMouthLevel(0.8)
    h.ctrl.setState('speaking')
    h.ctrl.tick()
    expect(mouthValue()).toBeCloseTo(0.8)

    // 门关：口部写 0 清态（不残留 0.8）；眨眼/呼吸仍驱动
    handle.setParam.mockClear()
    h.ctrl.setLipSync(false)
    h.ctrl.tick()
    expect(mouthValue()).toBe(0)
    expect(writtenIds(handle)).toContain('ParamEyeLOpen') // autoMotions 管理的眨眼不受 lipSync 门影响
    expect(h.ctrl.lipSyncEnabled).toBe(false)
  })

  it('playTapMotion（Task 5 点击预设动作）：白名单语义最接近 tap/greeting 命中 → 经 playMotion 仲裁；不打断高优先；无命中静默', async () => {
    // 命中：tap 语义优先
    const h = makeHarness()
    stubHandle(h.adapter, { motions: ['motions/greeting.motion3.json', 'motions/tap_body.motion3.json'] })
    await h.ctrl.init(fakeCanvas)
    const handle = h.getHandle()

    h.ctrl.playTapMotion(1)
    expect(handle.startMotion).toHaveBeenCalledWith('a', 'motions/tap_body.motion3.json', 1)

    // 不打断 3 级（error）：priority=1 被丢弃
    handle.startMotion.mockClear()
    h.ctrl.setState('error')
    h.ctrl.playTapMotion(1)
    expect(handle.startMotion).not.toHaveBeenCalled()

    // 无命中（白名单不含 tap/greeting/touch/knock 语义）→ 静默忽略不抛错
    const h2 = makeHarness()
    stubHandle(h2.adapter, { motions: ['motions/idle.motion3.json'] })
    await h2.ctrl.init(fakeCanvas)
    h2.ctrl.setState('idle')
    expect(() => h2.ctrl.playTapMotion(1)).not.toThrow()
    expect(h2.getHandle().startMotion).not.toHaveBeenCalled()
  })

  it('setViewTransform 转发 handle（钳制在 adapter 层，controller 原样转发）', async () => {
    const h = makeHarness()
    await h.ctrl.init(fakeCanvas)
    const handle = h.getHandle()
    h.ctrl.setViewTransform(2, 1, -1)
    expect(handle.setViewTransform).toHaveBeenCalledWith(2, 1, -1)
    h.ctrl.setViewTransform(100, -99, 99)
    expect(handle.setViewTransform).toHaveBeenLastCalledWith(100, -99, 99)
  })

  it('setState 状态变更 emit state 事件（Task 5 状态徽标订阅源）；同态幂等不重发', async () => {
    const { ctrl } = makeHarness()
    await ctrl.init(fakeCanvas)
    const onState = vi.fn()
    ctrl.on('state', onState)
    ctrl.setState('thinking')
    expect(onState).toHaveBeenCalledWith('thinking')
    ctrl.setState('speaking')
    expect(onState).toHaveBeenLastCalledWith('speaking')
    ctrl.setState('speaking')
    expect(onState).toHaveBeenCalledTimes(2) // 同态幂等
  })
})

describe('Live2DController Task 4：动作调度仲裁（B3）+ 情绪→表情（I-1）', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('playMotion：同动作短时重复合并（去抖 ~500ms）', async () => {
    vi.useFakeTimers()
    const h = makeHarness()
    stubHandle(h.adapter, { motions: ['motions/idle.motion3.json'] })
    await h.ctrl.init(fakeCanvas)
    const handle = h.getHandle()

    h.ctrl.playMotion('motions/idle.motion3.json', 2)
    expect(handle.startMotion).toHaveBeenCalledTimes(1)

    h.ctrl.playMotion('motions/idle.motion3.json', 2) // 500ms 内重复 → 合并忽略
    expect(handle.startMotion).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(500)
    h.ctrl.playMotion('motions/idle.motion3.json', 2) // 去抖窗口过 → 播放
    expect(handle.startMotion).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('playMotion：长动作 ~15s 超时 → stopMotion(priority)', async () => {
    vi.useFakeTimers()
    const h = makeHarness()
    stubHandle(h.adapter, { motions: ['motions/idle.motion3.json'] })
    await h.ctrl.init(fakeCanvas)
    const handle = h.getHandle()

    h.ctrl.playMotion('motions/idle.motion3.json', 2)
    expect(handle.stopMotion).not.toHaveBeenCalled()

    vi.advanceTimersByTime(15000)
    expect(handle.stopMotion).toHaveBeenCalledWith(2) // 超时停对应优先级
    vi.useRealTimers()
  })

  it('playMotion 优先级仲裁：3 级态（error）不被低优先打断；speaking/thinking 激活时不发点击（priority=1）', async () => {
    const h = makeHarness()
    stubHandle(h.adapter, { motions: ['motions/click.motion3.json', 'motions/wave.motion3.json'] })
    await h.ctrl.init(fakeCanvas)
    const handle = h.getHandle()
    handle.startMotion.mockClear()

    // error（3 级）：priority 1/2 均被丢弃
    h.ctrl.setState('error')
    h.ctrl.playMotion('motions/click.motion3.json', 1)
    h.ctrl.playMotion('motions/wave.motion3.json', 2)
    expect(handle.startMotion).not.toHaveBeenCalled()

    // speaking（2 级）：priority=1 点击被丢弃；priority=2 同等级可发
    h.ctrl.setState('speaking')
    h.ctrl.playMotion('motions/click.motion3.json', 1)
    expect(handle.startMotion).not.toHaveBeenCalled()
    h.ctrl.playMotion('motions/wave.motion3.json', 2)
    expect(handle.startMotion).toHaveBeenCalledTimes(1)

    // thinking（2 级）：priority=1 点击同样不打断
    h.ctrl.setState('thinking')
    handle.startMotion.mockClear()
    h.ctrl.playMotion('motions/click.motion3.json', 1)
    expect(handle.startMotion).not.toHaveBeenCalled()

    // 回 idle（0 级）：priority=1 点击可发
    h.ctrl.setState('idle')
    h.ctrl.playMotion('motions/click.motion3.json', 1)
    expect(handle.startMotion).toHaveBeenCalledTimes(1)
  })

  it('playMotion：模型未就绪（unloaded）只记最新不播放（不抛错、无 handle 不外发）', () => {
    const h = makeHarness()
    stubHandle(h.adapter, { motions: ['motions/idle.motion3.json'] })
    expect(() => h.ctrl.playMotion('motions/idle.motion3.json', 2)).not.toThrow()
    expect(h.adapter.handles.length).toBe(0) // 未 init → 无 handle，无外发目标
  })

  it('switchModel：清队列（stopAll）+ 清调度状态（切换后同路径动作不被上个模型去抖合并）', async () => {
    vi.useFakeTimers()
    const h = makeHarness()
    stubHandle(h.adapter, { motions: ['motions/tap.motion3.json'] })
    await h.ctrl.init(fakeCanvas) // handle1 on 'a'
    const h1 = h.getHandle()
    h1.startMotion.mockClear()
    h.ctrl.playMotion('motions/tap.motion3.json', 1)
    expect(h1.startMotion).toHaveBeenCalledTimes(1)

    // 切换模型：新 handle 被 stopAll（清队列）
    await h.ctrl.switchModel('b')
    const h2 = h.getHandle()
    expect(h2.stopAll).toHaveBeenCalledTimes(1)

    // 新模型同路径动作立即播放（去抖状态已被清，不被上个模型时间戳合并）
    h2.startMotion.mockClear()
    h.ctrl.playMotion('motions/tap.motion3.json', 1)
    expect(h2.startMotion).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('情绪→表情（I-1）：happy/sad/surprised 白名单命中 → setExpression；不命中 → 落 B4（不调 setExpression）', async () => {
    // 命中：whitelist 含 happy/f02/f06 对应路径
    const h = makeHarness()
    stubHandle(h.adapter, {
      expressions: ['expressions/happy.exp3.json', 'expressions/f02_sad.exp3.json', 'expressions/f06_surprised.exp3.json']
    })
    await h.ctrl.init(fakeCanvas)
    const handle = h.getHandle()

    h.ctrl.setState('happy')
    expect(handle.startExpression).toHaveBeenCalledWith('a', 'expressions/happy.exp3.json')

    h.ctrl.setState('sad')
    expect(handle.startExpression).toHaveBeenCalledWith('a', 'expressions/f02_sad.exp3.json')

    h.ctrl.setState('surprised')
    expect(handle.startExpression).toHaveBeenCalledWith('a', 'expressions/f06_surprised.exp3.json')
  })

  it('情绪→表情（I-1）：白名单无命中 → 不调 setExpression（落 B4 参数级，不空转）', async () => {
    const h = makeHarness()
    stubHandle(h.adapter, { expressions: ['expressions/f07_angry.exp3.json'] }) // 无 happy/sad/surprised/f01/f02/f06
    await h.ctrl.init(fakeCanvas)
    const handle = h.getHandle()

    h.ctrl.setState('happy')
    expect(handle.startExpression).not.toHaveBeenCalled()
  })
})
