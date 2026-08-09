import { isAbsolute, relative, resolve, sep } from 'path'

// 返回渲染根内绝对路径；非法（穿越/NUL/畸形百分比/双重解码）→ null。
// 注：URL pathname 恒以 '/' 开头，经 `'.' + rel` 归一为根相对（非"拒绝绝对路径"——
// '/' 前缀本就语义是根相对，真实越界由下面的 relative() 首段边界兜住）。
export function resolveRendererPath(rendererRoot: string, pathname: string): string | null {
  let rel: string
  try {
    rel = decodeURIComponent(pathname)
  } catch {
    return null // 孤立 % → 拒绝
  }
  if (rel.includes('\0')) return null // NUL 显式拒绝（不进 fs 层）
  const segs = rel.split('/')
  if (segs.some((s) => s === '..')) return null // 双重解码（%2e%2e）decode 后同样被此拒
  const candidate = resolve(rendererRoot, '.' + rel) // 前置 '.' → 相对；空 pathname → 渲染根
  const relToRoot = relative(rendererRoot, candidate)
  // 首段恰为 '..' 才算越界（字符串 startsWith('..') 会误杀根内 '..hidden' 等合法条目）
  const first = relToRoot.split(sep)[0]
  if (first === '..' || isAbsolute(relToRoot)) return null
  return candidate
}
