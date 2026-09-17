// tests/unit/helpers/architecture-imports.ts
//
// 架构边界门禁的**共享依赖扫描器**（2026-09-17 架构整改 Prompt 5）。
//
// ── 为什么抽出来 ────────────────────────────────────────────────────────────────
// Prompt 5 之前仓库里已有两台**同款**扫描器，各自带一份解析器与一份 Tarjan：
//   · `main-dependency-graph.spec.ts`（Main 值导入图 + SCC）
//   · `backend-capability-ports.spec.ts`（模块引用判定 + 具名导入收集）
// 它们各自的实现都是对的（且都被对抗 review 证伪过一轮），本文件**不替换**它们，只把
// "同一件事的第三、第四份拷贝" 挡在门外：新增的边界规则（shared 隔离 / renderer 特权边界 /
// renderer 纯域 / transport 方向）共用这一份。
//
// ── 它是什么、不是什么（刻意的小 API）────────────────────────────────────────────
// 是：`collectFiles`（收源码）· `createImportResolver`（解析 specifier 到真实文件）· `scanImports`
//     （AST 抽边）。三个纯函数 + 一个 `SourceFileGraph` 容器，**不含任何规则**——规则、matcher 与
//     失败信息都由各自的 spec 定义（这样 CI 报错才能说人话，而不是从引擎里冒出一句通用话术）。
// 不是：没有 LayerRegistry / RuleDSL / ArchitecturePolicyEngine。这里只有"读文件"和"按 AST 抽边"。
//     谁违反了什么、为什么、该往哪改——一律留在 spec 里。
//
// ── 为什么必须是 AST 而不是正则（本仓已被证伪过两轮）──────────────────────────────
// Prompt 1 的第一版 Main 环扫描器就是正则，被对抗 review 用两条具体的 `src/main` 编辑证伪：
//   · 假阴性：`export * as ns from './x'` 是真值边，`\*\s*from` 式正则匹配不到中间的 `as ns`
//     ⇒ 一个真环可以静默溜过门禁；
//   · 假阳性：靠前缀字符判断"类型位置的 `import()`"必然不全（`Array<import('x').Y`、
//     `keyof import('x').Y` 都会被误判成运行时边）⇒ 纯类型代码被无端判红。
// Prompt 3 又实测了五种绕过具名 import 的写法（命名空间 / `typeof import()` / `import = require` /
// 动态 `import()` / 转出口 barrel）。本扫描器对这两类都是**判定**而不是猜测：
//   · 值边（有运行时后果）：具名/默认/命名空间/副作用 `import`、`export ... from`、
//     `import = require`、动态 `import()`、`require('x')`；
//   · 类型边（编译期擦除）：`import type`、具名项**全部**带 `type`、`export type ... from`、
//     `ImportTypeNode`（`type X = import('m').Y` 与 `typeof import('m')`）。
// 调用方用 `edge.value` 决定要不要计边——"类型引用不算跨层实现依赖"这条口径因此是**数据**，不是注释。
//
// ── 与既有门禁的关系（避免第二套 Backend Port / Store 扫描逻辑）───────────────────
// 本文件**不**重复以下已存在的能力，也不被它们复用（改动它们会牵动已审计过的判别力证据）：
//   · `main-dependency-graph.spec.ts` 的 Main 值导入 SCC——仍由它独占（本批只做只读复用，不改它）；
//   · `store-graph.spec.ts` 的 store 间 SCC——同上；
//   · `backend-capability-ports.spec.ts` 的端口/消费方对账——本批只确认新规则不与之冲突。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/** `apps/desktop/src` 的绝对路径 */
export const SRC_DIR = fileURLToPath(new URL('../../../src', import.meta.url))

/** `<src>` 下的 posix 风格相对路径（`main/index.ts`、`renderer/src/...`）——所有分类 matcher 都用这个形态 */
export function sourceId(absolutePath: string): string {
  return relative(SRC_DIR, absolutePath).replace(/\\/g, '/')
}

/** `<src>` 下的绝对路径 */
export function srcPath(posixId: string): string {
  return join(SRC_DIR, ...posixId.split('/'))
}

/** 递归收集 `dir` 下满足 `filter` 的文件（绝对路径，按路径排序保证结果稳定） */
export function collectFiles(dir: string, filter: (name: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) { collectFiles(absolute, filter, out); continue }
    if (filter(entry.name)) out.push(absolute)
  }
  return out.sort()
}

