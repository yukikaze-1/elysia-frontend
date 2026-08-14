// tests/unit/recent-emoji.spec.ts
// Task 16:最近 Emoji localStorage 纯函数（spec §4.6，D7）——去重置前、上限 24、非法值容错。
// env=node：注入假 storage，无 localStorage 全局。
import { describe, expect, it } from 'vitest'
import { loadRecentEmoji, RECENT_EMOJI_KEY, recordEmoji, saveRecentEmoji } from '../../src/renderer/src/utils/recent-emoji'

function fakeStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> {
  const map = new Map(Object.entries(initial))
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v) } }
}

describe('recordEmoji（去重置前 + 上限）', () => {
  it('新 emoji 置前，旧项后移', () => {
    expect(recordEmoji(['a', 'b'], 'c')).toEqual(['c', 'a', 'b'])
  })
  it('已存在 emoji → 提到最前（去重）', () => {
    expect(recordEmoji(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
  })
  it('超上限截断到 24', () => {
    const recent = Array.from({ length: 24 }, (_, i) => `e${i}`)
    const next = recordEmoji(recent, 'new')
    expect(next).toHaveLength(24)
    expect(next[0]).toBe('new')
  })
})

describe('loadRecentEmoji / saveRecentEmoji', () => {
  it('空 storage → 空数组；解析非法 JSON → 空数组', () => {
    expect(loadRecentEmoji(fakeStorage())).toEqual([])
    expect(loadRecentEmoji(fakeStorage({ [RECENT_EMOJI_KEY]: 'not-json' }))).toEqual([])
  })
  it('round-trip：save 后 load 一致', () => {
    const storage = fakeStorage()
    saveRecentEmoji(['a', 'b'], storage)
    expect(loadRecentEmoji(storage)).toEqual(['a', 'b'])
  })
  it('非字符串元素丢弃', () => {
    const storage = fakeStorage({ [RECENT_EMOJI_KEY]: JSON.stringify(['a', 1, null]) })
    expect(loadRecentEmoji(storage)).toEqual(['a'])
  })
})
