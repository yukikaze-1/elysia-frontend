// tests/unit/protocol-live2d.spec.ts
// Task 3（A4）Step 4:protocol handler live2d 分支实测（Fake registry 注入）——registered/available 门禁 + fail-closed
// verify 时序 + containment/白名单 + 200+mime+no-store + dev CORS（ACAO+Vary，错误响应也回补）。env=node。
// 结构：vi.mock('electron') 捕获 protocol.handle 注册的真实 handler + mock net.fetch 提供文件字节；
// createLive2dResolver(Fake registry) 注入闭包逻辑（与 main/index.ts 接线同一工厂）。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockProtocol, mockNet, capturedHandler } = vi.hoisted(() => {
  let captured: ((request: Request) => Promise<Response>) | null = null
  return {
    mockProtocol: {
      handle: vi.fn((_scheme: string, handler: (request: Request) => Promise<Response>): void => { captured = handler })
    },
    mockNet: {
      fetch: vi.fn(async (_url: string) => new Response('model-bytes', { status: 200 }))
    },
    capturedHandler: () => captured
  }
})
vi.mock('electron', () => ({ protocol: mockProtocol, net: mockNet }))

import { createLive2dResolver, registerCyreneProtocolHandler, type Live2dResolverRegistry } from '../../src/main/protocol/handler'

// 可控 deferred（fail-closed 时序断言）
const deferred = <T,>() => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

// 小型 Fake registry：verifyIntegrity/listInstalledModels/resolveModelFile 全 spy 化，行为可按用例覆写
const makeFakeRegistry = (opts: {
  verify?: (id: string) => Promise<boolean>
  summaries?: Array<{ id: string; available: boolean }>
  resolve?: (id: string, relPath: string) => Promise<string | null>
} = {}): Live2dResolverRegistry => ({
  verifyIntegrity: vi.fn((id: string) => (opts.verify ? opts.verify(id) : Promise.resolve(true))),
  listInstalledModels: vi.fn(() => Promise.resolve(opts.summaries ?? [{ id: 'haru', available: true }])),
  resolveModelFile: vi.fn((id: string, relPath: string) =>
    opts.resolve ? opts.resolve(id, relPath) : Promise.resolve(relPath === 'model3.json' ? `/abs/haru/${relPath}` : null)
  )
})

// 注册真实 handler（闭包 = 真实 createLive2dResolver + Fake registry），然后 dispatch 一个 cyrene:// Request
const register = async (registry: Live2dResolverRegistry) => {
  await registerCyreneProtocolHandler({ resolveLive2d: createLive2dResolver(registry) })
}
const dispatch = (path: string, init?: RequestInit): Promise<Response> => {
  const h = capturedHandler()
  if (!h) throw new Error('protocol handler not registered')
  return h(new Request(`cyrene://renderer${path}`, init))
}

beforeEach(() => {
  mockProtocol.handle.mockClear()
  mockNet.fetch.mockClear()
})

describe('live2d 分支拒绝矩阵（handler 层）', () => {
  it('document 请求 → 403，resolveLive2d 不被调用', async () => {
    const registry = makeFakeRegistry()
    await register(registry)
    const res = await dispatch('/__cyrene-live2d/haru/model3.json', { headers: { 'sec-fetch-dest': 'document' } })
    expect(res.status).toBe(403)
    expect(registry.verifyIntegrity).not.toHaveBeenCalled()
  })

  it('非法 relPath（..）→ 403，parse 拒，resolver 不被调用', async () => {
    const registry = makeFakeRegistry()
    await register(registry)
    expect((await dispatch('/__cyrene-live2d/haru/../secret.txt')).status).toBe(403)
    expect(registry.verifyIntegrity).not.toHaveBeenCalled()
  })

  it('resolveLive2d 未接线 → 404', async () => {
    await registerCyreneProtocolHandler({})
    expect((await dispatch('/__cyrene-live2d/haru/model3.json')).status).toBe(404)
  })

  it('resolveLive2d 抛错 → 502（handler 兜底，不成为 rejected promise）', async () => {
    await registerCyreneProtocolHandler({
      resolveLive2d: async () => { throw new Error('boom') }
    })
    expect((await dispatch('/__cyrene-live2d/haru/model3.json')).status).toBe(502)
  })
})

describe('registered + available 门禁（M-3：协议层在 resolveModelFile 前自检）', () => {
  it('未知 modelId → 404，verifyIntegrity + listInstalledModels 均被调用，resolveModelFile 不被调用', async () => {
    const registry = makeFakeRegistry({ summaries: [] })
    await register(registry)
    const res = await dispatch('/__cyrene-live2d/unknown/model3.json')
    expect(res.status).toBe(404)
    expect(registry.verifyIntegrity).toHaveBeenCalledWith('unknown')
    expect(registry.listInstalledModels).toHaveBeenCalled()
    expect(registry.resolveModelFile).not.toHaveBeenCalled() // 门禁先行，白名单解析不触达
  })

  it('!available modelId → 404', async () => {
    const registry = makeFakeRegistry({ summaries: [{ id: 'haru', available: false }] })
    await register(registry)
    expect((await dispatch('/__cyrene-live2d/haru/model3.json')).status).toBe(404)
  })

  it('verifyIntegrity 失败（hash 不匹配）→ 404 fail-closed 熔断', async () => {
    const registry = makeFakeRegistry({ verify: async () => false })
    await register(registry)
    const res = await dispatch('/__cyrene-live2d/haru/model3.json')
    expect(res.status).toBe(404)
    expect(registry.verifyIntegrity).toHaveBeenCalledWith('haru')
    expect(registry.resolveModelFile).not.toHaveBeenCalled()
  })
})

