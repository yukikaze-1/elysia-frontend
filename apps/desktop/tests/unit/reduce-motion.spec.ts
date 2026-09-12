// tests/unit/reduce-motion.spec.ts
//
// M-24（2026-09-12，全量评审）：`prefers-reduced-motion` 零支持 + 项目自有「减少动态」开关只管
// Live2D、不管 CSS 动画。本文件两部分：
//   ① 门控逻辑（真值表、落类、媒体查询订阅/退订、老式 API 兼容）；
//   ② **覆盖完整性防漂移门禁**——扫描 `src/renderer/src` 下每一处 `animation: … infinite`，
//      要求全部被 `reduced-motion.css` 覆盖（且反向不留过期条目）。M-24 的成因就是「新加动画
//      时没人记得同步门控」，故这条门禁是本次修复的承重部分，而不只是"顺手加的测试"。
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  REDUCE_MOTION_CLASS,
  REDUCE_MOTION_QUERY,
  createReduceMotionGate,
  shouldReduceMotion,
  type ReduceMotionMedia,
  type ReduceMotionRoot
} from '../../src/renderer/src/utils/reduce-motion'

const DESKTOP_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const RENDERER_SRC = join(DESKTOP_ROOT, 'src/renderer/src')
const OVERRIDE_CSS = join(RENDERER_SRC, 'reduced-motion.css')

/** 注释字符替换为空格、**保留换行**：剥离后与原文等长，故行号可直接由索引换算（上一批踩过：用去掉注释的文本算行号会指错行） */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

function fakeRoot(): { classes: Set<string>; root: ReduceMotionRoot } {
  const classes = new Set<string>()
  return {
    classes,
    root: {
      classList: {
        toggle(token: string, force: boolean): void {
          if (force) classes.add(token)
          else classes.delete(token)
        }
      }
    }
  }
}

function fakeMedia(matches: boolean): { media: ReduceMotionMedia; listeners: Array<() => void>; emit: () => void } {
  const listeners: Array<() => void> = []
  return {
    listeners,
    emit: (): void => { for (const l of [...listeners]) l() },
    media: {
      matches,
      addEventListener: (_type, listener) => { listeners.push(listener) },
      removeEventListener: (_type, listener) => {
        const i = listeners.indexOf(listener)
        if (i >= 0) listeners.splice(i, 1)
      }
    }
  }
}

describe('M-24 减少动态门控', () => {
  it('真值表：系统偏好与自有开关任一为真即减少动态', () => {
    expect(shouldReduceMotion(false, false)).toBe(false)
    expect(shouldReduceMotion(true, false)).toBe(true)
    expect(shouldReduceMotion(false, true)).toBe(true)
    expect(shouldReduceMotion(true, true)).toBe(true)
  })

  it('系统偏好开启即落根类（自有开关关闭时同样生效）', () => {
    const { classes, root } = fakeRoot()
    const gate = createReduceMotionGate({ root, media: fakeMedia(true).media, readSetting: () => false })
    expect(gate.sync()).toBe(true)
    expect(classes.has(REDUCE_MOTION_CLASS)).toBe(true)
  })

  it('自有「减少动态」开关开启即落根类（不再只管 Live2D）', () => {
    const { classes, root } = fakeRoot()
    const gate = createReduceMotionGate({ root, media: fakeMedia(false).media, readSetting: () => true })
    expect(gate.sync()).toBe(true)
    expect(classes.has(REDUCE_MOTION_CLASS)).toBe(true)
  })

  it('两者都关闭时不落类（缺陷形态之一：无条件关掉动画）', () => {
    const { classes, root } = fakeRoot()
    const gate = createReduceMotionGate({ root, media: fakeMedia(false).media, readSetting: () => false })
    expect(gate.sync()).toBe(false)
    expect(classes.has(REDUCE_MOTION_CLASS)).toBe(false)
  })

  it('系统偏好运行时变化会重算（切换后无需重启应用）', () => {
    const { classes, root } = fakeRoot()
    const { media, emit, listeners } = fakeMedia(false)
    const gate = createReduceMotionGate({ root, media, readSetting: () => false })
    gate.sync()
    expect(classes.has(REDUCE_MOTION_CLASS)).toBe(false)
    expect(listeners.length).toBe(1)
    media.matches = true
    emit()
    expect(classes.has(REDUCE_MOTION_CLASS)).toBe(true)
    media.matches = false
    emit()
    expect(classes.has(REDUCE_MOTION_CLASS)).toBe(false)
  })

  it('dispose 后不再响应变化，且退订与幂等可查（不留静默监听）', () => {
    const { classes, root } = fakeRoot()
    const { media, emit, listeners } = fakeMedia(false)
    const gate = createReduceMotionGate({ root, media, readSetting: () => false })
    gate.sync()
    gate.dispose()
    expect(gate.isDisposed()).toBe(true)
    expect(listeners.length).toBe(0)
    media.matches = true
    emit()
    expect(classes.has(REDUCE_MOTION_CLASS)).toBe(false)
    expect(() => gate.dispose()).not.toThrow() // 幂等
  })

  it('兼容只有 addListener/removeListener 的老式 MediaQueryList', () => {
    const { classes, root } = fakeRoot()
    const listeners: Array<() => void> = []
    const media: ReduceMotionMedia = {
      matches: false,
      addListener: (l) => { listeners.push(l) },
      removeListener: (l) => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1) }
    }
    const gate = createReduceMotionGate({ root, media, readSetting: () => false })
    gate.sync()
    expect(listeners.length).toBe(1)
    media.matches = true
    for (const l of [...listeners]) l()
    expect(classes.has(REDUCE_MOTION_CLASS)).toBe(true)
    gate.dispose()
    expect(listeners.length).toBe(0)
  })
})

