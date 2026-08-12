// src/main/config/trusted-renderer-origin.ts
// 纯 Node（无 electron import）：electron.vite.config.ts（dev CSP 插件）也要 import 它构建 CSP。
// 「受信 Renderer URL」单一策略函数——窗口加载（main-window）/ 导航（navigation 经 devOrigin）/ IPC 来源（registry）共用。
import { RENDERER_HOST } from '../protocol/constants'

export function isLoopbackHostname(hostname: string): boolean {
  // 回环仅限字面 localhost / IPv6 [::1] / IPv4 127.0.0.0/8（完整四段点分）；
  // 用 ^127\. 前缀会误判 127.0.0.1.evil.example 这类普通域名（最终 review 收紧）
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
}

export function normalizeOrigin(url: URL): string {
  return `${url.protocol}//${url.host}`
}

const ALLOWLIST_ENV_KEY = 'CYRENE_DEV_RENDERER_ORIGINS'

/** 可信 dev Origin 集合：回环 http 恒允许 + allowlist（http、无 userinfo/fragment；非法条目跳过） */
export function resolveTrustedDevOrigins(env: Record<string, string | undefined> = {}): ReadonlySet<string> {
  const trusted = new Set<string>(['http://localhost', 'http://127.0.0.1', 'http://[::1]'])
  const raw = env[ALLOWLIST_ENV_KEY]
  if (!raw) return trusted
  for (const item of raw.split(',')) {
    const trimmed = item.trim()
    if (!trimmed) continue
    try {
      const u = new URL(trimmed)
      if (u.protocol !== 'http:') continue
      if (u.username || u.password || u.hash) continue
      trusted.add(normalizeOrigin(u))
    } catch {
      // 畸形条目跳过（fail-closed 于该条）
    }
  }
  return trusted
}

export function isTrustedDevUrl(url: URL, trusted: ReadonlySet<string>): boolean {
  if (url.protocol !== 'http:') return false
  if (url.username || url.password || url.hash) return false
  // 回环 hostname 恒放行任意端口；allowlist 保持精确 origin（含端口）语义
  return isLoopbackHostname(url.hostname) || trusted.has(normalizeOrigin(url))
}

export function isAppRendererUrl(rawUrl: string, trusted: ReadonlySet<string>): boolean {
  try {
    const url = new URL(rawUrl)
    // cyrene 分支也拒 userinfo（cyrene://evil@renderer 不因 host 匹配而放行）
    if (url.protocol === 'cyrene:' && url.host === RENDERER_HOST && !url.username && !url.password) return true
    return isTrustedDevUrl(url, trusted)
  } catch {
    return false
  }
}

/** 启动评估（B2）：falsy/空白 = absent（无 dev server）；非法 = untrusted（启动报错退出） */
export function evaluateDevRendererUrl(
  raw: string | undefined,
  env: Record<string, string | undefined>
): { status: 'absent' | 'trusted' | 'untrusted'; url?: URL; reason?: string } {
  if (!raw || !raw.trim()) return { status: 'absent' }
  let url: URL
  try { url = new URL(raw) } catch { return { status: 'untrusted', reason: '无法解析为 URL' } }
  if (url.protocol !== 'http:') return { status: 'untrusted', reason: `协议必须是 http:（收到 ${url.protocol}）` }
  if (url.username || url.password) return { status: 'untrusted', reason: '不允许 userinfo' }
  if (url.hash) return { status: 'untrusted', reason: '不允许 fragment' }
  const trusted = resolveTrustedDevOrigins(env)
  // 回环 hostname 恒放行任意端口（URL.hostname 含端口则 normalizeOrigin 不匹配无端口基础集合，须短路）；
  // allowlist 精确匹配（条目带端口 normalize 入集合）
  if (!isLoopbackHostname(url.hostname) && !trusted.has(normalizeOrigin(url))) {
    return { status: 'untrusted', reason: `host ${url.host} 不在回环或 ${ALLOWLIST_ENV_KEY} 白名单` }
  }
  return { status: 'trusted', url }
}

/** 记忆化运行时集合（env 恒定）：registry IPC 校验与 dev CSP 插件共用 */
let cachedTrusted: ReadonlySet<string> | null = null
export function getTrustedDevOrigins(): ReadonlySet<string> {
  if (!cachedTrusted) cachedTrusted = resolveTrustedDevOrigins(process.env)
  return cachedTrusted
}
