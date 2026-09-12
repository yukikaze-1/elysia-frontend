// tests/unit/dev-ports.spec.ts（node）
// 开发环境隔离（docs/19，2026-09-12）：端口与本地服务地址唯一配置来源的单测。
//
// 覆盖三件事——它们的失败模式都不是「测试红」而是「调试现场悄悄跑偏」：
//   ① 端口段契约：5373 必须是显式回环 + strictPort:true（strictPort 关掉就等于允许静默漂到 5174）；
//   ② 启动断言：dev server origin 与常量不一致时必须**判定失败**（而不是放行后让现场三处口径分叉）；
//   ③ 开发默认后端地址：env 覆盖生效 + 非法地址抛错（不静默回落到默认值）。
import { describe, expect, it } from 'vitest'
import {
  DEV_BACKEND_ORIGIN_ENV,
  DEV_DEFAULT_BACKEND_ORIGIN,
  DEV_SERVER_HOST,
  DEV_SERVER_ORIGIN,
  DEV_SERVER_PORT,
  assertDevServerOrigin,
  assertValidDevServerPort,
  devServerConfig,
  resolveDevDefaultBackendOrigin
} from '../../src/main/config/dev-ports'

describe('端口段契约', () => {
  it('Renderer 固定 5373 + 显式回环 IPv4 + strictPort', () => {
    expect(DEV_SERVER_PORT).toBe(5373)
    expect(DEV_SERVER_HOST).toBe('127.0.0.1')
    expect(DEV_SERVER_ORIGIN).toBe('http://127.0.0.1:5373')
    expect(devServerConfig()).toEqual({ port: 5373, host: '127.0.0.1', strictPort: true })
  })

  it('不落在常见 Vite/脚手架默认段（5173/5174/5273 等是撞车高发号）', () => {
    for (const collisionProne of [3000, 3001, 4173, 5173, 5174, 5273, 8000, 8080, 9222, 9223]) {
      expect(DEV_SERVER_PORT, `端口 ${collisionProne} 属高撞车号段`).not.toBe(collisionProne)
    }
  })

  it('端口校验：越界/非整数报错（不静默夹取）', () => {
    expect(assertValidDevServerPort(5373)).toBe(5373)
    expect(() => assertValidDevServerPort(80)).toThrow(/开发端口非法/)
    expect(() => assertValidDevServerPort(70000)).toThrow(/开发端口非法/)
    expect(() => assertValidDevServerPort(5373.5)).toThrow(/开发端口非法/)
  })
})

describe('assertDevServerOrigin（主进程启动断言）', () => {
  it('与常量一致 → ok', () => {
    expect(assertDevServerOrigin('http://127.0.0.1:5373')).toEqual({ ok: true })
    // 带路径/尾斜杠也应当通过（URL 解析后只看 host/port）
    expect(assertDevServerOrigin('http://127.0.0.1:5373/')).toEqual({ ok: true })
  })

  it('端口漂移（如被别的项目占住后落到 5174）→ 判定失败并说明原因', () => {
    const r1 = assertDevServerOrigin('http://127.0.0.1:5174')
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.reason).toContain('5174')

    const r2 = assertDevServerOrigin('http://127.0.0.1:5173')
    expect(r2.ok).toBe(false)
  })

  it('host 漂移（localhost / 通配）→ 判定失败', () => {
    expect(assertDevServerOrigin('http://localhost:5373').ok).toBe(false)
    expect(assertDevServerOrigin('http://0.0.0.0:5373').ok).toBe(false)
  })

  it('缺失/畸形/非 http → 判定失败（不把 undefined 当通过）', () => {
    expect(assertDevServerOrigin(undefined).ok).toBe(false)
    expect(assertDevServerOrigin('   ').ok).toBe(false)
    expect(assertDevServerOrigin('not-a-url').ok).toBe(false)
    expect(assertDevServerOrigin('cyrene://renderer/index.html').ok).toBe(false)
  })

  // —— 测试 harness 例外（docs/19）：只放宽端口，不放宽回环 ——
  it('harness 放行：任意回环端口通过（集成套件用 port 0 起独立 dev server）', () => {
    const opts = { allowAnyLoopbackPort: true }
    expect(assertDevServerOrigin('http://127.0.0.1:5373', opts)).toEqual({ ok: true })
    expect(assertDevServerOrigin('http://127.0.0.1:49731', opts)).toEqual({ ok: true })
    expect(assertDevServerOrigin('http://localhost:49731', opts)).toEqual({ ok: true })
    expect(assertDevServerOrigin('http://[::1]:49731', opts)).toEqual({ ok: true })
  })

  it('harness 放行仍拒绝非回环 host 与非 http 协议', () => {
    const opts = { allowAnyLoopbackPort: true }
    expect(assertDevServerOrigin('http://192.168.1.5:5373', opts).ok).toBe(false)
    expect(assertDevServerOrigin('https://127.0.0.1:5373', opts).ok).toBe(false)
    expect(assertDevServerOrigin(undefined, opts).ok).toBe(false)
  })
})

describe('resolveDevDefaultBackendOrigin（开发默认后端）', () => {
  it('无 env → 用固定常量（本机真实后端 8765）', () => {
    expect(DEV_DEFAULT_BACKEND_ORIGIN).toBe('http://127.0.0.1:8765')
    expect(resolveDevDefaultBackendOrigin({})).toBe('http://127.0.0.1:8765')
  })

  it('env 覆盖生效（多项目并存时各用各的后端）', () => {
    expect(resolveDevDefaultBackendOrigin({ [DEV_BACKEND_ORIGIN_ENV]: 'http://127.0.0.1:6380' }))
      .toBe('http://127.0.0.1:6380')
    expect(resolveDevDefaultBackendOrigin({ [DEV_BACKEND_ORIGIN_ENV]: 'https://backend.example' }))
      .toBe('https://backend.example')
  })

  it('env 置空串 → 不注入开发默认（显式关闭）', () => {
    expect(resolveDevDefaultBackendOrigin({ [DEV_BACKEND_ORIGIN_ENV]: '' })).toBeUndefined()
  })

  it('非法地址抛错（非回环 http / 带 userinfo / 带 query / 非 http(s)）', () => {
    for (const bad of [
      'http://192.168.1.5:8765',           // 非回环 http
      'http://user:pass@127.0.0.1:8765',   // userinfo
      'http://127.0.0.1:8765/?a=1',        // query
      'ws://127.0.0.1:8765',               // 非 http(s)
      'ftp://127.0.0.1:8765',
      'not-a-url'
    ]) {
      expect(() => resolveDevDefaultBackendOrigin({ [DEV_BACKEND_ORIGIN_ENV]: bad }), bad).toThrow()
    }
  })

  it('回环 http 三种写法均合法（与 ConnectionConfig 口径一致）', () => {
    for (const ok of ['http://127.0.0.1:8765', 'http://localhost:8765', 'http://[::1]:8765']) {
      expect(resolveDevDefaultBackendOrigin({ [DEV_BACKEND_ORIGIN_ENV]: ok }), ok).toBe(ok)
    }
  })
})
