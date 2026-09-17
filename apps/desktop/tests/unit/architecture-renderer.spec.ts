// tests/unit/architecture-renderer.spec.ts（架构门禁，2026-09-17 架构整改 Prompt 5）
//
// 目的：把 Renderer 侧两条**只写在文档里**的边界升级成机械门禁——
//   ① Renderer 是**不可信进程**：不得依赖 Main / Preload 的实现，不得碰 Electron 与特权 Node API；
//   ② Renderer 的**纯域模块层**（Prompt 4 下沉出来的判据模块）不得依赖 Vue / Pinia / store / 组件 /
//      renderer bootstrap。
//
// 背景（Prompt 5 的事实基线）：Prompt 4 建立的纯域模块此前**只有文档与约定**在守——
// `docs/20-...架构现状总览.md` §2.2 当时原文即「分层规则…目前只由文档与约定承担」，
// 而 `store-graph.spec.ts` 只扫 `stores/*.store.ts` 之间的环。也就是说把
// `import { useMessageStore } from '../stores/message.store'` 写进 `message/attribution.ts`
// 不会产生任何红灯——依赖倒置会静默发生，直到某个纯模块单测因为需要 Pinia 实例而崩掉。
//
// ── 判别口径（关键取舍）────────────────────────────────────────────────────────
//   · **按 matcher 分类，不按目录一刀切**。"同目录"不等于"同层"：
//       `renderer/src/stores/live2d.store.ts`    = Pinia facade
//       `renderer/src/live2d/directive-rules.ts` = 纯域判据
//       `renderer/src/composables/live2d-state-source.ts` = Vue 集成（运行时 `watch`）
//     故 `live2d/**` 既不是"全是 domain"也不是"全是集成"——分类见下面的 `isPureRegion` 谓词。
//   · **纯域 = 补集而非白名单**：`renderer/src/**` 减去 Vue 集成面（stores / components /
//     composables / bootstrap / `.vue` / vendored / 一个显式登记的 Vue 框架适配器）就是纯域。
//     新增 `renderer/src/xxx/` 目录**自动**被保护，不需要回来手工登记；往里面放需要 Vue 的文件
//     会被专门用例追问，逼一次显式决定。
//     反面教材（本规则刻意避免的形态）：`const DOMAIN_FILES = ['message/domain.ts', …]`——
//     每加一个域模块都要手工更新清单，且漏更新时门禁静默失效。
//   · **类型边按规则分别处理——不是"永远合法"**（提交前边界一致性复核修正）：
//     `import type` 编译期擦除、不产生运行时耦合，这是**事实**；但"因此它对任何层都合法"是**推论，不成立**。
//     本文件据此分两类：
//       - 目标是**框架机制**（`vue` 的 `Ref`/`WatchStopHandle`、`pinia`）：类型面不引入框架语义 ⇒ 放过类型边
//         （`纯域不得值导入 vue` 那条用例只拦运行时）。
//       - 目标是**下游层**（`stores/**` / `components/**` / renderer bootstrap）：它们的类型是**实现细节的
//         所有权**，域模块引用它会形成 compile-time 依赖倒置 ⇒ **类型边同样禁止**（见 Rule 3 第三条用例）。
//     三条规则各自写明自己的口径，读者不必猜。
//   · **分类 vs 例外**：本文件里唯一的清单是 `VUE_FRAMEWORK_ADAPTERS`（1 项），它是**分类**——
//     "把 Vue/浏览器机制接成响应式源"的通用适配器，因此不是纯域模块；它**不豁免任何规则**，
//     仍受 Rule 2（特权边界）与 Rule 4（bootstrap 方向）约束。新增项会被专门用例追问。
//   · **vendored 精确排除**：只排除 `renderer/src/live2d/framework/**`（Cubism SDK 第三方源码，
//     59 个 ts）。**不排除** `renderer/src/live2d/**`：Cyrene 自己的
//     `live2d/directive-rules.ts` / `state-machine.ts` / `gl/**` 仍受全部规则约束（mutation M10b 钉住）。
//   · **不做**"Renderer 只能依赖一个 store"这类不现实的规则：`components/**` 的 87 条 store 边、
//     组合根对具体层的广泛依赖都是**正确**的分层（facade 与组合根本来就要聚合）。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  SRC_DIR, SourceFileGraph, collectFiles, describeEdge, isSource, isVue, sourceId, srcPath
} from './helpers/architecture-imports'

const VENDORED_PREFIX = 'renderer/src/live2d/framework/'
const RENDERER_PREFIX = 'renderer/src/'
const STORES_PREFIX = 'renderer/src/stores/'
const COMPONENTS_PREFIX = 'renderer/src/components/'

/** renderer 里唯一的"框架包"依赖：能力入口只能是 window.cyrene，不得直接拿 electron */
const RENDERER_FORBIDDEN_PACKAGES: readonly string[] = ['electron']

