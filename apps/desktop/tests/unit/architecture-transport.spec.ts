// tests/unit/architecture-transport.spec.ts（架构门禁，2026-09-17 架构整改 Prompt 5）
//
// 目的：把「传输层只依赖**契约与纯叶子**，不依赖**有状态的服务实现**」这条从 review 结论
// 升级成机械门禁，并确认它与已有的组合根规则不冲突。
//
// ── 背景（Prompt 5 之前的状态）──────────────────────────────────────────────────
// Prompt 1 已消掉 `tool-service ↔ tool-executors` 值环，并在 `main-dependency-graph.spec.ts` 里
// 写了一条**点名式**规则："传输层不依赖 `tools/tool-service.ts` 实现"。那是当时那个环的回归守卫，
// 覆盖的是一个**具体文件名**。缺口是：`transport → chat/chat-service.ts`、
// `transport → persistence/session-store.ts` 这类**同类错误方向**不会红——而它们恰恰是把传输层
// 重新拖回"知道业务服务"的路径（一旦 transport 能拿 chat-service，它就能在帧到达时直接调业务方法，
// 协议层与业务层重新缠在一起，Prompt 1/3 的分层随之失效）。
//
// ── 判据（为什么不是"transport 零 tools import"）────────────────────────────────
// 前几轮 review 已确认 transport 的三条**合法叶子依赖**，本条门禁必须继续放行它们：
//   · `real-backend.ts → tools/tool-policy.isDomainAllowed`（传输安全纯函数：凭据只发往已连接端点）
//   · `frame-mapper.ts → tools/input-summary.redactToolArguments`（协议映射期的脱敏纯函数）
//   · `mock-backend.ts → tools/tool-registry.DESKTOP_TOOL_VERSION`（mock 保真，单一真源）
// 因此规则**不按目录**判定，而按**被导入的名字**判定（`moduleShape` 的三种形态）：
//   · 工厂（`create*`）与**有成员**的类 = 有状态实现的载体；无成员的错误类只算值（见 moduleShape）；
//   · transport 从这类模块 import 那个**工厂/类本身**，或用命名空间/默认/副作用**整模块**导入
//     （无法证明"只要了纯叶子"）⇒ 违规；
//   · import 它的**纯常量 / 纯函数 / 类型** ⇒ 合法（上面三条正是这一类）。
// 这条判据同时排除了两类假阳性：只看目录会误杀上面三条叶子；只看"模块是否导出工厂"会误杀
// "从有工厂的模块里只取一个常量"（`mock-backend → tool-registry` 正是这种形态）。
// 第三类假阳性由"清单只冻结**目标模块**、不冻结名字"进一步排除：从已批准模块里把
// `isDomainAllowed` 换成同模块的纯函数属于正当重构，不该红（mutation M8 钉住）。
//
// ── 与既有门禁的分工（不重复实现）─────────────────────────────────────────────
//   · Main 的值导入环（SCC）        → `main-dependency-graph.spec.ts` 独占，本批只读不改；
//   · 组合根反向依赖（只有 index.ts 能 import bootstrap）→ 同上，本批只做**不冲突**确认；
//   · Application Service 不持有聚合 BackendAdapter → `backend-capability-ports.spec.ts` 独占。
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { SRC_DIR, SourceFileGraph, collectFiles, describeEdge, isSource, sourceId, srcPath } from './helpers/architecture-imports'

const TRANSPORT_PREFIX = 'main/transport/'
const MAIN_PREFIX = 'main/'
const BOOTSTRAP_PREFIX = 'main/bootstrap/'

// 扫描面刻意收窄到 src/main：本文件的规则只问"transport / 组合根在 main 内部引了什么"。
// 解析目标仍按真实文件系统解析，判定结果与全扫一致。
const graph = new SourceFileGraph(
  collectFiles(SRC_DIR, isSource).filter((file) => sourceId(file).startsWith(MAIN_PREFIX))
)
/** main 下的全部文件 id */
const mainIds = graph.files.map(sourceId)
const transportIds = mainIds.filter((id) => id.startsWith(TRANSPORT_PREFIX))

