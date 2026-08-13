// src/renderer/src/layout/layout-storage.ts
// 阶段 3 G1（spec §4.5，决策 D6）：布局记忆持久化 —— Renderer localStorage，key cyrene.layout.v1。
// fail-safe：读失败/版本不符/形状非法 → 默认；写失败 → console.warn 非致命（spec §4.9 场景1/2）。
// override（会话期）与 viewportWidth（运行时）不持久化。storage 可注入（单测，沿用 setDesktopApi 模式）。
import { LIVE2D_DEFAULT_WIDTH, type LayoutConstants } from './constants'
import { clampLive2dWidth, type LayoutPrefs } from './effective-layout'

export const LAYOUT_STORAGE_KEY = 'cyrene.layout.v1'

export interface LayoutStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface StoredLayoutV1 {
  version: 1
  conversationCollapsed: boolean
  live2dVisible: boolean
  live2dWidth: number
}

const DEFAULT_PREFS = (): LayoutPrefs => ({ conversationCollapsed: false, live2dVisible: true, live2dWidth: LIVE2D_DEFAULT_WIDTH })

function isBoolean(v: unknown): v is boolean { return typeof v === 'boolean' }

function parseStored(raw: string | null, constants: LayoutConstants): LayoutPrefs {
  if (raw === null) return DEFAULT_PREFS()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_PREFS()
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PREFS()
  const o = parsed as Record<string, unknown>
  if (o['version'] !== 1) return DEFAULT_PREFS()
  if (!isBoolean(o['conversationCollapsed']) || !isBoolean(o['live2dVisible']) ||
      typeof o['live2dWidth'] !== 'number' || !Number.isFinite(o['live2dWidth'])) {
    return DEFAULT_PREFS()
  }
  return {
    conversationCollapsed: o['conversationCollapsed'],
    live2dVisible: o['live2dVisible'],
    live2dWidth: clampLive2dWidth(o['live2dWidth'], constants)
  }
}

let injectedStorage: LayoutStorageLike | null = null
/** 单测注入（LayoutStorageLike 是完整 localStorage 子集）；传 null 恢复浏览器默认 */
export function setLayoutStorageForTest(storage: LayoutStorageLike | null): void { injectedStorage = storage }

function browserStorage(): LayoutStorageLike | null {
  if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
  return null
}

/** 读入布局偏好；任何失败回默认（fail-safe，不抛错、不级联） */
export function readLayout(constants: LayoutConstants): LayoutPrefs {
  const s = injectedStorage ?? browserStorage()
  if (!s) return DEFAULT_PREFS()
  let raw: string | null = null
  try {
    raw = s.getItem(LAYOUT_STORAGE_KEY)
  } catch {
    raw = null
  }
  return parseStored(raw, constants)
}

/** 落盘布局偏好；写入失败仅 console.warn，内存态继续可用 */
export function writeLayout(prefs: LayoutPrefs, constants: LayoutConstants): void {
  const s = injectedStorage ?? browserStorage()
  if (!s) return
  const payload: StoredLayoutV1 = {
    version: 1,
    conversationCollapsed: prefs.conversationCollapsed,
    live2dVisible: prefs.live2dVisible,
    live2dWidth: clampLive2dWidth(prefs.live2dWidth, constants)
  }
  try {
    s.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(payload))
  } catch (e) {
    console.warn('[layout] 布局偏好写 localStorage 失败（非致命）', e)
  }
}
