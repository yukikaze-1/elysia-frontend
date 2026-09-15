// tests/unit/file-ref.spec.ts
// S5-B2（2026-09-15，H-01 结构性修法）：不可猜文件引用表（`main/attachments/file-ref.ts`）。
//
// 这张表是附件链的**信任锚**：Main 自己签发 token、自己保存 path，对端只能引用表里已有的条目。
// 故本文件钉的是三条对外承诺——**不可猜**、**会过期**、**有界**——外加一条结构性承诺：
// token 与路径之间没有可计算关系（不是哈希，不能从 token 反推路径）。
import { describe, expect, it } from 'vitest'
import { createFileRefRegistry, FILE_REF_MAX, FILE_REF_TTL_MS } from '../../src/main/attachments/file-ref'

/** 可控时钟（过期用例不睡真实时间） */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

describe('createFileRefRegistry（S5-B2）', () => {
  it('issue → resolve 往返拿到原路径', () => {
    const r = createFileRefRegistry()
    const ref = r.issue('/home/me/Documents/a.png')
    expect(r.resolve(ref)).toBe('/home/me/Documents/a.png')
    expect(r.size()).toBe(1)
  })

  it('未知 token → undefined（不抛错，由调用方 fail-closed）', () => {
    const r = createFileRefRegistry()
    r.issue('/home/me/a.png')
    expect(r.resolve('fileref_forged')).toBeUndefined()
    expect(r.resolve('')).toBeUndefined()
    expect(r.resolve('/home/me/a.png'), 'token 与路径不同域——直接用路径当 token 必须解析不到').toBeUndefined()
  })

  it('token 不可猜且不与路径同构：两次登记同路径得到不同 token，且都不含路径片段', () => {
    const r = createFileRefRegistry()
    const a = r.issue('/home/me/a.png')
    const b = r.issue('/home/me/a.png')
    expect(a).not.toBe(b)
    for (const ref of [a, b]) {
      expect(ref).toMatch(/^fileref_[0-9a-f]{64}$/)   // 32 字节 CSPRNG hex
      expect(ref).not.toContain('home')
      expect(ref).not.toContain('a.png')
    }
  })

  it('TTL 到期 → resolve 返回 undefined 并顺手删除条目', () => {
    const c = clock()
    const r = createFileRefRegistry({ ttlMs: 1000, now: c.now })
    const ref = r.issue('/home/me/a.png')
    c.advance(999)
    expect(r.resolve(ref), '未到期必须仍可解析').toBe('/home/me/a.png')
    c.advance(2)   // 累计 1001 > 1000
    expect(r.resolve(ref), '过期即失效').toBeUndefined()
    expect(r.size(), '过期条目在解析时被清除').toBe(0)
  })

  it('容量有界：超过 max 逐出**最旧**条目（新条目仍可解析）', () => {
    const r = createFileRefRegistry({ max: 3 })
    const refs = [r.issue('/p/1'), r.issue('/p/2'), r.issue('/p/3')]
    expect(r.size()).toBe(3)
    const newest = r.issue('/p/4')
    expect(r.size(), '插入后仍不超过上限').toBe(3)
    expect(r.resolve(refs[0]), '最旧的被逐出').toBeUndefined()
    expect(r.resolve(refs[1])).toBe('/p/2')
    expect(r.resolve(newest)).toBe('/p/4')
  })

  it('默认上限与 TTL 是常量（防有人把它们改成无界）', () => {
    expect(FILE_REF_MAX).toBeGreaterThan(0)
    expect(FILE_REF_MAX).toBeLessThanOrEqual(4096)
    expect(FILE_REF_TTL_MS).toBeGreaterThan(0)
    expect(FILE_REF_TTL_MS).toBeLessThanOrEqual(60 * 60 * 1000)
  })

  it('clear 清空全部（断线重连语义：token 不跨连接复用）', () => {
    const r = createFileRefRegistry()
    const ref = r.issue('/home/me/a.png')
    r.clear()
    expect(r.size()).toBe(0)
    expect(r.resolve(ref)).toBeUndefined()
  })
})