/** 生产源码：`.ts` / `.mts`，跳过 `.d.ts` / `.d.mts`（无值级代码，也不该被边界规则约束） */
export const isProductionSource = (name: string): boolean =>
  (name.endsWith('.ts') || name.endsWith('.mts')) && !name.endsWith('.d.ts') && !name.endsWith('.d.mts')

/** 类型声明文件（`.d.ts` / `.d.mts`） */
export const isDeclaration = (name: string): boolean => name.endsWith('.d.ts') || name.endsWith('.d.mts')

/** `.vue` 单文件组件（只见于 renderer） */
export const isVue = (name: string): boolean => name.endsWith('.vue')

/**
 * **被扫描**的源码集合：`.ts` / `.mts` / `.vue` **以及 `.d.ts` / `.d.mts`**。
 *
 * 为什么把声明文件也收进来（2026-09-17 对抗 review 的实测结论，FN-2）：`isProductionSource` 曾把
 * `.d.ts` 排除在扫描外，于是一个 `shared/domain/x.d.ts` 里的
 * `import type { RealBackend } from '../../main/transport/real-backend'` **完全不被看见**
 * ——门禁全绿，而 TS 真的会解析这条引用（`ts.resolveModuleName` 实测）.
 * "声明文件没有值级代码"是**分类**事实（它不该被当作某层的实现），不是"它的 import 不算依赖"。
 * 故：**收进来扫描依赖**，但在分层判定里用 `isProductionSource`/`isVue` 把它排除在"实现文件"之外。
 * 仓库里现有 6 个声明文件（`main/env.d.ts`、`preload/window.d.ts`、`renderer/src/env.d.ts`、
 * `live2d/framework.d.ts`、`live2d/core/live2dcubismcore.d.ts`、`voice/pcm-worklet.d.ts`）。
 */
export const isSource = (name: string): boolean => isProductionSource(name) || isVue(name) || isDeclaration(name)

// ─────────────────────────────────────────────────────────────────────────────
// 路径别名（与 `tsconfig.web.json` / `vitest.config.mts` 的 alias 表一致）
// ─────────────────────────────────────────────────────────────────────────────
const ALIASES: ReadonlyArray<readonly [prefix: string, target: string]> = [
  ['@shared/', 'shared/'],
  ['@renderer/', 'renderer/src/'],
  ['@framework/', 'renderer/src/live2d/framework/']
]

export type ImportTarget =
  /** 工作区内的真实文件 */
  | { kind: 'file'; file: string }
  /** npm 包 / Node 内建 / 其它裸标识符（含 `electron`）——"是否允许"由 spec 决定 */
  | { kind: 'bare'; name: string }
  /** `?raw` 之类的 bundler 后缀（Vite 资源导入），不参与跨层判定 */
  | { kind: 'asset'; name: string }

const CANDIDATE_SUFFIXES = ['', '.ts', '.mts', '.vue'] as const
const INDEX_SUFFIXES = ['index.ts', 'index.mts', 'index.vue'] as const

/**
 * TS 的 `allowImportingTsExtensions` + `moduleResolution: bundler` 下，`x.js` / `x.mjs` / `x.jsx`
 * 这三种 **out 后缀**会解析到同名 `.ts` / `.mts` / `.tsx`。少这一层映射时，`'./real-backend.js'`
 * 会解析失败并退化成 `bare`，于是所有 `kind === 'file'` 的守卫都跳过它——对抗 review 的 FN-3 实测形态。
 */
const JS_TO_TS_SUFFIX: ReadonlyArray<readonly [from: string, to: string]> = [
  ['.js', '.ts'], ['.mjs', '.mts'], ['.cjs', '.cts'], ['.jsx', '.tsx']
]

function firstExisting(base: string): string | null {
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = `${base}${suffix}`
    try { if (statSync(candidate).isFile()) return candidate } catch { /* 试下一个 */ }
  }
  for (const index of INDEX_SUFFIXES) {
    const candidate = join(base, index)
    try { if (statSync(candidate).isFile()) return candidate } catch { /* 试下一个 */ }
  }
  // out 后缀（`x.js` ⇒ 磁盘上是 `x.ts`）
  for (const [from, to] of JS_TO_TS_SUFFIX) {
    if (!base.endsWith(from)) continue
    const candidate = `${base.slice(0, -from.length)}${to}`
    try { if (statSync(candidate).isFile()) return candidate } catch { /* 试下一个 */ }
  }
  return null
}

