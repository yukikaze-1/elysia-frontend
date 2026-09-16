// tests/unit/backend-capability-ports.spec.ts（架构门禁，2026-09-17 架构整改 Prompt 3）
//
// 目的：把「Application Service 只能依赖它真正需要的后端能力」从口头约定变成可执行门禁。
//
// 背景（为什么需要它）：Prompt 3 之前 `BackendAdapter` 是一个 43 方法的宽接口，同时充当聚合面与
// 唯一注入面——任何服务拿到它就理论上能调用几乎整个 Python 后端能力面（违反 ISP），并会随着
// Memory / Schedule / Diary / Agent 等新领域继续膨胀成"整个后端 SDK"。Prompt 3 把它拆成 7 个领域
// 端口（`src/main/transport/backend-ports.ts`），聚合面退化为它们的交集 + 传输层接线槽。
//
// 拆分本身是改代码，而**不让它退化回去**只能靠机械守卫。本文件钉住四件事：
//   ① 端口清单与每个端口的方法名（多一个/少一个/挪到别的端口都必须显式改这张表 ⇒ 能力不会静默丢失）；
//   ② 聚合面只能由传输层实现与组合根持有（源码级：Application Service 不得 import `BackendAdapter`）；
//   ③ RealBackend / MockBackend 都满足**每一个**端口与聚合面（编译期 + 源码级双重证据）；
//   ④ 恰好 7 个端口、除事件源外不存在单方法端口（防"一个方法一个 interface"与 interface explosion）。
//
// 判别口径（关键取舍）：
//   · 用 TypeScript AST 而不是字符串扫描：`import type { BackendAdapter }` 与注释里出现同名字符串
//     必须区分开，否则门禁要么误报要么可被绕过（同一理由是 main-dependency-graph.spec.ts 用 AST 的原因）。
//   · 消费方 → 端口表**刻意硬编码**：它就是这个批次的核心契约（"ChatService 能用哪些 backend capability"），
//     从源码派生会让断言恒真。新增依赖必须显式改这里，于是 review 时可见。
//   · 编译期断言（模块顶层的 `conforms` 元组）与运行期断言同时存在：前者在 `pnpm typecheck` 里生效，
//     后者证明"冻结的清单"与"真实签名"没有漂移。
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import type {
  AttachmentBackendPort,
  BackendConnectionPort,
  BackendEventSourcePort,
  ChatBackendPort,
  ModelBackendPort,
  ToolBackendPort,
  VoiceBackendPort
} from '../../src/main/transport/backend-ports'
import type { BackendAdapter } from '../../src/main/transport/backend-adapter'
import type { RealBackend } from '../../src/main/transport/real-backend'
import type { MockBackend } from '../../src/main/transport/mock-backend'

const MAIN_DIR = fileURLToPath(new URL('../../src/main', import.meta.url))
const rel = (...segments: string[]): string => join(MAIN_DIR, ...segments)
/** 两个契约模块的**无扩展名绝对路径**（用于把每个 import 的 specifier 解析回真实目标） */
const PORTS_MODULE = rel('transport', 'backend-ports')
const AGGREGATE_MODULE = rel('transport', 'backend-adapter')

/**
 * 编译期证据：`[RealBackend, MockBackend]` 的**两个**实例类型都必须可赋值给该端口。
 * 只要有一个不满足，`PortConformance<X>` 求值为 `never`，下面那个元组常量即无法通过类型检查
 * （`pnpm typecheck` 红）——这是"Real/Mock 与端口契约不漂移"的最强证据，不依赖任何运行期行为。
 */
type PortConformance<Port> = [RealBackend, MockBackend] extends [Port, Port] ? true : never

const conforms: [
  PortConformance<BackendConnectionPort>,
  PortConformance<BackendEventSourcePort>,
  PortConformance<ChatBackendPort>,
  PortConformance<AttachmentBackendPort>,
  PortConformance<ModelBackendPort>,
  PortConformance<VoiceBackendPort>,
  PortConformance<ToolBackendPort>,
  PortConformance<BackendAdapter>
] = [true, true, true, true, true, true, true, true]

