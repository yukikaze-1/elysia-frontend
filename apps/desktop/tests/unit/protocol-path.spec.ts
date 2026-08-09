import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveRendererPath } from '../../src/main/protocol/path'

// 平台无关根：Windows 下 path.resolve 会生成 C:\… 形态，期望值须用 path.join 派生而非硬编码正斜杠串
const ROOT = path.resolve('opt', 'cyrene', 'renderer')

describe('resolveRendererPath', () => {
  it('合法相对路径 → 渲染根内绝对路径', () => {
    expect(resolveRendererPath(ROOT, '/index.html')).toBe(path.join(ROOT, 'index.html'))
    expect(resolveRendererPath(ROOT, '/assets/app.js')).toBe(path.join(ROOT, 'assets', 'app.js'))
  })
  it('空 pathname（/）→ 渲染根本身（目录由 handler 映射 index.html）', () => {
    expect(resolveRendererPath(ROOT, '/')).toBe(ROOT)
    expect(resolveRendererPath(ROOT, '')).toBe(ROOT)
  })
  it('含 .. 段 → null', () => {
    expect(resolveRendererPath(ROOT, '/../etc/passwd')).toBeNull()
    expect(resolveRendererPath(ROOT, '/assets/../../etc/passwd')).toBeNull()
  })
  it('双重解码 %2e%2e → null（decode 后成 .. 段）', () => {
    expect(resolveRendererPath(ROOT, '/%2e%2e/etc/passwd')).toBeNull()
  })
  it('NUL 字节 → null', () => {
    expect(resolveRendererPath(ROOT, '/a%00b')).toBeNull()
  })
  it('孤立 % → null（decodeURIComponent 抛）', () => {
    expect(resolveRendererPath(ROOT, '/a%')).toBeNull()
  })
  it('任何 .. 段即使留在根内也拒绝（保守，不做路径归一放行）', () => {
    expect(resolveRendererPath(ROOT, '/assets/../index.html')).toBeNull()
  })
  it('containment 契约：候选恒经 relative() 判定，结构性免疫字符串前缀陷阱', () => {
    // '.' 前置 + relative()：/.. 段被显式拒；深路径仍限根内。
    // 字符串前缀包含（startsWith(root)）会误放行 renderer2 兄弟目录——本实现用 relative() 边界，
    // 该陷阱无可触发的 API 输入（从根只能向下），故用契约测试锚定语义，防未来重构改回字符串前缀比较。
    expect(resolveRendererPath(ROOT, '/deep/nested/asset.js')).toBe(path.join(ROOT, 'deep', 'nested', 'asset.js'))
    expect(resolveRendererPath(ROOT, '/a/../../b')).toBeNull()
  })
  it('根内 .. 前缀条目（如 ..hidden）不被误杀', () => {
    expect(resolveRendererPath(ROOT, '/..hidden/asset.js')).toBe(path.join(ROOT, '..hidden', 'asset.js'))
  })
})
