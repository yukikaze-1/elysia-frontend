// tests/unit/live2d-adapter2.spec.ts
// 阶段 5 批次 B（Task 2，B3 adapter 面）：Live2DModelHandle 增参数通道（getParameterIdList/setParam）
// + motion/expression 加载播放（startMotion/startExpression/stopMotion/stopAll）+ 帧推进（update 内推进
// motion/expression manager）+ Layout 装配（有/无 → MVP 拟合路径）。
//
// 复用批次 A live2d-adapter.spec.ts 的 fake engine + fake fetch 记录 + fake GL 纪律；fixture 扩展（M-4）：
// FakeModel 补 mock getParameterCount/getParameterId(i).getString()/getParameterIndex/setParameterValueById，
// CubismModelSettingJson 补 getLayoutMap（从 model3 JSON 的 Layout 节点读出）+ motion/expression 枚举，
// 并 vi.mock `CubismMotionManager`/`CubismExpressionMotionManager`（它们吃真实 CubismModel）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---- vi.mock 区（工厂须在 import 前，经 vi.hoisted 共享可变状态） ----
type MockFn = ReturnType<typeof vi.fn>

interface FakeModel {
  update: MockFn
  getCanvasWidth: MockFn
  getCanvasHeight: MockFn
  saveParameters: MockFn
  loadParameters: MockFn
  release: MockFn
  getParameterCount: MockFn
  getParameterId: MockFn
  getParameterIndex: MockFn
  setParameterValueById: MockFn
}

interface FakePhysics {
  evaluate: MockFn
}

interface FakeMoc {
  createModel: () => FakeModel
  deleteModel: MockFn
  release: MockFn
}

interface FakeRenderer {
  initialize: MockFn
  startUp: MockFn
  bindTexture: MockFn
  setIsPremultipliedAlpha: MockFn
  setRenderState: MockFn
  drawModel: MockFn
  loadShaders: MockFn
  release: MockFn
  getMvpMatrix: MockFn
}

const shared = vi.hoisted(() => ({
  calls: [] as string[],
  mocCreates: [] as FakeMoc[],
  modelInstances: [] as FakeModel[],
  physicsInstances: [] as FakePhysics[],
  rendererInstances: [] as FakeRenderer[],
  motionManagers: [] as Record<string, MockFn>[],
  exprManagers: [] as Record<string, MockFn>[]
}))

vi.mock('@framework/live2dcubismframework', () => ({
  CubismFramework: {
    startUp: vi.fn(() => {
      shared.calls.push('startUp')
      return true
    }),
    initialize: vi.fn(() => {
      shared.calls.push('initialize')
    }),
    dispose: vi.fn(),
    cleanUp: vi.fn(),
    isStarted: vi.fn(() => true),
    isInitialized: vi.fn(() => true),
    getIdManager: vi.fn(() => ({ getId: (s: string) => s })),
    getInstance: undefined
  },
  Option: class {
    logFunction: unknown = undefined
    loggingLevel: unknown = undefined
  },
  LogLevel: { LogLevel_Off: 5, LogLevel_Verbose: 0, LogLevel_Debug: 1, LogLevel_Info: 2, LogLevel_Warning: 3, LogLevel_Error: 4 }
}))

/** FakeModelSetting：与批次 A 同构（JSON.parse 读 fixture），并补 motion/expression 枚举 + getLayoutMap。
 * 枚举从 model3 JSON 的 FileReferences.Motions（对象：group → [{File}]）与 Expressions（[{File}]）读出；
 * getLayoutMap 从 `Layout` 节点读出（官方大写/驼峰键），非空 → true。 */
