/**
 * 整 token 替换 [REDACTED]（替换型掩码，非 presence grep）：
 * 顺序关键——Bearer 先于 ≥40 长串（否则 Bearer token 先被长串规则命中）；短/无标记不误伤。
 */
const RULES: Array<{ re: RegExp; replacement: string }> = [
  { re: /Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, replacement: 'Bearer [REDACTED]' },
  { re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, replacement: '[REDACTED]' },
  { re: /\b(?:sk-[A-Za-z0-9]{10,}|AKIA[A-Z0-9]{16})\b/g, replacement: '[REDACTED]' },
  { re: /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/])/g, replacement: '[REDACTED]' }
]

export function redactSensitiveValues(text: string): string {
  let out = text
  for (const { re, replacement } of RULES) out = out.replace(re, replacement)
  return out
}