/** 特权 Node 内建：renderer 无 Node 能力，import 它只有"构建期就坏"或"运行期 undefined"两种结局 */
const PRIVILEGED_BUILTINS: readonly string[] = [
  'fs', 'fs/promises', 'child_process', 'worker_threads', 'net', 'tls', 'dgram',
  'cluster', 'http', 'https', 'http2', 'vm', 'inspector', 'repl', 'readline',
  'module', 'process', 'v8', 'perf_hooks', 'async_hooks', 'diagnostics_channel', 'wasi', 'sqlite'
]
function nodeBuiltinName(specifier: string): string | null {
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier
  const base = bare.split('/')[0] ?? bare
  return PRIVILEGED_BUILTINS.includes(base) ? base : null
}

const isVendored = (id: string): boolean => id.startsWith(VENDORED_PREFIX)
const isStore = (id: string): boolean => id.startsWith(STORES_PREFIX)
const isComponent = (id: string): boolean => id.startsWith(COMPONENTS_PREFIX)
/**
 * **Vue 组合式函数目录**：`composables/**` 按 Vue 社区与本仓的目录语义就是"组件侧的可复用响应式单元"，
 * 属集成面而不是纯域面。整目录一次性分类（对抗 review FP-7 的实测：一个标准
 * `composables/useOnline.ts` 曾被判红，而它与已登记的 `document-visibility.ts` 是同一类东西）。
 * 该目录**不豁免任何规则**：Rule 2（特权边界）与 Rule 4（bootstrap 方向）照常生效。
 */
const COMPOSABLES_PREFIX = 'renderer/src/composables/'
const isComposable = (id: string): boolean => id.startsWith(COMPOSABLES_PREFIX)
/** renderer 组合根三件套：`main.ts`（挂载）/ `bootstrap.ts`（水合与订阅装配）/ `App.vue`（根组件） */
const isRendererBootstrap = (id: string): boolean =>
  id === 'renderer/src/bootstrap.ts' || id === 'renderer/src/main.ts' || id === 'renderer/src/App.vue'

/**
 * **Vue 框架适配器**：物理位置不在 stores/components/composables 里，但职责就是"把浏览器/Vue 机制
 * 接成响应式源"，因此不是纯域模块。**判定依据是它运行时用 Vue 原语**，不是"它在某目录里"。
 *
 * 为什么这不算"例外表"：例外表是"规则本该管、但这次放过"（会随时间腐化）；这里是**分类**——
 * `utils/document-visibility.ts` 与服务**所有**可见性消费方的通用响应式源同址是刻意的，
 * 把它算进纯域才是分类错误（它头注即写明"把 `document.hidden` 变成响应式 `visible`"）。
 *
 * **为什么只有一项**（2026-09-17 对抗 review 的收敛结果）：
 *   · 组件侧可复用的响应式单元放 `composables/**` 即由整目录分类，**不需要**登记；
 *   · 放在领域目录（`message/` `live2d/` …）里、又需要响应式的模块会被门禁判红并追问
 *     ——那正是我们想要的摩擦。`live2d/state-source.ts`（`watch` 编排）就是被这条规则
 *     判红后用**生产代码移动**（⇒ `composables/live2d-state-source.ts`）解决的，不是靠登记豁免；
 *   · 只有"与浏览器/框架机制同类、且刻意与领域目录同址"的通用源才值得占用这张表的一行。
 *
 * 规模守卫：下面的"未登记的 Vue 运行时依赖"用例会**逐个追问**新增项；本表不豁免任何规则，
 * 只影响"纯域面"的成员归属。
 */
const VUE_FRAMEWORK_ADAPTERS: readonly string[] = [
  'renderer/src/utils/document-visibility.ts'   // ref：把 document.visibilityState 变成响应式源（服务所有可见性消费方）
]

/**
 * **纯域面**（本门禁保护的对象）：`renderer/src/**` 里既不是 Vue 集成面、也不是 vendored 的源码。
 * 当前实测 51 个文件，覆盖 `message/` · `conversation/` · `voice/` · `composer/` ·
 * `character-editor/` · `live2d/` · `layout/` · `attachments/` · `utils/`（除 `document-visibility.ts`）。
 * 声明文件（`.d.ts`）也在扫描面上——它们的 import 同样是依赖边。
 */
const isPureRegion = (id: string): boolean =>
  id.startsWith(RENDERER_PREFIX) && !isVendored(id) && !isStore(id) && !isComponent(id) && !isComposable(id) &&
  !isRendererBootstrap(id) && !isVue(id) && !VUE_FRAMEWORK_ADAPTERS.includes(id)

// 扫描面刻意收窄到 src/renderer：本文件的规则都只问"renderer 往外引了什么"。
// 解析目标仍按真实文件系统解析（`resolveImport` 与扫描面无关），故 renderer 写
// `import '../../main/x'` 依旧会被解析成真实的 main 文件并判红（mutation M5 钉住）。
const graph = new SourceFileGraph(
  collectFiles(SRC_DIR, isSource).filter((file) => sourceId(file).startsWith(RENDERER_PREFIX))
)
const rendererIds = graph.files.map(sourceId)
const productionRendererIds = rendererIds.filter((id) => !isVendored(id))
const pureIds = rendererIds.filter(isPureRegion)