/** 端口清单 + 每个端口的方法名（架构整改 Prompt 3 冻结；改动必须显式改这里） */
const PORT_SURFACE = {
  BackendConnectionPort: ['connect', 'disconnect', 'getConnectionState'],
  BackendEventSourcePort: ['subscribe'],
  ChatBackendPort: [
    'activateConversation', 'cancelGeneration', 'createConversation', 'deleteConversation', 'getConversation',
    'getConversationMessages', 'getMessageContext', 'listConversations', 'listStickers', 'queryChatHistory',
    'renameConversation', 'sendMessage'
  ],
  AttachmentBackendPort: ['readToolAttachment', 'signAttachmentUrl', 'uploadAttachments'],
  ModelBackendPort: [
    'activateModelProfile', 'deleteModelProfile', 'getActiveModelSelection', 'listModelProfiles', 'listTtsVoices',
    'previewTts', 'saveModelProfile', 'setTtsVoice', 'testModelProfile'
  ],
  VoiceBackendPort: [
    'audioCancel', 'cancelDictation', 'cancelRealtimeVoice', 'commitVoice', 'discardVoice', 'sendAudioBytes',
    'startDictation', 'startRealtimeVoice', 'startRecordVoice', 'stopDictation', 'stopRealtimeVoice', 'stopRecordVoice'
  ],
  ToolBackendPort: ['getToolCallStatus', 'submitToolResult', 'uploadToolAttachment']
} as const satisfies Record<string, readonly string[]>

/**
 * 消费方 → 它允许从 `backend-ports.ts` 导入的名字（**硬编码契约**，见文件头"判别口径"）。
 * 每行的含义就是"这个模块能用哪些后端能力"——比聚合面的 43 个方法窄得多。
 *
 * 表里除端口外还出现两个**端口载荷类型**（`UploadContent` 是 uploadAttachments 的入参、
 * `BackendEventHandler` 是 subscribe 的回调类型）与聚合面 `BackendAdapter`：它们刻意与端口同址，
 * 于是"某个模块从后端契约模块导入了什么"是可穷举的——新增任何导入都必须显式改这张表。
 */
const CONSUMER_PORTS: Record<string, string[]> = {
  'chat/chat-service.ts': ['BackendConnectionPort', 'BackendEventSourcePort', 'ChatBackendPort'],
  'diagnostics/diagnostics-service.ts': ['BackendEventSourcePort'],
  'characters/character-service-assembly.ts': ['BackendConnectionPort'],
  'attachments/upload-service.ts': ['AttachmentBackendPort', 'UploadContent'],
  'attachments/media-service.ts': ['AttachmentBackendPort'],
  'voice/voice-handlers.ts': ['VoiceBackendPort'],
  'models/model-handlers.ts': ['ModelBackendPort'],
  'ipc/handlers.ts': ['ModelBackendPort', 'VoiceBackendPort'],
  'tools/tool-status-sender.ts': ['ToolBackendPort'],
  // 聚合面自身：7 个端口的交集（它只能 extend，不得再声明方法）
  'transport/backend-adapter.ts': [
    'AttachmentBackendPort', 'BackendConnectionPort', 'BackendEventSourcePort', 'ChatBackendPort',
    'ModelBackendPort', 'ToolBackendPort', 'VoiceBackendPort'
  ],
  // 传输层实现：只从端口模块取共享载荷类型（UploadContent / BackendEventHandler）
  'transport/real-backend.ts': ['BackendEventHandler', 'UploadContent'],
  'transport/mock-backend.ts': ['BackendEventHandler', 'UploadContent'],
  // 组合根：容器只分发连接/voice/model 三张视图（其余视图在构造期直接注入各自服务）
  'bootstrap/services.ts': ['BackendConnectionPort', 'ModelBackendPort', 'ToolBackendPort', 'VoiceBackendPort'],
  // 入口：只取连接视图做「当前激活会话」探针（不持有聚合面）
  'index.ts': ['BackendConnectionPort']
}

function parse(relativePath: string): ts.SourceFile {
  return parseSource(rel(relativePath), readFileSync(rel(relativePath), 'utf8'))
}

/** 独立出来供"判别力自证"注入合成源码后复用同一实现 */
function parseSource(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, /* setParentNodes */ false, ts.ScriptKind.TS)
}

/** main 下所有 .ts（跳过 .d.ts） */
function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) { collectFiles(absolute, out); continue }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(absolute)
  }
  return out
}

/**
 * `sourceFile`（位于 `file`）对模块 `targetModule`（无扩展名绝对路径）的**具名**依赖：
 * `import { X } from` / `import { type X } from` / `export { X } from` / `export type { X } from`
 * 的具名项。用**路径解析**而不是字符串后缀匹配（同一模块在不同目录下的相对写法各不相同），
 * 并按本仓 `allowImportingTsExtensions` 归一带扩展名的写法。
 */
