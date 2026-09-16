// tests/unit/main-dependency-graph.spec.ts（架构门禁，2026-09-17 架构整改 Prompt 1）
//
// 目的：把「Main 内部不得有循环依赖」从口头约定变成可执行门禁。
//
// 背景（为什么需要它）：Renderer 侧早有同类门禁（`store-graph.spec.ts`，Tarjan SCC），**Main 侧一直没有**
// ——`docs/review/2026-09-11-full-frontend-review.md:367` 的 M-14 记过这个缺口。2026-09-17 的 Prompt 1 整改
// 才第一次把 Main 里已存在的一个真环消掉（`tools/tool-service.ts ↔ tools/tool-executors.ts`：执行器为了读
// 5 个执行上限常量而反向 import 服务实现）。消环本身是改代码，而**不让它回来**只能靠机械守卫：ESM 循环
// import 在"仅函数体内使用"时不报错、无编译期信号、无运行期红灯，正是本仓反复吃过的形态。
//
// 判定口径（关键取舍）：
//   · 只统计**值导入**（value edge）——它有运行时后果（模块求值顺序 / TDZ / 半初始化命名空间）。
//   · `import type` 与 `import { type X }`（具名项**全部**带 type）不计边：编译期擦除，不产生运行时边。
//     故本门禁**允许**类型层互相引用（例如 `tool-execution-contract` 的类型位置引用 `grant-store.GrantStore`，
//     而 `grant-store` 值 import 契约的 `ToolServiceError`——类型 2-环、值单向，运行时无环）。
//     一条项目级门禁若把类型也计入，会把这类正当写法判红，从而被迫为"图好看"拆散领域模型。
//   · 同一模块内自环不计；>= 2 节点的强连通分量即环。
//   · 动态 `import('x')` 计边（真实的运行时边，只是延迟求值）；**类型位置**的 `import('x').Y`
//     （`ImportTypeNode`，即 `import type` 的另一种写法）不计。
//   · 不解析 node 内建、npm 包、以及 src/main 之外的路径（`@shared/*` 等在别层，本门禁只管 main 内部）。
//
// 解析器为什么用 TypeScript AST 而不是正则（2026-09-17，本文件第一版是正则，被对抗 review 用两条具体的
// src/main 编辑证伪）：
//   · 假阴性：`export * as ns from './x'` 是真值边，但"`\*\s*from`"式正则匹配不到中间的 `as ns`
//     ⇒ 一个真环可以静默溜过门禁。同类还有 `import x = require('./y')`。
//   · 假阳性：识别"类型位置的 `import()`"靠前缀字符判断必然不全（`Array<import('x').Y`、
//     `unknown as import('x').Y`、`keyof import('x').Y` 都会被误判成运行时边）⇒ 纯类型代码被无端判红。
//   `typescript` 是本仓库既有 devDependency，`ts.createSourceFile` + AST 遍历对这两类都是**判定**而不是猜测。
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const MAIN_DIR = fileURLToPath(new URL('../../src/main', import.meta.url))

/** main 下所有 .ts（跳过 .d.ts：无值级代码） */
function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) { collectFiles(abs, out); continue }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(abs)
  }
  return out
}

/** 把 specifier 解析到 main 下的真实文件；main 之外（相对路径越界 / 裸包名）返回 null */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null   // 裸包名 / @shared 等：不属于 main 内部图
  const base = resolve(dirname(fromFile), specifier)
  const candidates = [base, `${base}.ts`, join(base, 'index.ts')]
  for (const candidate of candidates) {
    if (!candidate.startsWith(MAIN_DIR + sep)) continue   // 越出 main ⇒ 不计
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch { /* 不是文件，试下一个 */ }
  }
  return null
}

/** `import { type a, type b } from`（具名项全部带 type）等价于 `import type`；`import {} from` 也是纯类型面 */
function isTypeOnlyNamedBindings(clause: ts.ImportClause): boolean {
  const bindings = clause.namedBindings
  if (!bindings || !ts.isNamedImports(bindings)) return false
  if (bindings.elements.length === 0) return true
  return bindings.elements.every((element) => element.isTypeOnly)
}

