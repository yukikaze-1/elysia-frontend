// tests/unit/live2d-adapter.spec.ts
// Task 5（A2，spec §3.2 / brief Step 3）：Live2DAdapter 单测——fake engine（FakeLive2DEngine，可注错）+
// fake fetch 记录 + fake GL 上下文对象；Framework 各模块经 vi.mock 拦截（node 环境无 Live2DCubismCore/WebGL）。
//
// 覆盖：
//  - initialize：engine.createContext → null → false（且不触 framework 启动）；成功 → startUp 先于
//    initialize、无 getInstance().reinitialize。
//  - createModel：fetch 按 cyrene://renderer/__cyrene-live2d/{id}/{path} 逐文件（model3 → moc3 → 纹理 →
//    physics）；modelId ASCII slug 不编码、relPath 各段 encodeURIComponent（中文文件名）；FileReferences
//    以 model3.json 目录为 base 解析；纹理超 maxTextureSize → Live2DTextureError；GPU-lost（事件或轮询）
//    → Live2DGpuLostError；无 Physics 声明 → 不创建物理。
//  - update/draw：handle.update(dt) 驱动 model.update + physics.evaluate；handle.draw 设置视口/MVP 并
//    drawModel('/live2d/shaders/')；loadShaders 在首次 draw 前已调用。
//  - destroy：handle.destroy 幂等（renderer.release/model.release 各一次）；adapter.destroy 调用
//    onContextLost 注销函数（无残留监听）。
// 注（brief Step 3.注）：Framework 内部真实渲染调用不在本单测覆盖（WebGL 集成域归 Task 7/真机）。
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
  calls: [] as string[], // framework 生命周期调用序列
  mocCreates: [] as FakeMoc[], // 创建的 moc 记录（含 deleteModel/release 追踪）
  modelInstances: [] as FakeModel[], // moc.createModel 返回的 fake model
  physicsInstances: [] as FakePhysics[], // CubismPhysics.create 结果
  physicsDeletes: [] as unknown[], // CubismPhysics.delete 入参
  rendererInstances: [] as FakeRenderer[] // new CubismRenderer_WebGL 实例
}))

vi.mock('@framework/live2dcubismframework', () => {
  return {
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
      // 关键断言：r.5 无 getInstance().reinitialize（不应存在）
      getInstance: undefined
    },
    // 对照 real Option（live2dcubismframework.ts:263）：logFunction/loggingLevel 字段
    Option: class {
      logFunction: unknown = undefined
      loggingLevel: unknown = undefined
    },
    LogLevel: { LogLevel_Off: 5, LogLevel_Verbose: 0, LogLevel_Debug: 1, LogLevel_Info: 2, LogLevel_Warning: 3, LogLevel_Error: 4 }
  }
})

vi.mock('@framework/cubismmodelsettingjson', () => {
  // 对照 real CubismModelSettingJson（cubismmodelsettingjson.ts:29）：从 model3.json 字节解析 FileReferences。
  // 本 mock 用 JSON.parse 读取 fixture（Adapter 只消费本项目内核用到的方法面）。
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
    getPoseFileName(): string {
      return this.str(this.refs().Pose)
    }
    getExpressionCount(): number {
      return 0
    }
    getMotionGroupCount(): number {
      return 0
    }
    getUserDataFile(): string {
      return this.str(this.refs().UserData)
    }
    getLayoutMap(_out: Map<string, number>): boolean {
      return false
    }
    release(): void {}
  }
  return { CubismModelSettingJson }
})