vi.mock('@framework/cubismmodelsettingjson', () => {
  class CubismModelSettingJson {
    private data: Record<string, unknown> | null
    constructor(buffer: ArrayBuffer, _size: number) {
      this.data = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer))) as Record<string, unknown>
    }
    private refs(): Record<string, unknown> {
      const fr = this.data && this.data.FileReferences
      return (fr && typeof fr === 'object' ? fr : {}) as Record<string, unknown>
    }
    private str(v: unknown): string {
      return typeof v === 'string' ? v : ''
    }
    getModelFileName(): string {
      return this.str(this.refs().Moc)
    }
    getTextureCount(): number {
      return Array.isArray(this.refs().Textures) ? (this.refs().Textures as unknown[]).length : 0
    }
    getTextureFileName(index: number): string {
      const t = this.refs().Textures
      if (!Array.isArray(t)) return ''
      const name = (t as unknown[])[index]
      return typeof name === 'string' ? name : ''
    }
    getPhysicsFileName(): string {
      return this.str(this.refs().Physics)
    }
    getExpressionCount(): number {
      return Array.isArray(this.refs().Expressions) ? (this.refs().Expressions as unknown[]).length : 0
    }
    getExpressionFileName(index: number): string {
      const e = this.refs().Expressions
      if (!Array.isArray(e)) return ''
      const item = (e as unknown[])[index] as Record<string, unknown>
      return this.str(item && item.File)
    }
    getMotionGroupCount(): number {
      const m = this.refs().Motions
      return m && typeof m === 'object' ? Object.keys(m).length : 0
    }
    getMotionGroupName(index: number): string {
      const m = this.refs().Motions
      if (!m || typeof m !== 'object') return ''
      return Object.keys(m)[index]
    }
    getMotionCount(groupName: string): number {
      const m = this.refs().Motions
      const g = m && typeof m === 'object' ? (m as Record<string, unknown>)[groupName] : undefined
      return Array.isArray(g) ? g.length : 0
    }
    getMotionFileName(groupName: string, index: number): string {
      const m = this.refs().Motions
      const g = m && typeof m === 'object' ? (m as Record<string, unknown>)[groupName] : undefined
      const item = Array.isArray(g) ? (g as unknown[])[index] : undefined
      return this.str((item as Record<string, unknown>) && (item as Record<string, unknown>).File)
    }
    getLayoutMap(out: Map<string, number>): boolean {
      const layout = this.data && (this.data.Layout as Record<string, unknown>)
      if (!layout || typeof layout !== 'object') return false
      let ret = false
      for (const k of Object.keys(layout)) {
        const v = Number((layout)[k])
        if (Number.isFinite(v)) {
          out.set(k, v)
          ret = true
        }
      }
      return ret
    }
    release(): void {}
  }
  return { CubismModelSettingJson }
})

vi.mock('@framework/model/cubismmoc', () => {
  function makeModel(): FakeModel {
    // 默认参数集：index0=ParamAngleZ、index1=ParamEyeLOpen；getParameterIndex 未知名 → count+5（not-exist 域）
    const paramIds = ['ParamAngleZ', 'ParamEyeLOpen']
    const model: FakeModel = {
      update: vi.fn(),
      getCanvasWidth: vi.fn(() => 2),
      getCanvasHeight: vi.fn(() => 3),
      saveParameters: vi.fn(),
      loadParameters: vi.fn(),
      release: vi.fn(),
      getParameterCount: vi.fn(() => paramIds.length),
      getParameterId: vi.fn((i: number) => ({ getString: () => paramIds[i] })),
      getParameterIndex: vi.fn((id: string) => {
        const i = paramIds.indexOf(id)
        return i >= 0 ? i : paramIds.length + 5 // not-exist 合成索引域 [count, …)，永不为 -1
      }),
      setParameterValueById: vi.fn()
    }
    shared.modelInstances.push(model)
    return model
  }
  return {
    CubismMoc: {
      create: vi.fn(() => {
        const moc: FakeMoc = {
          createModel: makeModel,
          deleteModel: vi.fn((_m: unknown) => {}),
          release: vi.fn()
        }
        shared.mocCreates.push(moc)
        return moc
      }),
      delete: vi.fn()
    }
  }
})

vi.mock('@framework/physics/cubismphysics', () => ({
  CubismPhysics: {
    create: vi.fn(() => {
      const phys: FakePhysics = { evaluate: vi.fn() }
      shared.physicsInstances.push(phys)
      return phys
    }),
    delete: vi.fn()
  }
}))