/**
 * 造一个"从某文件出发"的 specifier 解析器。
 *
 * 解析规则与打包器/tsconfig 对齐（这是 Prompt 3 那条"用路径解析而不是字符串后缀匹配"的口径）：
 *   · 相对路径按 posix 规范化后逐候选尝试：原样 → `.ts` / `.mts` / `.vue` → 目录下的 `index.*` →
 *     out 后缀映射（`x.js` ⇒ `x.ts`）；因此 `./x`、`./x.ts`、`./x.js`、`../dir/x` 只要指向同一文件
 *     就解析成同一个绝对路径；
 *   · `@shared/*` / `@renderer/*` / `@framework/*` 按别名表展开（`renderer` 侧大量使用）；
 *   · 裸标识符（`electron` / `vue` / `zod` / `node:fs`）原样返回 `bare`——**不猜**它是不是包；
 *   · 带 `?raw` / `?url` 的导入归 `asset`，避免把 Vite 资源当模块判层。
 *
 * **别名展开后必须在 `SRC_DIR` 内**（对抗 review FN-4）：`@renderer/` 已映射到 `renderer/src/`，
 * 故再写 `@renderer/src/bootstrap` 会展开成 `renderer/src/src/bootstrap.ts`——一个**不存在**的路径。
 * 旧实现把它归 `bare`，于是"`@renderer/src/bootstrap` 形式的纯域 → bootstrap 反向依赖"整段隐形
 * （相对写法 `../bootstrap` 会红，别名写法却绿——这正是最坏的一类假阴性）。
 * 现在改为**先把别名展开归一化成规范路径、再用它解析**：`@renderer/src/bootstrap` 与
 * `../bootstrap` 解析成同一个绝对路径 `renderer/src/bootstrap.ts`，两条路都判红。
 * 归一化后越出 `SRC_DIR` 的（含 `..` 的别名写法）仍归 `bare`，不会伪装成仓库内文件。
 */
export function createImportResolver(fromFile: string): (specifier: string) => ImportTarget {
  return (specifier: string): ImportTarget => {
    const [pathPart = '', query] = specifier.split('?')
    if (query !== undefined) return { kind: 'asset', name: specifier }
    for (const [prefix, target] of ALIASES) {
      if (!pathPart.startsWith(prefix)) continue
      const file = firstExisting(join(SRC_DIR, ...normalizeAliasPath(target, pathPart.slice(prefix.length))))
      return file && isInsideSrc(file) ? { kind: 'file', file } : { kind: 'bare', name: specifier }
    }
    if (!pathPart.startsWith('.')) return { kind: 'bare', name: pathPart }
    const file = firstExisting(resolve(dirname(fromFile), pathPart))
    // 相对路径解析不到真实文件（或越出 src）：这是**仓库内的悬空引用**，当归为裸名而不是静默丢弃，
    // 于是"解析器悄悄退化成不报边"会被调用方的非空断言抓到。
    return file && isInsideSrc(file) ? { kind: 'file', file } : { kind: 'bare', name: specifier }
  }
}

/**
 * 别名根 + 用户写的尾部 ⇒ 规范化的路径分段。
 *
 * 两件事（都由对抗 review FN-4 逼出来）：
 *   ① **重叠去重**：`@renderer/` 的根是 `renderer/src`，而使用者可能再写一遍其中的目录
 *      （`@renderer/src/bootstrap`）——那是指向**同一个文件**的另一种写法，不是 `renderer/src/src/…`。
 *      故尾部若以根的最后一段开头（`src/…`），先把重叠部分摘掉。
 *   ② **消 `..`**：`@shared/../main/x` 这类写法不该伪装成 shared 内部的路径。
 */
function normalizeAliasPath(aliasRoot: string, tail: string): string[] {
  const rootSegments = aliasRoot.split('/').filter((segment) => segment !== '')
  const tailSegments = tail.split('/').filter((segment) => segment !== '' && segment !== '.')
  const lastRootSegment = rootSegments[rootSegments.length - 1]
  if (lastRootSegment !== undefined && tailSegments[0] === lastRootSegment) tailSegments.shift()
  const out = [...rootSegments]
  for (const segment of tailSegments) {
    if (segment === '..') { out.pop(); continue }
    out.push(segment)
  }
  return out
}

/** 解析结果必须落在 `SRC_DIR` 内——否则它不是"仓库内的模块"，不该被当成层的实现 */
function isInsideSrc(file: string): boolean {
  return file === SRC_DIR || file.startsWith(SRC_DIR + sep)
}

