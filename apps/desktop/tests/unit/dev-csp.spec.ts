// tests/unit/dev-csp.spec.ts
import { describe, expect, it } from 'vitest'
import { buildDevCsp } from '../../src/main/config/dev-csp'
import { resolveTrustedDevOrigins } from '../../src/main/config/trusted-renderer-origin'

describe('buildDevCsp', () => {
  it('含 frame-ancestors/frame-src/form-action none', () => {
    const csp = buildDevCsp(resolveTrustedDevOrigins({}))
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("frame-src 'none'")
    expect(csp).toContain("form-action 'none'")
  })
  it('connect-src 含每受信 origin 的 ws/wss 源，不含裸 ws:/wss: scheme', () => {
    const connect = buildDevCsp(resolveTrustedDevOrigins({})).split('; ').find((d) => d.startsWith('connect-src'))!
    expect(connect).toContain('ws://localhost:*')
    expect(connect).toContain('ws://127.0.0.1:*')
    expect(connect).toContain('wss://localhost:*')
    expect(connect).not.toContain('ws://[::1]:*') // Chromium 拒 IPv6+端口通配源；同源 ws 由 'self' 覆盖
    expect(connect.split(' ')).not.toContain('ws:')
    expect(connect.split(' ')).not.toContain('wss:')
  })
  it('保留 style-src unsafe-inline（Vue SFC dev 样式）', () => {
    expect(buildDevCsp(resolveTrustedDevOrigins({}))).toContain("style-src 'self' 'unsafe-inline'")
  })
  it('allowlist 附加 origin 的 ws 进入 connect-src（hostname 通配端口）', () => {
    const t = resolveTrustedDevOrigins({ CYRENE_DEV_RENDERER_ORIGINS: 'http://192.168.1.5:5173' })
    const connect = buildDevCsp(t).split('; ').find((d) => d.startsWith('connect-src'))!
    expect(connect).toContain('ws://192.168.1.5:*')
  })
  it('dev 两处加 cyrene:（media-src + img-src）；connect-src 不含 cyrene:（2026-09-10 收紧）', () => {
    const csp = buildDevCsp(resolveTrustedDevOrigins({}))
    expect(csp).toContain("media-src 'self' cyrene:")
    expect(csp).toContain("img-src 'self' data: blob: cyrene:")
    // 2026-09-10：dev 下已无 fetch 指向 cyrene://（模型文件走 IPC 供给、着色器根相对、媒体是元素加载），
    // 故 connect-src 不再放行 cyrene:。原断言基于「Framework 经 fetch(cyrene://) 取 shader」这一与实现
    // 不符的注释——该错误认知正是 dev 形态 Live2D 加载失败长期未被定位的原因。
    const connect = csp.split('; ').find((d) => d.startsWith('connect-src'))!
    expect(connect).not.toContain('cyrene:')
  })
  it('connect-src 含 self；绝不含 wasm-unsafe-eval / unsafe-eval（Core 为 asm.js 非 wasm）', () => {
    const csp = buildDevCsp(resolveTrustedDevOrigins({}))
    const connect = csp.split('; ').find((d) => d.startsWith('connect-src'))!
    expect(connect).toContain("connect-src 'self'")
    expect(connect).not.toContain('cyrene:')
    expect(csp).not.toContain('wasm-unsafe-eval')
    expect(csp).not.toContain("'unsafe-eval'")
  })
})

it('dev img-src 追加 cyrene:（贴图经 cyrene:// 媒体代理；元素加载，不经 connect-src）', () => {
  const csp = buildDevCsp(resolveTrustedDevOrigins({}))
  expect(csp).toContain("img-src 'self' data: blob: cyrene:")
  const connect = csp.split('; ').find((d) => d.startsWith('connect-src'))!
  expect(connect).not.toContain('cyrene:')
})