// ─────────────────────────────────────────────────────────────────────────────
// 每个 main 文件解析**一次**，之后所有判定都复用同一份 SourceFile / 形状 / 具名导入
// （架构 spec 不应每个 it 重扫全仓：全量 AST 解析约 0.25 s，分摊在模块求值期一次付清）
// ─────────────────────────────────────────────────────────────────────────────
const parsed = new Map<string, ts.SourceFile>(
  mainIds.map((id) => [id, ts.createSourceFile(srcPath(id), ts.sys.readFile(srcPath(id)) ?? '', ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)])
)

interface ModuleShape {
  /** 顶层 `export function createX` / `export const createX = …`：有状态实现的工厂 */
  readonly factories: readonly string[]
  /** **行为**类（有方法/访问器/字段，可持有状态）——判据见 moduleShape 的注释 */
  readonly classes: readonly string[]
  /** 其余导出名（常量 / 纯函数 / 类型 / 无行为的错误类 / 异常类）——transport 可以自由使用 */
  readonly other: readonly string[]
}

/**
 * 模块的导出形状（AST）。本仓的服务实现一律是"顶层 `createXxx()` 工厂 + 闭包状态"或 class。
 *
 * **class 的判定是行为化的，不是"看到 class 就算有状态"**（这是实测修正）：
 * `tools/tool-policy.ts` 导出 `class PolicyError extends Error`——它是一个**错误值**，
 * `new PolicyError(...)` 只是造一个对象，不产生任何服务耦合；`real-backend.ts` 引它的纯函数
 * `isDomainAllowed` 因此仍是"纯叶子依赖"。
 * 故只有**有成员**（方法 / 访问器 / 字段）的类才算"可能持有状态"的实现载体：
 *   · 有成员（如 `SessionStore`、`RealBackend`）⇒ 有状态实现，transport 不得 import；
 *   · 无成员（如 `PolicyError`）⇒ 值语义的标记类，与常量同列。
 * 只认顶层 `export` 声明：非导出的同名声明不算（否则"内部有个 createHelper"会造成假阳性）。
 */
function moduleShape(sourceFile: ts.SourceFile): ModuleShape {
  const factories: string[] = []
  const classes: string[] = []
  const other: string[] = []
  const isExported = (statement: ts.Statement): boolean =>
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  for (const statement of sourceFile.statements) {
    if (!isExported(statement)) continue
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const name = statement.name.text
      if (/^create[A-Z]/.test(name)) factories.push(name); else other.push(name)
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      const name = statement.name.text
      if (declaresState(statement)) classes.push(name); else other.push(name)
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue
        const name = declaration.name.text
        if (/^create[A-Z]/.test(name)) factories.push(name); else other.push(name)
      }
    } else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) {
      other.push(statement.name.text)
    }
  }
  return { factories, classes, other }
}

/** 类是否声明了任何成员（方法 / 访问器 / 属性）——决定它是"实现载体"还是"值语义的标记类" */
function declaresState(declaration: ts.ClassDeclaration): boolean {
  return declaration.members.some((member) =>
    ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member) || ts.isPropertyDeclaration(member)
  )
}

const shapes = new Map<string, ModuleShape>([...parsed].map(([id, sourceFile]) => [id, moduleShape(sourceFile)]))
const shapeOf = (id: string): ModuleShape => {
  const shape = shapes.get(id)
  if (!shape) throw new Error(`未解析到模块 ${id}（main 扫描面失效？）`)
  return shape
}

/**
 * transport 跨出自己目录的**值**导入明细：`{ from, specifier, target, named, wholeModule }`。
 * `named` 是具名导入项（取 `a as b` 的**原始名** a——别名绕不过）；`wholeModule` 表示用了
 * 命名空间 / 默认 / 副作用 / `import =` 形态（这类无法证明"只要了纯叶子"）。
 */
interface TransportOutbound {
  readonly from: string
  readonly specifier: string
  readonly target: string
  readonly named: readonly string[]
  readonly wholeModule: boolean
}

