// tests/unit/layout-storage.spec.ts
// Task 5:布局记忆存储层（spec §4.5，决策 D6）——key cyrene.layout.v1、fail-safe、宽度 clamp、可注入 storage。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LAYOUT_CONSTANTS } from '../../src/renderer/src/layout/constants'
import {
  LAYOUT_STORAGE_KEY, readLayout, setLayoutStorageForTest, writeLayout, type LayoutStorageLike
} from '../../src/renderer/src/layout/layout-storage'

const C = LAYOUT_CONSTANTS
interface MockStorage extends LayoutStorageLike { store: Map<string, string> }
let storage: MockStorage

beforeEach(() => {
  storage = {
    store: new Map(),
    getItem: vi.fn((k: string) => storage.store.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => { storage.store.set(k, v) })
  }
  setLayoutStorageForTest(storage)
})
afterEach(() => setLayoutStorageForTest(null))

describe('layout-storage（D6，key cyrene.layout.v1）', () => {
  it('round-trip：writeLayout 后 readLayout 恢复同一偏好（含宽度 clamp）', () => {
    writeLayout({ conversationCollapsed: true, live2dVisible: false, live2dWidth: 380 }, C)
    expect(readLayout(C)).toEqual({ conversationCollapsed: true, live2dVisible: false, live2dWidth: 380 })
  })
  it('写越界宽度落盘前 clamp [300,420]', () => {
    writeLayout({ conversationCollapsed: false, live2dVisible: true, live2dWidth: 999 }, C)
    expect(JSON.parse(storage.store.get(LAYOUT_STORAGE_KEY)!)).toEqual({
      version: 1, conversationCollapsed: false, live2dVisible: true, live2dWidth: 420
    })
  })
  it('key 缺失 → 默认偏好', () => {
    expect(readLayout(C)).toEqual({ conversationCollapsed: false, live2dVisible: true, live2dWidth: 340 })
  })
  it('JSON 损坏 → 默认偏好（不抛错）', () => {
    storage.store.set(LAYOUT_STORAGE_KEY, '{broken')
    expect(() => readLayout(C)).not.toThrow()
    expect(readLayout(C)).toEqual({ conversationCollapsed: false, live2dVisible: true, live2dWidth: 340 })
  })
  it('version ≠ 1 → 默认偏好', () => {
    storage.store.set(LAYOUT_STORAGE_KEY, JSON.stringify({ version: 2, conversationCollapsed: true, live2dVisible: true, live2dWidth: 340 }))
    expect(readLayout(C)).toEqual({ conversationCollapsed: false, live2dVisible: true, live2dWidth: 340 })
  })
  it('字段形状非法 → 默认偏好', () => {
    storage.store.set(LAYOUT_STORAGE_KEY, JSON.stringify({ version: 1, conversationCollapsed: 'yes', live2dVisible: true, live2dWidth: 340 }))
    expect(readLayout(C)).toEqual({ conversationCollapsed: false, live2dVisible: true, live2dWidth: 340 })
  })
  it('宽度越界读入 clamp [300,420]', () => {
    storage.store.set(LAYOUT_STORAGE_KEY, JSON.stringify({ version: 1, conversationCollapsed: false, live2dVisible: true, live2dWidth: 50 }))
    expect(readLayout(C).live2dWidth).toBe(300)
  })
  it('写失败（setItem 抛错）→ 不抛、console.warn 非致命', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    storage.setItem = vi.fn(() => { throw new Error('QuotaExceeded') })
    expect(() => writeLayout({ conversationCollapsed: false, live2dVisible: true, live2dWidth: 340 }, C)).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
  it('读 getItem 抛错 → 默认偏好（不级联）', () => {
    storage.getItem = vi.fn(() => { throw new Error('SecurityError') })
    expect(() => readLayout(C)).not.toThrow()
    expect(readLayout(C)).toEqual({ conversationCollapsed: false, live2dVisible: true, live2dWidth: 340 })
  })
})