vi.mock('@framework/model/cubismmoc', () => {
  function makeModel(): FakeModel {
    const model: FakeModel = {
      update: vi.fn(),
      getCanvasWidth: vi.fn(() => 2),
      getCanvasHeight: vi.fn(() => 3),
      saveParameters: vi.fn(),
      loadParameters: vi.fn(),
      release: vi.fn()
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

vi.mock('@framework/physics/cubismphysics', () => {
  return {
    CubismPhysics: {
      create: vi.fn(() => {
        const phys: FakePhysics = { evaluate: vi.fn() }
        shared.physicsInstances.push(phys)
        return phys
      }),
      delete: vi.fn((p: unknown) => {
        shared.physicsDeletes.push(p)
      })
    }
  }
})

vi.mock('@framework/rendering/cubismrenderer_webgl', () => {
  return {
    CubismRenderer_WebGL: vi.fn(function (this: FakeRenderer, _width: number, _height: number) {
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
  }
})

// ---- fixtures 与测试工具 ----
import { FakeLive2DEngine } from '../../src/renderer/src/live2d/gl/fake'
import { Live2DAdapter, Live2DGpuLostError, Live2DTextureError } from '../../src/renderer/src/live2d/adapter'
import type { Live2DModelHandle } from '../../src/renderer/src/live2d/adapter'

/** Haru 风格 fixture：两层纹理（含中文文件名）+ 物理 */
const MODEL3_HARU = JSON.stringify({
  Version: 3,
  FileReferences: {
    Moc: 'model.moc3',
    Textures: ['textures/texture_00.png', 'textures/修女莉尔.png'],
    Physics: 'physics/physics.json'
  }
})

/** 嵌套 model3Path + 无 Physics fixture（base 目录解析 + 物理缺省分支） */
const MODEL3_NESTED = JSON.stringify({
  Version: 3,
  FileReferences: {
    Moc: 'moc/model.moc3',
    Textures: ['tex/a.png']
  }
})

function jsonBody(json: string): { ok: true; arrayBuffer: () => Promise<ArrayBuffer> } {
  const buf = new TextEncoder().encode(json).buffer
  return { ok: true, arrayBuffer: async () => buf }
}

/** 可注入记录器：按 URL 后缀返回 model3/moc3/纹理/物理字节；记录每次 URL。
 * 返回类型对齐 `typeof fetch`（adapter 的 fetchImpl 槽位），运行时返回伪 Response 对象。 */
function makeFakeFetch(recorded: string[], model3Json: string): typeof fetch {
  return vi.fn(async (url: string) => {
    recorded.push(url)
    if (url.endsWith('model3.json')) return jsonBody(model3Json)
    if (url.endsWith('.png')) return { ok: true, blob: async () => new Blob(['png-bytes']) }
    if (url.endsWith('.moc3')) return { ok: true, arrayBuffer: async () => new Uint8Array([0, 1, 2, 3]).buffer }
    if (url.endsWith('.json')) return jsonBody('{}')
    throw new Error(`unexpected URL: ${url}`)
  }) as unknown as typeof fetch
}

/** fake WebGLRenderingContext 对象：覆盖 Adapter 纹理/初始化用到的 GL 常量与方法调用 */
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

/** fake canvas：宽高供 draw 视口/MVP 计算 + contextlost 事件接口（FakeEngine 不消费事件 API） */
function makeFakeCanvas(): HTMLCanvasElement {
  return { width: 340, height: 680, addEventListener: vi.fn(), removeEventListener: vi.fn(), getContext: vi.fn() } as unknown as HTMLCanvasElement
}

/** 标准夹具：engine + 记录器 + adapter，均在 lambda 内组装避免跨用例共享 */
function makeHarness(model3Json = MODEL3_HARU) {
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
  shared.physicsDeletes.length = 0
  shared.rendererInstances.length = 0
}

beforeEach(() => {
  vi.clearAllMocks()
  resetShared()
  // bitmap 解码桩：256x256（默认上限 2048 内），close 桩
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 256, height: 256, close: vi.fn() })))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Live2DAdapter.initialize（CubismFramework 官方序列）', () => {
  it('engine.createContext → null → 返回 false 且不触发 framework 启动', () => {
    const canvas = makeFakeCanvas()
    const engine = new FakeLive2DEngine({ contextResult: null })
    const adapter = new Live2DAdapter({ engine, fetchImpl: fetch })
    expect(adapter.initialize(canvas)).toBe(false)
    expect(shared.calls).toEqual([]) // 无 startUp/initialize
    expect(engine.createContextCalls).toHaveLength(1)
    expect(engine.createContextCalls[0].attrs).toEqual({ alpha: true, antialias: false, depth: false })
  })

  it('成功 → startUp 先于 initialize；无 getInstance().reinitialize', () => {
    const { gl, canvas, adapter } = makeHarness()
    expect(adapter.initialize(canvas)).toBe(true)
    expect(shared.calls).toEqual(['startUp', 'initialize']) // 官方序列顺序
    expect(shared.calls).not.toContain('reinitialize')
    expect(gl).toBeTruthy()
    // 幂等：重复 initialize 不重复触发（无重复 startUp/initialize）
    expect(adapter.initialize(canvas)).toBe(true)
    expect(shared.calls).toEqual(['startUp', 'initialize'])
  })

  it('initialize 后 contextlost 监听已注册；adapter.destroy 注销监听（无残留）', () => {
    const { canvas, engine, adapter } = makeHarness()
    adapter.initialize(canvas)
    expect(engine.unregisterCount).toBe(0)
    adapter.destroy()
    expect(engine.unregisterCount).toBe(1) // onContextLost 返回的注销函数被调用
  })
})

describe('Live2DAdapter.createModel（cyrene:// 逐文件供给 + 装配）', () => {
  it('按 cyrene://renderer/__cyrene-live2d/{id}/{path} 逐文件 fetch（model3→moc3→纹理→physics）', async () => {
    const { recorded, gl, canvas, adapter } = makeHarness()
    expect(adapter.initialize(canvas)).toBe(true)

    const handle = await adapter.createModel({ modelId: 'haru', model3Path: 'model3.json' })

    // modelId 不编码（ASCII slug）；relPath 各段 encodeURIComponent（中文文件名）
    expect(recorded).toEqual([
      'cyrene://renderer/__cyrene-live2d/haru/model3.json',
      'cyrene://renderer/__cyrene-live2d/haru/model.moc3',
      'cyrene://renderer/__cyrene-live2d/haru/textures/texture_00.png',
      `cyrene://renderer/__cyrene-live2d/haru/textures/${encodeURIComponent('修女莉尔')}.png`,
      'cyrene://renderer/__cyrene-live2d/haru/physics/physics.json'
    ])

    // 装配：moc/model/renderer 建立、startUp 以 gl、纹理绑定、物理创建、shader 于首次 draw 前加载
    expect(shared.mocCreates).toHaveLength(1)
    expect(shared.modelInstances).toHaveLength(1)
    const renderer = shared.rendererInstances[0]
    const model = shared.modelInstances[0]
    expect(renderer).toBeTruthy()
    expect(renderer.initialize).toHaveBeenCalledWith(model, 1)
    expect(renderer.startUp).toHaveBeenCalledWith(gl)
    expect(renderer.setIsPremultipliedAlpha).toHaveBeenCalledWith(true)
    expect(renderer.bindTexture).toHaveBeenCalledTimes(2)
    expect(renderer.loadShaders).toHaveBeenCalledWith('/live2d/shaders/') // 首次 draw 前
    expect(shared.physicsInstances).toHaveLength(1)
    expect(gl.createTexture).toHaveBeenCalledTimes(2)
    expect(handle).toBeTruthy()

    // handle.update(dt)：物理 evaluate + model.update
    const phys = shared.physicsInstances[0]
    handle.update(0.016)
    expect(phys.evaluate).toHaveBeenCalledWith(model, 0.016)
    expect(model.update).toHaveBeenCalledOnce()

    // handle.draw()：视口 = canvas 尺寸、MVP 拟合、drawModel('/live2d/shaders/')
    handle.draw()
    expect(renderer.setRenderState).toHaveBeenCalledWith(null, [0, 0, 340, 680])
    expect(renderer.getMvpMatrix).toHaveBeenCalled()
    expect(renderer.drawModel).toHaveBeenCalledWith('/live2d/shaders/')
  })

  it('FileReferences 以 model3.json 目录为 base 解析；无 Physics 声明 → 不创建物理', async () => {
    const { recorded, canvas, adapter } = makeHarness(MODEL3_NESTED)
    adapter.initialize(canvas)
    await adapter.createModel({ modelId: 'haru', model3Path: 'models/core/model3.json' })

    expect(recorded[0]).toBe('cyrene://renderer/__cyrene-live2d/haru/models/core/model3.json')
    expect(recorded[1]).toBe('cyrene://renderer/__cyrene-live2d/haru/models/core/moc/model.moc3')
    expect(recorded[2]).toBe('cyrene://renderer/__cyrene-live2d/haru/models/core/tex/a.png')
    expect(shared.physicsInstances).toHaveLength(0) // Physics 缺省 → 跳过
    expect(shared.rendererInstances[0].bindTexture).toHaveBeenCalledTimes(1)
  })

  it('纹理超 maxTextureSize → Live2DTextureError；无悬挂 handle（已清理）', async () => {
    const { gl, canvas, engine, adapter } = makeHarness()
    adapter.initialize(canvas)
    engine.setMaxTextureSize(64) // 纹理 256x256 超限
    await expect(adapter.createModel({ modelId: 'haru', model3Path: 'model3.json' })).rejects.toBeInstanceOf(
      Live2DTextureError
    )
    expect(gl.texImage2D).not.toHaveBeenCalled() // 上传前即拦截
    // 中途失败资源已清理：无悬挂 handle，update 不抛
    engine.setMaxTextureSize(2048)
    expect(() => adapter.update()).not.toThrow()
  })

  it('GPU-lost（轮询 isContextLost）→ createModel 抛 Live2DGpuLostError', async () => {
    const { engine, canvas, adapter } = makeHarness()
    adapter.initialize(canvas)
    engine.setContextLost(true)
    await expect(adapter.createModel({ modelId: 'haru', model3Path: 'model3.json' })).rejects.toBeInstanceOf(
      Live2DGpuLostError
    )
  })

  it('未 initialize 就 createModel → 抛错（非 GPU/纹理错误类型）', async () => {
    const { adapter } = makeHarness()
    await expect(adapter.createModel({ modelId: 'haru', model3Path: 'model3.json' })).rejects.toThrow(
      'must be initialized'
    )
  })

  it('C2-2：context lost 后经保存的 WEBGL_lose_context.restoreContext 恢复，再继续创建模型', async () => {
    const recorded: string[] = []
    const engine = new FakeLive2DEngine({ maxTextureSize: 2048 })
    const restoreContext = vi.fn(() => { engine.setContextLost(false) })
    let extAvailable = true
    const gl = makeFakeGl()
    Object.assign(gl, {
      getExtension: vi.fn((_name: string) => (extAvailable ? { restoreContext } : null))
    })
    const canvas = makeFakeCanvas()
    engine.setContextResult(gl)
    const adapter = new Live2DAdapter({ engine, fetchImpl: makeFakeFetch(recorded, MODEL3_HARU) })
    adapter.initialize(canvas)
    // 真机时序：context 丢失后 getExtension('WEBGL_lose_context') 返回 null；
    // adapter.reset 的 destroy → initialize 不覆盖旧扩展引用，重建 createModel 时用旧引用 restore。
    adapter.destroy()
    extAvailable = false
    engine.setContextLost(true)
    adapter.initialize(canvas)
    const handle = await adapter.createModel({ modelId: 'haru', model3Path: 'model3.json' })
    expect(restoreContext).toHaveBeenCalledTimes(1)
    expect(recorded[0]).toBe('cyrene://renderer/__cyrene-live2d/haru/model3.json')
    expect(handle).toBeTruthy()
  })
})

describe('Live2DAdapter.update（渲染 tick + GPU-lost 事件）', () => {
  async function readyAdapter() {
    const h = makeHarness()
    const { canvas, adapter } = h
    adapter.initialize(canvas)
    await adapter.createModel({ modelId: 'haru', model3Path: 'model3.json' })
    return h
  }

  it('无当前模型 → no-op 不抛', () => {
    const { adapter } = makeHarness()
    expect(() => adapter.update()).not.toThrow()
  })

  it('contextlost 事件置位 → update 抛 Live2DGpuLostError', async () => {
    const { engine, adapter } = await readyAdapter()
    engine.setContextLost(false)
    expect(() => adapter.update()).not.toThrow() // 正常 tick
    engine.fireContextLost() // 手动触发 webglcontextlost
    expect(() => adapter.update()).toThrow(Live2DGpuLostError)
  })

  it('isContextLost 轮询为 true → update 抛 Live2DGpuLostError', async () => {
    const { engine, adapter } = await readyAdapter()
    engine.setContextLost(true)
    expect(() => adapter.update()).toThrow(Live2DGpuLostError)
  })

  it('draw 的 MVP 矩阵不变式：原点居中免平移（m12/m13=0）+ 等比正向缩放（P1 审查修复）', async () => {
    const { canvas, adapter } = makeHarness()
    adapter.initialize(canvas)
    const handle = await adapter.createModel({ modelId: 'haru', model3Path: 'model3.json' })
    handle.draw()

    const renderer = shared.rendererInstances[0]
    // handle.draw() 内 renderer.getMvpMatrix().setMatrix(matrix) —— 取 getMvpMatrix 首次调用的返回值里
    // setMatrix 的首个入参（即 buildFitMvp 产出的列主矩阵）
    const mvpResult = renderer.getMvpMatrix.mock.results[0]?.value as {
      setMatrix: { mock: { calls: Array<[Float32Array]> } }
    }
    const m = mvpResult.setMatrix.mock.calls[0]?.[0]

    // 模型画布 mock 固定 2x3，视口 340x680：scale = min(340/2, 680/3) = 170
    expect(m?.[0]).toBe(1) // sx = 2*170/340
    expect(m?.[5]).toBe(0.5) // sy = 2*170/680（等比，仅视口不同缩放）
    expect(m?.[12]).toBe(0) // 原点居中空间无平移（P1：此前 tx=-(sx*W)/2 会把模型推出视口）
    expect(m?.[13]).toBe(0)
    expect(m?.[10]).toBe(1)
    expect(m?.[15]).toBe(1)
  })
})

describe('Live2DAdapter.destroy / handle.destroy（资源释放 + 幂等）', () => {
  async function readyHandle(): Promise<{ adapter: Live2DAdapter; engine: FakeLive2DEngine; handle: Live2DModelHandle }> {
    const { canvas, adapter, engine } = makeHarness()
    adapter.initialize(canvas)
    const handle = await adapter.createModel({ modelId: 'haru', model3Path: 'model3.json' })
    return { adapter, engine, handle }
  }

  it('handle.destroy 幂等：renderer.release/moc.deleteModel/moc.release/setting 各一次', async () => {
    const { handle } = await readyHandle()
    const renderer = shared.rendererInstances[0]
    const moc = shared.mocCreates[0]
    const phys = shared.physicsInstances[0]

    handle.destroy()
    handle.destroy() // 幂等：二次无副作用

    expect(renderer.release).toHaveBeenCalledTimes(1)
    expect(moc.deleteModel).toHaveBeenCalledTimes(1) // 包装的 model.release()（cubismmodel.ts:1856）
    expect(moc.release).toHaveBeenCalledTimes(1)
    expect(shared.physicsDeletes).toEqual([phys]) // CubismPhysics.delete 一次
    expect(shared.modelInstances[0].release).toHaveBeenCalledTimes(0) // 经 deleteModel 内部释放，不重复直调
  })

  it('adapter.destroy：销毁句柄 + 移除 contextlost 监听（无残留）', async () => {
    const { adapter, engine, handle } = await readyHandle()
    const renderer = shared.rendererInstances[0]

    adapter.destroy()

    expect(renderer.release).toHaveBeenCalledTimes(1) // 经 handle.destroy 释放模型
    expect(engine.unregisterCount).toBe(1) // onContextLost 注销函数被调
    expect(() => adapter.update()).not.toThrow() // 无悬挂 handle
    expect(handle).toBeTruthy()
  })
})