// ─────────────────────────────────────────────────────────────────────────────
// AST 抽边
// ─────────────────────────────────────────────────────────────────────────────
export type ImportForm =
  | 'import'            // `import X from` / `import * as X from` / `import { a } from` / `import 'm'`
  | 'export-from'       // `export ... from`（含 `export * as ns from` 与通配转出口）
  | 'import-equals'     // `import x = require('m')`
  | 'dynamic-import'    // `import('m')`（运行时边，延迟求值）
  | 'require'           // `require('m')`（CJS 边；单引号 / 双引号 / 反引号都算）
  | 'suspense-fallback' // `.vue` 的 `<script src="…">`：SFC 的依赖载体不在内联块里
  | 'import-type'       // `type X = import('m').Y` / `typeof import('m')`（**总是**类型边）

export interface ImportEdge {
  /** 源码里的原始 specifier（报错信息要显示它，而不是解析后的绝对路径） */
  readonly specifier: string
  readonly form: ImportForm
  /** 编译期擦除的类型边（`import type` / 全 type 具名项 / `export type` / `ImportTypeNode`） */
  readonly typeOnly: boolean
  readonly target: ImportTarget
}

/**
 * 抽出 `.vue` 的 `<script>` / `<script setup>` 块。
 *
 * 两种块都要处理（对抗 review FN-5）：`<script setup lang="ts" src="../x.ts">` 的**依赖载体是
 * `src` 指向的那个文件**，内联体是空的。旧实现直接剥掉标签、只留内联体 ⇒ 该 SFC 在图上**一条边都没有**，
 * 于是"`.vue` → 一个再 import main 的 `.ts`"这条链整段隐形。现在 `src` 也产出一条边
 * （form = `suspense-fallback`），并让图把被引文件一并纳入扫描面。
 */
interface ScriptBlock {
  /** 内联脚本正文（`src` 形式时为空串） */
  readonly code: string
  /** `<script ... src="...">` 的 src 值（无则 undefined） */
  readonly src: string | undefined
}

function scriptBlocksOf(source: string, vue: boolean): ScriptBlock[] {  if (!vue) return [{ code: source, src: undefined }]
  const blocks = source.match(/<script[^>]*>[\s\S]*?<\/script>/g) ?? []
  return blocks.map((block) => {
    const openTag = block.slice(0, block.indexOf('>') + 1)
    const src = /\ssrc\s*=\s*["']([^"']+)["']/.exec(openTag)?.[1]
    return { code: block.replace(/<\/?script[^>]*>/g, ''), src }
  })
}

/** `import { type a, type b } from`（具名项**全部**带 type）等价于 `import type`；`import {} from` 也是纯类型面 */
function isTypeOnlyNamedBindings(clause: ts.ImportClause): boolean {
  const bindings = clause.namedBindings
  if (!bindings || !ts.isNamedImports(bindings)) return false
  if (bindings.elements.length === 0) return true
  return bindings.elements.every((element) => element.isTypeOnly)
}

/** `export { type a } from`（具名项全部带 type）同理 */
function isTypeOnlyNamedExports(clause: ts.NamedExportBindings): boolean {
  if (!ts.isNamedExports(clause)) return false
  if (clause.elements.length === 0) return true
  return clause.elements.every((element) => element.isTypeOnly)
}

/**
 * 从一个**已解析的 SourceFile** 抽全部边。
 * 独立出来是为了让门禁能做"解析器判别力自证"：往同一份实现里注入合成片段，验明它计哪些写法、
 * 不计哪些写法。缺了这层，扫描器退化成"什么都不报"时门禁会恒绿。
 */