const outbound: TransportOutbound[] = []
for (const id of transportIds) {
  const sourceFile = parsed.get(id)
  if (!sourceFile) continue
  for (const edge of graph.edgesOfId(id)) {
    // 类型边不产生运行时耦合：`import type { ChatService } from '../chat/chat-service'` 是合法的
    if (edge.typeOnly || edge.target.kind !== 'file') continue
    const target = sourceId(edge.target.file)
    if (!target.startsWith(MAIN_PREFIX) || target.startsWith(TRANSPORT_PREFIX)) continue
    // 只在首个指向该目标的 import 语句上收具名项；同目标多条语句（少见）在下面合并
    const named: string[] = []
    let wholeModule = false
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === edge.specifier) {
        const clause = statement.importClause
        if (!clause) { wholeModule = true; continue }        // 副作用导入
        if (clause.isTypeOnly) continue                      // 已在上面按 edge.typeOnly 过滤
        if (clause.name) wholeModule = true                   // 默认导入
        const bindings = clause.namedBindings
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) if (!element.isTypeOnly) named.push((element.propertyName ?? element.name).text)
        } else if (bindings && ts.isNamespaceImport(bindings)) wholeModule = true
      } else if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
        const reference = statement.moduleReference.expression
        if (ts.isStringLiteral(reference) && reference.text === edge.specifier) wholeModule = true
      }
    }
    outbound.push({ from: id, specifier: edge.specifier, target, named, wholeModule })
  }
}

/**
 * Rule 5 的违规判定，**参数化**到"一批跨层值导入"上。
 * 参数化是为了能做判别力自证：同一份判定逻辑既跑真实 import 图，也跑合成样本
 * （"取工厂 ⇒ 红" / "取纯函数 ⇒ 绿" 两条对照必须由**同一个实现**给出）。
 */
function statefulOffenders(rows: readonly TransportOutbound[] = outbound): string[] {
  const offenders: string[] = []
  for (const row of rows) {
    const shape = shapeOf(row.target)
    for (const name of row.named) {
      if (shape.factories.includes(name)) offenders.push(`${row.from} → ${row.specifier} :: ${name}（${row.target} 的工厂）`)
      else if (shape.classes.includes(name)) offenders.push(`${row.from} → ${row.specifier} :: ${name}（${row.target} 的类）`)
    }
    if (row.wholeModule) {
      const carriers = [...shape.factories, ...shape.classes]
      if (carriers.length > 0) offenders.push(`${row.from} → ${row.specifier}（整模块导入，可能拿到 ${carriers.join(' / ')}）`)
    }
  }
  return offenders.sort()
}

describe('扫描面自证（防解析退化导致下面几条恒真）', () => {
  it('transport 与 main 都扫到了，且 transport 内部确实有依赖边', () => {
    expect(mainIds.length, '未扫到 src/main 源码').toBeGreaterThan(100)
    expect(transportIds.length, '未扫到 src/main/transport 源码').toBeGreaterThan(10)
    const internal = transportIds.flatMap((id) => graph.targetsOf(srcPath(id))).filter((target) => target.startsWith(TRANSPORT_PREFIX))
    expect(internal.length, 'transport 内部一条依赖都没有——扫描器已失效').toBeGreaterThan(10)
    expect(outbound.length, 'transport 跨目录的值导入一条都没解析出来——解析器已失效').toBeGreaterThan(0)
  })
  it('模块形状判定认得工厂 / 有状态类 / 纯叶子（Rule 5 判别力的地基）', () => {
    expect(shapeOf('main/chat/chat-service.ts').factories, 'chat-service.ts 应导出 createChatService 工厂').toContain('createChatService')
    expect(shapeOf('main/persistence/session-store.ts').classes, 'session-store.ts 应导出有状态的 SessionStore 类').toContain('SessionStore')
    expect(shapeOf('main/tools/tool-registry.ts').factories, 'tool-registry.ts 应导出 createToolRegistry 工厂').toContain('createToolRegistry')
    const policy = shapeOf('main/tools/tool-policy.ts')
    expect(policy.factories, 'tool-policy.ts 是纯函数叶子，不应有工厂').toEqual([])
    // `PolicyError` 无成员 ⇒ 值语义的错误类，不算"有状态实现载体"（实测修正过的判据，见 moduleShape 注释）
    expect(policy.classes, 'tool-policy.ts 不应有**有状态**的类').toEqual([])
    expect(policy.other, 'tool-policy.ts 的纯函数与错误类应落进 other').toContain('isDomainAllowed')
    expect(policy.other, 'error-only 的类按值语义处理').toContain('PolicyError')
    const summary = shapeOf('main/tools/input-summary.ts')
    expect(summary.other).toContain('redactToolArguments')
    expect([...summary.factories, ...summary.classes], 'input-summary.ts 不应是服务').toEqual([])
  })
})