/**
 * 抽出一个文件的**值导入**边（AST 判定，见文件头"为什么用 AST"）。
 *
 * 计边：`import X from` / `import * as X from` / `import { a } from` / `import { type a, b } from` /
 *      `import 'm'`（副作用）/ `export ... from`（含 `export * as ns from`、`export { a } from`）/
 *      运行时 `import('m')` / `import x = require('m')`。
 * 不计边：`import type` / `import { type a }`（全类型）/ `import { } from` / `export type ... from` /
 *        `ImportTypeNode`（`type X = import('m').Y`）。
 */
function valueEdgesOf(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, /* setParentNodes */ false, ts.ScriptKind.TS)
  return collectValueEdges(file, sourceFile)
}

/** 从已解析的 SourceFile 上取值导入边（独立出来供"解析器判别力"用例注入片段后复用同一实现） */
function collectValueEdges(file: string, sourceFile: ts.SourceFile): string[] {
  const targets = new Set<string>()
  const add = (specifier: string): void => {
    const resolved = resolveSpecifier(file, specifier)
    if (resolved && resolved !== file) targets.add(resolved)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      // 副作用 import（无 clause）与 `import X` / `import * as X` 都是值边
      const { moduleSpecifier } = node
      if ((!clause || (!clause.isTypeOnly && !isTypeOnlyNamedBindings(clause))) && ts.isStringLiteral(moduleSpecifier)) {
        add(moduleSpecifier.text)
      }
    } else if (ts.isExportDeclaration(node)) {
      const { moduleSpecifier } = node
      if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier) && !node.isTypeOnly) add(moduleSpecifier.text)
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        const reference = node.moduleReference.expression
        if (ts.isStringLiteral(reference)) add(reference.text)
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments
      if (argument && ts.isStringLiteral(argument)) add(argument.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return [...targets]
}

function buildGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>()
  for (const file of collectFiles(MAIN_DIR)) graph.set(file, valueEdgesOf(file))
  return graph
}

/** Tarjan 强连通分量（迭代式，避免深递归爆栈；与 store-graph.spec.ts 同款算法） */
function stronglyConnectedComponents(graph: Map<string, string[]>): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  let counter = 0
  for (const root of graph.keys()) {
    if (index.has(root)) continue
    const work: Array<[string, number]> = [[root, 0]]
    while (work.length > 0) {
      const frame = work[work.length - 1]
      const [node, next] = frame
      if (next === 0) {
        index.set(node, counter); low.set(node, counter); counter++
        stack.push(node); onStack.add(node)
      }
      const neighbours = graph.get(node) ?? []
      if (next < neighbours.length) {
        frame[1] = next + 1
        const target = neighbours[next]
        if (!graph.has(target)) continue
        if (!index.has(target)) work.push([target, 0])
        else if (onStack.has(target)) low.set(node, Math.min(low.get(node)!, index.get(target)!))
      } else {
        work.pop()
        if (low.get(node) === index.get(node)) {
          const component: string[] = []
          let popped: string
          do { popped = stack.pop()!; onStack.delete(popped); component.push(popped) } while (popped !== node)
          components.push(component)
        }
        if (work.length > 0) {
          const parent = work[work.length - 1][0]
          low.set(parent, Math.min(low.get(parent)!, low.get(node)!))
        }
      }
    }
  }
  return components
}

const rel = (file: string): string => relative(MAIN_DIR, file).replace(/\\/g, '/')
const mainFile = (name: string): string => {
  const found = [...buildGraph().keys()].find((f) => f.endsWith(join('tools', name)))
  if (!found) throw new Error(`未找到 tools/${name}`)
  return found
}