/**
 * **运行时依赖 Vue 的 renderer 文件**——由 import 图**算出来**，不是登记表。
 * 用于两件事：① 扫描面自证（集成面非空）；② 证明"哪些文件是集成面"是判定结果而非豁免名单。
 */
const vueRuntimeUsers = productionRendererIds.filter((id) =>
  graph.edgesOfId(id).some((edge) => !edge.typeOnly && edge.target.kind === 'bare' && edge.target.name === 'vue')
)
/** Vue 集成面 = 路径分类出的集成目录 + 运行时依赖 Vue 的文件（后者当前只有 2 个，见文件头） */
const integrationIds = productionRendererIds.filter((id) => !isPureRegion(id))
const integrationUserCount = vueRuntimeUsers.length

describe('扫描面自证（防分类失效导致下面几条恒真）', () => {
  it('renderer 源码被扫到，且 vendored 与 Cyrene 自有 Live2D 代码被正确区分', () => {
    expect(rendererIds.length, '未扫到 src/renderer 源码').toBeGreaterThan(150)
    expect(pureIds.length, '纯域面为空——分类谓词或扫描器已失效').toBeGreaterThan(40)
    expect(integrationIds.length, 'Vue 集成面为空——分类谓词已失效').toBeGreaterThan(60)
    expect(integrationUserCount, '没有任何文件运行时依赖 vue——解析器已失效').toBeGreaterThan(50)
    // 全量解析一次，让下面的规则用例共用同一份缓存（规则本身是毫秒级的）
    expect(graph.files.flatMap((file) => graph.edgesOf(file)).length, 'renderer 一条导入都没解析出来').toBeGreaterThan(200)
    // vendored 只排除 framework/**：Cyrene 自己的 live2d 文件必须**仍在**受保护面里
    const ownLive2d = pureIds.filter((id) => id.startsWith('renderer/src/live2d/'))
    expect(ownLive2d.length, 'live2d 自有代码被误当 vendored 排除了').toBeGreaterThanOrEqual(10)
    expect(ownLive2d, 'directive-rules 必须受纯域规则保护').toContain('renderer/src/live2d/directive-rules.ts')
    expect(ownLive2d, 'state-machine 必须受纯域规则保护').toContain('renderer/src/live2d/state-machine.ts')
  })

  it('正在使用 Vue 的文件里，只有已登记的框架适配器落在纯域面之外（新增项会被追问）', () => {
    // 这条用例是**登记点的守卫**：新出现一个"运行时依赖 Vue、但不在集成目录里"的文件时，
    // 它不会静默通过——这里会列出它，并给出三个修法（换目录 / 登记分类 / 去掉 Vue）。
    const unregistered = vueRuntimeUsers
      .filter((id) => !isVendored(id) && !id.endsWith('.vue'))
      .filter((id) => !['renderer/src/bootstrap.ts', 'renderer/src/main.ts', 'renderer/src/App.vue'].includes(id))
      .filter((id) => !isStore(id) && !isComponent(id) && !isComposable(id))
      .filter((id) => !VUE_FRAMEWORK_ADAPTERS.includes(id))
      .map((id) => id.replace('renderer/src/', ''))
      .sort()
    expect(
      unregistered,
      '出现了"运行时依赖 Vue、但不在 stores/components/composables/bootstrap，也未登记为框架适配器"的文件：\n' +
      `${unregistered.join('\n')}\n` +
      '请三选一：① 它是组件侧可复用的响应式单元 ⇒ 挪进 `renderer/src/composables/**`（整目录已分类为集成面）；' +
      '② 它是与 visibility/浏览器机制同类的通用响应式源 ⇒ 加进 VUE_FRAMEWORK_ADAPTERS 并写明理由；' +
      '③ 它本该是纯域判据 ⇒ 去掉 Vue，把编排留给 store/组件。\n' +
      '（不要为了让它变绿而放宽整个规则：纯域面的价值正是"不依赖框架"。）'
    ).toEqual([])
    // 反面读数：已登记的适配器必须**真的**在用 Vue（否则登记项已过期，该删）
    const stale = VUE_FRAMEWORK_ADAPTERS.filter((id) => !vueRuntimeUsers.includes(id))
    expect(stale, `下列登记项已不再运行时依赖 Vue，请从 VUE_FRAMEWORK_ADAPTERS 删除：\n${stale.join('\n')}`).toEqual([])
  })

  it('Prompt 4 下沉出来的域模块逐个都在纯域面上（回归锚点：少一个说明分类漏了）', () => {
    const expected = [
      'renderer/src/message/acceptance.ts',
      'renderer/src/message/attribution.ts',
      'renderer/src/message/domain.ts',
      'renderer/src/message/fencing.ts',
      'renderer/src/message/index-store.ts',
      'renderer/src/conversation/backend-identity.ts',
      'renderer/src/conversation/protocol.ts',
      'renderer/src/voice/session.ts',
      'renderer/src/composer/dictation-hold.ts',
      'renderer/src/character-editor/draft-patch.ts',
      'renderer/src/character-editor/draft-templates.ts',
      'renderer/src/live2d/directive-rules.ts'
    ]
    const missing = expected.filter((id) => !pureIds.includes(id))
    expect(missing, `下列纯域模块不在受保护面上（分类谓词出问题）：\n${missing.join('\n')}`).toEqual([])
  })

  it('分类谓词把"同目录不同层"分开：store 不是域模块，域模块不是 store', () => {
    expect(isPureRegion('renderer/src/stores/live2d.store.ts'), 'Pinia facade 不得被当成纯域').toBe(false)
    expect(isPureRegion('renderer/src/live2d/directive-rules.ts'), '纯域判据必须被保护').toBe(true)
    expect(isPureRegion('renderer/src/App.vue'), '根组件是集成面').toBe(false)
    expect(isPureRegion('renderer/src/live2d/framework/cubismmodel.ts'), 'vendored 不得被保护').toBe(false)
  })
})

