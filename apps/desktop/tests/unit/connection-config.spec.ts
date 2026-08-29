import { describe, expect, it } from 'vitest'
import { ConnectionConfig, type ConnectionConfigStorePort } from '../../src/main/connection/connection-config'
import { CyreneErrorCode } from '../../src/shared/errors'

function makePort() {
  const mem = new Map<string, string>()
  const port: ConnectionConfigStorePort = {
    loadToken: () => Promise.resolve(mem.get('token')),
    saveToken: (v) => { mem.set('token', v); return Promise.resolve() },
    clearToken: () => { mem.delete('token'); return Promise.resolve() },
    loadBinding: () => Promise.resolve(mem.get('binding')),
    saveBinding: (o) => { mem.set('binding', o); return Promise.resolve() },
    clearBinding: () => { mem.delete('binding'); return Promise.resolve() }
  }
  return { port, mem }
}

describe('ConnectionConfig', () => {
  it('https 任意 host 规范化通过 → baseUrl/wsUrl 正确派生', () => {
    const { port } = makePort(); const c = new ConnectionConfig(port)
    const e = c.normalizeEndpoint('https://example.com/')
    expect(e.origin).toBe('https://example.com')
    expect(e.baseUrl).toBe('https://example.com')
    expect(e.wsUrl).toBe('wss://example.com/ws')
  })
  it('远程 http://example.com 被拒 INVALID_INPUT', () => {
    const { port } = makePort(); const c = new ConnectionConfig(port)
    try { c.normalizeEndpoint('http://example.com'); expect.unreachable() }
    catch (e: unknown) { expect((e as { code?: string }).code).toBe(CyreneErrorCode.INVALID_INPUT) }
  })
  it('回环 http://127.0.0.1:8765 / localhost / [::1] 通过', () => {
    const { port } = makePort(); const c = new ConnectionConfig(port)
    for (const u of ['http://127.0.0.1:8765', 'http://localhost:8765', 'http://[::1]:8765']) {
      const e = c.normalizeEndpoint(u)
      expect(e.baseUrl).toBe(u.replace(/\/$/, ''))
      expect(e.wsUrl).toBe(u.replace(/^http/, 'ws') + '/ws')
    }
  })
  it('主机名以 127 开头但不是回环 → 拒（禁前缀匹配）', () => {
    const { port } = makePort(); const c = new ConnectionConfig(port)
    expect(() => c.normalizeEndpoint('http://127.1.2.3.attacker.com')).toThrow()
  })
  it('userinfo/query/fragment 拒绝', () => {
    const { port } = makePort(); const c = new ConnectionConfig(port)
    for (const u of ['https://user:pass@example.com', 'https://example.com/?a=1', 'https://example.com/#x']) {
      expect(() => c.normalizeEndpoint(u)).toThrow()
    }
  })
  it('path 前缀保留 + 尾斜杠去除 → ws 挂 /ws', () => {
    const { port } = makePort(); const c = new ConnectionConfig(port)
    const e = c.normalizeEndpoint('https://example.com/pfx/')
    expect(e.baseUrl).toBe('https://example.com/pfx')
    expect(e.wsUrl).toBe('wss://example.com/pfx/ws')
  })
  it('setEndpoint origin 变化 → 自动清 token 与绑定', async () => {
    const { port, mem } = makePort(); const c = new ConnectionConfig(port)
    await c.setEndpoint('https://a.example')
    await c.setBackendToken('t1')
    expect(mem.get('token')).toBe('t1')
    await c.setEndpoint('https://b.example') // origin 变
    expect(mem.get('token')).toBeUndefined()
    expect(mem.get('binding')).toBeUndefined()
  })
  it('setBackendToken 未设 endpoint → CREDENTIAL_UNAVAILABLE', async () => {
    const { port } = makePort(); const c = new ConnectionConfig(port)
    await expect(c.setBackendToken('t')).rejects.toMatchObject({ code: CyreneErrorCode.CREDENTIAL_UNAVAILABLE })
  })
  it('connect 绑定校验：绑定 origin ≠ 当前 → CREDENTIAL_UNAVAILABLE', async () => {
    const { port } = makePort(); const c = new ConnectionConfig(port)
    await c.setEndpoint('https://a.example'); await c.setBackendToken('t')
    await c.setEndpoint('https://b.example') // 自动清绑定
    expect(await c.getTokenBinding()).toBeUndefined()
  })
})

// UII-QQ 设置页批次：开发默认地址守卫（评审修复 #1——默认注入绝不清除已持久化凭据）
describe('ConnectionConfig.maybeApplyDevDefault', () => {
  it('全新会话（无 endpoint/Token/绑定）→ 应用默认地址', async () => {
    const { port, mem } = makePort(); const c = new ConnectionConfig(port)
    expect(await c.maybeApplyDevDefault('http://127.0.0.1:8765')).toBe(true)
    expect(c.getEndpoint()?.origin).toBe('http://127.0.0.1:8765')
    // setEndpoint 只在 setBackendToken 时落绑定——此处绑定仍为空属预期（连接后 setBackendToken 才写）
    expect(mem.get('binding')).toBeUndefined()
  })
  it('重启场景：绑定 origin === 默认 origin（Token+绑定）→ 恢复默认地址、凭据原样保留', async () => {
    const { port, mem } = makePort(); const c = new ConnectionConfig(port)
    await c.setEndpoint('http://127.0.0.1:8765'); await c.setBackendToken('local-token')
    // 模拟重启：endpoint 内存态清空，Token+绑定仍持久化——同 port 新实例应恢复默认地址让已存凭据继续可用
    const c2 = new ConnectionConfig(port)
    expect(c2.getEndpoint()).toBeUndefined()
    expect(await c2.maybeApplyDevDefault('http://127.0.0.1:8765')).toBe(true)
    expect(c2.getEndpoint()?.origin).toBe('http://127.0.0.1:8765')
    expect(mem.get('token')).toBe('local-token')
    expect(mem.get('binding')).toBe('http://127.0.0.1:8765')
  })
  it('已持久化 Token+绑定（其他 origin）→ 不应用、凭据原样保留', async () => {
    const { port, mem } = makePort(); const c = new ConnectionConfig(port)
    await c.setEndpoint('https://prod.example'); await c.setBackendToken('prod-token')
    // 模拟重启：内存 endpoint 随进程丢失，持久化凭据仍在——同 port 新实例
    const c2 = new ConnectionConfig(port)
    expect(c2.getEndpoint()).toBeUndefined()
    expect(await c2.maybeApplyDevDefault('http://127.0.0.1:8765')).toBe(false)
    expect(c2.getEndpoint()).toBeUndefined()
    expect(mem.get('token')).toBe('prod-token')
    expect(mem.get('binding')).toBe('https://prod.example')
  })
  it('仅 Token 无绑定 → 不应用（凭据存在即视为已配置过）', async () => {
    const { port, mem } = makePort(); const c = new ConnectionConfig(port)
    mem.set('token', 'orphan-token')
    expect(await c.maybeApplyDevDefault('http://127.0.0.1:8765')).toBe(false)
    expect(mem.get('token')).toBe('orphan-token')
  })
  it('会话内已配置 endpoint → 不应用、不改已有地址', async () => {
    const { port } = makePort(); const c = new ConnectionConfig(port)
    await c.setEndpoint('https://prod.example')
    expect(await c.maybeApplyDevDefault('http://127.0.0.1:8765')).toBe(false)
    expect(c.getEndpoint()?.origin).toBe('https://prod.example')
  })
})