function importedNamesFrom(sourceFile: ts.SourceFile, file: string, targetModule: string): string[] {
  const names: string[] = []
  const collect = (bindings: ts.NamedImportBindings | ts.NamedExportBindings | undefined): void => {
    if (!bindings || (!ts.isNamedImports(bindings) && !ts.isNamedExports(bindings))) return
    for (const element of bindings.elements) names.push((element.propertyName ?? element.name).text)
  }
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!resolvesTo(statement.moduleSpecifier)) continue
      collect(statement.importClause?.namedBindings)
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      if (!resolvesTo(statement.moduleSpecifier)) continue
      collect(statement.exportClause)
    }
  }
  return names.sort()

  function resolvesTo(specifier: ts.Expression): boolean {
    if (!ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) return false
    return resolve(dirname(file), specifier.text).replace(/\.ts$/, '') === targetModule
  }
}

/**
 * 该文件**是否以任何形式**引用模块 `targetModule`（含具名之外的写法）。
 *
 * 为什么不能只看具名 import（2026-09-17 反向 review H1 的实测结论）：下面三种写法都能在不被
 * `importedNamesFrom` 看见的情况下依赖聚合面/端口，其中"转出口 barrel"还能把下游整段依赖隐藏掉：
 *   · `import type * as T from './backend-adapter'`（命名空间）
 *   · `type A = typeof import('./backend-adapter').BackendAdapter`（ImportTypeNode / typeof import）
 *   · `export type { BackendAdapter } from './backend-adapter'`（转出口，供他人再 import）
 * 故"谁依赖了这个模块"一律用本函数判定；具名表只用于"依赖了哪些名字"的逐字对账。
 */
function referencesModule(sourceFile: ts.SourceFile, file: string, targetModule: string): boolean {
  const resolvesTo = (specifier: ts.Expression): boolean =>
    ts.isStringLiteral(specifier) && specifier.text.startsWith('.') &&
    resolve(dirname(file), specifier.text).replace(/\.ts$/, '') === targetModule
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      // 具名 / 命名空间 / 默认 / 副作用 import 与 `export ... from` 一律计（moduleSpecifier 可能缺省）
      if (node.moduleSpecifier && resolvesTo(node.moduleSpecifier)) { found = true; return }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const reference = node.moduleReference.expression
      if (reference && resolvesTo(reference)) { found = true; return }
    } else if (ts.isImportTypeNode(node)) {
      // `type A = typeof import('./x').Y` / `import('./x').Y`（类型位置的 import）
      if (ts.isLiteralTypeNode(node.argument) && resolvesTo(node.argument.literal)) { found = true; return }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments
      if (argument && resolvesTo(argument)) { found = true; return }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

/** 文件里所有 `Pick<XPort, 'a' | 'b'>` 视图（消费方用 Pick 声明"我只要这几项能力"时的实际面） */
function pickViews(sourceFile: ts.SourceFile): Array<{ port: string; keys: string[] }> {
  const views: Array<{ port: string; keys: string[] }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === 'Pick') {
      const [portArgument, keysArgument] = node.typeArguments ?? []
      if (portArgument && keysArgument && ts.isTypeReferenceNode(portArgument) && ts.isIdentifier(portArgument.typeName)) {
        const literals = ts.isUnionTypeNode(keysArgument) ? [...keysArgument.types] : [keysArgument]
        const keys = literals
          .filter((literal): literal is ts.LiteralTypeNode => ts.isLiteralTypeNode(literal) && ts.isStringLiteral(literal.literal))
          .map((literal) => (literal.literal as ts.StringLiteral).text)
        if (keys.length > 0) views.push({ port: portArgument.typeName.text, keys: keys.sort() })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return views
}

/** 文件里是否出现标识符 `name`（**按 AST 判定**：注释/JSDoc 不算，barrel 转出口也绕不过） */
function referencesName(sourceFile: ts.SourceFile, name: string): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isIdentifier(node) && node.text === name) { found = true; return }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

/** 类型别名右侧的交集成员（如 `type ChatServiceBackendPort = A & B & C`） */
function intersectionAliasMembers(sourceFile: ts.SourceFile, aliasName: string): string[] {
  for (const statement of sourceFile.statements) {
    if (!ts.isTypeAliasDeclaration(statement) || statement.name.text !== aliasName) continue
    const members: string[] = []
    const collect = (node: ts.TypeNode): void => {
      if (ts.isIntersectionTypeNode(node)) { for (const part of node.types) collect(part); return }
      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) members.push(node.typeName.text)
    }
    collect(statement.type)
    return members.sort()
  }
  throw new Error(`未找到类型别名 ${aliasName}`)
}