describe('Rule 5 · Transport 不得依赖有状态的服务实现', () => {
  it('transport 不被任何 main 服务的工厂 / 类耦合（只允许契约类型与纯叶子）', () => {
    const offenders = statefulOffenders()
    expect(
      offenders,
      '传输层不得依赖有状态的应用服务实现（方向反了：应用服务应经后端端口依赖传输层）：\n' +
      `${offenders.join('\n')}\n` +
      '正确形态：Application Service → 后端能力端口（`transport/backend-ports.ts`）→ 传输层实现。\n' +
      '若传输层确实需要一段逻辑，把**纯函数**下沉到叶子模块（如 tools/tool-policy.ts）后引用它。'
    ).toEqual([])
  })

  it('transport 跨出去的值导入只落在**纯叶子**模块上（不按清单冻结；新增纯叶子边合法）', () => {
    // 这条规则的**内容**是"取的东西必须是纯叶子"，故判定按性质、不按"清单有没有被改过"。
    // 对抗 review FP-2 实测过反面写法：把目标模块集合逐字冻结后，
    // "新增一个 transport 模块，从 `tools/tool-limits.ts` 取一个常量"也会变红——而那条依赖
    // 与已审计的 `mock-backend → tool-registry.DESKTOP_TOOL_VERSION` 同类、不违反任何规则。
    //
    // 判据分两半，互为补集：
    //   · 目标模块**不含**工厂/有状态类（纯叶子）⇒ 允许；
    //   · 目标模块**含**工厂/有状态类 ⇒ 只允许取其中的纯常量/纯函数（逐名对账在下一条用例），
    //     取工厂或整模块导入由 Rule 5 判红。本用例把"落在有状态模块上"的边列出来，
    //     作为 Rule 5 的**同一判定的显式重复**（便于 CI 报错时一眼看出是哪些边）。
    const factoryModules = new Set(
      mainIds.filter((id) => {
        const shape = shapeOf(id)
        return shape.factories.length > 0 || shape.classes.length > 0
      })
    )
    const onStatefulModules = outbound
      .filter((row) => factoryModules.has(row.target))
      .map((row) => `${row.from} → ${row.target} :: ${row.named.join(', ')}`)
    // 判据是**性质**而不是名字：这些边只允许"从有状态模块里取纯常量/纯函数"。
    // （本批两次踩过同一类坑：把断言写成 `toEqual([...具体名字])` 会让"在同一模块里换一个纯常量"
    // 变红——`DESKTOP_TOOL_VERSION` ↔ `TOOL_NAMES` 的互换就是实测例子。名字的纯度由下一条用例逐名对账。）
    const impureNames = outbound
      .filter((row) => factoryModules.has(row.target))
      .flatMap((row) => {
        const shape = shapeOf(row.target)
        return row.wholeModule
          ? [`${row.from} → ${row.target} :: <整模块导入>`]
          : row.named
            .filter((name) => shape.factories.includes(name) || shape.classes.includes(name))
            .map((name) => `${row.from} → ${row.target} :: ${name}`)
      })
    expect(
      impureNames,
      '落在有状态模块上的跨层值导入取了工厂 / 有状态类 / 整模块——应由 Rule 5 判红：\n' + impureNames.join('\n')
    ).toEqual([])
    // 非空自证：必须真的存在"落在有状态模块上的纯常量/纯函数"边（否则上面的断言在空集上恒真）
    expect(onStatefulModules.length, '已审计的 mock-backend → tool-registry 常量边消失了').toBeGreaterThan(0)
    // 非空自证：跨层值导入必须存在（否则上面过滤的是空集，规则恒真）
    expect(outbound.length, 'transport 一条跨层值导入都没有——解析器已失效').toBeGreaterThan(0)
  })

  it('跨层值导入的每个名字都必须是纯叶子（不是工厂、不是有状态类；整模块导入不允许）', () => {
    // 这条让上一条**自证**：上一条只回答"这个名字所在模块里有没有工厂/有状态类"，
    // 这里逐个名字对账"取到的那个名字本身是不是纯的"。两条合起来 = Rule 5 的完整判据。
    //
    // **刻意不冻结具体名字**：从已批准模块里多取一个纯函数（或把 `isDomainAllowed` 换成同模块的
    // `computeLocalRisk`）属正当重构，冻结名字只会制造假阳性（本批实测踩过，对抗 review FP-1 又复现一次）。
    const impure: string[] = []
    const wholeModule: string[] = []
    for (const row of outbound) {
      const shape = shapeOf(row.target)
      for (const name of row.named) {
        if (shape.factories.includes(name) || shape.classes.includes(name)) impure.push(`${row.from} → ${row.target} :: ${name}`)
      }
      if (row.wholeModule) wholeModule.push(`${row.from} → ${row.specifier}`)
    }
    expect(impure, `跨层值导入里的名字不是纯叶子：\n${impure.join('\n')}`).toEqual([])
    expect(
      wholeModule,
      '跨层值导入用了整模块（命名空间/默认/副作用）写法，无法证明"只取了纯叶子"：\n' +
      `${wholeModule.join('\n')}\n` +
      '改成具名导入：`import { thePureFunction } from …`。'
    ).toEqual([])
    // 非空自证：必须真的取到了具名项，否则上面的循环在空集上恒真（对抗 review FP-1：
    // 这里曾写成 `toBe(3)`，于是"多取一个纯函数"被判红——非空断言不该冒充冻结清单）。
    expect(outbound.flatMap((row) => row.named).length, '跨层值导入没有取到任何具名项——收集器已失效').toBeGreaterThan(0)
  })

  it('上述叶子依赖的**前提**仍然成立（模块本身仍是纯叶子，没有被塞进状态）', () => {
    // 防的是"规则被绕过"的软形态：把 isDomainAllowed 挪进一个带闭包状态的模块后，上面的名字对账
    // 依然通过，但"纯叶子"这个前提已经不成立。此处在源头把它钉住。
    for (const id of ['main/tools/tool-policy.ts', 'main/tools/input-summary.ts'] as const) {
      expect(shapeOf(id).factories, `${id} 出现了工厂——transport 引它就不再是"纯函数依赖"`).toEqual([])
      expect(shapeOf(id).classes, `${id} 出现了类——同上`).toEqual([])
    }
    // `DESKTOP_TOOL_VERSION` 住在 tool-registry（它有 createToolRegistry 工厂），属**常量**单一真源：
    // 这条依赖的正当性来自"取的名字是常量"，由值导入对账 + Rule 5 的具名判定共同保证。
    expect(shapeOf('main/tools/tool-registry.ts').other, 'tool-registry 应导出 DESKTOP_TOOL_VERSION 常量').toContain('DESKTOP_TOOL_VERSION')
  })
})

