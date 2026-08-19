import { describe, expect, it } from 'vitest'
import { computeTextDiff, detectTextFormat, normalizeToFormat } from '../../src/main/tools/text-diff'

describe('computeTextDiff', () => {
  it('行级新增/删除/上下文', () => {
    const d = computeTextDiff('a\nb\n', 'a\nc\n')
    expect(d.lines.filter(l => l.kind === 'added').map(l => l.text)).toContain('c\n')
    expect(d.added).toBe(1); expect(d.removed).toBe(1)
  })
  it('100 行截断（MAX_DIFF_LINES）', () => {
    const old_ = Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n')
    const d = computeTextDiff(old_, old_ + '\nx')
    expect(d.truncated).toBe(true)
  })
})
describe('detectTextFormat / normalizeToFormat（D6B-19/L-2 拆行段重拼）', () => {
  it('CRLF 检测与往返无损', () => {
    const fmt = detectTextFormat('a\r\nb\r\n')
    expect(fmt.eol).toBe('crlf'); expect(fmt.endsWithNewline).toBe(true)
    const out = normalizeToFormat('a\nb', fmt)
    expect(out).toBe('a\r\nb\r\n')     // 拆行段重拼，无 \r\r\n
  })
  it('BOM 保留', () => { expect(detectTextFormat('﻿a\n').hasBom).toBe(true) })
})