vi.mock('@framework/rendering/cubismrenderer_webgl', () => ({
  CubismRenderer_WebGL: vi.fn(function (this: FakeRenderer, _w: number, _h: number) {
    this.initialize = vi.fn()
    this.startUp = vi.fn()
    this.bindTexture = vi.fn()
    this.setIsPremultipliedAlpha = vi.fn()
    this.setRenderState = vi.fn()
    this.drawModel = vi.fn()
    this.loadShaders = vi.fn()
    this.release = vi.fn()
    this.getMvpMatrix = vi.fn(() => ({ setMatrix: vi.fn(), getArray: vi.fn(() => new Float32Array(16)) }))
    shared.rendererInstances.push(this)
  })
}))

// motion/expression 播放原语 mock（它们吃真实 CubismModel，单测用 fake 记录调用）
vi.mock('@framework/motion/cubismmotionmanager', () => {
  class CubismMotionManager {
    updateMotion: MockFn
    startMotionPriority: MockFn
    stopAllMotions: MockFn
    constructor() {
      this.updateMotion = vi.fn(() => false)
      this.startMotionPriority = vi.fn()
      this.stopAllMotions = vi.fn()
      shared.motionManagers.push(this as unknown as Record<string, MockFn>)
    }
  }
  return { CubismMotionManager }
})

vi.mock('@framework/motion/cubismexpressionmotionmanager', () => {
  class CubismExpressionMotionManager {
    updateMotion: MockFn
    startMotion: MockFn
    stopAllMotions: MockFn
    constructor() {
      this.updateMotion = vi.fn(() => false)
      this.startMotion = vi.fn()
      this.stopAllMotions = vi.fn()
      shared.exprManagers.push(this as unknown as Record<string, MockFn>)
    }
  }
  return { CubismExpressionMotionManager }
})

vi.mock('@framework/motion/cubismmotion', () => ({
  CubismMotion: { create: vi.fn((_b: ArrayBuffer, _s: number) => ({ kind: 'motion' })) }
}))

vi.mock('@framework/motion/cubismexpressionmotion', () => ({
  CubismExpressionMotion: { create: vi.fn((_b: ArrayBuffer, _s: number) => ({ kind: 'expr' })) }
}))

// Layout 装配的 CubismModelMatrix mock：记录构造与 setupFromLayout 入参；getArray 返回按 h 缩放的有限矩阵
vi.mock('@framework/math/cubismmodelmatrix', () => {
  const instances: Array<{ w: number; h: number; layoutMap: Map<string, number> | null }> = []
  class CubismModelMatrix {
    w: number
    h: number
    layoutMap: Map<string, number> | null = null
    constructor(w?: number, h?: number) {
      this.w = w ?? 0
      this.h = h ?? 0
      instances.push(this)
    }
    setupFromLayout(map: Map<string, number>): void {
      this.layoutMap = new Map(map)
    }
    getArray(): Float32Array {
      const s = this.w > 0 && this.h > 0 ? 2 / this.h : 1
      const m = new Float32Array(16)
      m[0] = s
      m[5] = s
      m[10] = 1
      m[15] = 1
      return m
    }
  }
  return { CubismModelMatrix, __instances: instances }
})

// ---- fixtures 与测试工具 ----
import { FakeLive2DEngine } from '../../src/renderer/src/live2d/gl/fake'
import { Live2DAdapter } from '../../src/renderer/src/live2d/adapter'
import type { Live2DModelHandle } from '../../src/renderer/src/live2d/adapter'

/** 有动作 + 表情 + Layout 的 fixture（官方大写/驼峰 Layout 键） */
const MODEL3_FULL = JSON.stringify({
  Version: 3,
  FileReferences: {
    Moc: 'model.moc3',
    Textures: ['textures/texture_00.png'],
    Physics: 'physics/physics.json',
    Motions: {
      Idle: [{ File: 'motions/idle.motion3.json' }, { File: 'motions/brave.motion3.json' }],
      TapBody: [{ File: 'motions/tap.motion3.json' }]
    },
    Expressions: [{ Name: 'Happy', File: 'expressions/happy.exp3.json' }]
  },
  Layout: { Width: 2, Height: 3, CenterX: 0, CenterY: 0 }
})

