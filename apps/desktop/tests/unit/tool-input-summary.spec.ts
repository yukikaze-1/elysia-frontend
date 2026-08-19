import { describe, expect, it } from 'vitest'
import { redactToolArguments } from '../../src/main/tools/input-summary'

describe('redactToolArguments（Task 4 / F-6-04，镜像后端 _safe_arg_summary）', () => {
  it('敏感 13 键（含大小写）恒 <redacted>', () => {
    const keys = ['token', 'Key', 'password', 'secret', 'authorization', 'cookie', 'content', 'prompt', 'path', 'base_url', 'URL', 'query', 'api_key']
    const input = Object.fromEntries(keys.map((k) => [k, 'secret-value']))
    const out = redactToolArguments(input)
    expect(out).toBe(keys.map((k) => `${k}=<redacted>`).join(', '))
  })
  it('deny-by-default：普通字符串只记 <str:N>；数字/布尔/对象/数组/null 按类型', () => {
    expect(redactToolArguments({ message: '你好世界' })).toBe('message=<str:4>')
    expect(redactToolArguments({ n: 42, ok: true, o: { a: 1 }, arr: [1], nil: null })).toBe('n=<number>, ok=<boolean>, o=<dict>, arr=<list>, nil=<NoneType>')
  })
  it('空 dict → undefined；多字段拼接用 ", "', () => {
    expect(redactToolArguments({})).toBeUndefined()
    expect(redactToolArguments({ a: 'x', b: 1 })).toBe('a=<str:1>, b=<number>')
  })
})
