// tests/unit/font-scale-tokens.spec.ts
// 「全局字体缩放」的判别力门禁（2026-09-13，doc 03 §12.4 / doc 11 §7.2）。
//
// 为什么用源码扫描：本项落地前的实测是——`--cy-user-font-scale` **早已定义、也早已被 body 消费**，
// 但 renderer 的 323 处 `font-size` 里 308 处引用的是**绝对 px** 的 `--cy-font-*` token，
// 组件显式字号覆盖 body 继承，所以"给这个变量赋值"**视觉上几乎无效**。
// 于是本项的实质是"让整条阶梯自己乘这个变量"，而它极容易被后续任何一次编辑破坏：
//   - 新增一个写死 px 的 token 或组件字号 ⇒ 那一处不跟着缩放（用户看到"有的字变大了、有的没变"）；
//   - 有人"顺手"把 body 改回 `calc(var(--cy-font-base) * var(--cy-user-font-scale))` ⇒ **双重缩放**（130% 变 169%）。
// 这类退化在功能测试里全是绿的（字号确实"变了"），故必须直接钉住源码。
//
// 规则（2026-09-13 基线，全部 0 违规、例外表为空）：
//   ① tokens.css 里每个 `--cy-font-*` 定义都必须乘 `--cy-user-font-scale`；
//   ② renderer 源码（.vue/.css）里不得出现裸 `font-size: <N>px`；
//   ③ 任何 `font-size` 声明不得同时出现 `--cy-font-base` 与该缩放变量（双重缩放）。
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const RENDERER_DIR = join(__dirname, '../../src/renderer/src')
const TOKENS = join(RENDERER_DIR, 'tokens.css')
const SCALE_VAR = '--cy-user-font-scale'

/** 例外表（当前为空）。非空必须写清理由：为什么这一处字号**不应该**跟随用户缩放。 */
const BARE_PX_EXCEPTIONS: Record<string, string> = {}

interface SourceFile { rel: string; text: string }

/** 遍历 renderer 源码（.vue / .css；.ts 无字号声明——实测） */
function scanRenderer(): SourceFile[] {
  const files: SourceFile[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!name.endsWith('.vue') && !name.endsWith('.css')) continue
      const rel = relative(RENDERER_DIR, full).split(sep).join('/')
      files.push({ rel, text: readFileSync(full, 'utf8') })
    }
  }
  walk(RENDERER_DIR)
  return files
}

const FILES = scanRenderer()
const TOKENS_TEXT = readFileSync(TOKENS, 'utf8')

/** 取每行等号左边的 token 名（`--cy-font-xs: calc(...)` → `--cy-font-xs`） */
function fontTokenLines(text: string): Array<{ line: number; name: string; value: string }> {
  const out: Array<{ line: number; name: string; value: string }> = []
  text.split('\n').forEach((raw, i) => {
    const m = /^\s*(--cy-font-[a-z0-9-]+)\s*:\s*(.+?);/.exec(raw)
    if (m) out.push({ line: i + 1, name: m[1], value: m[2] })
  })
  return out
}

describe('字体缩放：token 阶梯（规则 ①）', () => {
  it('tokens.css 里每个 --cy-font-* 定义都乘 --cy-user-font-scale', () => {
    const tokens = fontTokenLines(TOKENS_TEXT)
    expect(tokens.length, '退化哨兵：解析不到字号 token 说明本用例的解析器失效了').toBeGreaterThanOrEqual(5)
    const notScaled = tokens.filter((t) => !t.value.includes(SCALE_VAR))
    expect(
      notScaled.map((t) => `${t.name}（tokens.css:${t.line}）= ${t.value}`),
      '以下字号 token 不跟随用户缩放——用户会看到"有的字变大了、有的没变"'
    ).toEqual([])
  })

  it('缩放变量本身有且只有一个默认定义（值 1），由渲染层在根节点覆盖', () => {
    const defs = TOKENS_TEXT.split('\n')
      .map((l, i) => ({ line: i + 1, m: /^\s*(--cy-user-font-scale)\s*:\s*(.+?);/.exec(l) }))
      .filter((d) => d.m !== null)
    expect(defs.length, `${SCALE_VAR} 必须**恰好**定义一次（多写一处会让覆盖顺序变得不可推理）`).toBe(1)
    expect(defs[0].m![2]).toBe('1')
  })
})

describe('字体缩放：不得写死 px（规则 ②）', () => {
  it('renderer 源码里没有裸 font-size: <N>px（例外表为空）', () => {
    const offenders: string[] = []
    for (const f of FILES) {
      f.text.split('\n').forEach((line, i) => {
        if (!/font-size:\s*\d+(\.\d+)?px/.test(line)) return
        if (BARE_PX_EXCEPTIONS[f.rel] !== undefined) return
        offenders.push(`${f.rel}:${i + 1}`)
      })
    }
    expect(offenders, '裸 px 字号不跟随用户缩放（doc 2026-08-29-UI精修整改清单 §红线：不得用固定 px 绕过字号缩放）').toEqual([])
  })
})

describe('字体缩放：不得双重缩放（规则 ③）', () => {
  it('没有任何 font-size 声明同时引用 --cy-font-base 与缩放变量', () => {
    const offenders: string[] = []
    for (const f of FILES) {
      f.text.split('\n').forEach((line, i) => {
        if (!/font-size\s*:/.test(line)) return
        if (line.includes('--cy-font-base') && line.includes(SCALE_VAR)) offenders.push(`${f.rel}:${i + 1}`)
      })
    }
    expect(offenders, '--cy-font-base 已经乘过缩放变量，再乘一次会把 130% 变成 169%').toEqual([])
  })
})