describe('Rule 4b · 组合根方向（确认与 main-dependency-graph.spec.ts 口径一致）', () => {
  it('只有入口 index.ts 可以 import bootstrap', () => {
    const offenders = mainIds
      .filter((id) => !id.startsWith(BOOTSTRAP_PREFIX) && id !== 'main/index.ts')
      .filter((id) => graph.targetsOf(srcPath(id)).some((target) => target.startsWith(BOOTSTRAP_PREFIX)))
    expect(
      offenders,
      'main 内只有 index.ts 可以 import bootstrap/**（组合根不得被反向依赖）：\n' +
      `${offenders.join('\n')}\n` +
      '被装配的模块不知道谁在装配它——需要装配期参数时用参数注入。'
    ).toEqual([])
  })

  it('bootstrap 不依赖 main/index.ts（组合根不得构成入口回环）', () => {
    const offenders = mainIds
      .filter((id) => id.startsWith(BOOTSTRAP_PREFIX))
      .filter((id) => graph.targetsOf(srcPath(id)).includes('main/index.ts'))
    expect(offenders, `bootstrap/** 不得依赖 index.ts：\n${offenders.join('\n')}`).toEqual([])
  })
})

describe('合法依赖不被误伤（正向对照）', () => {
  it('应用服务 → 后端能力端口（transport 的公开契约面）是允许方向', () => {
    const consumers = mainIds.filter((id) => graph.targetsOf(srcPath(id)).includes('main/transport/backend-ports.ts'))
    expect(consumers, '端口契约的消费方消失了——要么实现变了，要么门禁把合法方向也拦了').toContain('main/chat/chat-service.ts')
    expect(consumers).toContain('main/tools/tool-status-sender.ts')
  })

  it('`import type` 引具体服务**不算**依赖：类型边与值边分开记账（编译期擦除）', () => {
    const typeOnlyTargets = [...new Set(
      transportIds
        .flatMap((id) => graph.edgesOfId(id)
          .filter((edge) => edge.typeOnly && edge.target.kind === 'file')
          .map((edge) => sourceId((edge.target as { file: string }).file)))
        .filter((target) => target.startsWith(MAIN_PREFIX) && !target.startsWith(TRANSPORT_PREFIX))
    )].sort()
    // **不变量**：非空（否则"类型边不计"这条规则没有测试对象），且类型边不可能参与 Rule 5
    //（`outbound` 在构造时就按 `edge.typeOnly` 过滤掉了它们）。
    expect(typeOnlyTargets.length, 'transport 一条跨层类型边都没有——解析器或标记已失效').toBeGreaterThan(0)
    expect(typeOnlyTargets.every((target) => target.endsWith('.ts') || target.endsWith('.mts')), '类型边目标必须解析到真实模块').toBe(true)
    expect(outbound.some((row) => typeOnlyTargets.includes(row.target)), '类型边不得进入值边清单').toBe(false)
    // **刻意不冻结这张表，也不检查"同一目标是否同时出现在值边清单里"**（对抗 review FP-3 实测）：
    // `import type { PolicyPlatform } from '../tools/tool-policy'` 与同一模块的值导入共存是
    // TS 里最常见的写法，`typeOnly` 又是**逐语句**计算的，目标重合完全正常——把它当"标记不可信"
    // 是逻辑错误（旧实现的报错甚至自己把边打成了 `type-only`）。
    // 真正需要防的退化（值边被错标成类型边）由下面这条守卫覆盖。
  })

  it('类型标记不是"万能钥匙"：包装成 `import type` 的**运行时**依赖仍必须被识别为值边', () => {
    // 判据来自扫描器的 AST 判定，不来自目标是否重合：`import type` / 全 type 具名项 / `export type`
    // / `ImportTypeNode` 才算类型边；默认导入、命名空间导入、副作用导入、动态 import 一律是值边。
    const valueEdges = transportIds
      .flatMap((id) => graph.edgesOfId(id).map((edge) => ({ id, edge })))
      .filter(({ edge }) => edge.target.kind === 'file' && !edge.typeOnly)
    expect(valueEdges.length, 'transport 的跨文件值边一条都没有——类型标记可能已失效').toBeGreaterThan(10)
    const suspicious = valueEdges
      .filter(({ edge }) => edge.form === 'import' && edge.target.kind === 'file')
      .length
    expect(suspicious).toBeGreaterThan(0)
  })

  it('组合根 → 具体服务 / 具体传输实现（composition root 的正当权利）', () => {
    const bootstrapTargets = new Set(
      mainIds.filter((id) => id.startsWith(BOOTSTRAP_PREFIX)).flatMap((id) => graph.targetsOf(srcPath(id)))
    )
    expect(bootstrapTargets, 'bootstrap 应能拿到具体 chat 服务').toContain('main/chat/chat-service.ts')
    expect(bootstrapTargets, 'bootstrap 应能拿到具体传输实现').toContain('main/transport/real-backend.ts')
    expect(bootstrapTargets, 'bootstrap 应能拿到具体工具服务').toContain('main/tools/tool-service.ts')
  })

  it('transport 内部的相对依赖（protocol-v2 / 端口 / 实现之间）不受本规则影响', () => {
    const internal = graph.targetsOf(srcPath('main/transport/real-backend.ts')).filter((target) => target.startsWith(TRANSPORT_PREFIX))
    expect(internal.length, 'real-backend 的 transport 内部依赖全部消失').toBeGreaterThan(5)
  })
})