/** `ApplicationServices.backend` 的键集（组合根向后续阶段分发的后端视图；多一张即能力面变宽） */
function applicationServicesBackendKeys(sourceFile: ts.SourceFile): string[] {
  for (const statement of sourceFile.statements) {
    if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== 'ApplicationServices') continue
    for (const member of statement.members) {
      if (!ts.isPropertySignature(member) || !ts.isIdentifier(member.name) || member.name.text !== 'backend') continue
      const type = member.type
      if (!type || !ts.isTypeLiteralNode(type)) throw new Error('ApplicationServices.backend 必须是内联类型字面量（门禁需读出键集）')
      return type.members
        .filter((m): m is ts.PropertySignature => ts.isPropertySignature(m) && !!m.name && ts.isIdentifier(m.name))
        .map((m) => (m.name as ts.Identifier).text)
        .sort()
    }
  }
  throw new Error('未找到 ApplicationServices.backend')
}

/** 该文件的模块身份（相对 main 的 posix 风格路径），与 `CONSUMER_PORTS` 的键同构 */
const moduleId = (file: string): string => relative(MAIN_DIR, file).replace(/\\/g, '/')

/** 接口的成员名（方法签名 + 属性签名）与 extends 列表 */
function interfaceShape(sourceFile: ts.SourceFile, name: string): { members: string[]; extendsNames: string[] } {
  for (const statement of sourceFile.statements) {
    if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== name) continue
    const members = statement.members.map((member) => {
      const memberName = member.name
      if (!memberName || !ts.isIdentifier(memberName)) throw new Error(`${name} 存在非具名成员（门禁无法判定）`)
      return memberName.text
    })
    const extendsNames = (statement.heritageClauses ?? [])
      .filter((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
      .flatMap((clause) => clause.types.map((type) => {
        // `setParentNodes: false` 下 getText() 不可用，直接取标识符文本（本仓聚合面只 extend 具名接口）
        if (!ts.isIdentifier(type.expression)) throw new Error(`${name} 的 extends 子句不是具名接口`)
        return type.expression.text
      }))
    return { members: members.sort(), extendsNames }
  }
  throw new Error(`未找到接口 ${name}`)
}

/** 类的**公开**方法/访问器名（private/protected 不计；构造函数不计） */
function publicClassMembers(sourceFile: ts.SourceFile, name: string): string[] {
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name?.text !== name) continue
    const members: string[] = []
    for (const member of statement.members) {
      const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) ?? [] : []
      if (modifiers.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword)) continue
      if (!ts.isMethodDeclaration(member) && !ts.isGetAccessorDeclaration(member)) continue
      if (ts.isIdentifier(member.name)) members.push(member.name.text)
    }
    return members.sort()
  }
  throw new Error(`未找到类 ${name}`)
}