describe('Rule 2 · Renderer 特权边界：不可信进程不得拿 Main / Electron 能力', () => {
  it('renderer 不得 import main / preload 的实现（值边与类型边都不允许）', () => {
    const offenders: string[] = []
    for (const { from, edge } of graph.forEachEdge()) {
      if (!from.startsWith(RENDERER_PREFIX) || isVendored(from)) continue
      if (edge.target.kind !== 'file') continue
      const target = sourceId(edge.target.file)
      if (target.startsWith('main/') || target.startsWith('preload/')) offenders.push(describeEdge(from, edge))
    }
    expect(
      offenders,
      'Renderer 是不可信进程，不得依赖 Main / Preload 的实现（只能经 window.cyrene 的窄 API 取能力）：\n' +
      `${offenders.join('\n')}\n` +
      '需要的类型请从 @shared/** 取（跨进程契约层）；需要的能力请让 preload 暴露一个具名窄方法。'
    ).toEqual([])
  })

  it('renderer 不得 import electron（无 ipcRenderer、无 Node；能力入口只能是 window.cyrene）', () => {
    const offenders: string[] = []
    for (const { from, edge } of graph.forEachEdge()) {
      if (!from.startsWith(RENDERER_PREFIX) || isVendored(from)) continue
      if (edge.target.kind === 'bare' && RENDERER_FORBIDDEN_PACKAGES.includes(edge.target.name)) offenders.push(describeEdge(from, edge))
    }
    expect(
      offenders,
      'Renderer 不得直接依赖 electron：\n' +
      `${offenders.join('\n')}\n` +
      '能力入口是 window.cyrene（preload 的 contextBridge 面）。\n' +
      '注：`vue` / `pinia` 在本层是**正常依赖**（store 与组件本来就用它们）——它们受 Rule 3 约束，' +
      '即只允许出现在 Vue 集成面，不允许出现在纯域模块里。'
    ).toEqual([])
  })

  it('vue / pinia 的**值**导入只允许出现在 Vue 集成面（纯域面之外）', () => {
    const offenders = productionRendererIds
      .filter((id) => isPureRegion(id))
      .flatMap((id) => graph.edgesOfId(id)
        .filter((edge) => !edge.typeOnly && edge.target.kind === 'bare' && (edge.target.name === 'vue' || edge.target.name === 'pinia'))
        .map((edge) => describeEdge(id, edge)))
    expect(
      offenders,
      '框架包（vue / pinia）的值导入出现在纯域面上——分层被打穿：\n' +
      `${offenders.join('\n')}\n` +
      '这是 Rule 3 的兜底断言（纯域规则按"不得 import store/components/bootstrap"判定，' +
      '本条按"不得运行时依赖框架包"判定，两者互为补集）。'
    ).toEqual([])
  })

  it('renderer 不得 import 特权 Node 内建（fs / child_process / net / tls / worker_threads …）', () => {
    const offenders: string[] = []
    for (const { from, edge } of graph.forEachEdge()) {
      if (!from.startsWith(RENDERER_PREFIX) || isVendored(from) || edge.target.kind !== 'bare') continue
      const builtin = nodeBuiltinName(edge.target.name)
      if (builtin) offenders.push(`${describeEdge(from, edge)}   [privileged builtin: ${builtin}]`)
    }
    expect(
      offenders,
      'Renderer 里出现特权 Node 内建：打包后必然在运行期坏掉（或被迫引入 polyfill 掩盖分层）：\n' +
      `${offenders.join('\n')}\n` +
      '读盘 / 起进程 / 原生对话框都在 Main；Renderer 只经 window.cyrene 请求。'
    ).toEqual([])
  })
})