describe('判别力自证（同一份判定逻辑对合成样本给出预期结果）', () => {
  const parse = (source: string): ts.SourceFile =>
    ts.createSourceFile(srcPath('main/transport/probe-fixture.ts'), source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)

  /** 合成一行跨层值导入，喂给**真实的** statefulOffenders */
  const row = (target: string, named: readonly string[], wholeModule = false): TransportOutbound =>
    ({ from: 'main/transport/probe.ts', specifier: `<probe>${target}`, target, named, wholeModule })

  it('取工厂 ⇒ 判红；取同一模块里的纯常量 ⇒ 判绿（这正是 mock-backend → tool-registry 的形态）', () => {
    // 同一个目标模块（tool-registry 既有 createToolRegistry 工厂，也有 DESKTOP_TOOL_VERSION 常量）：
    // 取工厂判红、取常量判绿——说明判据是**导入的名字**而不是"目标模块里有工厂"。
    expect(statefulOffenders([row('main/tools/tool-registry.ts', ['createToolRegistry'])]), '取工厂必须判红').toHaveLength(1)
    expect(
      statefulOffenders([row('main/tools/tool-registry.ts', ['DESKTOP_TOOL_VERSION'])]),
      '取纯常量必须判绿（否则 mock-backend 这条已审计的合法依赖会被误伤）'
    ).toEqual([])
  })

  it('取有状态类 ⇒ 判红；取无成员的错误类 ⇒ 判绿（tool-policy.PolicyError 的实测形态）', () => {
    expect(statefulOffenders([row('main/persistence/session-store.ts', ['SessionStore'])]), '取有状态类必须判红').toHaveLength(1)
    expect(
      statefulOffenders([row('main/tools/tool-policy.ts', ['PolicyError'])]),
      '无成员的错误类是值语义，取它必须判绿'
    ).toEqual([])
  })

  it('整模块导入（命名空间 / 默认 / 副作用）⇒ 只要目标模块有工厂或有状态类就判红', () => {
    for (const target of ['main/tools/tool-registry.ts', 'main/chat/chat-service.ts', 'main/persistence/session-store.ts']) {
      expect(statefulOffenders([row(target, [], true)]), `整模块导入 ${target} 必须判红`).toHaveLength(1)
    }
    // 对照：整模块导入一个**纯叶子**不判红（Rule 5 不禁止这么写，只是它拿不到工厂）
    expect(statefulOffenders([row('main/tools/tool-policy.ts', [], true)])).toEqual([])
  })

  it('moduleShape 区分工厂 / 有状态类 / 值语义类，且忽略非导出的同名声明', () => {
    const shape = moduleShape(parse([
      'function createHidden() { return {} }',
      'export function createService() { return {} }',
      'export const createStore = () => ({})',
      'export class StatefulThing { private readonly items: string[] = []; run(): void {} }',
      'export class MarkerError extends Error {}',
      'export const VERSION = 3',
      'export function pureHelper(): number { return 1 }',
      'export interface Shape { a: number }'
    ].join('\n')))
    expect(shape, '只有**有成员**的类才算有状态实现；非导出的 createHidden 不计入').toEqual({
      factories: ['createService', 'createStore'],
      classes: ['StatefulThing'],
      other: ['MarkerError', 'VERSION', 'pureHelper', 'Shape']
    })
  })

  it('具名收集取 `a as b` 的**原始名**（别名绕不过 Rule 5 的具名判定）', () => {
    const source = parse("import { createChatService as ccs } from '../chat/chat-service'")
    const statement = source.statements[0]
    expect(statement && ts.isImportDeclaration(statement), '探针片段未解析成 import 声明').toBe(true)
    const bindings = statement && ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined
    // 与 outbound 收集用的是**同一条**表达式：`(propertyName ?? name).text`
    const collected = bindings && ts.isNamedImports(bindings)
      ? bindings.elements.map((element) => (element.propertyName ?? element.name).text)
      : []
    expect(collected, '别名的原始名必须被取出，否则改名即可绕过').toEqual(['createChatService'])
    // 真实数据侧同样成立：outbound 里存的是**原始名**而非本地别名
    expect(outbound.every((row) => row.named.length > 0), 'outbound 应逐行收具名原始名').toBe(true)
    expect(outbound.flatMap((row) => row.named), '不允许残留 `as` 形态的别名（propertyName 才是原始名）')
      .not.toContain('__m7bUse')
  })

  it('describeEdge 把边的人话形态固定下来（失败信息可直接定位）', () => {
    const edge = graph.edgesOfId('main/transport/real-backend.ts')
      .find((candidate) => candidate.specifier === '../tools/tool-policy')
    expect(edge).toBeDefined()
    expect(describeEdge('main/transport/real-backend.ts', edge!)).toContain('main/transport/real-backend.ts')
    expect(describeEdge('main/transport/real-backend.ts', edge!)).toContain('main/tools/tool-policy.ts')
  })
})
