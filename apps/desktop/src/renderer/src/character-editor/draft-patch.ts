// renderer/src/character-editor/draft-patch.ts
// 角色草稿的 JSON Pointer / dot-path 写入（无 Vue / 无 Pinia）。
//
// 为什么单独存在：这是一个**带安全守卫的通用写法**——路径分段解析（`~0`/`~1` 反转义）、
// 原型污染拒绝（`__proto__`/`prototype`/`constructor`）、数组越界拒绝、以及「只写自有属性」
// 纪律。此前它内嵌在 `character-editor.store.updateField` 里，只能经「整棵 Pinia + mock api +
// 假定时器」的 store 集成用例到达（582 行 spec 里没有一个用例直接打这些边界）。
//
// 依赖方向：本模块不 import store；`cloneValue` 来自共享域（同一份实现，避免第二套深拷贝）。
import { cloneValue } from '@shared/domain'

/** 路径里不得出现的原型属性名（原型污染防线）。 */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

/**
 * 解析路径。
 *
 * 以 `/` 开头视为 RFC 6901 JSON Pointer（`~1` → `/`、`~0` → `~`，顺序承重：先 `~1` 后 `~0`，
 * 反过来会把 `~01` 错解成 `/`）；否则按 `.` 分段。
 * 任一分段为空或命中原型属性名 ⇒ 返回 undefined（调用方拒绝整次写入）。
 */
export function parseDraftPath(path: string): string[] | undefined {
  const segments = path.startsWith('/')
    ? path.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    : path.split('.')
  if (segments.length === 0) return undefined
  if (segments.some((part) => !part || FORBIDDEN_SEGMENTS.has(part))) return undefined
  return segments
}

function isObjectLike(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null
}

/**
 * 就地写入一条路径，返回**新的**草稿对象；路径非法/越界/叶子不是自有属性时返回 `undefined`
 * （调用方据此**完全不改动**草稿，而不是半写入）。
 *
 * 写入的值经 `cloneValue`：调用方传入的可能是响应式代理或将被复用的对象，直接存引用会让
 * 之后的编辑穿透到草稿之外。
 */
export function applyDraftPatch<T extends object>(draft: T, path: string, value: unknown): T | undefined {
  const segments = parseDraftPath(path)
  if (!segments) return undefined
  const next = cloneValue(draft) as unknown as Record<string, unknown>
  let target: Record<string, unknown> | unknown[] = next
  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index]
    const child: Record<string, unknown> | unknown[] | undefined = Array.isArray(target)
      ? arrayChild(target, segment)
      : objectChild(target, segment)
    if (child === undefined) return undefined
    target = child
  }
  const leaf = segments[segments.length - 1]
  if (Array.isArray(target)) {
    const arrayIndex = arrayIndexOrUndefined(target, leaf)
    if (arrayIndex === undefined) return undefined
    target[arrayIndex] = cloneValue(value)
  } else {
    // 只写**自有**属性：`in` / 原型链上的键会让一次表单写入悄悄落到继承属性上。
    if (!Object.prototype.hasOwnProperty.call(target, leaf)) return undefined
    target[leaf] = cloneValue(value)
  }
  return next as unknown as T
}

function arrayChild(target: unknown[], segment: string): Record<string, unknown> | unknown[] | undefined {
  const index = arrayIndexOrUndefined(target, segment)
  if (index === undefined) return undefined
  const child = target[index]
  return isObjectLike(child) ? child : undefined
}

function objectChild(target: Record<string, unknown>, segment: string): Record<string, unknown> | unknown[] | undefined {
  const child = target[segment]
  return isObjectLike(child) ? child : undefined
}

function arrayIndexOrUndefined(target: unknown[], segment: string): number | undefined {
  const index = Number(segment)
  if (!Number.isSafeInteger(index) || index < 0 || index >= target.length) return undefined
  return index
}