describe('Rule 3 · Renderer 纯域模块：不得依赖框架、store、组件与 bootstrap', () => {
  it('纯域不得 import pinia（任何形态，含类型边）', () => {
    const offenders: string[] = []
    for (const id of pureIds) {
      for (const edge of graph.edgesOfId(id)) {
        if (edge.target.kind === 'bare' && edge.target.name === 'pinia') offenders.push(describeEdge(id, edge))
      }
    }
    expect(
      offenders,
      '纯域模块不得依赖 Pinia —— 一旦依赖，它就必须在 Pinia 实例下才能被测试与复用：\n' +
      `${offenders.join('\n')}\n` +
      '允许的方向：store（facade）→ 纯域模块。判据要响应式时，由 store 侧 watch 后回调传入。'
    ).toEqual([])
  })

  it('纯域不得**值**导入 vue（`import type` 允许：编译期擦除，不产生运行时耦合）', () => {
    const offenders: string[] = []
    const typeOnlyUsers: string[] = []
    for (const id of pureIds) {
      for (const edge of graph.edgesOfId(id)) {
        if (edge.target.kind !== 'bare' || edge.target.name !== 'vue') continue
        if (edge.typeOnly) { typeOnlyUsers.push(id); continue }
        offenders.push(describeEdge(id, edge))
      }
    }
    expect(
      offenders,
      '纯域模块在**运行时**依赖了 Vue：\n' +
      `${offenders.join('\n')}\n` +
      '修法二选一：① 把该模块移出纯域面（它是 Vue 集成面，不是纯域判据）；' +
      '② 把 Vue 编排留在 store / 组件里，纯域模块只收值参数。\n' +
      '若它确实是"共用基础设施 + Vue 响应式"形态（如 document-visibility），' +
      '把它登记进 VUE_FRAMEWORK_ADAPTERS 并写明理由——登记点只有一个，且会在"未登记"用例里被追问。'
    ).toEqual([])
    // 记录读数而不是断言：纯域模块 `import type { Ref } from 'vue'` 是**合法**写法（编译期擦除）。
    // 当前为 0 个；将来出现时这里不会红，但读数会变，review 时可见。
    expect(typeOnlyUsers.filter((id) => !pureIds.includes(id)), '内部自洽性').toEqual([])
  })

  it('纯域不得 import store / 组件 / renderer bootstrap —— **含 `import type`**（compile-time 依赖同样是依赖）', () => {
    // ── 为什么这里**不**放过类型边（2026-09-17 提交前边界一致性复核的结论）──────────────
    // 本文件其他规则（Vue / pinia）都放过 `import type`，因为**目标本身是框架机制**（Ref/WatchStopHandle），
    // 类型面不引入框架语义。本条的三个目标不同：stores / components / bootstrap 是**下游层**，
    // 它们的类型是**实现细节的所有权**，不是中性契约：
    //   · `stores/viewer.store.ts` 的 state 类型 = 该 store 的实现形状；域模块引用它 ⇒ 纯域模块的编译面
    //     随 store 重构而改变，而 store 又依赖纯域模块 ⇒ **编译期依赖倒置**（这正是纯域存在要防的事）。
    //   · `components/**` 更甚：组件类型（props / expose）**定义上**就是"纯域的下游"，
    //     纯域引用它等于把消费者写进被消费者。
    //   · renderer bootstrap 是启动装配层，其类型描述的是装配参数，同样只属于组合根。
    // 所以：**type edge ≠ runtime edge**（本条不改这个事实，Vue/pinia 两条规则继续按它判），
    // 但**不同层的规则可以明确禁止 type-only 依赖**——这里就是。
    //
    // ── 事实基线（提交前实测，零违规）────────────────────────────────────────────────
    // 纯域面 55 个文件里，指向 stores/components/bootstrap 的类型边 = **0 条**；
    // 纯域面的类型边只落在：`shared/**`（23）· 同域纯模块（`./fencing`、`./gl/types` 等 5）·
    // vendored Cubism（9，仅 `live2d/` 与 `framework.d.ts`）。
    // 也就是说本条**不需要任何 exception**，也不需要迁移任何类型。
    //
    // ── 允许的方向（正对照见文末"合法依赖不被误伤"）────────────────────────────────
    // Store → 纯域模块（含类型）· 组件 → 纯域模块 · 纯域 → 同域纯模块 / shared / 通用 utils。
    const offenders: string[] = []
    for (const id of pureIds) {
      for (const edge of graph.edgesOfId(id)) {
        if (edge.target.kind !== 'file') continue
        const target = sourceId(edge.target.file)
        if (isStore(target) || isComponent(target) || isRendererBootstrap(target)) {
          offenders.push(`${describeEdge(id, edge)}${edge.typeOnly ? '   [类型边：同样禁止]' : ''}`)
        }
      }
    }
    expect(
      offenders,
      '纯域模块 import 了 store / 组件 / renderer bootstrap（**类型边也算**；允许的方向恰好相反）：\n' +
      `${offenders.join('\n')}\n` +
      '允许方向：Store / 组件 → 纯域模块 → 同域纯模块 / shared 契约 / 真正的通用 utils。\n' +
      '修法：① 需要状态 ⇒ 由调用方把值当参数传进来，不要 import store；\n' +
      '     ② 需要类型 ⇒ 该类型若是**中性契约**，它属于 shared 或该域自己的纯模块（在那里声明），\n' +
      '        不属于 store —— store 的类型是它的实现细节，引用它会把编译期依赖倒置；\n' +
      '     ③ 需要组件的 props/expose 类型 ⇒ 说明这段逻辑本就该住在组件里。'
    ).toEqual([])
  })

  it('纯域模块 → shared 契约 / 同域纯类型 / 通用 utils 类型（允许方向，正对照）', () => {
    // 正对照：收紧"下游层类型边"之后，**合法**的类型依赖必须仍然绿。三条各自钉一个来源：
    const sharedType = graph.edgesOfId('renderer/src/message/fencing.ts')
      .filter((edge) => edge.typeOnly && edge.target.kind === 'file' && sourceId(edge.target.file).startsWith('shared/'))
    expect(sharedType.length, '纯域 → shared 契约类型（本仓 23 条的主形态）').toBeGreaterThan(0)
    const sameDomainType = graph.edgesOfId('renderer/src/message/attribution.ts')
      .filter((edge) => edge.typeOnly && edge.target.kind === 'file' && sourceId(edge.target.file) === 'renderer/src/message/fencing.ts')
    expect(sameDomainType.length, '纯域 → 同域纯模块类型（fencing 的判据类型）').toBeGreaterThan(0)
    const utilType = graph.edgesOfId('renderer/src/utils/error-message.ts')
      .filter((edge) => edge.typeOnly && edge.target.kind === 'file' && sourceId(edge.target.file) === 'renderer/src/utils/public-error.ts')
    expect(utilType.length, '纯域 → 通用 utils 类型（public-error 的中性形状）').toBeGreaterThan(0)
    const vendoredType = graph.edgesOfId('renderer/src/live2d/adapter.ts')
      .filter((edge) => edge.typeOnly && edge.target.kind === 'file' && sourceId(edge.target.file).startsWith(VENDORED_PREFIX))
    expect(vendoredType.length, '纯域 → vendored 类型（Cubism 类型面）').toBeGreaterThan(0)
  })

  it('纯域面的类型边**只**落在允许的目标上（shared / 同域纯模块 / 通用 utils / vendored）', () => {
    // 这条把上面那条规则的反面说全：不是"某个具体文件没违规"，而是**整片纯域面的类型边集合**
    // 都不含 stores / components / bootstrap。新增的违规类型边会在这里显形（与 Rule 3 第三条互为双保险：
    // 那条按"目标是不是下游层"判，这条按"目标是不是允许层"判）。
    const allowed = (target: string): boolean =>
      target.startsWith('shared/') || target.startsWith('renderer/src/live2d/framework/') ||
      target.startsWith('renderer/src/utils/') ||
      // 同域纯模块：同目录下的其它纯文件（message/ → message/、live2d/ → live2d/ …）
      pureIds.includes(target)
    const offenders: string[] = []
    for (const id of pureIds) {
      for (const edge of graph.edgesOfId(id)) {
        if (!edge.typeOnly || edge.target.kind !== 'file') continue
        const target = sourceId(edge.target.file)
        if (!allowed(target)) offenders.push(`${id}  --[type-only]-->  ${target}`)
      }
    }
    expect(
      offenders,
      '纯域面的类型边落到了允许集合之外（下游层 / 未知层）：\n' + offenders.join('\n')
    ).toEqual([])
  })

  it('store 语义与文件后缀一致：用了 `defineStore` 的文件必须在 `stores/**` 且以 `.store.ts` 结尾', () => {
    // 判据是**行为**（源码里真的调了 defineStore）而不是文件名清单（对抗 review FP-6 实测：
    // 旧实现的 4 项路径白名单会把"新增一个不含 pinia 的协调器"和"重命名已登记的协调器"都判红，
    // 而那两件事都不违反任何规则）。反向也管：叫 `*.store.ts` 却不含 defineStore 同样要求解释。
    const definesStore = (id: string): boolean => /defineStore\s*\(/.test(readFileSync(srcPath(id), 'utf8'))
    const violations: string[] = []
    for (const id of productionRendererIds.filter((candidate) => candidate.endsWith('.ts'))) {
      const namedAsStore = /\.store\.ts$/.test(id)
      const piniaStore = definesStore(id)
      if (piniaStore && !isStore(id)) violations.push(`${id}：调用了 defineStore 却不在 renderer/src/stores/** 下`)
      else if (piniaStore && !namedAsStore) violations.push(`${id}：调用了 defineStore 却不是 *.store.ts 命名`)
      else if (namedAsStore && !piniaStore) violations.push(`${id}：以 .store.ts 命名却没有 defineStore（命名会误导读者）`)
    }
    expect(
      violations,
      'store 的**行为**与文件位置/后缀不一致：\n' +
      `${violations.join('\n')}\n` +
      '修法：Pinia store 一律叫 `renderer/src/stores/<name>.store.ts`；`stores/**` 下的非 store 辅助模块\n' +
      '（如 `session.ts` 身份镜像、`desktop-api.ts` 注入点、`character-runtime-coordinator.ts`）不叫 *.store.ts 即可，\n' +
      '**不需要**回来登记任何清单。'
    ).toEqual([])
    // 非空自证：这条规则必须有测试对象（否则 defineStore 检测退化时会恒真）
    expect(productionRendererIds.filter(definesStore).length, '一个 defineStore 都没检测到——规则已恒真').toBeGreaterThanOrEqual(15)
  })

  it('`stores/**` 下的非 store 辅助模块不叫 *.store.ts（后缀是给读者的信号，不是白名单）', () => {
    // 这条只保留**后缀 ↔ 内容**的一致性，不再维护路径白名单（见上一条的行为判定）。
    // `session.ts` / `desktop-api.ts` / `desktop-api.types.ts` / `character-runtime-coordinator.ts`
    // 都因为"不含 defineStore"而天然通过，新增同类辅助模块同样通过、重命名也通过。
    const storeFiles = graph.files.map(sourceId).filter(isStore)
    const misnamed = storeFiles.filter((id) => !id.endsWith('.store.ts') && !id.endsWith('.ts'))
    expect(misnamed, `stores/ 下出现非 TS 源码：\n${misnamed.join('\n')}`).toEqual([])
    expect(storeFiles.filter((id) => id.endsWith('.store.ts')).length, '扫到的 *.store.ts 太少，后缀约定或扫描器已失效').toBeGreaterThanOrEqual(15)
  })
})

describe('Rule 4 · Renderer bootstrap 只有一个方向：bootstrap → 其余，不得反过来', () => {
  it('除 main.ts / App.vue 外，renderer 内没有任何模块 import renderer bootstrap', () => {
    const offenders: string[] = []
    for (const { from, edge } of graph.forEachEdge()) {
      if (!from.startsWith(RENDERER_PREFIX) || from === 'renderer/src/main.ts' || from === 'renderer/src/App.vue') continue
      if (edge.target.kind !== 'file') continue
      if (sourceId(edge.target.file) === 'renderer/src/bootstrap.ts') offenders.push(describeEdge(from, edge))
    }
    expect(
      offenders,
      'renderer bootstrap 是启动装配层，只能被入口（main.ts / App.vue）使用；被装配的模块不得反向依赖它：\n' +
      `${offenders.join('\n')}\n` +
      '模块需要"装配期注入"的东西时，用参数/回调接收，而不是 import bootstrap 去取。'
    ).toEqual([])
  })

  it('renderer bootstrap 本身可以广泛向下依赖（组合根的正当权利，不被任何规则判红）', () => {
    // renderer 的组合根是**两段**：`main.ts` 直接 import store 并挂载；`bootstrap.ts` 是
    // `createRendererBootstrap(api, stores)` 工厂——store 由 main.ts 传入，它自己只 import 类型与 utils。
    // 这正是组合根该有的形态（装配者知道具体实现），故此处断言"它确实在装配具体层"而不是"依赖很多 store"。
    const mainTargets = new Set(graph.targetsOf(srcPath('renderer/src/main.ts')))
    const mainStores = [...mainTargets].filter((id) => isStore(id))
    expect(mainStores.length, 'main.ts 应直接装配多个 store（renderer 组合根的第一段）').toBeGreaterThanOrEqual(3)
    const bootstrapTargets = new Set(graph.targetsOf(srcPath('renderer/src/bootstrap.ts')))
    expect(bootstrapTargets.has('renderer/src/stores/desktop-api.types.ts'), 'bootstrap 应声明它所需的 API 面类型').toBe(true)
    expect([...bootstrapTargets].some((id) => id.startsWith('renderer/src/utils/')), 'bootstrap 应能取用 renderer utils').toBe(true)
  })

  it('对照：Vue 集成面之间成环**不是**本门禁的判红项（环由 store-graph 专管）', () => {
    // 说明这条对照为什么存在：`components ↔ stores` 之间存在合法的双向引用（组件读 store、
    // store 不 import 组件——但 .vue 之间、store 与 coordinator 之间可以互相引用）。
    // 若这里顺手加一条"全 renderer 无环"，会在合法的框架集成写法上判红，属于典型的过度约束。
    // 本用例只钉住"本 spec 没有把环规则偷偷加进来"这一事实：环规则的唯一所有者是
    // `store-graph.spec.ts`（store 间）与 `main-dependency-graph.spec.ts`（Main 内）。
    const storeToComponent = [...graph.forEachEdge()].filter(
      ({ from, edge }) => isStore(from) && edge.target.kind === 'file' && isComponent(sourceId(edge.target.file))
    )
    expect(storeToComponent, 'store 不应 import 组件（若确属必要，请在此登记并说明）').toEqual([])
  })
})

describe('合法依赖不被误伤（正向对照：这些关系必须保持绿）', () => {
  it('store → 纯域模块（Prompt 4 的正当方向）', () => {
    const expected: ReadonlyArray<readonly [store: string, domain: string]> = [
      ['renderer/src/stores/message.store.ts', 'renderer/src/message/attribution.ts'],
      ['renderer/src/stores/message.store.ts', 'renderer/src/message/fencing.ts'],
      ['renderer/src/stores/conversation.store.ts', 'renderer/src/conversation/protocol.ts'],
      ['renderer/src/stores/voice.store.ts', 'renderer/src/voice/session.ts'],
      ['renderer/src/stores/character-editor.store.ts', 'renderer/src/character-editor/draft-patch.ts']
    ]
    for (const [store, domain] of expected) {
      expect(graph.targetsOf(srcPath(store)), `${store} → ${domain} 这条正当依赖不见了`).toContain(domain)
    }
  })

  it('组件 → store / 组件 → composable / 组件 → 纯域模块', () => {
    const chatInput = graph.targetsOf(srcPath('renderer/src/components/CyChatInput.vue'))
    expect(chatInput.some((id) => isStore(id)), '组件读 store 是正当的').toBe(true)
    expect(chatInput, '组件 → 纯域模块（dictation-hold）').toContain('renderer/src/composer/dictation-hold.ts')
    const live2dPanel = graph.targetsOf(srcPath('renderer/src/components/CyLive2DPanel.vue'))
    expect(live2dPanel, '组件 → 纯域模块（state-machine）').toContain('renderer/src/live2d/state-machine.ts')
  })

  it('纯域模块 → shared 契约 / 通用 utils（允许方向）', () => {
    const targets = graph.targetsOf(srcPath('renderer/src/message/index-store.ts'))
    expect(targets, '纯域模块读 shared 契约是核心允许方向').toContain('shared/contracts/index.ts')
    expect(targets, '纯域模块用真正的通用 util 是被允许的（不制造重复 helper）').toContain('renderer/src/utils/message-order.ts')
  })

  it('两个 Vue 集成文件仍在集成面上、且仍被约束（不是"排除扫描"）', () => {
    // 这两处是**判定结果**而不是豁免：`composables/live2d-state-source.ts` 运行时用 `watch`
    // （整目录分类为集成面，故它在纯域面之外），`utils/document-visibility.ts` 是登记过的框架适配器。
    // 反向价值：两者仍然受 Rule 2（不得碰 main/preload/electron/特权 Node）与 Rule 4 约束。
    for (const id of ['renderer/src/composables/live2d-state-source.ts', 'renderer/src/utils/document-visibility.ts']) {
      expect(isPureRegion(id), `${id} 应被分类为 Vue 集成面`).toBe(false)
      const violations = graph.edgesOfId(id).filter(
        (edge) => edge.target.kind === 'file' &&
          (sourceId((edge.target as { file: string }).file).startsWith('main/') ||
           sourceId((edge.target as { file: string }).file).startsWith('preload/'))
      )
      expect(violations, `${id} 不得因为"不在纯域面"就绕过特权边界规则`).toEqual([])
    }
  })
})

describe('分类 matcher 的可维护性（新目录出现时的行为是明确定义的）', () => {
  it('renderer/src 下的每个顶层条目都能被谓词分类（不存在"无人认领"的文件）', () => {
    const unclassified = rendererIds.filter(
      (id) => !isPureRegion(id) && !isStore(id) && !isComponent(id) && !isComposable(id) &&
        !isRendererBootstrap(id) && !isVue(id) && !isVendored(id) && !VUE_FRAMEWORK_ADAPTERS.includes(id)
    )
    expect(
      unclassified,
      '出现既非纯域、也非任何已知集成面的文件——分类谓词需要更新：\n' + unclassified.join('\n')
    ).toEqual([])
  })

  it('matcher 只用路径前缀与文件名，不硬编码文件清单（新增域模块无需改本文件）', () => {
    // 这条用例是"规则本身"的守卫：把纯域判定写成常量数组时它会红。
    // 判据：`isPureRegion` 对同一目录下的**虚构**文件给出与真实文件一致的答案。
    expect(isPureRegion('renderer/src/message/whatever-new-module.ts')).toBe(true)
    expect(isPureRegion('renderer/src/brand-new-domain/anything.ts')).toBe(true)
    expect(isPureRegion('renderer/src/stores/whatever-new.store.ts')).toBe(false)
    expect(isPureRegion('renderer/src/components/WhateverNew.vue')).toBe(false)
  })

  it('扫描根下的 src 与 vendored 前缀都真实存在（拼错前缀会让排除静默失效）', () => {
    expect(graph.files.map(sourceId).some((id) => id === `${VENDORED_PREFIX}cubismframeworkconfig.ts`)).toBe(true)
    // 声明文件也在扫描面上（对抗 review FN-2：`.d.ts` 里的跨层 import 曾整段隐形）
    expect(isSource('x.ts') && isSource('x.vue') && isSource('x.d.ts')).toBe(true)
    expect(graph.files.map(sourceId)).toContain(`${RENDERER_PREFIX}env.d.ts`)
  })})