/** 文件里导出的全部 interface / type 别名名（用于"端口文件里不得悄悄多出契约"的守卫） */
function exportedTypeNames(sourceFile: ts.SourceFile): { interfaces: string[]; aliases: string[] } {
  const interfaces: string[] = []
  const aliases: string[] = []
  for (const statement of sourceFile.statements) {
    const isExported = ts.canHaveModifiers(statement)
      ? (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      : false
    if (!isExported) continue
    if (ts.isInterfaceDeclaration(statement)) interfaces.push(statement.name.text)
    if (ts.isTypeAliasDeclaration(statement)) aliases.push(statement.name.text)
  }
  return { interfaces: interfaces.sort(), aliases: aliases.sort() }
}

/** 文件里所有 `Pick<X, 'a' | 'b'>` 的键（角色域端口由 shared 冻结契约派生，键即其方法集） */
function pickKeys(sourceFile: ts.SourceFile): string[] {
  const keys: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === 'Pick') {
      const keysArgument = node.typeArguments?.[1]
      if (keysArgument) {
        const literals = ts.isUnionTypeNode(keysArgument) ? [...keysArgument.types] : [keysArgument]
        for (const literal of literals) {
          if (ts.isLiteralTypeNode(literal) && ts.isStringLiteral(literal.literal)) keys.push(literal.literal.text)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return keys
}

const portsSource = parse('transport/backend-ports.ts')
const aggregateSource = parse('transport/backend-adapter.ts')
const realSource = parse('transport/real-backend.ts')
const mockSource = parse('transport/mock-backend.ts')

const PORT_NAMES = Object.keys(PORT_SURFACE)
const portMembers = new Map(PORT_NAMES.map((name) => [name, interfaceShape(portsSource, name).members]))
/**
 * 两个"设计常量"：端口数量与方法总数（= 架构整改 Prompt 3 拆分前 `BackendAdapter` 的方法数）。
 * 它们**刻意写死**：变化本身就是要人停下来重新审视的信号（新增端口 / 增删后端能力），
 * 而不是"跑一遍就自动跟上"的东西。改它们时同步改 PORT_SURFACE 与 CONSUMER_PORTS。
 */
const EXPECTED_PORT_COUNT = 7
const EXPECTED_METHOD_TOTAL = 43

describe('后端能力端口：冻结清单（架构整改 Prompt 3）', () => {
  it('领域端口数量冻结（新增端口是设计决策，必须显式改本文件的常量与表）', () => {
    // 20+ 是本批明确要求"停下来重新审视"的数量级；改这个常量＝承诺重新解释为什么还需要那么多
    expect(PORT_NAMES.length, `端口数量变化：请同步 EXPECTED_PORT_COUNT(${EXPECTED_PORT_COUNT})、PORT_SURFACE 与 CONSUMER_PORTS`).toBe(EXPECTED_PORT_COUNT)
    expect(PORT_NAMES).toEqual([
      'BackendConnectionPort', 'BackendEventSourcePort', 'ChatBackendPort',
      'AttachmentBackendPort', 'ModelBackendPort', 'VoiceBackendPort', 'ToolBackendPort'
    ])
  })

  it('端口文件里除这 7 个端口外不得再导出别的对象契约（含 type 别名形式的"第 8 个端口"）', () => {
    const declared = exportedTypeNames(portsSource)
    // 允许的两个**载荷类型**（端口方法的入参/回调类型），不是能力面
    const PAYLOAD_INTERFACES = ['UploadContent']
    const PAYLOAD_ALIASES = ['BackendEventHandler']
    expect(declared.interfaces.filter((n) => !PAYLOAD_INTERFACES.includes(n))).toEqual([...PORT_NAMES].sort())
    expect(declared.aliases).toEqual(PAYLOAD_ALIASES)
  })

  it('每个端口的方法名与冻结表逐字一致（能力不会静默丢失或漂移）', () => {
    for (const name of PORT_NAMES) {
      expect(portMembers.get(name), `${name} 的成员与冻结表不一致（改端口必须同步 PORT_SURFACE）`).toEqual([...PORT_SURFACE[name as keyof typeof PORT_SURFACE]])
    }
  })

  it('端口不得互相 extends（继承会把别的端口的能力重新暴露给本端口的消费方）', () => {
    const withHeritage = PORT_NAMES.filter((name) => interfaceShape(portsSource, name).extendsNames.length > 0)
    // 唯一允许有 extends 的是聚合面（`backend-adapter.ts` 显式组合 7 个端口）
    expect(withHeritage, '端口必须是扁平的：组合只发生在聚合面，不在端口之间').toEqual([])
  })

  it('端口之间方法不重叠（每个后端能力恰好属于一个端口）', () => {
    const seen = new Map<string, string>()
    const duplicates: string[] = []
    for (const name of PORT_NAMES) {
      for (const member of portMembers.get(name) ?? []) {
        const owner = seen.get(member)
        if (owner) duplicates.push(`${member}: ${owner} & ${name}`)
        else seen.set(member, name)
      }
    }
    expect(duplicates, '同一方法被两个端口声明（依赖面被重复暴露）').toEqual([])
    expect(seen.size, `端口并集应覆盖全部 ${EXPECTED_METHOD_TOTAL} 个后端方法（数量变化请同步 EXPECTED_METHOD_TOTAL 与 PORT_SURFACE）`).toBe(EXPECTED_METHOD_TOTAL)
  })

  it('除事件源外不存在单方法端口（禁止"一个方法一个 interface"）', () => {
    const singleMethod = PORT_NAMES.filter((name) => (portMembers.get(name) ?? []).length === 1)
    // 事件源是唯一豁免：它的全部能力就是 subscribe，且有两个需求不同的消费者（chat 转发 / diagnostics tap）
    expect(singleMethod).toEqual(['BackendEventSourcePort'])
  })

  it('端口契约模块是 Main 依赖图里的叶子：只 import `@shared/**`（不碰 main 内部、也不碰 raw 协议层）', () => {
    const specifiers = portsSource.statements
      .filter(ts.isImportDeclaration)
      .map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text)
    // 叶子的含义：① 端口只在编译期存在、不可能参与任何 Main 运行时环；② 端口无法引用
    // `protocol-v2/**` 的 raw schema / 帧 mapper / 后端 DTO，故"参数是域形状"这条不是靠人盯。
    const offenders = specifiers.filter((specifier) => !specifier.startsWith('@shared/'))
    expect(offenders, '端口模块只允许 import @shared/**').toEqual([])
    expect(specifiers.length, '未解析到端口模块的 import（扫描器退化）').toBeGreaterThan(5)
  })

  it('聚合面 = 7 个端口的交集 + 传输层接线槽；自身不声明任何方法', () => {
    const aggregate = interfaceShape(aggregateSource, 'BackendAdapter')
    expect(aggregate.extendsNames.sort()).toEqual([...PORT_NAMES].sort())
    // 聚合面自己的成员只有接线槽（可选属性），不得有任何方法——否则它又会变回可以就地增长的地方
    expect(aggregate.members).toEqual(['onToolRequest'])
    const own = aggregateSource.statements.find((s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === 'BackendAdapter')
    const slot = own?.members[0]
    expect(slot && ts.isPropertySignature(slot), 'onToolRequest 必须是属性（接线槽）而不是方法').toBe(true)
    expect(slot && ts.isPropertySignature(slot) && slot.questionToken !== undefined, 'onToolRequest 必须可选（mock 不实现）').toBe(true)
  })
})

describe('RealBackend / MockBackend 与端口契约一致', () => {
  it('编译期断言就位（不满足时 pnpm typecheck 红）且运行期恒真', () => {
    expect(conforms).toEqual([true, true, true, true, true, true, true, true])
  })

  it('两个实现类都声明了每个端口的全部方法（源码级：签名漂移在这里红）', () => {
    const realMembers = new Set(publicClassMembers(realSource, 'RealBackend'))
    const mockMembers = new Set(publicClassMembers(mockSource, 'MockBackend'))
    const missing: string[] = []
    for (const name of PORT_NAMES) {
      for (const member of portMembers.get(name) ?? []) {
        if (!realMembers.has(member)) missing.push(`RealBackend.${member}（${name}）`)
        if (!mockMembers.has(member)) missing.push(`MockBackend.${member}（${name}）`)
      }
    }
    expect(missing, '实现类缺少端口声明的方法').toEqual([])
  })

  it('实现类的额外公开成员只允许是接线槽/测试夹具或角色域端口（新增能力必须落到端口）', () => {
    const portUnion = new Set([...portMembers.values()].flat())
    // 角色域方法由 `character-backend-port.ts` 的 Pick 组合覆盖（derived from shared 冻结契约），不在这 7 个端口内
    const characterKeys = pickKeys(parse('characters/character-backend-port.ts'))
    expect(characterKeys.length, '未解析到角色域端口键（扫描器退化）').toBeGreaterThan(10)
    // 允许的额外公开成员：real 的 token setter（单测注入）、mock 的测试夹具与释放钩子
    const ALLOWED_EXTRA = new Set(['setToken', 'dispose', 'generateMultiSegmentEvents', 'ttsActive'])
    for (const [label, source, className] of [['RealBackend', realSource, 'RealBackend'], ['MockBackend', mockSource, 'MockBackend']] as const) {
      const extra = publicClassMembers(source, className)
        .filter((m) => !portUnion.has(m) && !characterKeys.includes(m) && !ALLOWED_EXTRA.has(m))
      expect(extra, `${label} 出现未归入任何端口的公开成员（新增能力必须落到端口）`).toEqual([])
    }
  })
})

describe('Application Service 的后端依赖面（消费方 → 端口）', () => {
  const mainFiles = collectFiles(MAIN_DIR)
  /** 每个 main 文件 import 的端口名 / 聚合面名（路径解析后的判定结果） */
  const portsImporters = new Map<string, string[]>()
  const aggregateImporters = new Map<string, string[]>()
  /** "是否以任何形式引用该模块"（命名空间 / typeof import / 转出口 barrel 也算） */
  const portsReferrers = new Set<string>()
  const aggregateReferrers = new Set<string>()
  for (const file of mainFiles) {
    const sourceFile = parseSource(file, readFileSync(file, 'utf8'))
    const ports = importedNamesFrom(sourceFile, file, PORTS_MODULE)
    const aggregate = importedNamesFrom(sourceFile, file, AGGREGATE_MODULE)
    if (ports.length > 0) portsImporters.set(moduleId(file), ports)
    if (aggregate.length > 0) aggregateImporters.set(moduleId(file), aggregate)
    if (referencesModule(sourceFile, file, PORTS_MODULE)) portsReferrers.add(moduleId(file))
    if (referencesModule(sourceFile, file, AGGREGATE_MODULE)) aggregateReferrers.add(moduleId(file))
  }

  it('扫描面非空（防解析退化导致下面几条恒真）', () => {
    expect(mainFiles.length).toBeGreaterThan(100)
    expect([...portsImporters.keys()].length).toBeGreaterThan(5)
    expect([...aggregateImporters.keys()].length).toBeGreaterThan(1)
  })

  it('聚合面只允许被传输层实现与组合根引用（Application Service 一律不得持有）', () => {
    // 用 referencesModule 而不是具名 import：命名空间 import / `typeof import()` / 转出口 barrel 都不放过
    const allowed = (id: string): boolean => id.startsWith('transport/') || id.startsWith('bootstrap/')
    const offenders = [...aggregateReferrers].filter((id) => !allowed(id))
    expect(offenders, 'Application Service 不得依赖聚合 BackendAdapter（应依赖领域端口）').toEqual([])
  })

  it('端口契约只允许被登记过的模块引用（barrel / 命名空间写法同样必须登记）', () => {
    const expected = new Set(Object.keys(CONSUMER_PORTS))
    const unregistered = [...portsReferrers].filter((id) => !expected.has(id))
    expect(unregistered, '出现未登记的端口引用点——必须在 CONSUMER_PORTS 里显式声明它的依赖面').toEqual([])
  })

  it('聚合面类型名不得出现在传输层与组合根之外（按标识符判定：转出口 barrel 也绕不过）', () => {
    // 为什么还要按**标识符**再判一次：`transport/**` 里若出现 barrel（`export type { BackendAdapter } from …`），
    // 下游服务 import 的是 barrel 而不是 backend-adapter，上面那条基于模块路径的判定就看不见了。
    // 类型名只要在服务代码里出现，就说明它拿到了聚合面——与它经哪条路径拿到无关。
    const allowed = (id: string): boolean => id.startsWith('transport/') || id.startsWith('bootstrap/')
    const offenders = mainFiles
      .map(moduleId)
      .filter((id) => !allowed(id))
      .filter((id) => referencesName(parse(id), 'BackendAdapter'))
    expect(offenders, '传输层与组合根之外的模块不得引用聚合类型 BackendAdapter').toEqual([])
  })

  it('每个消费方导入的端口集合与冻结表逐字一致（依赖面可见且不可静默扩大）', () => {
    const rows = [...portsImporters.entries()].sort()
    expect(Object.fromEntries(rows), '后端端口依赖面发生变化——必须显式更新本文件的 CONSUMER_PORTS').toEqual(
      Object.fromEntries(Object.entries(CONSUMER_PORTS).sort())
    )
  })

  it('用 Pick 声明窄视图的消费方，其 Pick 键集与冻结表逐字一致（端口内收窄也不许悄悄变宽）', () => {
    const expected: Record<string, Array<{ port: string; keys: string[] }>> = {
      'attachments/upload-service.ts': [{ port: 'AttachmentBackendPort', keys: ['uploadAttachments'] }],
      'attachments/media-service.ts': [{ port: 'AttachmentBackendPort', keys: ['readToolAttachment', 'signAttachmentUrl'] }],
      'tools/tool-status-sender.ts': [{ port: 'ToolBackendPort', keys: ['submitToolResult', 'uploadToolAttachment'] }]
    }
    for (const [relativePath, expectedViews] of Object.entries(expected)) {
      const views = pickViews(parse(relativePath))
      // media-service 的两个 Pick（sign + Partial<read>）合并成一条视图键集对比
      const merged = new Map<string, Set<string>>()
      for (const view of views) {
        const keys = merged.get(view.port) ?? new Set<string>()
        for (const key of view.keys) keys.add(key)
        merged.set(view.port, keys)
      }
      const normalized = [...merged.entries()].map(([port, keys]) => ({ port, keys: [...keys].sort() })).sort((a, b) => a.port.localeCompare(b.port))
      expect(normalized, `${relativePath} 的 Pick 视图发生变化`).toEqual([...expectedViews].sort((a, b) => a.port.localeCompare(b.port)))
    }
    // ChatService 用的是交集别名（需要 3 个端口的全量能力），成员同样逐字冻结
    expect(intersectionAliasMembers(parse('chat/chat-service.ts'), 'ChatServiceBackendPort')).toEqual(
      ['BackendConnectionPort', 'BackendEventSourcePort', 'ChatBackendPort']
    )
  })

  it('组合根只分发连接/voice/model 三张视图，且不持有聚合面', () => {
    for (const bootstrapFile of ['bootstrap/services.ts', 'bootstrap/register-ipc.ts', 'bootstrap/wire.ts', 'bootstrap/shutdown-sequence.ts', 'bootstrap/test-probe.ts']) {
      expect(aggregateImporters.get(bootstrapFile) ?? [], `${bootstrapFile} 不应持有聚合面`).toEqual([])
    }
    expect(portsImporters.get('bootstrap/services.ts')).toEqual(['BackendConnectionPort', 'ModelBackendPort', 'ToolBackendPort', 'VoiceBackendPort'])
    // ApplicationServices.backend 的键集同样冻结（多分发一张视图＝组合根对外能力面变宽）
    expect(applicationServicesBackendKeys(parse('bootstrap/services.ts'))).toEqual(['connection', 'model', 'voice'])
  })
})

describe('门禁判别力自证（缺失即"恒真绿灯"）', () => {
  const probePath = rel('transport', 'probe-fixture.ts')

  it('importedNamesFrom 按**路径**解析（认得 `import type` / `import { type X }` / 带扩展名 / `export ... from`）', () => {
    const source = parseSource(probePath, [
      "import type { BackendAdapter } from './backend-adapter'",
      "import { type ChatBackendPort, type VoiceBackendPort } from './backend-ports'",
      "import type { ModelBackendPort } from '../models/model-backend-port'",
      "import type { SomethingElse } from './backend-ports-extra'",
      "export type { BackendConnectionPort } from '../transport/backend-ports.ts'"
    ].join('\n'))
    expect(importedNamesFrom(source, probePath, AGGREGATE_MODULE)).toEqual(['BackendAdapter'])
    expect(importedNamesFrom(source, probePath, PORTS_MODULE)).toEqual(['BackendConnectionPort', 'ChatBackendPort', 'VoiceBackendPort'])
  })

  // 反向 review H1 的实测形态：这些写法都不产生"具名 import"，只靠 importedNamesFrom 会全部漏判
  const BYPASS_FORMS: Array<[label: string, snippet: string]> = [
    ['命名空间 import', "import type * as T from './backend-adapter'"],
    ['typeof import()', "type A = typeof import('./backend-adapter').BackendAdapter"],
    ['类型位置 import()', "type B = import('./backend-adapter').BackendAdapter"],
    ['import = require', "import T = require('./backend-adapter')"],
    ['动态 import()', "const m = await import('./backend-adapter')"]
  ]

  it('referencesModule 抓得住全部绕过具名 import 的依赖写法（每一条都由反向 review 证伪过）', () => {
    for (const [label, snippet] of BYPASS_FORMS) {
      const source = parseSource(probePath, snippet)
      expect(referencesModule(source, probePath, AGGREGATE_MODULE), `${label} 未被判定为依赖`).toBe(true)
      // 对照：具名收集器对这些写法**看不到任何名字**（正是它需要 referencesModule 兜底的原因）
      expect(importedNamesFrom(source, probePath, AGGREGATE_MODULE), `${label} 意外产出了具名项`).toEqual([])
    }
  })

  it('转出口 barrel 自身可被具名收集器看见，其**下游**由"未登记引用点"用例兜住', () => {
    const source = parseSource(probePath, "export type { BackendAdapter } from './backend-adapter'")
    expect(importedNamesFrom(source, probePath, AGGREGATE_MODULE)).toEqual(['BackendAdapter'])
    expect(referencesModule(source, probePath, AGGREGATE_MODULE)).toBe(true)
  })

  it('referencesModule 不误判同前缀模块与类型名巧合', () => {
    const source = parseSource(probePath, [
      "import type { SomethingElse } from './backend-adapter-extra'",
      "type C = typeof import('./backend-ports').ChatBackendPort"
    ].join('\n'))
    expect(referencesModule(source, probePath, AGGREGATE_MODULE)).toBe(false)
    expect(referencesModule(source, probePath, PORTS_MODULE)).toBe(true)
  })

  it('interfaceShape / publicClassMembers 对合成源码给出预期形状（扫描器未退化）', () => {
    const source = parseSource(probePath, [
      'export interface P { a(): void; b?: () => void }',
      'export interface Q extends P { c(): void }',
      'export class Impl implements Q {',
      '  a(): void {}',
      '  private hidden(): void {}',
      '  get b(): (() => void) | undefined { return undefined }',
      '  c(): void {}',
      '}'
    ].join('\n'))
    expect(interfaceShape(source, 'P')).toEqual({ members: ['a', 'b'], extendsNames: [] })
    expect(interfaceShape(source, 'Q')).toEqual({ members: ['c'], extendsNames: ['P'] })
    expect(publicClassMembers(source, 'Impl')).toEqual(['a', 'b', 'c'])
  })
})