export function collectImportEdges(file: string, sourceFile: ts.SourceFile): ImportEdge[] {
  const resolveSpecifier = createImportResolver(file)
  const edges: ImportEdge[] = []
  const add = (specifier: string, form: ImportForm, typeOnly: boolean): void => {
    edges.push({ specifier, form, typeOnly, target: resolveSpecifier(specifier) })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const { moduleSpecifier, importClause } = node
      if (ts.isStringLiteral(moduleSpecifier)) {
        // 副作用 import（无 clause）= 值边；`import X` / `import * as X` 不可能是 type-only
        const typeOnly = !!importClause && (importClause.isTypeOnly || isTypeOnlyNamedBindings(importClause))
        add(moduleSpecifier.text, 'import', typeOnly)
      }
    } else if (ts.isExportDeclaration(node)) {
      const { moduleSpecifier, exportClause } = node
      if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
        const typeOnly = !!node.isTypeOnly || (!!exportClause && isTypeOnlyNamedExports(exportClause))
        add(moduleSpecifier.text, 'export-from', typeOnly)
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        const reference = node.moduleReference.expression
        if (reference && ts.isStringLiteral(reference)) add(reference.text, 'import-equals', node.isTypeOnly ?? false)
      }
    } else if (ts.isImportTypeNode(node)) {
      // `type X = import('m').Y` / `type X = typeof import('m')`：**类型位置**的 import，编译期擦除
      const { argument } = node
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) {
        add(argument.literal.text, 'import-type', true)
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments
      if (argument && ts.isStringLiteral(argument)) add(argument.text, 'dynamic-import', false)
    } else if (ts.isCallExpression(node) && isRequireCall(node)) {
      // `require('m')`：CJS / 历史写法。**必须走 AST 而不是正则**——对抗 review 的 FN-1 实测：
      // 旧实现只匹配单引号 `require\(\s*'([^']+)'\s*\)`，于是 `require("../chat/chat-service")`
      // 与反引号写法**完全不被扫描**，而 TS 与打包器对三种引号一视同仁。
      const [argument] = node.arguments
      if (argument && ts.isStringLiteralLike(argument)) add(argument.text, 'require', false)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return edges
}

/**
 * `require('m')` / `require("m")` / ``require(`m`)``——按 AST 判定被调用者就是标识符 `require`。
 * 必须先判 `expression` 存在：语法错误的源码会产出带 `undefined` 字段的节点，
 * `ts.isIdentifier(undefined)` 本身会抛（实测踩到过，整个 spec 变成 0 test）。
 */
function isRequireCall(node: ts.CallExpression): boolean {
  const callee: ts.Expression | undefined = node.expression
  return !!callee && ts.isIdentifier(callee) && callee.text === 'require' && node.arguments.length === 1
}

/**
 * 读一个文件并抽边。
 * `.vue` 额外处理 `<script src="…">`：内联体为空、依赖全在 `src` 指向的文件里（见 ScriptBlock 注释）。
 */
export function scanImports(file: string): ImportEdge[] {
  return scanImportsOf(file, readFileSync(file, 'utf8'))
}

/**
 * 同一份实现的**合成源码**入口：`file` 只用来决定解析基准与是否按 SFC 处理，源码由调用方给。
 * 门禁的判别力自证用它注入片段（`.vue` 的 `<script src>`、声明文件、出后缀等形态），
 * 于是验的是**生产扫描路径**，而不是测试里另写的一份等价物。
 */
export function scanImportsOf(file: string, source: string): ImportEdge[] {
  const vue = isVue(file)
  const blocks = scriptBlocksOf(source, vue)
  const edges: ImportEdge[] = []
  for (const block of blocks) {
    const sourceFile = ts.createSourceFile(file, block.code, ts.ScriptTarget.Latest, /* setParentNodes */ false, ts.ScriptKind.TS)
    edges.push(...collectImportEdges(file, sourceFile))
    if (block.src !== undefined) {
      // SFC 的 `<script src>`：实体是被引用的**外部文件**（通常是 .ts/.d.ts），故它不是类型边
      edges.push({
        specifier: block.src,
        form: 'suspense-fallback',
        typeOnly: false,
        target: createImportResolver(file)(block.src)
      })
    }
  }
  return edges
}

// ─────────────────────────────────────────────────────────────────────────────
// 图容器：**一次扫描，多个 it 复用**（架构 spec 不应让 pnpm test 变慢）
// ─────────────────────────────────────────────────────────────────────────────
export class SourceFileGraph {
  private readonly cache = new Map<string, ImportEdge[]>()

  /**
   * 参与扫描的文件（绝对路径）。
   *
   * **默认全扫 `<src>`**（357 个文件 ≈ 3.4 MB，AST 解析约 0.4 s）。规则只需要某一层时，
   * 可以显式传入更窄的集合（如 `shared/**`）把成本降一个数量级——判定结果不变，
   * 因为**解析目标**（`createImportResolver`）始终按真实文件系统解析，与"扫描谁"无关：
   * shared 里写 `import '../../main/config'` 仍会被解析成 `main/config/index.ts`。
   * 只有"谁 import 了我"这类**反向**问题才必须全扫。
   *
   * 传入的集合会**自动补上**被 `<script src="…">` 引用的文件（对抗 review FN-5）：
   * 那个文件是 SFC 的依赖载体，若它自己不在扫描面上，SFC 的整条依赖链就断了。
   */
  readonly files: readonly string[]