/** 无动作/无表情/无 Layout fixture */
const MODEL3_NOLAYOUT = JSON.stringify({
  Version: 3,
  FileReferences: {
    Moc: 'model.moc3',
    Textures: ['textures/texture_00.png'],
    Physics: 'physics/physics.json'
  }
})

function jsonBody(json: string): { ok: true; arrayBuffer: () => Promise<ArrayBuffer> } {
  const buf = new TextEncoder().encode(json).buffer
  return { ok: true, arrayBuffer: async () => buf }
}

/** 可注入记录器：按 URL 后缀返回 model3/moc3/纹理/物理/motion3/exp3 字节；记录每次 URL */
function makeFakeFetch(recorded: string[], model3Json: string): typeof fetch {
  return vi.fn(async (url: string) => {
    recorded.push(url)
    if (url.endsWith('model3.json')) return jsonBody(model3Json)
    if (url.endsWith('.png')) return { ok: true, blob: async () => new Blob(['png-bytes']) }
    if (url.endsWith('.moc3')) return { ok: true, arrayBuffer: async () => new Uint8Array([0, 1, 2, 3]).buffer }
    if (url.endsWith('.motion3.json') || url.endsWith('.exp3.json')) {
      return { ok: true, arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer }
    }
    if (url.endsWith('.json')) return jsonBody('{}')
    throw new Error(`unexpected URL: ${url}`)
  }) as unknown as typeof fetch
}

function makeFakeGl(): WebGLRenderingContext {
  const gl: Record<string, unknown> = {
    TEXTURE_2D: 0x0de1,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    LINEAR: 0x2601,
    LINEAR_MIPMAP_LINEAR: 0x2703,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
    createTexture: vi.fn(() => ({})),
    deleteTexture: vi.fn(),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    pixelStorei: vi.fn(),
    texImage2D: vi.fn(),
    generateMipmap: vi.fn()
  }
  return gl as unknown as WebGLRenderingContext
}

function makeFakeCanvas(): HTMLCanvasElement {
  return { width: 340, height: 680, addEventListener: vi.fn(), removeEventListener: vi.fn(), getContext: vi.fn() } as unknown as HTMLCanvasElement
}

function makeHarness(model3Json = MODEL3_FULL) {
  const recorded: string[] = []
  const gl = makeFakeGl()
  const canvas = makeFakeCanvas()
  const fetchMock = makeFakeFetch(recorded, model3Json)
  const engine = new FakeLive2DEngine({ contextResult: gl, maxTextureSize: 2048 })
  const adapter = new Live2DAdapter({ engine, fetchImpl: fetchMock })
  return { recorded, gl, canvas, fetchMock, engine, adapter }
}

function resetShared(): void {
  shared.calls.length = 0
  shared.mocCreates.length = 0
  shared.modelInstances.length = 0
  shared.physicsInstances.length = 0
  shared.rendererInstances.length = 0
  shared.motionManagers.length = 0
  shared.exprManagers.length = 0
}

let matrixInstances: Array<{ w: number; h: number; layoutMap: Map<string, number> | null }>
beforeEach(async () => {
  vi.clearAllMocks()
  resetShared()
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 256, height: 256, close: vi.fn() })))
  const mm = await import('@framework/math/cubismmodelmatrix')
  matrixInstances = (mm as unknown as { __instances: Array<{ w: number; h: number; layoutMap: Map<string, number> | null }> }).__instances
  matrixInstances.length = 0 // 模块级 mock 数组跨用例累积，先清空
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function readyHandle(model3Json = MODEL3_FULL): Promise<{
  adapter: Live2DAdapter
  handle: Live2DModelHandle
  recorded: string[]
}> {
  const { recorded, canvas, adapter } = makeHarness(model3Json)
  adapter.initialize(canvas)
  const handle = await adapter.createModel({ modelId: 'haru', model3Path: 'model3.json' })
  return { adapter, handle, recorded }
}

