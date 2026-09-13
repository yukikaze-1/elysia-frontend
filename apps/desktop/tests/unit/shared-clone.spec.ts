// tests/unit/shared-clone.spec.ts
// 全仓唯一 cloneValue（src/shared/domain/clone.ts）的行为钉住。
// 抽取背景：本函数此前有 10 份拷贝，其中 character-catalog.store.ts 的那份是 Renderer 里唯一缺异常守卫的
// 实现，导致真机角色 revision 渲染崩溃（DataCloneError 逃逸渲染函数 → 消息列表坍缩）。
// 本 spec 既覆盖守卫语义，也覆盖 Main 侧原先没有守卫的调用形态。
import { describe, expect, it } from 'vitest'
import { reactive, ref, isProxy } from 'vue'
import { cloneValue } from '@shared/domain'

describe('shared cloneValue（JSON-safe 深拷贝，2026-09-10 抽取）', () => {
  it('纯数据：深拷贝且不等引用（改写副本不污染原对象）', () => {
    const source = { a: 1, nested: { b: [1, 2, 3] } }
    const copy = cloneValue(source)
    expect(copy).toEqual(source)
    expect(copy).not.toBe(source)
    expect(copy.nested).not.toBe(source.nested)
    copy.nested.b.push(4)
    expect(source.nested.b).toEqual([1, 2, 3])
  })

  it('Vue reactive Proxy：不抛错、返回非 Proxy 的纯快照（真实崩溃路径）', () => {
    const store = reactive({ presentation: { themeColor: '#fff', idleExpressions: ['a'] } })
    expect(isProxy(store)).toBe(true)
    expect(() => structuredClone(store)).toThrow()   // 前置事实：未加守卫时必然抛 DataCloneError
    const copy = cloneValue(store.presentation)
    expect(copy.themeColor).toBe('#fff')
    expect(copy.idleExpressions).toEqual(['a'])
    expect(isProxy(copy)).toBe(false)
    // 快照与原 Proxy 解耦
    copy.idleExpressions.push('b')
    expect(store.presentation.idleExpressions).toEqual(['a'])
  })

  it('Vue ref（.value 为对象）同样走守卫分支', () => {
    const r = ref({ list: [1, 2] })
    const copy = cloneValue(r.value)
    expect(copy).toEqual({ list: [1, 2] })
    expect(isProxy(copy)).toBe(false)
  })

  it('结构化克隆不可用时回退 JSON 快照（旧 Electron / 测试环境兼容）', () => {
    const original = globalThis.structuredClone
    try {
      // @ts-expect-error 测试替身：模拟 structuredClone 缺失
      delete globalThis.structuredClone
      const copy = cloneValue({ a: { b: 2 } })
      expect(copy).toEqual({ a: { b: 2 } })
    } finally {
      globalThis.structuredClone = original
    }
  })

  it('JSON 回退语义的已知边界：undefined 字段被丢弃（记录而非隐藏）', () => {
    const original = globalThis.structuredClone
    try {
      // @ts-expect-error 测试替身
      delete globalThis.structuredClone
      const copy = cloneValue({ keep: 1, drop: undefined })
      expect('drop' in copy).toBe(false)
    } finally {
      globalThis.structuredClone = original
    }
  })
})
