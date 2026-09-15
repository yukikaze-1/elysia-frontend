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
import type { CharacterState } from '../../src/renderer/src/live2d/state-machine'
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
  // C2（批次 C）：既有单测按满帧驱动（quality 恒 draw）——FrameBudget 门在低功耗/自适应模式下的 skip 语义
  // 由 perf.spec.ts 纯逻辑 + 本 spec 专门的 low_power 用例覆盖；此处避免真实时间下连续 tick 被 16.67ms
  // 间隔误 skip 而破坏既有逐帧断言。
  ctrl.setPerformanceMode('quality')
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
  adapter.createModel.mockImplementation(() => {
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

  // L7（2026-09-15 Live2D 评审）：白名单只保证「文件在清单里」，不保证「此刻读得到」——文件被删/损坏时
  // `startExpression`/`startMotion` 会 reject，而此前是 fire-and-forget ⇒ unhandledrejection，只打一行 console。
  // 判别力：去掉 controller 里的 `.catch(...)` ⇒ 本条的 errors 断言红（并会留下未处理拒绝）。
  it('L7：白名单内文件读取失败 → emit error（不再是未处理的承诺拒绝）', async () => {
    const h = makeHarness()
    stubHandle(h.adapter, { expressions: ['expressions/happy.exp3.json'] })
    await h.ctrl.init(fakeCanvas)
    const errors: unknown[] = []
    h.ctrl.on('error', (e) => errors.push(e))
    h.getHandle().startExpression = vi.fn(async () => { throw new Error('HTTP 404') })

    expect(h.ctrl.setExpression('expressions/happy.exp3.json')).toBe(true)   // 仍返回 true（白名单命中、已分派）
    await vi.waitFor(() => { expect(errors).toHaveLength(1) })
    expect((errors[0] as Error).message).toBe('HTTP 404')
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

  it('B4 路由：无动作模型写参数级(ParamAngleX)；有动作+有表情模型不写参数级(走 B3/I-1)', async () => {
    const h1 = makeHarness()
    stubHandle(h1.adapter, { params: [...FULL_PARAMS], motions: [], expressions: [] })
    await h1.ctrl.init(fakeCanvas)
    h1.ctrl.setState('thinking')
    h1.ctrl.tick()
    expect(writtenIds(h1.getHandle())).toContain('ParamAngleX')

    const h2 = makeHarness()
    stubHandle(h2.adapter, { params: [...FULL_PARAMS], motions: ['motions/idle.motion3.json'], expressions: ['expressions/happy.exp3.json'] })
    await h2.ctrl.init(fakeCanvas)
    h2.ctrl.setState('thinking')
    h2.ctrl.tick()
    expect(writtenIds(h2.getHandle())).not.toContain('ParamAngleX') // 有动作+有表情 → 走 B3/I-1，不写参数级
  })

  it('F3：有动作但 expressions 空 → 情绪态走 B4 参数级近似（happy → 笑眼，不空转表情）', async () => {
    const h = makeHarness()
    stubHandle(h.adapter, { params: ['ParamEyeRSmile', 'ParamEyeLSmile'], motions: ['motions/idle.motion3.json'], expressions: [] })
    await h.ctrl.init(fakeCanvas)
    const handle = h.getHandle()
    h.ctrl.setState('happy')
    h.ctrl.tick()
    // expressionWhitelist.size===0（有动作但无表情）→ F3 门放行 B4：happy 写笑眼参数
    expect(writtenIds(handle)).toContain('ParamEyeRSmile')
    expect(writtenIds(handle)).toContain('ParamEyeLSmile')
  })

  it('F2：thinking/speaking 眨眼加快（rate=2，闭眼更频繁）——idle（rate=1）保持既有节奏', async () => {
    // I-1 修复（批次 C 审查 round1）：注入确定性 animSeed——controller.animSeed = (Math.random()*0xffffffff)>>>0，
    // 未 mock 时每次跑随机，4s 窗口存在 seed 区间使 idle=1 且 think=1（flaky ~13-23%）。固定 Math.random=0.8 →
    // animSeed=0xCCCCCCCC → animClock.random()≡0.8 → blinkTarget seed 固定（与 param-anim 层 fixedClock(0.5) 同款：
    // 同 seed 同序列）。该 seed 下 mulberry32 首值使 rate=1 首睁眼间隔 >4s（idle 0 次眨眼）而 rate=2 首间隔 <4s
    // （think 1 次）→ think>idle 确定性成立，任意次复跑同结果。
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.8)
    try {
      const h = makeHarness()
      stubHandle(h.adapter, { params: ['ParamEyeROpen'], motions: [], expressions: [] })
      await h.ctrl.init(fakeCanvas)
      const handle = h.getHandle()
      // 控制 performance.now 推进动画时间（每 tick +100ms，确定性窗口 ~4s）——断言 blink 闭眼事件频率
      let now = 1000
      const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now)
      const countClosures = (state: CharacterState): number => {
        handle.setParam.mockClear()
        now = 1000 // 与首次 run 同一起点（animT0 已在首 tick 置 1.1，重放同相位）
        h.ctrl.setState(state)
        let closures = 0
        let prev = 1
        for (let i = 0; i < 40; i++) {
          now += 100
          h.ctrl.tick()
          const calls = handle.setParam.mock.calls.filter((c: unknown[]) => c[0] === 'ParamEyeROpen')
          const v = calls.length > 0 ? (calls[calls.length - 1][1] as number) : prev
          if (v < 1 && prev === 1) closures++ // 睁眼 → 闭眼计一次 blink
          prev = v
        }
        return closures
      }
      const idleClosures = countClosures('idle')
      const thinkClosures = countClosures('thinking')
      // 固定 seed：idle=0（rate=1 首睁眼间隔 >4s 窗口）且 think≥1（rate=2 首间隔 <4s）→ think>idle 确定性成立
      expect(idleClosures).toBe(0)
      expect(thinkClosures).toBeGreaterThan(0)
      expect(thinkClosures).toBeGreaterThan(idleClosures)
      nowSpy.mockRestore()
    } finally {
      randomSpy.mockRestore()
    }
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

  it('setExpression/playMotion 返回白名单命中 boolean；playMotion durationMs 以 15s 封顶', async () => {
    const h = makeHarness()
    stubHandle(h.adapter, { params: [], motions: ['motions/idle.motion3.json'], expressions: ['expressions/F01.exp3.json'] })
    await h.ctrl.init(fakeCanvas) // whitelist 仅在 switchModel 后 cacheModelFacts 填充
    expect(h.ctrl.playMotion('motions/not-in-whitelist.motion3.json', 1)).toBe(false)
    const spy = vi.spyOn(globalThis, 'setTimeout')
    expect(h.ctrl.playMotion('motions/idle.motion3.json', 1, 30000)).toBe(true)
    expect(spy.mock.calls.some((c) => c[1] === 15000)).toBe(true) // min(30000, 15000) 封顶
    spy.mockClear()
    expect(h.ctrl.playMotion('motions/idle.motion3.json', 1, 5000)).toBe(true)
    expect(spy.mock.calls.some((c) => c[1] === 5000)).toBe(true) // durationMs 透传（<15s 不改写）
    expect(h.ctrl.setExpression('expressions/not-in-whitelist.exp3.json')).toBe(false)
    expect(h.ctrl.setExpression('expressions/F01.exp3.json')).toBe(true)
  })
})

describe('Live2DController 批次 C（C1）：通用口部写出（D5C-02，替换旧 M5 门块）', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('口部写出对所有 ready 模型生效（有动作 fake 也写）；lipSync 关 → 电口写 0', async () => {
    const h = makeHarness()
    stubHandle(h.adapter, { params: ['ParamMouthOpenY'], motions: ['motions/idle.motion3.json'], expressions: [] })
    await h.ctrl.init(fakeCanvas) // whitelist/cacheModelFacts 在 switchModel 后填充；fakeCanvas 用现有 spec 夹具
    const handle = h.getHandle()
    h.ctrl.setState('speaking'); h.ctrl.setMouthLevel(0.8)
    h.ctrl.tick()
    const mouthWrites = handle.setParam.mock.calls.filter((c) => c[0] === 'ParamMouthOpenY')
    expect(mouthWrites.length).toBeGreaterThan(0) // 有动作模型电口也被写
    h.ctrl.setLipSync(false); h.ctrl.tick()
    const last = handle.setParam.mock.calls.filter((c) => c[0] === 'ParamMouthOpenY').at(-1)
    expect(last?.[1]).toBe(0) // lipSync 关 → 电口写 0 清态
  })

  it('B3 动作后写覆盖电口：tick 后口部最终值 = 动作值（adapter.update 覆写）', async () => {
    const h = makeHarness()
    stubHandle(h.adapter, { params: ['ParamMouthOpenY'], motions: ['motions/idle.motion3.json'], expressions: [] })
    await h.ctrl.init(fakeCanvas)
    const handle = h.getHandle()
    // 模拟 motion manager 后写：adapter.update 时把 ParamMouthOpenY 覆写为动作值 0.5
    // （MockFn 类型不可直接调用，cast 为参数写签名）
    const setParam = handle.setParam as unknown as (id: string, value: number) => void
    h.adapter.update.mockImplementation(() => { setParam('ParamMouthOpenY', 0.5) })
    h.ctrl.setState('speaking'); h.ctrl.setMouthLevel(0.8)
    h.ctrl.tick()
    const last = handle.setParam.mock.calls.filter((c) => c[0] === 'ParamMouthOpenY').at(-1)
    expect(last?.[1]).toBe(0.5) // 动作值赢（updateAnimation 口部写 → adapter.update 覆写顺序钉死）
  })
})

describe('Live2DController 批次 C（C2）：reset(modelId?) 重建 + FrameBudget 降帧门 + setVisibility', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('reset(modelId)：modelId 有值且 available → 重载之', async () => {
    const h = makeHarness()
    await h.ctrl.init(fakeCanvas) // 'a'
    await h.ctrl.switchModel('b')
    await h.ctrl.reset('b') // b 仍 available → 重载 b
    expect(h.ctrl.status).toBe('ready')
    expect(h.ctrl.modelId).toBe('b')
    expect(h.adapter.initialize).toHaveBeenCalledTimes(2) // init 一次 + reset 重建一次（GL 重创建）
  })

  it('reset(modelId)：modelId 不可用 → 回退首个可用', async () => {
    const h = makeHarness()
    await h.ctrl.init(fakeCanvas) // 'a'
    await h.ctrl.switchModel('b')
    await h.ctrl.reset('missing-model') // 目标不在 list/不可用 → 首个可用 a
    expect(h.ctrl.status).toBe('ready')
    expect(h.ctrl.modelId).toBe('a')
  })

  it('reset()：无参缺省回退首个可用（既有语义保留）', async () => {
    const h = makeHarness()
    await h.ctrl.init(fakeCanvas)
    await h.ctrl.switchModel('b')
    await h.ctrl.reset() // 缺省 → 首个可用 a
    expect(h.ctrl.status).toBe('ready')
    expect(h.ctrl.modelId).toBe('a')
  })

  it('reset(modelId)：initialize 返回 false → fallback（不 createModel）', async () => {
    const h = makeHarness()
    await h.ctrl.init(fakeCanvas)
    h.adapter.initialize.mockReturnValueOnce(false)
    await h.ctrl.reset('a')
    expect(h.ctrl.status).toBe('fallback')
    expect(h.adapter.createModel).toHaveBeenCalledTimes(1) // 仅 init 一次（reset 未走到 createModel）
  })

  it('reset(modelId)：list 无可用 → fallback（不悬置 loading）', async () => {
    const handles: FakeHandle[] = []
    const adapter = {
      handles,
      initialize: vi.fn(() => true),
      createModel: vi.fn(async () => { const h = makeHandle({}); handles.push(h); return h }),
      update: vi.fn(),
      destroy: vi.fn()
    }
    const broken: Live2DModelSummary = { ...MODEL_A, available: false, reason: 'missing_file' }
    const ctrl = new Live2DController({ adapter: adapter as unknown as Live2DAdapter, list: async () => [broken] })
    await ctrl.init(fakeCanvas) // fallback（无可用）
    await ctrl.reset('a')
    expect(ctrl.status).toBe('fallback')
    expect(adapter.createModel).not.toHaveBeenCalled()
  })

  it('reset 重建成功后帧循环恢复：budget first 复位（setPerformanceMode 重放触发 setMode → 首帧必画）', async () => {
    const h = makeHarness()
    await h.ctrl.init(fakeCanvas)
    await h.ctrl.reset('a') // 重建
    expect(h.ctrl.status).toBe('ready')
    h.adapter.update.mockClear()
    h.ctrl.tick() // 重建后第一帧必须画（重放 setPerformanceMode 时 setMode 已重置 first）
    expect(h.adapter.update).toHaveBeenCalledTimes(1)
  })

  it('tick 经 FrameBudget 门：low_power 距上次 draw <33ms 的帧被 skip（不 updateAnimation、不 adapter.update）', async () => {
    const h = makeHarness()
    stubHandle(h.adapter, { params: [...FULL_PARAMS], motions: [] })
    await h.ctrl.init(fakeCanvas)
    const handle = h.getHandle()
    h.ctrl.setPerformanceMode('low_power') // setMode 重置 first → 下一帧必画
    handle.setParam.mockClear()
    h.adapter.update.mockClear()
    h.ctrl.tick() // 首帧（必画）：updateAnimation + adapter.update + feedCost
    expect(h.adapter.update).toHaveBeenCalledTimes(1)
    expect(handle.setParam.mock.calls.length).toBeGreaterThan(0)
    h.adapter.update.mockClear()
    handle.setParam.mockClear()
    h.ctrl.tick() // 紧接首帧 <33ms → skip（不写参数、不 update）
    expect(h.adapter.update).not.toHaveBeenCalled()
    expect(handle.setParam).not.toHaveBeenCalled()
  })

  it('setVisibility(false) 停渲染；true 恢复（controller 级门，独立于 FrameBudget）', async () => {
    const h = makeHarness()
    await h.ctrl.init(fakeCanvas)
    h.ctrl.setVisibility(false)
    h.ctrl.tick()
    expect(h.adapter.update).not.toHaveBeenCalled() // 隐藏不产生帧
    h.ctrl.setVisibility(true)
    h.ctrl.tick()
    expect(h.adapter.update).toHaveBeenCalledTimes(1) // 可见恢复
  })
})
