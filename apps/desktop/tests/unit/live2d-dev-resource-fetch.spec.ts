// tests/unit/live2d-dev-resource-fetch.spec.ts
// 2026-09-10：dev 形态 Live2D 供给（IPC）单元测试。
//
// 背景：`pnpm dev` 下页面由 Vite dev server 供给（origin `http://localhost:<port>`），而模型文件只在
// `cyrene://` 上；scheme 恒 corsEnabled:false（阶段 5 D-4 安全结论），跨源 fetch 被 Chromium 拒绝并抛
// 原生 `TypeError: Failed to fetch`——真机表现为「模型加载失败 / 原因：Failed to fetch」且清单同时显示
// 「已发现 N 个模型，其中可用 N 个」。本 spec 钉住替身 fetch 的契约：URL 形态不变、参数解码正确、
// 字节与状态码如实映射、非模型资源不误走 IPC。
// env=node。location / import.meta.env 按需 stub。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDevLive2dFetch, needsIpcResourceSupply, type Live2dModelFileReader } from '../../src/renderer/src/live2d/dev-resource-fetch'
import { LIVE2D_PATH_PREFIX } from '@shared/contracts'

const URL_OF_HARU = `cyrene://renderer${LIVE2D_PATH_PREFIX}haru/model3.json`

/** 记录调用参数的 reader；默认回小字节 */
function makeReader(result?: Awaited<ReturnType<Live2dModelFileReader>>) {
  const calls: Array<[string, string]> = []
  const reader: Live2dModelFileReader = (modelId, relPath) => {
    calls.push([modelId, relPath])
    return Promise.resolve(result ?? { ok: true, bytes: new Uint8Array([1, 2, 3]), mime: 'application/json' })
  }
  return { reader, calls }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('createDevLive2dFetch：URL → IPC → Response', () => {
  it('解析出 (modelId, relPath) 并交给 reader——URL 形态与打包形态一致（仍为 cyrene://…）', async () => {
    const { reader, calls } = makeReader()
    await createDevLive2dFetch(reader)(URL_OF_HARU)
    expect(calls).toEqual([['haru', 'model3.json']])
  })

  it('relPath 逐段 percent-decode（适配器 encodePath 的对称面），modelId 不编码', async () => {
    const { reader, calls } = makeReader()
    await createDevLive2dFetch(reader)(
      `cyrene://renderer${LIVE2D_PATH_PREFIX}haru/expressions/${encodeURIComponent('开心 01.exp3.json')}`
    )
    expect(calls).toEqual([['haru', 'expressions/开心 01.exp3.json']])
  })

  it('成功 → Response 200 + 原字节 + mime；arrayBuffer/blob 可用（纹理走 createImageBitmap）', async () => {
    const { reader } = makeReader({ ok: true, bytes: new Uint8Array([7, 8, 9, 10]), mime: 'image/png' })
    const f = createDevLive2dFetch(reader)
    const binary = await f(URL_OF_HARU)
    expect(binary.ok).toBe(true)
    expect(binary.status).toBe(200)
    expect(binary.headers.get('Content-Type')).toBe('image/png')
    expect(new Uint8Array(await binary.arrayBuffer())).toEqual(new Uint8Array([7, 8, 9, 10]))
    // 纹理路径走 blob()（loadTexture → createImageBitmap）；Response body 只能消费一次，故另取一份
    const texture = await f(URL_OF_HARU)
    expect((await texture.blob()).size).toBe(4)
  })

  it('ok:false → Response 非 ok 且带原状态码（适配器据此抛「HTTP 404」类可读错误）', async () => {
    const { reader } = makeReader({ ok: false, status: 403 })
    const res = await createDevLive2dFetch(reader)(URL_OF_HARU)
    expect(res.ok).toBe(false)
    expect(res.status).toBe(403)
  })

  it('非模型资源路径 → 抛 TypeError，绝不误经 IPC（着色器由 dev server 同源供给）', async () => {
    const { reader, calls } = makeReader()
    await expect(createDevLive2dFetch(reader)('cyrene://renderer/__cyrene-media/sticker/x')).rejects.toThrow(TypeError)
    expect(calls).toEqual([])
  })

  it('接受 RequestInfo/URL 三种入参形态（typeof fetch 兼容面）', async () => {
    const { reader, calls } = makeReader()
    const f = createDevLive2dFetch(reader)
    await f(new URL(URL_OF_HARU))
    await f(new Request(URL_OF_HARU))
    expect(calls).toEqual([['haru', 'model3.json'], ['haru', 'model3.json']])
  })
})

describe('needsIpcResourceSupply：判定「页面与 cyrene:// 是否跨源」', () => {
  it('dev 形态（MODE=development + http 页面）→ true', () => {
    vi.stubEnv('MODE', 'development')
    vi.stubGlobal('location', { protocol: 'http:' })
    expect(needsIpcResourceSupply()).toBe(true)
  })

  it('打包/preview 形态（页面自身即 cyrene://renderer，同源）→ false，走原生 fetch', () => {
    vi.stubEnv('MODE', 'production')
    vi.stubGlobal('location', { protocol: 'cyrene:' })
    expect(needsIpcResourceSupply()).toBe(false)
  })

  it('MODE 非 development（test 构建/单测 happy-dom 的 http 页面）→ false，不误走 IPC', () => {
    vi.stubEnv('MODE', 'test')
    vi.stubGlobal('location', { protocol: 'http:' })
    expect(needsIpcResourceSupply()).toBe(false)
  })

  it('MODE=development 但页面已在 cyrene://（--mode development 直启）→ false', () => {
    vi.stubEnv('MODE', 'development')
    vi.stubGlobal('location', { protocol: 'cyrene:' })
    expect(needsIpcResourceSupply()).toBe(false)
  })

  it('无 location（node 环境）→ false，不抛', () => {
    vi.stubEnv('MODE', 'development')
    vi.stubGlobal('location', undefined)
    expect(needsIpcResourceSupply()).toBe(false)
  })
})
