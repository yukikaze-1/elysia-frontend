// tests/unit/live2d-serve-gate.spec.ts
// 2026-09-10：Live2D 模型文件「供给闸门」单元测试。
//
// 为什么单独测这一层：dev 形态修法给 Live2D 增加了**第二条供给通道**（IPC），而门禁判定必须两条通道
// 共用同一实现——各写一份就迟早分叉，分叉的那一侧即绕过入口。本 spec 直接钉住该共享实现的行为，
// 使「协议通道」与「IPC 通道」都不能各自漂移。
// env=node（gateLive2dFile 为 electron-free 纯逻辑）。
import { describe, expect, it, vi } from 'vitest'
import { gateLive2dFile, gateHttpFailure, type Live2dResolverRegistry } from '../../src/main/live2d/serve-gate'

const makeRegistry = (opts: {
  verify?: (id: string) => Promise<boolean>
  summaries?: Array<{ id: string; available: boolean }>
  resolve?: (id: string, relPath: string) => Promise<string | null>
} = {}): Live2dResolverRegistry => ({
  verifyIntegrity: vi.fn((id: string) => (opts.verify ? opts.verify(id) : Promise.resolve(true))),
  listInstalledModels: vi.fn(() => Promise.resolve(opts.summaries ?? [{ id: 'haru', available: true }])),
  resolveModelFile: vi.fn((id: string, relPath: string) =>
    opts.resolve ? opts.resolve(id, relPath) : Promise.resolve(`/models/${id}/${relPath}`)
  )
})

describe('gateLive2dFile：判定矩阵', () => {
  it('全通 → ok + 绝对路径', async () => {
    const registry = makeRegistry()
    await expect(gateLive2dFile(registry, 'haru', 'model3.json')).resolves.toEqual({
      kind: 'ok',
      absPath: '/models/haru/model3.json'
    })
  })

  it('verifyIntegrity 失败 → not_found（404，不泄露「存在但哈希不过」）', async () => {
    const registry = makeRegistry({ verify: () => Promise.resolve(false) })
    await expect(gateLive2dFile(registry, 'haru', 'model3.json')).resolves.toEqual({ kind: 'not_found' })
  })

  it('verifyIntegrity 失败 → 不再查清单、不再解析文件（fail-closed 短路）', async () => {
    const registry = makeRegistry({ verify: () => Promise.resolve(false) })
    await gateLive2dFile(registry, 'haru', 'model3.json')
    expect(registry.listInstalledModels).not.toHaveBeenCalled()
    expect(registry.resolveModelFile).not.toHaveBeenCalled()
  })

  it('verifyIntegrity 先于 listInstalledModels（完整哈希未过不得先暴露清单状态）', async () => {
    const order: string[] = []
    const registry = makeRegistry({
      verify: () => { order.push('verify'); return Promise.resolve(true) }
    })
    vi.mocked(registry.listInstalledModels).mockImplementation(() => { order.push('list'); return Promise.resolve([{ id: 'haru', available: true }]) })
    vi.mocked(registry.resolveModelFile).mockImplementation(() => { order.push('resolve'); return Promise.resolve('/models/haru/model3.json') })
    await gateLive2dFile(registry, 'haru', 'model3.json')
    expect(order).toEqual(['verify', 'list', 'resolve'])
  })

  it('模型未注册 → not_found，且不调 resolveModelFile（防用状态码区分遍历与存在）', async () => {
    const registry = makeRegistry({ summaries: [{ id: 'wanko', available: true }] })
    await expect(gateLive2dFile(registry, 'haru', 'model3.json')).resolves.toEqual({ kind: 'not_found' })
    expect(registry.resolveModelFile).not.toHaveBeenCalled()
  })

  it('模型 registered 但 available=false → not_found', async () => {
    const registry = makeRegistry({ summaries: [{ id: 'haru', available: false }] })
    await expect(gateLive2dFile(registry, 'haru', 'model3.json')).resolves.toEqual({ kind: 'not_found' })
    expect(registry.resolveModelFile).not.toHaveBeenCalled()
  })

  it('resolveModelFile 拒绝（穿越/白名单未命中/非普通文件）→ forbidden', async () => {
    const registry = makeRegistry({ resolve: () => Promise.resolve(null) })
    await expect(gateLive2dFile(registry, 'haru', '../../etc/passwd')).resolves.toEqual({ kind: 'forbidden' })
  })

  it('registry 抛异常 → bad_gateway（封口，不向上逃逸）', async () => {
    const registry = makeRegistry({ verify: () => Promise.reject(new Error('registry exploded')) })
    await expect(gateLive2dFile(registry, 'haru', 'model3.json')).resolves.toEqual({ kind: 'bad_gateway' })
  })

  it('resolveModelFile 抛异常同样封口为 bad_gateway', async () => {
    const registry = makeRegistry({ resolve: () => Promise.reject(new Error('io')) })
    await expect(gateLive2dFile(registry, 'haru', 'model3.json')).resolves.toEqual({ kind: 'bad_gateway' })
  })

  it('gateHttpFailure：三种失败各自的状态码与文本（两条通道共用同一映射）', () => {
    expect(gateHttpFailure('not_found')).toEqual({ status: 404, text: 'Not Found' })
    expect(gateHttpFailure('forbidden')).toEqual({ status: 403, text: 'Forbidden' })
    expect(gateHttpFailure('bad_gateway')).toEqual({ status: 502, text: 'Bad Gateway' })
  })
})