function modelUnderTest(): FakeModel {
  return shared.modelInstances[shared.modelInstances.length - 1]
}

function firstMvpSetMatrix(): Float32Array {
  const renderer = shared.rendererInstances[0]
  const mvpResult = renderer.getMvpMatrix.mock.results[0]?.value as {
    setMatrix: { mock: { calls: Array<[Float32Array]> } }
  }
  return mvpResult.setMatrix.mock.calls[0]?.[0]
}

describe('handle 新方法暴露 + 参数通道（getParameterIdList/setParam）', () => {
  it('handle 暴露批次 B 全部新方法', async () => {
    const { handle } = await readyHandle()
    expect(typeof handle.getParameterIdList).toBe('function')
    expect(typeof handle.setParam).toBe('function')
    expect(typeof handle.startMotion).toBe('function')
    expect(typeof handle.startExpression).toBe('function')
    expect(typeof handle.stopMotion).toBe('function')
    expect(typeof handle.stopAll).toBe('function')
    // 既有 update/draw/destroy 契约保留
    expect(typeof (handle as unknown as { update: unknown }).update).toBe('function')
    expect(typeof (handle as unknown as { draw: unknown }).draw).toBe('function')
    expect(typeof (handle as unknown as { destroy: unknown }).destroy).toBe('function')
  })

  it('getParameterIdList 返回模型参数 Id 列表', async () => {
    const { handle } = await readyHandle()
    expect(handle.getParameterIdList()).toEqual(['ParamAngleZ', 'ParamEyeLOpen'])
    expect(modelUnderTest().getParameterCount).toHaveBeenCalled()
    expect(modelUnderTest().getParameterId).toHaveBeenCalledWith(0)
    expect(modelUnderTest().getParameterId).toHaveBeenCalledWith(1)
  })

  it('setParam：已知 Id 正确写入；未知 Id 静默忽略（setParameterValueById 不被调用）', async () => {
    const { handle } = await readyHandle()
    const model = modelUnderTest()

    // 已知 Id → 写入
    handle.setParam('ParamAngleZ', 0.5)
    expect(model.setParameterValueById).toHaveBeenCalledWith('ParamAngleZ', 0.5)

    // 未知 Id（getParameterIndex 返回合成 not-exist 索引 ≥ count，非 -1）→ 静默忽略，不写
    handle.setParam('Nope', 1)
    handle.setParam('AlsoUnknown', 2)
    expect(model.setParameterValueById).toHaveBeenCalledTimes(1) // 仅已知 Id 一次
  })
})

