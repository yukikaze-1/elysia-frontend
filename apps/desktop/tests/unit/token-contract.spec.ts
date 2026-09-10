// tests/unit/token-contract.spec.ts（多套 UI 基础，2026-09-10）
//
// 目的：把 tokens.css 从「一份约定」变成「一条门禁」。
//
// 背景（审计实测）：tokens.css 开篇即声明「这是 UI 的视觉契约……组件不得另起颜色」，
// 但此前有 5 个 token 被组件引用、却从未定义（--cy-accent-weak / --cy-danger-text /
// --cy-diff-add / --cy-diff-del / --cy-warning-text），组件一律以
// `var(--cy-x, <硬编码色>)` 兜底——即这些颜色实际游离在 token 体系之外，换肤必然漏改。
// 这类缺陷靠人工审查抓不住（视觉上看不出差别），必须由测试强制。
//
// 本文件三条契约：
//   ① 组件引用的任何 --cy-* 必须在 tokens.css 定义（否则引用落空 → 落回兜底/继承色）；
//   ② 组件不得自带 --cy-* 定义（避免局部覆盖 token，使皮肤不可预测）；
//   ③ 组件不得为 token 引用提供兜底值（`var(--cy-x, …)`）——兜底即「这个 token 可能不存在」，
//      等于把颜色决策从 tokens.css 挪回组件，破坏换肤单点。
//
// 节点环境（默认）：直接读源码文本，不挂载组件。
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const RENDERER = join(__dirname, '../../src/renderer/src')
const TOKENS_FILE = join(RENDERER, 'tokens.css')

/** 递归收集 .vue / .css 文件（组件与样式面） */
function collectStyleFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      // Live2D 为 vendored 第三方运行时，其样式不属本契约
      if (entry === 'live2d' || entry === 'public') continue
      out.push(...collectStyleFiles(full))
    } else if (entry.endsWith('.vue') || entry.endsWith('.css')) {
      out.push(full)
    }
  }
  return out
}

const styleFiles = collectStyleFiles(RENDERER)
const tokenSource = readFileSync(TOKENS_FILE, 'utf8')

/** 剥掉 CSS 注释：否则注释里举例说明的 `var(--cy-x, …)` 会被当成真实引用污染判定 */
function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * 运行时由 :style 注入的自定义属性——语义是「运行时数值」而非「视觉决策」，
 * 不属于皮肤覆写面，故豁免契约 ①/②。
 */
const RUNTIME_INJECTED = new Set(['--cy-public-mood-intensity'])

/** tokens.css 中定义的 token 名（`--cy-foo:`） */
const definedTokens = new Set(
  [...stripCssComments(tokenSource).matchAll(/(--cy-[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
)

describe('token 契约：tokens.css 是视觉决策的单点', () => {
  it('tokens.css 自身可解析且定义了基础 token（防解析失效导致后两条空过）', () => {
    expect(definedTokens.size).toBeGreaterThan(20)
    expect(definedTokens.has('--cy-surface')).toBe(true)
    expect(definedTokens.has('--cy-text')).toBe(true)
  })

  it('① 组件引用的每个 --cy-* 都在 tokens.css 定义（引用不得落空）', () => {
    const unresolved: string[] = []
    for (const file of styleFiles) {
      const source = stripCssComments(readFileSync(file, 'utf8'))
      for (const m of source.matchAll(/var\(\s*(--cy-[a-z0-9-]+)/g)) {
        if (RUNTIME_INJECTED.has(m[1])) continue
        if (!definedTokens.has(m[1])) unresolved.push(`${file.replace(RENDERER, '')} → ${m[1]}`)
      }
    }
    expect([...new Set(unresolved)].sort()).toEqual([])
  })

  it('② 组件不得自带 --cy-* 定义（皮肤只在 tokens.css 覆写）', () => {
    const offenders: string[] = []
    for (const file of styleFiles) {
      if (file === TOKENS_FILE) continue
      const source = stripCssComments(readFileSync(file, 'utf8'))
      for (const m of source.matchAll(/(--cy-[a-z0-9-]+)\s*:/g)) {
        if (RUNTIME_INJECTED.has(m[1])) continue
        offenders.push(`${file.replace(RENDERER, '')} → ${m[1]}`)
      }
    }
    expect([...new Set(offenders)].sort()).toEqual([])
  })

  it('③ 组件不得为 token 引用提供兜底值（var(--cy-x, …)）', () => {
    const fallbacks: string[] = []
    for (const file of styleFiles) {
      if (file === TOKENS_FILE) continue
      const source = stripCssComments(readFileSync(file, 'utf8'))
      // var(--cy-x,  <非空>  )：逗号后必须紧跟 `)` 才算无兜底
      for (const m of source.matchAll(/var\(\s*(--cy-[a-z0-9-]+)\s*,\s*([^)]*)/g)) {
        if (m[2].trim() !== '') fallbacks.push(`${file.replace(RENDERER, '')} → ${m[1]} 兜底「${m[2].trim()}」`)
      }
    }
    expect(fallbacks.sort()).toEqual([])
  })

  it('豁免集合本身是有效的（防豁免名单被滥用/写错后空过）', () => {
    const source = readFileSync(join(RENDERER, 'components/CyCharacterPublicState.vue'), 'utf8')
    for (const name of RUNTIME_INJECTED) {
      expect(source, `${name} 应在组件中以 :style 注入`).toContain(name)
    }
  })
})
