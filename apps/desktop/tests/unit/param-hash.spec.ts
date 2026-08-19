import { describe, expect, it } from 'vitest'
import { canonicalJsonStringify, computeParamHash } from '../../src/main/tools/param-hash'

describe('canonicalJsonStringify（D6B-22：递归键排序 + 紧凑分隔 + 非 ASCII 不转义）', () => {
  it('键序打乱 → 同产物', () => {
    const a = { b: 1, a: { d: 2, c: 3 } }
    expect(canonicalJsonStringify(a)).toBe('{"a":{"c":3,"d":2},"b":1}')
  })
  it('非 ASCII 原样（ensure_ascii=false 等价）', () => {
    expect(canonicalJsonStringify({ path: '笔记.md' })).toBe('{"path":"笔记.md"}')
  })
})
describe('computeParamHash（SHA-256 hex，D6B-22 固定向量写死，A-11）', () => {
  it('固定向量与后端 plugin.py canonical 产物一致', () => {
    // 权威向量（用后端 canonical 算法——递归键排序 + 紧凑 ,/: + 非 ASCII 不转义——本地实算后写死）
    expect(computeParamHash({ path: '/tmp/a.txt' })).toBe('548d0264343c1d2d510c941fa833479bca4ba541a9e46ba8051d883dc53cb41a')
    expect(computeParamHash({ b: 1, a: { d: 2, c: 3 } })).toBe('78d48859c3252943aab7306f76c80f3f07783582e05ab8f944ce0696f2dbfc67')
    expect(computeParamHash({ path: '笔记.md' })).toBe('eca509557dd035b394e527935c3dd5643eadcb9f0399bf8d60f0524967038174')
    // 同输入幂等
    expect(computeParamHash({ path: '/tmp/a.txt' })).toBe(computeParamHash({ path: '/tmp/a.txt' }))
  })
})