describe('Main 依赖图：值导入不得有环', () => {
  it('图可解析且非空（防解析失效导致下一条恒真）', () => {
    const graph = buildGraph()
    expect(graph.size, '未扫到 main 源码').toBeGreaterThan(50)
    const edgeCount = [...graph.values()].reduce((n, deps) => n + deps.length, 0)
    expect(edgeCount, '未解析出任何 main 内部依赖边——解析器已失效').toBeGreaterThan(50)
  })

  it('扫描器只收 main 内部目标：不含裸包名与越界相对路径', () => {
    for (const deps of buildGraph().values()) {
      for (const dep of deps) {
        expect(dep.startsWith(MAIN_DIR + sep), `依赖边指向 main 之外：${dep}`).toBe(true)
        expect(dep.endsWith('.ts')).toBe(true)
      }
    }
  })

  /**
   * 解析器判别力自证（2026-09-17）：`export * as ns from`（正则版漏判的真值边）会被对抗 review 用来藏环，
   * 这里用**同一份实现**验明它确实计边，同时验明类型面确实不计边。缺了这条，"解析器退化成不报边"时
   * 上面的非空断言可能仍然通过。
   *
   * 注：本用例只用**合法 TS** 写法。第一版曾拿 `type P = unknown as import('./x').Y` 当不计边的样本，
   * 但那个写法本身是语法错误（`as` 右侧要 TypeNode，`import(...)` 是表达式），解析器把它收成 CallExpression
   * 并计边其实是对的——是断言错了，不是实现错了。
   */
  it('解析器判别力：计 `export * as ns from` / 不计 `ImportTypeNode` 与 `import type`', () => {
    const probePath = join(MAIN_DIR, 'tools', 'tool-executors.ts')
    const original = readFileSync(probePath, 'utf8')
    const cases: Array<[string, boolean]> = [
      // —— 真值边 ——
      ["import { createExecutors } from './tool-service'", true],
      ["import * as svc from './tool-service'", true],
      ["import './tool-service'", true],
      ["export * from './tool-service'", true],
      ["export * as svc from './tool-service'", true],   // 正则版在此漏判（`as ns` 挡住了 `\*\s*from`）
      ["export { createExecutors } from './tool-service'", true],
      ["const m = await import('./tool-service')", true],
      ["import svc = require('./tool-service')", true],
      // —— 类型面（编译期擦除，不计边）——
      ["import type { ToolService } from './tool-service'", false],
      ["import { type ToolService } from './tool-service'", false],
      ["import {} from './tool-service'", false],
      ["export type { ToolService } from './tool-service'", false],
      ["export type * as svc from './tool-service'", false],
      ["type P = import('./tool-service').ToolService", false],
      ["type P = Promise<import('./tool-service').ToolService | null>", false],
      ["type P = Array<import('./tool-service').ToolService>", false],
      ["type P = (import('./tool-service').ToolService)", false],
      ["type P = typeof import('./tool-service')", false],
      ["interface I { m(): Promise<import('./tool-service').ToolService> }", false],
      ["type P = keyof import('./tool-service').ToolServiceMap", false],
    ]
    // 用一个真实存在的目标文件做探针：把每种写法追加到该文件源码后重新解析（不落盘）
    for (const [snippet, expected] of cases) {
      const sourceFile = ts.createSourceFile(probePath, `${original}\n${snippet}\n`, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
      const values = collectValueEdges(probePath, sourceFile)
      const countsService = values.some((v) => v.endsWith('tool-service.ts'))
      expect(countsService, `写法判定错误（期望${expected ? '计边' : '不计边'}）：${snippet}`).toBe(expected)
    }
  })

  it('无强连通分量大于 1（即无环）', () => {
    const graph = buildGraph()
    const cycles = stronglyConnectedComponents(graph).filter((c) => c.length > 1)
    const report = cycles.map((c) => [...c].map(rel).sort().join('  <->  ')).sort()
    expect(report, `main 内出现值导入环：\n${report.join('\n')}`).toEqual([])
  })

  // —— 定点回归守卫（Prompt 1 消掉的那个环，不得回来）——
  it('tools/tool-executors 不依赖 tools/tool-service（Prompt 1 消环点）', () => {
    const graph = buildGraph()
    const deps = (graph.get(mainFile('tool-executors.ts')) ?? []).map(rel)
    expect(deps).not.toContain('tools/tool-service.ts')
  })

  it('契约与常量模块不依赖任何 main 模块（叶子约束）', () => {
    const graph = buildGraph()
    for (const name of ['tool-execution-contract.ts', 'tool-limits.ts'] as const) {
      expect((graph.get(mainFile(name)) ?? []).map(rel), `tools/${name} 必须是叶子模块`).toEqual([])
    }
  })

  it('传输层不依赖 tools/tool-service 实现（只依赖工具域契约）', () => {
    const graph = buildGraph()
    const transport = [...graph.keys()].filter((f) => f.includes(join('main', 'transport')))
    expect(transport.length, '未扫到 transport 文件').toBeGreaterThan(5)
    const offenders = transport
      .filter((f) => (graph.get(f) ?? []).some((dep) => dep.endsWith(join('tools', 'tool-service.ts'))))
      .map(rel)
    expect(offenders, `transport 不得依赖 concrete tool-service 实现：\n${offenders.join('\n')}`).toEqual([])
  })

  // —— 组合根分层（2026-09-17 架构整改 Prompt 2）——
  // `main/index.ts` + `main/bootstrap/**` 是**组合根**：它们可以依赖具体服务与基础设施（装配就是要
  // 知道具体类型），但**反向依赖必须为空**——被装配的模块不知道自己被谁装配，否则
  // "service → bootstrap" 会让分层重新变成一张网，并给未来在 bootstrap 里加副作用制造机会。
  const BOOTSTRAP = join('main', 'bootstrap') + sep
  const isBootstrap = (file: string): boolean => file.includes(BOOTSTRAP)
  const isEntry = (file: string): boolean => file.endsWith(join('main', 'index.ts'))

  it('只有入口 index.ts 可以依赖 bootstrap（services/transport/domain 不得反向依赖组合根）', () => {
    const graph = buildGraph()
    const offenders = [...graph.keys()]
      .filter((file) => !isEntry(file) && !isBootstrap(file))
      .filter((file) => (graph.get(file) ?? []).some((dep) => isBootstrap(dep)))
      .map(rel)
    expect(offenders, `main 内部只有 index.ts 可以 import bootstrap/**：\n${offenders.join('\n')}`).toEqual([])
  })

  it('bootstrap 不依赖 index.ts（组合根不得形成入口回环）', () => {
    const graph = buildGraph()
    const offenders = [...graph.keys()]
      .filter(isBootstrap)
      .filter((file) => (graph.get(file) ?? []).some((dep) => isEntry(dep)))
      .map(rel)
    expect(offenders, `bootstrap/** 不得依赖 index.ts：\n${offenders.join('\n')}`).toEqual([])
  })

  it('index.ts 只做编排：其导入面限定为 bootstrap/**、config、windows 与 electron/node 内建', () => {
    const graph = buildGraph()
    const entry = [...graph.keys()].find(isEntry)
    expect(entry, '未找到 src/main/index.ts').toBeDefined()
    const allowed = (dep: string): boolean =>
      isBootstrap(dep) ||
      dep.includes(join('main', 'config') + sep) ||
      dep.includes(join('main', 'windows') + sep)
    const offenders = (graph.get(entry!) ?? []).filter((dep) => !allowed(dep)).map(rel)
    expect(offenders, `index.ts 不得直接依赖具体服务/基础设施（应经 bootstrap 阶段模块）：\n${offenders.join('\n')}`).toEqual([])
  })

  it('bootstrap 目录内部分层：pre-ready / infrastructure 不依赖 services / wire / register-ipc / start-application', () => {
    const graph = buildGraph()
    const early = ['pre-ready.ts', 'infrastructure.ts', 'runtime-guards.ts'].map((n) => join(MAIN_DIR, 'bootstrap', n))
    const late = ['services.ts', 'wire.ts', 'register-ipc.ts', 'start-application.ts', 'test-probe.ts'].map((n) => join(MAIN_DIR, 'bootstrap', n))
    const offenders: string[] = []
    for (const file of early) {
      for (const dep of graph.get(file) ?? []) {
        if (late.includes(dep)) offenders.push(`${rel(file)} → ${rel(dep)}`)
      }
    }
    expect(offenders, `早期阶段不得依赖晚期阶段（否则阶段边界失效）：\n${offenders.join('\n')}`).toEqual([])
  })
})