describe('startMotion/startExpression/stopAll（白名单深度防御 + cyrene:// 加载）', () => {
  it('startMotion 从白名单加载 motion：cyrene:// 正确路径 + CubismMotion.create + startMotionPriority', async () => {
    const { recorded, handle } = await readyHandle()
    await handle.startMotion('haru', 'motions/idle.motion3.json', 2)

    expect(recorded).toContain(
      'cyrene://renderer/__cyrene-live2d/haru/motions/idle.motion3.json'
    )
    const mm = shared.motionManagers[0]
    expect(mm).toBeTruthy()
    expect((mm as { startMotionPriority: MockFn }).startMotionPriority).toHaveBeenCalledTimes(1)
    // 参数：(motion, autoDelete=true, priority=2)
    expect((mm as { startMotionPriority: MockFn }).startMotionPriority.mock.calls[0]?.[1]).toBe(true)
    expect((mm as { startMotionPriority: MockFn }).startMotionPriority.mock.calls[0]?.[2]).toBe(2)
  })

  it('startMotion：白名单外文件抛错（深度防御）', async () => {
    const { handle } = await readyHandle()
    await expect(handle.startMotion('haru', 'motions/not_in_whitelist.motion3.json', 1)).rejects.toThrow(
      'not in whitelist'
    )
    expect(shared.motionManagers[0]?.startMotionPriority).not.toHaveBeenCalled()
  })

  it('startExpression 从白名单加载：cyrene:// 正确路径 + startMotion', async () => {
    const { recorded, handle } = await readyHandle()
    await handle.startExpression('haru', 'expressions/happy.exp3.json')

    expect(recorded).toContain(
      'cyrene://renderer/__cyrene-live2d/haru/expressions/happy.exp3.json'
    )
    const em = shared.exprManagers[0]
    expect(em).toBeTruthy()
    expect((em as { startMotion: MockFn }).startMotion).toHaveBeenCalledTimes(1)
    expect((em as { startMotion: MockFn }).startMotion.mock.calls[0]?.[1]).toBe(true) // autoDelete
  })

  it('startExpression：白名单外抛错', async () => {
    const { handle } = await readyHandle()
    await expect(handle.startExpression('haru', 'expressions/evil.exp3.json')).rejects.toThrow('not in whitelist')
  })

  it('stopAll 停止 motion + expression 队列', async () => {
    const { handle } = await readyHandle()
    const mm = shared.motionManagers[0]
    const em = shared.exprManagers[0]

    handle.stopAll()
    expect((mm as { stopAllMotions: MockFn }).stopAllMotions).toHaveBeenCalledTimes(1)
    expect((em as { stopAllMotions: MockFn }).stopAllMotions).toHaveBeenCalledTimes(1)
  })

  it('stopMotion 真实实现（I-2）：SDK 无按优先级停原语 → stopAllMotions（长动作 ~15s 上限的落点）', async () => {
    const { handle } = await readyHandle()
    const mm = shared.motionManagers[0] as { stopAllMotions: MockFn }
    const em = shared.exprManagers[0] as { stopAllMotions: MockFn }

    handle.stopMotion(2)
    expect(mm.stopAllMotions).toHaveBeenCalledTimes(1) // 停全部 motion（保守）
    expect(em.stopAllMotions).not.toHaveBeenCalled() // expression 队列不受影响
  })
})

describe('update(dt) 帧推进：motion + expression manager == 物理 == model.update', () => {
  it('update(dt) 依次推进 motionManager/expressionManager/physics/model', async () => {
    const { handle } = await readyHandle()
    const model = modelUnderTest()
    const phys = shared.physicsInstances[0]
    const mm = shared.motionManagers[0] as { updateMotion: MockFn }
    const em = shared.exprManagers[0] as { updateMotion: MockFn }

    handle.update(0.016)

    expect(mm.updateMotion).toHaveBeenCalledWith(model, 0.016)
    expect(em.updateMotion).toHaveBeenCalledWith(model, 0.016)
    expect(phys.evaluate).toHaveBeenCalledWith(model, 0.016)
    expect(model.update).toHaveBeenCalledOnce()
  })
})