  constructor(files?: readonly string[]) {
    const seeds = files ?? collectFiles(SRC_DIR, isSource)
    const known = new Set(seeds)
    const extra: string[] = []
    for (const file of seeds) {
      if (!isVue(file)) continue
      for (const edge of scanImports(file)) {
        if (edge.form !== 'suspense-fallback' || edge.target.kind !== 'file') continue
        if (known.has(edge.target.file)) continue
        known.add(edge.target.file)
        extra.push(edge.target.file)
      }
    }
    this.files = extra.length > 0 ? [...seeds, ...extra.sort()] : seeds
  }

  /** 某个文件的边（带缓存） */
  edgesOf(file: string): ImportEdge[] {
    const cached = this.cache.get(file)
    if (cached) return cached
    const edges = scanImports(file)
    this.cache.set(file, edges)
    return edges
  }

  edgesOfId(id: string): ImportEdge[] {
    return this.edgesOf(srcPath(id))
  }

  /** 迭代所有 (文件, 边)；`from` 是 `<src>` 下的 posix 路径 */
  *forEachEdge(): Generator<{ from: string; edge: ImportEdge }> {
    for (const file of this.files) {
      const from = sourceId(file)
      for (const edge of this.edgesOf(file)) yield { from, edge }
    }
  }

  /** 出边指向的 `<src>` 内文件 id 集合（值边 + 类型边；调用方按 `edge.typeOnly` 自行筛） */
  targetsOf(file: string): string[] {
    const targets = new Set<string>()
    for (const edge of this.edgesOf(file)) {
      if (edge.target.kind === 'file') targets.add(sourceId(edge.target.file))
    }
    return [...targets]
  }
}

/** 一个 `(sourceId → targetId)` 边的可读描述，供失败信息使用 */
export function describeEdge(from: string, edge: ImportEdge): string {
  const target = edge.target.kind === 'file' ? sourceId(edge.target.file)
    : edge.target.kind === 'bare' ? `<bare ${edge.target.name}>`
      : `<asset ${edge.target.name}>`
  return `${from}  --[${edge.form}${edge.typeOnly ? ', type-only' : ''}]-->  ${edge.specifier}  ⇒  ${target}`
}

/**
 * Tarjan 强连通分量（迭代式，避免深递归爆栈）。
 * **刻意留在这里的第二个实现**：`main-dependency-graph.spec.ts` 与 `store-graph.spec.ts` 各有一份，
 * 它们已由 mutation 证明过判别力，本批不动它们（改动已审计门禁的实现＝重开证据）。本文件这份只给
 * 新规则用；`architecture-renderer.spec.ts` 有一条"合法框架集成文件仍可成环"的对照用例在用它。
 */
export function stronglyConnectedComponents<N>(nodes: readonly N[], neighboursOf: (node: N) => readonly N[]): N[][] {
  const index = new Map<N, number>()
  const low = new Map<N, number>()
  const onStack = new Set<N>()
  const stack: N[] = []
  const components: N[][] = []
  let counter = 0
  for (const root of nodes) {
    if (index.has(root)) continue
    const work: Array<[N, number]> = [[root, 0]]
    while (work.length > 0) {
      const frame = work[work.length - 1]
      if (!frame) break
      const [node, next] = frame
      if (next === 0) {
        index.set(node, counter); low.set(node, counter); counter++
        stack.push(node); onStack.add(node)
      }
      const neighbours = neighboursOf(node)
      if (next < neighbours.length) {
        frame[1] = next + 1
        const target = neighbours[next]
        if (target === undefined) continue
        if (!index.has(target)) work.push([target, 0])
        else if (onStack.has(target)) low.set(node, Math.min(low.get(node) ?? 0, index.get(target) ?? 0))
      } else {
        work.pop()
        if (low.get(node) === index.get(node)) {
          const component: N[] = []
          let popped = stack.pop()
          while (popped !== undefined) {
            onStack.delete(popped); component.push(popped)
            if (popped === node) break
            popped = stack.pop()
          }
          components.push(component)
        }
        const parent = work[work.length - 1]
        if (parent) low.set(parent[0], Math.min(low.get(parent[0]) ?? 0, low.get(node) ?? 0))
      }
    }
  }
  return components
}