describe('M-24 覆盖完整性门禁（漏一处持续动画即红）', () => {
  /** 递归收集 renderer 源码下的 .vue 与 .css */
  function collectFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...collectFiles(full))
      else if (entry.name.endsWith('.vue') || entry.name.endsWith('.css')) out.push(full)
    }
    return out
  }

  /** 取出 .vue 的 `<style>` 块（含起始行号）；.css 整体视作一个块 */
  function styleBlocks(file: string): Array<{ text: string; startLine: number }> {
    const raw = readFileSync(file, 'utf8')
    if (file.endsWith('.css')) return [{ text: raw, startLine: 1 }]
    const blocks: Array<{ text: string; startLine: number }> = []
    const re = /<style[^>]*>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(raw)) !== null) {
      const from = m.index + m[0].length
      const to = raw.indexOf('</style>', from)
      if (to < 0) continue
      blocks.push({ text: raw.slice(from, to), startLine: raw.slice(0, from).split('\n').length })
    }
    return blocks
  }

  /** 扫描所有含 `animation: … infinite` 的规则 → 选择器 + 位置 */
  function infiniteRules(): Array<{ file: string; line: number; selector: string }> {
    const hits: Array<{ file: string; line: number; selector: string }> = []
    for (const file of collectFiles(RENDERER_SRC)) {
      if (file.endsWith('reduced-motion.css')) continue
      for (const block of styleBlocks(file)) {
        const css = stripComments(block.text)
        const rule = /([^{}]+)\{([^{}]*)\}/g
        let m: RegExpExecArray | null
        while ((m = rule.exec(css)) !== null) {
          if (!/\banimation\s*:[^;}]*\binfinite\b/.test(m[2])) continue
          const line = block.startLine + css.slice(0, m.index).split('\n').length - 1
          for (const selector of m[1].split(',')) {
            const trimmed = selector.trim()
            if (trimmed) hits.push({ file: relative(DESKTOP_ROOT, file), line, selector: trimmed })
          }
        }
      }
    }
    return hits
  }

  /** reduced-motion.css 里 `animation: none` 规则覆盖的选择器（去掉 `html.<class> ` 前缀后的形态） */
  function overrideSelectors(): string[] {
    const css = stripComments(readFileSync(OVERRIDE_CSS, 'utf8'))
    const out: string[] = []
    const rule = /([^{}]+)\{([^{}]*)\}/g
    let m: RegExpExecArray | null
    while ((m = rule.exec(css)) !== null) {
      if (!/\banimation\s*:\s*none\b/.test(m[2])) continue
      for (const selector of m[1].split(',')) {
        const trimmed = selector.trim()
        if (trimmed) out.push(trimmed.replace(`html.${REDUCE_MOTION_CLASS} `, ''))
      }
    }
    return out
  }

  it('门控类名与媒体查询常量没有漂移（改常量却忘了改 CSS 会静默失效）', () => {
    const css = readFileSync(OVERRIDE_CSS, 'utf8')
    expect(css).toContain(`html.${REDUCE_MOTION_CLASS} `)
    expect(REDUCE_MOTION_QUERY).toBe('(prefers-reduced-motion: reduce)')
  })

  it('扫描器仍是活的（退化哨兵：已知至少有 6 处持续动画）', () => {
    const hits = infiniteRules()
    expect(hits.length, `扫描到的持续动画：${JSON.stringify(hits)}`).toBeGreaterThanOrEqual(6)
  })

  it('每一处持续动画都被 reduced-motion.css 覆盖', () => {
    const covered = new Set(overrideSelectors())
    const missing = infiniteRules().filter((hit) => !covered.has(hit.selector))
    expect(
      missing,
      `以下持续动画未被「减少动态」门控覆盖（新增动画时必须同步加进 reduced-motion.css）：${JSON.stringify(missing)}`
    ).toEqual([])
  })

  it('reduced-motion.css 里没有已失效的选择器（防止规则指向不存在的动画）', () => {
    const live = new Set(infiniteRules().map((hit) => hit.selector))
    const stale = overrideSelectors().filter((selector) => !live.has(selector))
    expect(stale, `以下覆盖规则已无对应动画，应删除：${JSON.stringify(stale)}`).toEqual([])
  })
})