describe('Layout 装配 + draw() MVP 拟合路径', () => {
  it('有 Layout：CubismModelMatrix 以真实画布维度构造 + setupFromLayout 收到归一化键 + MVP 非退化', async () => {
    const { handle } = await readyHandle(MODEL3_FULL)

    // 构造了一个 CubismModelMatrix（传画布真实维度 2x3）
    expect(matrixInstances).toHaveLength(1)
    expect(matrixInstances[0].w).toBe(2)
    expect(matrixInstances[0].h).toBe(3)
    // Layout 键归一：官方 Width/Height/CenterX/CenterY → setupFromLayout 期望的小写 snake_case
    const layout = matrixInstances[0].layoutMap
    expect(layout).toBeTruthy()
    expect(layout?.get('width')).toBe(2)
    expect(layout?.get('height')).toBe(3)
    expect(layout?.has('center_x')).toBe(true)
    expect(layout?.has('center_y')).toBe(true)

    // draw() 走 layout MVP 拟合路径：矩阵所有元素有限（非退化，无 NaN/Infinity）
    handle.draw()
    const m = firstMvpSetMatrix()
    expect(m).toBeTruthy()
    for (const v of Array.from(m)) {
      expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('无 Layout：不构造 CubismModelMatrix，draw() 沿用 scale-only buildFitMvp', async () => {
    const { handle } = await readyHandle(MODEL3_NOLAYOUT)
    expect(matrixInstances).toHaveLength(0)

    handle.draw()
    const m = firstMvpSetMatrix()
    // 模型画布 2x3、视口 340x680：scale = min(170, 226.67) = 170
    expect(m?.[0]).toBe(1) // sx = 2*170/340
    expect(m?.[5]).toBe(0.5) // sy = 2*170/680
    expect(m?.[12]).toBe(0)
    expect(m?.[13]).toBe(0)
  })

  it('setViewTransform（Task 5 缩放/偏移）：默认 1/0/0 与批次 A 等价；scale 倍增、offset 平移、越界钳制', async () => {
    const { handle } = await readyHandle(MODEL3_NOLAYOUT)
    const mvpMatrix = () => {
      const renderer = shared.rendererInstances[0]
      const results = renderer.getMvpMatrix.mock.results
      const last = results[results.length - 1]?.value as {
        setMatrix: { mock: { calls: Array<[Float32Array]> } }
      }
      return last.setMatrix.mock.calls[last.setMatrix.mock.calls.length - 1]?.[0]
    }

    // 默认视图变换（1/0/0）：与批次 A scale-only 完全一致
    handle.draw()
    const base = mvpMatrix()
    expect(base?.[0]).toBe(1)
    expect(base?.[12]).toBe(0)
    expect(base?.[13]).toBe(0)

    // scale=2、offset(1,-1)
    handle.setViewTransform(2, 1, -1)
    handle.draw()
    const m = mvpMatrix()
    expect(m?.[0]).toBeCloseTo(2) // sx * 2
    expect(m?.[5]).toBeCloseTo(1) // sy * 2 = 0.5*2
    expect(m?.[12]).toBeCloseTo(0.25) // offsetX=1 → +0.25 clip
    expect(m?.[13]).toBeCloseTo(-0.25) // offsetY=-1 → -0.25 clip
    for (const v of Array.from(m)) {
      expect(Number.isFinite(v)).toBe(true) // 非退化（无 NaN/Infinity）
    }

    // 越界钳制：scale 100→3；offset -99/99 → ±2 → ±0.5 clip
    handle.setViewTransform(100, -99, 99)
    handle.draw()
    const m2 = mvpMatrix()
    expect(m2?.[0]).toBeCloseTo(3)
    expect(m2?.[12]).toBeCloseTo(-0.5)
    expect(m2?.[13]).toBeCloseTo(0.5)
  })
})

describe('批次 C（C2）：adapter.initialize 半初始化兜底（Task5 P3，重建路径再走 initialize）', () => {
  it('framework initialize 抛错 → adapter 释放已建 context/监听（destroy 清部分状态），再次 initialize 可重建', async () => {
    // 让 framework 的 initialize 抛错（模拟半初始化：gl 已建、监听已注册、框架启动序列中断）
    const framework = await import('@framework/live2dcubismframework')
    vi.mocked(framework.CubismFramework.initialize).mockImplementationOnce(() => {
      throw new Error('framework init failed')
    })
    const { canvas, engine, adapter } = makeHarness()
    expect(() => adapter.initialize(canvas)).toThrow('framework init failed')
    // 已建 context 与监听已释放（destroy 清 gl/监听）——无部分状态残留
    expect(engine.createContextCalls.length).toBe(1) // 第一次创建已发生
    expect(engine.unregisterCount).toBe(1) // destroy 已注销 contextlost 监听（无泄漏）
    // 再次 initialize 可完整重建（this.gl 已清空，不误判已初始化；幂等守卫不再短路）
    expect(adapter.initialize(canvas)).toBe(true)
    expect(engine.createContextCalls.length).toBe(2) // 第二次创建（新 context）
    expect(engine.unregisterCount).toBe(1) // 新监听已注册（未注销）
  })
})
