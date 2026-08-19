/** 工具参数安全摘要（镜像后端 Module/tool/safety.py `_safe_arg_summary`，D6A-04/spec §3.4）。
 * 敏感键恒 <redacted>；deny-by-default：所有字符串值只记 <str:N>（白名单恒空）；非字符串按类型名；
 * 输出 "k=v, k=v" 拼接；空 dict → undefined。 */
const REDACTED_KEYS = new Set([
  'token', 'key', 'password', 'secret', 'authorization', 'cookie',
  'content', 'prompt', 'path', 'base_url', 'url', 'query', 'api_key'
])

function typeName(v: unknown): string {
  if (v === null) return 'NoneType'
  if (Array.isArray(v)) return 'list'
  if (typeof v === 'object') return 'dict'
  return typeof v
}

export function redactToolArguments(raw: Record<string, unknown>): string | undefined {
  const keys = Object.keys(raw)
  if (keys.length === 0) return undefined
  return keys.map((k) => {
    const v = raw[k]
    if (REDACTED_KEYS.has(k.toLowerCase())) return `${k}=<redacted>`
    if (typeof v === 'string') return `${k}=<str:${v.length}>`
    return `${k}=<${typeName(v)}>`
  }).join(', ')
}
