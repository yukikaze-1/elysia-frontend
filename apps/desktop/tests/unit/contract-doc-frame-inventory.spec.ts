// tests/unit/contract-doc-frame-inventory.spec.ts
//
// 「文档 ↔ 代码」守护（2026-09-14 建立）。
//
// 为什么需要它：既有的 `check:contract` 比的是**代码 ↔ 后端**，而 CLAUDE.md 把 doc 02 定为
// "后端协议与前端领域契约"的维护文档——**"文档 ↔ 代码"这一段此前没有任何门禁**。缺口是实际
// 长出过漂移的：`typing`、`character.state.changed`、`character.catalog.changed` 三型曾被代码
// 接纳而 doc 02 全文 0 命中（`git show HEAD` 核实），直到 2026-09-14 人工对拍才发现。
//
// 本门禁做的是**集合相等**（不是"文档里提到过"那种弱断言）：
//   · 脚本的 `WS_V2_FRAME_TYPES`（代码侧真相） ⊆ doc 02 §19.2 的机器校验清单
//   · 且 doc 02 的清单 ⊆ `WS_V2_FRAME_TYPES`（反向：清单里不许有代码不认的类型）
// 因此**增删任一白名单类型却忘了改文档、或文档写了代码没有的类型，都会红**。
//
// 为什么不直接 `import` 那个脚本：它顶部就读文件、并在不满足时 `process.exit`，
// 是**带副作用的可执行脚本**而非库。这里按先例用**源码文本抽取 + 退化哨兵**（与
// `temp-dirs` 防漂移门禁同款做法），并在抽取失败时明确报"解析器失效"而不是静默通过。
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DESKTOP = join(__dirname, '..', '..')
const REPO = join(DESKTOP, '..', '..')
const SCRIPT = join(DESKTOP, 'scripts', 'check-backend-contract.mjs')
const RAW_SCHEMAS = join(DESKTOP, 'src', 'main', 'transport', 'protocol-v2', 'raw-schemas.ts')

/** 机器校验锚点：doc 02 §19.2 里含 `WS_V2_FRAME_TYPES`(N) 的那一行清单。
 *  注意：紧邻的 HTML 注释里也写了 `WS_V2_FRAME_TYPES`（说明格式用），故取行时必须排除注释行，
 *  否则会抓到注释、`(N)` 解析失败——本用例第一版正是这样红的。 */
const INVENTORY_MARKER = '`WS_V2_FRAME_TYPES`('

function doc02Path(): string {
  const docsDir = join(REPO, 'docs')
  const hit = readdirSync(docsDir).find((n) => n.startsWith('02-') && n.endsWith('.md'))
  if (!hit) throw new Error(`未找到 doc 02（${docsDir}）`)
  return join(docsDir, hit)
}

/** 从脚本源码抽取 WS_V2_FRAME_TYPES；**先剥注释**，避免把注释里的示例名当类型 */
function scriptFrameTypes(): string[] {
  const src = readFileSync(SCRIPT, 'utf8').replace(/\/\/[^\n]*/g, '')
  const m = /WS_V2_FRAME_TYPES\s*=\s*\[([\s\S]*?)\]/.exec(src)
  if (!m) throw new Error('未能在 check-backend-contract.mjs 中定位 WS_V2_FRAME_TYPES 数组（解析器失效）')
  const types = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  if (types.length < 30) throw new Error(`只解析出 ${types.length} 个类型，疑似解析器失效`)
  return [...new Set(types)]
}

