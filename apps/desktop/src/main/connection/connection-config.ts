// apps/desktop/src/main/connection/connection-config.ts
import { isIP } from 'node:net'
import { CyreneError, CyreneErrorCode } from '../../shared/errors'

/** 规范化后的 endpoint：origin 用于 token 绑定比对；baseUrl 供 connect/REST；wsUrl 由 URL 对象协议转换派生（不字符串拼接） */
export interface NormalizedEndpoint {
  origin: string
  baseUrl: string
  wsUrl: string
}

/** ConnectionConfig 依赖的存储端口（Main 装配时注入 CredentialStore 包装；token 与绑定同仓不同 key） */
export interface ConnectionConfigStorePort {
  loadToken(): Promise<string | undefined>
  saveToken(v: string): Promise<void>
  clearToken(): Promise<void>
  loadBinding(): Promise<string | undefined>   // BACKEND_TOKEN_ORIGIN_KEY 值（origin 明文）
  saveBinding(origin: string): Promise<void>
  clearBinding(): Promise<void>
}

/**
 * 回环 host 判定：禁止 `hostname.startsWith('127.')` 前缀匹配。
 * IPv4 用 `isIP` + 首字节 === 127（127.0.0.0/8 全段）；IPv6 仅 `::1`；localhost 恒真。
 */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  if (h === 'localhost') return true
  if (isIP(h) === 4) return Number(h.split('.')[0]) === 127   // 127.0.0.0/8
  if (isIP(h) === 6) return h === '::1'
  return false
}

/**
 * ConnectionConfig：endpoint 规范化 + Token 与 Origin 绑定（决策 3/9）。
 * 纯逻辑、不依赖 Electron——存储经注入端口，测试用 fake port。
 * onEndpointChanged 为可选审计回调（Task 8 注入日志；spec 3.1.2）。
 */
export class ConnectionConfig {
  private endpoint?: NormalizedEndpoint   // 内存持有，重启需重设（决策 3）

  constructor(
    private readonly port: ConnectionConfigStorePort,
    private readonly onEndpointChanged?: (e: NormalizedEndpoint) => void
  ) {}

  /** 校验失败抛 CyreneError(INVALID_INPUT) */
  normalizeEndpoint(rawUrl: string): NormalizedEndpoint {
    let u: URL
    try { u = new URL(rawUrl) } catch { throw new CyreneError(CyreneErrorCode.INVALID_INPUT, 'Endpoint 不是合法 URL') }
    if (u.username || u.password) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, 'Endpoint 不得包含 userinfo')
    if (u.search || u.hash) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, 'Endpoint 不得包含 query 或 fragment')
    const host = u.hostname
    if (u.protocol === 'https:') { /* 任意 host 通过 */ }
    else if (u.protocol === 'http:') { if (!isLoopbackHost(host)) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, 'http 仅允许回环地址') }
    else throw new CyreneError(CyreneErrorCode.INVALID_INPUT, 'Endpoint 仅支持 https 或回环 http')
    const origin = `${u.protocol}//${u.host}`
    const baseUrl = origin + u.pathname.replace(/\/+$/, '')   // 保留 pathname、去尾斜杠
    const ws = new URL(u.toString()); ws.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = ws.origin + ws.pathname.replace(/\/+$/, '') + '/ws'
    return { origin, baseUrl, wsUrl }
  }

  /** origin 变化 → clearToken + clearBinding（旧绑定不得跨 origin 复用）；内存 endpoint 更新 */
  async setEndpoint(rawUrl: string): Promise<NormalizedEndpoint> {
    const e = this.normalizeEndpoint(rawUrl)
    const binding = await this.port.loadBinding()
    if (binding && binding !== e.origin) { await this.port.clearToken(); await this.port.clearBinding() }
    this.endpoint = e
    this.onEndpointChanged?.(e)
    return e
  }

  getEndpoint(): NormalizedEndpoint | undefined { return this.endpoint }

  /**
   * UII-QQ 设置页批次：开发默认地址守卫注入。
   * 会话内未配置 endpoint 时：无任何持久化凭据 → 直接应用；已有凭据 → 仅当持久化绑定 origin
   * 与默认地址一致才恢复（覆盖重启场景：endpoint 内存态清空、本机 Token 仍在，恢复默认地址
   * 已存凭据才能继续可用）。绑定其他 origin / 仅 Token 无绑定一律不动——setEndpoint 对 origin
   * 变化会清凭据（见上），默认注入绝不得触发该清除路径。
   * @returns 是否实际应用
   */
  async maybeApplyDevDefault(rawUrl: string): Promise<boolean> {
    if (this.endpoint) return false
    const [binding, token] = await Promise.all([this.port.loadBinding(), this.port.loadToken()])
    if (binding || token) {
      if (!binding) return false
      let e: NormalizedEndpoint
      try { e = this.normalizeEndpoint(rawUrl) } catch { return false }
      if (binding !== e.origin) return false
    }
    await this.setEndpoint(rawUrl)
    return true
  }

  /** 未设 endpoint → CREDENTIAL_UNAVAILABLE；saveToken + saveBinding(currentOrigin) */
  async setBackendToken(token: string): Promise<void> {
    const e = this.endpoint
    if (!e) throw new CyreneError(CyreneErrorCode.CREDENTIAL_UNAVAILABLE, '请先设置后端地址')
    await this.port.saveToken(token); await this.port.saveBinding(e.origin)
  }

  async clearBackendToken(): Promise<void> { await this.port.clearToken(); await this.port.clearBinding() }

  async getTokenBinding(): Promise<{ origin: string } | undefined> {
    const o = await this.port.loadBinding(); return o ? { origin: o } : undefined
  }
}
