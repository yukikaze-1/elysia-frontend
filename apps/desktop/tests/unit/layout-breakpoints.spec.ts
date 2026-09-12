// tests/unit/layout-breakpoints.spec.ts
// M-23（2026-09-12，P2-7）：**不可达窄窗媒体查询**的回归门禁。
//
// 背景（评审 M-23，已实测复现）：窗口硬最小宽度是 1100px（renderer 常量 MIN_WINDOW_WIDTH，
// 执行点 src/main/windows/main-window.ts 的 minWidth），所以 renderer 视口恒 ≥ 约 1084px。
// 但仓库里曾有 10 处 `@media (max-width: 560/680/720/760px)` —— **永远不可能匹配**：
// 它们不产生任何效果，却让代码和文档看起来"响应式分层已实现"。同一批次删除了 `layout/constants.ts`
// 的 `BREAKPOINTS`（只被自身定义与 spec 断言引用），并留了书面说明（见该文件"响应式分层现状"注释）。
//
// 本门禁的判据**只用真实常量** `MIN_WINDOW_WIDTH`：数值改了，判据自动跟着改；
// 任何 `max-width < MIN_WINDOW_WIDTH` 的媒体查询都是死代码，必须在实现真正的窄窗分层之前消失。
//
// 说明：比较对象是最小**窗口**宽度而非最小**视口**宽度。窗口宽度是 1100，视口还要再减去标题栏/边框
// （约 1084），故 `max-width === MIN_WINDOW_WIDTH` 在真机上同样不匹配。本门禁只拦"必然不可达"
// （严格小于）——这是能由常量唯一确定的部分，也正好是 M-23 那 10 处的形态；等号这一档留给实机验证。
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { MIN_WINDOW_WIDTH } from '../../src/renderer/src/layout/constants'

const DESKTOP_ROOT = join(__dirname, '../..')
const RENDERER_SRC = join(DESKTOP_ROOT, 'src/renderer/src')

/** vendored / 非本项目编写的资源目录：其样式不属本契约（与 token-contract.spec.ts 同一豁免口径） */
const SKIP_DIRS = new Set(['live2d', 'public'])

/** 递归收集 renderer 的 .vue / .css（**全部**样式面：媒体查询可以出现在任何组件里） */
function collectStyleFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) collectStyleFiles(full, out)
      continue
    }
    if (entry.endsWith('.vue') || entry.endsWith('.css')) out.push(full)
  }
  return out
}

/**
 * 剥掉 CSS 注释：注释里写到的 `@media (max-width: …)` 例子不算真实声明（避免假红）。
 *
 * **注释内容用空格替换而非删除**：删除会把多行注释压成 0 行，导致后面的偏移量整体前移、
 * 报出的行号与真实行不对应——本门禁自己的"行号定位"自检就是这样抓到这个 bug 的
 * （植入一个 680px 查询后，报出的行指向了 `<style scoped>` 而不是 `@media` 那行）。
 * 保留换行才能让 `lineAt` 给出**原文件**的行号，报错才指得准。
 */
function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
}

/**
 * 判据正则：`max-width: <N>px`。
 * `(?<![\w-])` 挡住 `--max-width`、`inline-max-width` 之类的自定义属性名；`i` 让 `MAX-WIDTH`（合法 CSS
 * 属性名大小写不敏感）同样被认出；显式 `px` 后缀使 `40em` / 无单位数值被忽略。
 *
 * 注意：这个正则**只识别声明形态**，是否位于 `@media` 前奏由 extractMaxWidths 负责（见下）。
 */
const MAX_WIDTH_PX = /(?<![\w-])max-width\s*:\s*(\d+(?:\.\d+)?)px/gi

/** `@media` 前奏的开头（含未闭合前的空白） */
const MEDIA_AT_RULE = /@media\b/gi

/** `max-width` 在被断言的样式文件里的所有出现形态（含 `em`/无单位），仅用于退化哨兵自证 */
const ANY_MAX_WIDTH = /(?<![\w-])max-width\s*:/gi

interface Breakpoint {
  /** 相对 apps/desktop 的路径，报错信息里直接可用 */
  file: string
  /** 1 起算的行号 */
  line: number
  /** 媒体查询里的 px 数值 */
  px: number
}

/** 1 起算行号（offset 之前换行数 + 1，不受 CRLF/LF 影响） */
function lineAt(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset; i += 1) {
    if (text[i] === '\n') line += 1
  }
  return line
}

/**
 * 提取样式文件里**媒体查询前奏中**的 `max-width: <N>px`（含行号，便于报错定位）。
 *
 * 为什么必须限定在 `@media` 前奏里：普通元素声明 `.cy-revision-toolbar select { max-width: 160px; }`
 * 与响应式断点毫无关系——第一版实现直接全文件匹配 max-width，就把它误判成了"不可达断点"（实测假红）。
 * 前奏取 `@media` 之后到第一个 `{`（query 列表结束）或第一个 `;`（`@import` 之类的简写 at-rule）之前。
 */
function extractMaxWidths(source: string, file: string): Breakpoint[] {
  const stripped = stripCssComments(source)
  const found: Breakpoint[] = []
  for (const media of stripped.matchAll(MEDIA_AT_RULE)) {
    const preludeStart = (media.index ?? 0) + media[0].length
    const rest = stripped.slice(preludeStart)
    const brace = rest.indexOf('{')
    const semi = rest.indexOf(';')
    const end = brace < 0 ? rest.length : semi >= 0 && semi < brace ? semi : brace
    const prelude = rest.slice(0, end)
    for (const match of prelude.matchAll(MAX_WIDTH_PX)) {
      found.push({ file, line: lineAt(stripped, preludeStart + (match.index ?? 0)), px: Number(match[1]) })
    }
  }
  // 按出现顺序（行号）排序：同一个前奏里多个条件也保持确定性
  return found.sort((a, b) => a.line - b.line)
}