/** 从 doc 02 的机器校验锚点行抽取清单 */
function docFrameTypes(): { declaredCount: number; types: string[] } {
  const text = readFileSync(doc02Path(), 'utf8')
  const line = text
    .split('\n')
    .find((l) => l.includes(INVENTORY_MARKER) && !l.trimStart().startsWith('<!--'))
  if (!line) throw new Error(`doc 02 §19.2 缺少机器校验锚点（应含 ${INVENTORY_MARKER} 的非注释行）；若改过格式请同步本用例`)
  const count = /\((\d+)\)/.exec(line)
  if (!count) throw new Error('机器校验锚点里没有声明条数 "(N)"')
  // 只取该行内反引号包裹的标识符，且排除锚点自身的 `WS_V2_FRAME_TYPES`
  const types = [...line.matchAll(/`([^`]+)`/g)]
    .map((x) => x[1])
    .filter((x) => x !== 'WS_V2_FRAME_TYPES')
  return { declaredCount: Number(count[1]), types: [...new Set(types)] }
}

/** 生产代码真正认得的帧 type（`type: z.literal('…')`，与脚本同款抽取口径） */
function rawFrameTypes(): string[] {
  const src = readFileSync(RAW_SCHEMAS, 'utf8')
  const types = [...src.matchAll(/type:\s*z\.literal\(\s*["']([^"']+)["']\s*\)/g)]
    .filter((m) => !src.slice(src.lastIndexOf('\n', m.index - 1) + 1, m.index).includes('//'))
    .map((m) => m[1])
  return [...new Set(types)]
}

describe('doc 02 §19.2 帧类型清单 ↔ 契约门禁白名单（文档↔代码守护）', () => {
  it('两侧集合相等（增删白名单而忘改文档、或文档写了代码不认的类型，都红）', () => {
    const script = scriptFrameTypes()
    const { types: doc } = docFrameTypes()

    const onlyInScript = script.filter((t) => !doc.includes(t))
    const onlyInDoc = doc.filter((t) => !script.includes(t))
    // 报出差异本身，而不是只报"长度不等"——否则失败信息无法指导修复
    expect(onlyInScript, '白名单里有、doc 02 清单里没有（请同步 §19.2）').toEqual([])
    expect(onlyInDoc, 'doc 02 清单里有、白名单里没有（请同步 WS_V2_FRAME_TYPES）').toEqual([])
    expect(doc, '两侧顺序也须一致（便于逐行对拍）').toEqual(script)
  })

  it('锚点声明的条数与实际条数一致，且与白名单规模一致', () => {
    const script = scriptFrameTypes()
    const { declaredCount, types: doc } = docFrameTypes()
    expect(declaredCount, '锚点里的 "(N)" 与实际列出的条数不符').toBe(doc.length)
    expect(declaredCount).toBe(script.length)
  })

  it('每个白名单类型都真的被生产代码认（`type: z.literal` 存在）——防"文档与白名单一起漂"', () => {
    const script = scriptFrameTypes()
    const raw = rawFrameTypes()
    expect(raw.length, 'raw-schemas.ts 里没解析到帧类型，疑似解析器失效').toBeGreaterThan(20)
    const missing = script.filter((t) => !raw.includes(t))
    expect(missing, '白名单里有生产代码未实现的类型（文档会跟着一起说错）').toEqual([])
  })

  it('doc 02 里仍保留三处曾漂移的类型说明（回归保护，防被"整理"掉）', () => {
    const text = readFileSync(doc02Path(), 'utf8')
    const section = text.slice(text.indexOf('### 19.2 '))
    expect(section, '未找到 §19.2').not.toBe('')
    for (const t of ['typing', 'character.state.changed', 'character.catalog.changed']) {
      expect(section, `§19.2 应说明 ${t}（它曾是"代码已认、文档未记"的漂移实例）`).toContain(t)
    }
  })
})

// —— REST 半边（2026-09-14 补）——
//
// 与 WS 段同源：`check:contract` 的 REST 段比的是「后端 rest.py ↔ 前端 rest-schemas.ts」，
// 属"代码 ↔ 后端"；而 doc 02 §19 表里那 16 个目标模型此前**只存在于脚本的常量里**，
// 文档没有机器可校验的落点 ⇒ 同一条"文档 ↔ 代码"的缝。这里按同一规格补上。
const REST_INVENTORY_MARKER = '`REST_TARGET_MODELS`('

/** 从脚本源码抽取 REST_TARGET_MODELS 的**键**（后端模型名）；先剥注释 */
function scriptRestModels(): string[] {
  const src = readFileSync(SCRIPT, 'utf8').replace(/\/\/[^\n]*/g, '')
  const m = /REST_TARGET_MODELS\s*=\s*\{([\s\S]*?)\n\}/.exec(src)
  if (!m) throw new Error('未能在 check-backend-contract.mjs 中定位 REST_TARGET_MODELS 对象（解析器失效）')
  const names = [...m[1].matchAll(/^\s*(\w+)\s*:/gm)].map((x) => x[1])
  if (names.length < 8) throw new Error(`只解析出 ${names.length} 个 REST 目标模型，疑似解析器失效`)
  return [...new Set(names)]
}

/** 从 doc 02 的 REST 机器校验锚点行抽取清单（排除相邻的 HTML 注释行） */
function docRestModels(): { declaredCount: number; models: string[] } {
  const text = readFileSync(doc02Path(), 'utf8')
  const line = text
    .split('\n')
    .find((l) => l.includes(REST_INVENTORY_MARKER) && !l.trimStart().startsWith('<!--'))
  if (!line) throw new Error(`doc 02 §19.3 缺少机器校验锚点（应含 ${REST_INVENTORY_MARKER} 的非注释行）`)
  const count = /\((\d+)\)/.exec(line)
  if (!count) throw new Error('REST 机器校验锚点里没有声明条数 "(N)"')
  const models = [...line.matchAll(/`([^`]+)`/g)].map((x) => x[1]).filter((x) => x !== 'REST_TARGET_MODELS')
  return { declaredCount: Number(count[1]), models: [...new Set(models)] }
}

