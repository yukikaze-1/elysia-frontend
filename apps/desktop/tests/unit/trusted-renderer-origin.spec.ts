import { describe, expect, it } from 'vitest'
import {
  isLoopbackHostname, resolveTrustedDevOrigins, evaluateDevRendererUrl, isAppRendererUrl
} from '../../src/main/config/trusted-renderer-origin'

describe('isLoopbackHostname', () => {
  it('回环 true：localhost / 127.x / [::1]', () => {
    expect(isLoopbackHostname('localhost')).toBe(true)
    expect(isLoopbackHostname('127.0.0.1')).toBe(true)
    expect(isLoopbackHostname('127.8.9.10')).toBe(true)
    expect(isLoopbackHostname('[::1]')).toBe(true)
  })
  it('非回环 false', () => {
    expect(isLoopbackHostname('192.168.1.10')).toBe(false)
    expect(isLoopbackHostname('example.com')).toBe(false)
    expect(isLoopbackHostname('10.0.0.1')).toBe(false)
  })
})

describe('resolveTrustedDevOrigins', () => {
  it('无 env → 仅回环 http 三 origin', () => {
    const s = resolveTrustedDevOrigins({})
    expect(s.has('http://localhost')).toBe(true)
    expect(s.has('http://127.0.0.1')).toBe(true)
    expect(s.has('http://[::1]')).toBe(true)
    expect(s.has('http://192.168.1.5')).toBe(false)
  })
  it('allowlist 附加 http origin；https/userinfo/fragment/畸形条目跳过', () => {
    const s = resolveTrustedDevOrigins({
      CYRENE_DEV_RENDERER_ORIGINS: 'http://192.168.1.5:5173, https://evil.example, http://user:pass@x:1, http://y:2/#frag, not-a-url'
    })
    expect(s.has('http://192.168.1.5:5173')).toBe(true)
    expect(s.has('https://evil.example')).toBe(false)
    expect(s.has('http://x:1')).toBe(false)
    expect(s.has('http://y:2')).toBe(false)
  })
  it('空白条目忽略', () => {
    const s = resolveTrustedDevOrigins({ CYRENE_DEV_RENDERER_ORIGINS: ' , , http://10.0.0.2:5173 ' })
    expect(s.has('http://10.0.0.2:5173')).toBe(true)
  })
})

describe('evaluateDevRendererUrl', () => {
  it('falsy/空白 → absent', () => {
    expect(evaluateDevRendererUrl(undefined, {}).status).toBe('absent')
    expect(evaluateDevRendererUrl('', {}).status).toBe('absent')
    expect(evaluateDevRendererUrl('   ', {}).status).toBe('absent')
  })
  it('回环 → trusted', () => {
    expect(evaluateDevRendererUrl('http://localhost:5173', {}).status).toBe('trusted')
    expect(evaluateDevRendererUrl('http://127.0.0.1:5173', {}).status).toBe('trusted')
    expect(evaluateDevRendererUrl('http://[::1]:5173', {}).status).toBe('trusted')
  })
  it('https/局域网无 allowlist/userinfo/fragment/畸形 → untrusted', () => {
    expect(evaluateDevRendererUrl('https://example.test/', {}).status).toBe('untrusted')
    expect(evaluateDevRendererUrl('http://192.168.1.5:5173', {}).status).toBe('untrusted')
    expect(evaluateDevRendererUrl('http://user:pass@localhost:5173', {}).status).toBe('untrusted')
    expect(evaluateDevRendererUrl('http://localhost:5173/#frag', {}).status).toBe('untrusted')
    expect(evaluateDevRendererUrl('not-a-url', {}).status).toBe('untrusted')
    expect(evaluateDevRendererUrl('file:///x', {}).status).toBe('untrusted')
  })
  it('局域网 + allowlist → trusted；untrusted 带 reason', () => {
    const r = evaluateDevRendererUrl('http://192.168.1.5:5173', { CYRENE_DEV_RENDERER_ORIGINS: 'http://192.168.1.5:5173' })
    expect(r.status).toBe('trusted')
    expect(evaluateDevRendererUrl('https://example.test/', {}).reason).toContain('http')
  })
})

describe('isAppRendererUrl', () => {
  const trusted = resolveTrustedDevOrigins({})
  it('cyrene://renderer → true；错误 cyrene host → false', () => {
    expect(isAppRendererUrl('cyrene://renderer/index.html', trusted)).toBe(true)
    expect(isAppRendererUrl('cyrene://evil/index.html', trusted)).toBe(false)
  })
  it('受信 http → true；异源/畸形 → false', () => {
    expect(isAppRendererUrl('http://localhost:5173/', trusted)).toBe(true)
    expect(isAppRendererUrl('http://evil.example/', trusted)).toBe(false)
    expect(isAppRendererUrl('not a url', trusted)).toBe(false)
  })
})