const styleFiles: string[] = collectStyleFiles(RENDERER_SRC)

/** 人可读位置，例如 `src/renderer/src/components/CySettingsView.vue:264` */
const where = (b: Breakpoint): string => `${b.file}:${b.line}`

describe('布局断点：不存在永不匹配的窄窗媒体查询（M-23 门禁）', () => {
  it('扫描面非空（防"扫描器坏了 ⇒ 0 命中 ⇒ 假绿"）', () => {
    const vues = styleFiles.filter((f) => f.endsWith('.vue'))
    const cssFiles = styleFiles.filter((f) => f.endsWith('.css'))
    expect(styleFiles.length).toBeGreaterThan(20)
    expect(vues.length).toBeGreaterThan(20)
    expect(cssFiles.length).toBeGreaterThan(0)
    // 定向哨兵：这不是"随便一个 .vue 都在"的断言，而是锚定真实目录树
    expect(styleFiles).toContain(join(RENDERER_SRC, 'tokens.css'))
    expect(styleFiles).toContain(join(RENDERER_SRC, 'components', 'CySettingsView.vue'))
  })

  it('每个 max-width 断点都 ≥ MIN_WINDOW_WIDTH（否则是永不匹配的死代码）', () => {
    const offenders: Breakpoint[] = []
    for (const file of styleFiles) {
      const rel = relative(DESKTOP_ROOT, file)
      const source = readFileSync(file, 'utf8')
      for (const b of extractMaxWidths(source, rel)) {
        // 自证行号可信：该行必须真的含有 @media —— 否则报错会把维护者指向无关行
        // （用 `^\s*@media` 会把同行前置的规则误判为"定位失效"，故只要求该行出现 `@media`）
        expect(source.split('\n')[b.line - 1], `${where(b)} 行号定位失效`).toContain('@media')
        if (b.px < MIN_WINDOW_WIDTH) offenders.push(b)
      }
    }
    expect(
      offenders.map(where),
      `renderer 视口恒 ≥ 约 ${MIN_WINDOW_WIDTH}px（main-window.ts minWidth = layout/constants.ts MIN_WINDOW_WIDTH），`
      + '下列 @media (max-width: …) 永不匹配、是必须删除的死代码：\n'
      + offenders.map((b) => `  ${where(b)} → max-width: ${b.px}px`).join('\n'),
    ).toEqual([])
  })

  it('退化哨兵：提取器能识别合格断点，且不会误伤 min-width / 普通 max-width 声明（防门禁空过）', () => {
    // 删除后真实语料里已 **0 命中**，所以必须喂内联夹具证明"识别能力仍在"。
    // 夹具数值**由 MIN_WINDOW_WIDTH 推导**（不写死 680/1200）：这样"阈值→判据"这条链无论常量取何值
    // 都在被检验，改常量不会让哨兵偷偷变成空断言（第一版写死 680 时，把常量降到 600 哨兵就假红了）。
    const below = MIN_WINDOW_WIDTH - 1   // 合格行/不可达断点
    const above = MIN_WINDOW_WIDTH + 1   // 合格断点
    // 行布局：1 /* 注释 */ · 2 below（不可达） · 3 min-width/em/无 px 三个干扰项 ·
    //        4 `.el { max-width: 160px }`（**普通声明，不是断点**） · 5 MAX-WIDTH 大写 + above（合格）
    const fixture = [
      `/* @media (max-width: ${below}px) { .a { color: red; } } */`,
      `@media (max-width: ${below}px) { .x { color: red; } }`,
      `   @media (min-width: ${above}px) { .y { color: blue; } }   @media (max-width: 40em) { .z { color: green; } }   @media (max-width: 700) { .w { color: pink; } }`,
      '.el { max-width: 160px; }',
      `@media (MAX-WIDTH: ${above}px) { .v { color: teal; } }`,
    ].join('\n')

    const hits = extractMaxWidths(fixture, 'fixture.vue')
    expect(hits).toEqual([
      { file: 'fixture.vue', line: 2, px: below },
      { file: 'fixture.vue', line: 5, px: above },
    ])
    // 低于阈值的那个必须真的被现行判据判为不可达（哨兵与判据**同源**），等号/高于不违规
    expect(hits.filter((b) => b.px < MIN_WINDOW_WIDTH).map(where)).toEqual(['fixture.vue:2'])
    // 注释内的 111px 未被采集（stripCssComments 生效）
    expect(hits.map((b) => b.px)).not.toContain(111)
    // 普通声明里的 160px 未被采集 —— 这是第一版实现的真实假红（`.cy-revision-toolbar select { max-width: 160px }`）
    expect(hits.map((b) => b.px)).not.toContain(160)

    // 反空过哨兵：证明夹具里**确实**存在 `max-width:` 形态（否则"没识别成断点"可能只是夹具写错了）
    expect(fixture.match(ANY_MAX_WIDTH)?.length).toBe(6)

    // 判据必须比较**真实常量**：等于/大于阈值不违规，小于才违规
    const at = (px: number): Breakpoint => ({ file: 'fixture.vue', line: 1, px })
    expect([at(MIN_WINDOW_WIDTH)].filter((b) => b.px < MIN_WINDOW_WIDTH)).toEqual([])
    expect([at(MIN_WINDOW_WIDTH - 1)].filter((b) => b.px < MIN_WINDOW_WIDTH)).toHaveLength(1)
  })
})