describe('doc 02 §19.3 REST 目标模型清单 ↔ 脚本 REST_TARGET_MODELS（文档↔代码守护）', () => {
  it('两侧集合相等（增删目标模型而忘改文档、或文档写了脚本没有的模型，都红）', () => {
    const script = scriptRestModels()
    const { models: doc } = docRestModels()
    const onlyInScript = script.filter((t) => !doc.includes(t))
    const onlyInDoc = doc.filter((t) => !script.includes(t))
    expect(onlyInScript, '脚本里有、doc 02 §19.3 没有（请同步 §19.3）').toEqual([])
    expect(onlyInDoc, 'doc 02 §19.3 里有、脚本没有（请同步 REST_TARGET_MODELS）').toEqual([])
    expect(doc, '两侧顺序也须一致（便于逐行对拍）').toEqual(script)
  })

  it('锚点声明的条数与实际条数一致，且与脚本规模一致', () => {
    const script = scriptRestModels()
    const { declaredCount, models: doc } = docRestModels()
    expect(declaredCount, '锚点里的 "(N)" 与实际列出的条数不符').toBe(doc.length)
    expect(declaredCount).toBe(script.length)
  })

  it('每个目标模型引用的前端 schema 都真的存在于 rest-schemas.ts（防"文档与脚本一起漂"）', () => {
    const src = readFileSync(RAW_SCHEMAS.replace(/raw-schemas\.ts$/, 'rest-schemas.ts'), 'utf8')
    const exported = new Set([...src.matchAll(/^export const (\w+Schema)/gm)].map((m) => m[1]))
    expect(exported.size, 'rest-schemas.ts 里没解析到导出 schema，疑似解析器失效').toBeGreaterThan(10)
    const scriptSrc = readFileSync(SCRIPT, 'utf8').replace(/\/\/[^\n]*/g, '')
    const m = /REST_TARGET_MODELS\s*=\s*\{([\s\S]*?)\n\}/.exec(scriptSrc)
    const refs = [...(m?.[1] ?? '').matchAll(/'(\w+Schema)'/g)].map((x) => x[1])
    expect(refs.length).toBeGreaterThan(8)
    const dangling = [...new Set(refs)].filter((r) => !exported.has(r))
    expect(dangling, '脚本引用了 rest-schemas.ts 里不存在的 schema（重命名/删除未同步）').toEqual([])
  })
})
