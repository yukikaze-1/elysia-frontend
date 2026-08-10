// tests/unit/redact.spec.ts
import { describe, expect, it } from 'vitest'
import { redactSensitiveValues } from '../../src/main/diagnostics/redact'

describe('redactSensitiveValues', () => {
  it('Bearer token → Bearer [REDACTED]（保留 scheme 词）', () => {
    expect(redactSensitiveValues('auth: Bearer abc.def-ghi_123XYZ')).toBe('auth: Bearer [REDACTED]')
  })
  it('JWT（eyJ 三段）→ [REDACTED]', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.aGVsbG8td29ybGQtZGF0YQ'
    expect(redactSensitiveValues(`token=${jwt}`)).toBe('token=[REDACTED]')
  })
  it('sk- / AKIA 前缀 → [REDACTED]', () => {
    expect(redactSensitiveValues('key=sk-abc123DEF456ghi789')).toBe('key=[REDACTED]')
    expect(redactSensitiveValues('key=AKIAIOSFODNN7EXAMPLE')).toBe('key=[REDACTED]')
  })
  it('≥40 高熵 base64 长串 → [REDACTED]', () => {
    const long = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5'
    expect(redactSensitiveValues(`v=${long}`)).toBe('v=[REDACTED]')
  })
  it('普通文本不误伤', () => {
    expect(redactSensitiveValues('hello world, 你好')).toBe('hello world, 你好')
    expect(redactSensitiveValues('版本号 v1.2.3 已发布')).toBe('版本号 v1.2.3 已发布')
  })
  it('短 token（<40）无前缀标记 → 保留（无法可靠判定，不误伤）', () => {
    expect(redactSensitiveValues('x=shorttoken')).toBe('x=shorttoken')
  })
  it('≥40 Bearer token 由 Bearer 规则命中（顺序回归：非 ≥40 规则二次替换）', () => {
    // 45 位 base64 连续段 + '-' 尾巴：若 ≥40 规则先跑会把它替换为 [REDACTED] 并漏出 -bbb... 尾巴，
    // 只有 Bearer 规则先命中才得到干净的 `Bearer [REDACTED]`——真钉住规则顺序。
    const longToken = `${'a'.repeat(45)}-${'b'.repeat(29)}`
    expect(redactSensitiveValues(`auth: Bearer ${longToken}`)).toBe('auth: Bearer [REDACTED]')
  })
})