describe('fail-closed 时序：首个请求 await 全量 hash，完成前不响应', () => {
  it('deferred 未 resolve 前响应不 settle，resolve true 后才 200（首命中 await 全量 hash）', async () => {
    const d = deferred<boolean>()
    const registry = makeFakeRegistry({
      verify: (id) => {
        expect(id).toBe('haru')
        return d.promise
      }
    })
    await register(registry)
    let settled = false
    const p = dispatch('/__cyrene-live2d/haru/model3.json').then((r) => { settled = true; return r })
    // 等宏任务：verifyIntegrity 仍在 pending，响应必须未 settle
    await new Promise((r) => setTimeout(r, 20))
    expect(settled).toBe(false)
    d.resolve(true)
    const res = await p
    expect(res.status).toBe(200)
  })

  it('deferred 完成但 hash 失败 → 首个请求 404（等完才裁决，fail-closed）', async () => {
    const d = deferred<boolean>()
    const registry = makeFakeRegistry({ verify: () => d.promise })
    await register(registry)
    let settled = false
    const p = dispatch('/__cyrene-live2d/haru/model3.json').then((r) => { settled = true; return r })
    await new Promise((r) => setTimeout(r, 20))
    expect(settled).toBe(false)
    d.resolve(false)
    expect((await p).status).toBe(404)
  })
})

describe('白名单（resolveModelFile）+ 供给', () => {
  it('白名单内 → 200 + Content-Type（mimeOf）+ Cache-Control: no-store', async () => {
    const registry = makeFakeRegistry()
    await register(registry)
    const res = await dispatch('/__cyrene-live2d/haru/model3.json')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(mockNet.fetch).toHaveBeenCalledWith('file:///abs/haru/model3.json') // pathToFileURL 绝对路径直供
    await res.text()
  })

  it('白名单外（resolveModelFile null）→ 403', async () => {
    const registry = makeFakeRegistry()
    await register(registry)
    const res = await dispatch('/__cyrene-live2d/haru/secret.txt')
    expect(res.status).toBe(403)
    expect(registry.resolveModelFile).toHaveBeenCalledWith('haru', 'secret.txt')
  })
})

describe('dev CORS（ACAO 成功与错误响应均回补；非受信不加）', () => {
  it('受信 dev Origin（http://localhost:5173）→ 成功响应带 ACAO + Vary: Origin', async () => {
    const registry = makeFakeRegistry()
    await register(registry)
    const res = await dispatch('/__cyrene-live2d/haru/model3.json', { headers: { origin: 'http://localhost:5173' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
    expect(res.headers.get('Vary')).toBe('Origin')
    await res.text()
  })

  it('非受信 Origin（非回环 http）→ 无 ACAO', async () => {
    const registry = makeFakeRegistry()
    await register(registry)
    const res = await dispatch('/__cyrene-live2d/haru/model3.json', { headers: { origin: 'http://192.168.1.5:5173' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(res.headers.get('Vary')).toBeNull()
    await res.text()
  })

  it('畸形 Origin → 无 ACAO（fail-closed 不向上抛）', async () => {
    const registry = makeFakeRegistry()
    await register(registry)
    const res = await dispatch('/__cyrene-live2d/haru/model3.json', { headers: { origin: 'not-a-url' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    await res.text()
  })

  it('错误响应也回补 ACAO（dev Origin）：404（未知模型）与 403（白名单外）', async () => {
    const known = makeFakeRegistry({ summaries: [{ id: 'haru', available: true }] })
    await register(known)
    const err404 = await dispatch('/__cyrene-live2d/ghost/model3.json', { headers: { origin: 'http://localhost:5173' } })
    expect(err404.status).toBe(404)
    expect(err404.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
    expect(err404.headers.get('Vary')).toBe('Origin')

    const outside = makeFakeRegistry()
    await register(outside)
    const err403 = await dispatch('/__cyrene-live2d/haru/secret.txt', { headers: { origin: 'http://localhost:5173' } })
    expect(err403.status).toBe(403)
    expect(err403.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
    expect(err403.headers.get('Vary')).toBe('Origin')
  })

  it('非受信 Origin 的错误响应同样无 ACAO', async () => {
    const registry = makeFakeRegistry({ summaries: [] })
    await register(registry)
    const res = await dispatch('/__cyrene-live2d/ghost/model3.json', { headers: { origin: 'http://192.168.1.5:5173' } })
    expect(res.status).toBe(404)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})