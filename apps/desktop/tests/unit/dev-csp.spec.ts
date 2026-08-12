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
    expect(connect).toContain('ws://[::1]:*')
    expect(connect).toContain('wss://localhost:*')
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
})
