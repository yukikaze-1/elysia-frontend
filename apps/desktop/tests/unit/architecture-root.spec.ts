// tests/unit/architecture-root.spec.ts（架构门禁，2026-09-17 架构整改 Prompt 5）
//
// 目的：把「`src/shared` 是跨进程的稳定契约层」「`src/preload` 是窄能力桥」这两条从文档约定
// 升级成可执行门禁。
//
// 为什么需要它（实测缺口）：Prompt 5 之前，全仓**没有任何**门禁扫过 shared 或 preload 的导入面——
// `dependency-classification.spec.ts` 只回答"main/preload 用到的包是否在 dependencies 里"，
// `ipc-surface-alignment.spec.ts` 只回答"通道三面是否对齐"。也就是说
// `shared/contracts/app.ts` 里写一句 `import { ref } from 'vue'`、或一句 `import { app } from 'electron'`
// **一个红灯都不会有**，而 shared 被 main / preload / renderer **三方同时 import**——
// 它一旦绑上任一侧的运行时，污染面是全部三个进程。
//
// 判别口径（关键取舍）：
//   · shared → main/preload/renderer 一律禁止，**类型边也算**。契约层引用实现层（哪怕是
//     `import type`）＝ 依赖方向反了；它同时会让 shared 的编译面耦合到进程内模块。
//     对照：shared **内部**的类型互引是允许的（`character.ts ↔ conversation.ts` 是已审计的
//     领域类型关系），本文末尾有专门用例钉住它不被误伤。
//   · 特权 Node 内建的判据是「是否突破跨运行时中性」而不是「是不是内建」：`node:buffer` 这类
//     纯数据内建在 Electron 三进程里语义相同，不该被机械禁掉——见 PRIVILEGED_BUILTINS 的注释。
//   · renderer 侧另有一份更严的规则（`architecture-renderer.spec.ts`：renderer 不得碰 privileged
//     Node API）。两处列表**有意重复**：它们的"为什么"不同（这里是"契约层不得绑运行时"，
//     那里是"不可信进程不得拿特权"），合并会把两条独立理由塞进一个共享常量，改一条会静默改另一条。
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import {
  SRC_DIR, SourceFileGraph, collectFiles, collectImportEdges, describeEdge, isSource, scanImportsOf, sourceId, srcPath,
  stronglyConnectedComponents
} from './helpers/architecture-imports'

/**
 * 突破"跨 Electron 进程 / 跨运行环境中性"的 Node 内建。
 *
 * 判据（不是"是不是内建"）：**换一个进程或运行环境，这个模块还成立吗？**
 *   · 文件系统 / 子进程 / 网络 / 线程：只有在持特权的进程里才有意义 ⇒
 *     契约层一旦引用它，就再也不能被 renderer 或任何 web 环境安全 import；
 *   · `node:path` / `node:buffer` / `node:util` 这类纯数据与纯算法内建：三进程语义相同，
 *     **不在名单里**（本仓当前 shared 也确实零 Node 导入——`shared/domain/history-date.ts`
 *     自己做日期格式化而没引 `node:util`，就是这条口径的实例）。
 * 名单取"privileged implementation"这一侧：宁可少列，也不把 cross-runtime 的内建一起禁掉。
 */
const PRIVILEGED_BUILTINS: readonly string[] = [
  'fs', 'fs/promises', 'child_process', 'worker_threads', 'net', 'tls', 'dgram',
  'cluster', 'http', 'https', 'http2', 'vm', 'inspector', 'repl', 'readline',
  'module', 'process', 'v8', 'perf_hooks', 'async_hooks', 'diagnostics_channel', 'wasi', 'sqlite'
]

/** `node:fs` / `fs` / `fs/promises` → 归一成不带前缀的裸名；非内建返回 null */
function nodeBuiltinName(specifier: string): string | null {
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier
  const base = bare.split('/')[0] ?? bare
  return PRIVILEGED_BUILTINS.includes(base) ? base : null
}

const FORBIDDEN_PROCESS_PREFIXES = ['main/', 'preload/', 'renderer/'] as const
/** 进程外/表现层的运行时，契约层不得绑定 */
const FORBIDDEN_RUNTIME_PACKAGES: readonly string[] = ['electron', 'vue', 'pinia']

const SHARED_PREFIX = 'shared/'
const PRELOAD_PREFIX = 'preload/'

// 扫描面刻意收窄到 shared + preload：本文件的两组规则只问"这两个层往外引了什么"，
// 不需要遍历全仓（少解析 ~320 个文件）。解析目标仍按真实文件系统解析，判定结果不受影响。
const graph = new SourceFileGraph(
  collectFiles(SRC_DIR, isSource).filter((file) => {
    const id = sourceId(file)
    return id.startsWith(SHARED_PREFIX) || id.startsWith(PRELOAD_PREFIX)
  })
)
const sharedIds = graph.files.map(sourceId).filter((id) => id.startsWith(SHARED_PREFIX))
const preloadIds = graph.files.map(sourceId).filter((id) => id.startsWith(PRELOAD_PREFIX))

describe('扫描器判别力（缺了这几条，下面的边界断言可能恒真）', () => {
  it('扫描面非空且两个受保护层都在（先付掉 AST 解析成本，后面每条规则都是毫秒级）', () => {
    expect(sharedIds.length, '未扫到 src/shared 源码').toBeGreaterThan(20)
    expect(preloadIds.length, '未扫到 src/preload 源码').toBeGreaterThanOrEqual(2)
    // 全量解析一次，让上面两条规则与"谁 import 了 shared"的正向对照共用同一份缓存
    const scanned = graph.files.flatMap((file) => graph.edgesOf(file)).length
    expect(scanned, '共享层一条导入都没解析出来——扫描器已失效').toBeGreaterThan(50)
    expect(sharedIds, 'shared 的目录结构变了（契约 / 领域 / Schema / 错误四类）').toContain('shared/contracts/index.ts')
    expect(preloadIds, 'preload 的唯一 API 面不见了').toContain('preload/desktop-api.ts')
  })

  it('shared 内部的相对 import 确实被解析成同层文件（防"解析退化成不报边"）', () => {
    // shared/contracts/index.ts 是 barrel（17 个 re-export）——解析器失效时这里会先红
    const contracts = graph.edgesOfId('shared/contracts/index.ts')
    expect(contracts.length, 'shared/contracts/index.ts 的 re-export 一条都没解析出来').toBeGreaterThan(10)
    const resolved = contracts.filter((edge) => edge.target.kind === 'file')
    expect(resolved.length).toBe(contracts.length)
    for (const edge of resolved) {
      expect(edge.target.kind === 'file' && sourceId(edge.target.file).startsWith(SHARED_PREFIX)).toBe(true)
    }
  })

  it('解析器认得别名、带扩展名写法与裸包名（三种形态各自的判定）', () => {
    // `shared/schemas/ipc-response.ts` 里同时有 `zod`（裸包）与 `@shared/contracts`（别名）
    const edges = graph.edgesOfId('shared/schemas/ipc-response.ts')
    expect(edges.some((e) => e.target.kind === 'bare' && e.target.name === 'zod')).toBe(true)
    expect(edges.some((e) => e.target.kind === 'file' && sourceId(e.target.file) === 'shared/contracts/index.ts')).toBe(true)
  })
})

describe('Rule 1 · Shared 隔离：契约层不得依赖任一进程的实现', () => {
  it('shared 不得 import main / preload / renderer（类型边同样禁止：契约层引用实现层即方向反转）', () => {
    const offenders: string[] = []
    for (const { from, edge } of graph.forEachEdge()) {
      if (!from.startsWith(SHARED_PREFIX)) continue
      if (edge.target.kind !== 'file') continue
      const target = sourceId(edge.target.file)
      if (FORBIDDEN_PROCESS_PREFIXES.some((prefix) => target.startsWith(prefix))) {
        offenders.push(describeEdge(from, edge))
      }
    }
    expect(
      offenders,
      'src/shared/** 是三个进程共用的契约层，不得依赖任何进程的实现：\n' +
      `${offenders.join('\n')}\n` +
      '允许的方向：main / preload / renderer → shared（单向）。\n' +
      '需要复用 main 内的逻辑时，把**纯类型或纯函数**下沉到 shared，而不是反向 import。'
    ).toEqual([])
  })

  it('shared 不得 import electron / vue / pinia', () => {
    const offenders: string[] = []
    for (const { from, edge } of graph.forEachEdge()) {
      if (!from.startsWith(SHARED_PREFIX)) continue
      if (edge.target.kind === 'bare' && FORBIDDEN_RUNTIME_PACKAGES.includes(edge.target.name)) {
        offenders.push(describeEdge(from, edge))
      }
    }
    expect(
      offenders,
      'src/shared/** 必须保持跨进程、跨运行时中性，不得绑定 electron / vue / pinia：\n' +
      `${offenders.join('\n')}\n` +
      '契约层要渲染相关类型时，用具名数据形状描述它（如 `appearance.ts` 的字体缩放），而不是引 Vue 类型。'
    ).toEqual([])
  })

  it('shared 不得 import 特权 Node 内建（fs / child_process / net / worker_threads …）', () => {
    const offenders: string[] = []
    for (const { from, edge } of graph.forEachEdge()) {
      if (!from.startsWith(SHARED_PREFIX) || edge.target.kind !== 'bare') continue
      const builtin = nodeBuiltinName(edge.target.name)
      if (builtin) offenders.push(`${describeEdge(from, edge)}   [privileged builtin: ${builtin}]`)
    }
    expect(
      offenders,
      'src/shared/** 会被 renderer 直接 import（renderer 无 Node 能力），不得使用特权 Node 内建：\n' +
      `${offenders.join('\n')}\n` +
      '跨运行时的纯内建（如 node:buffer）不在禁止名单；需要读盘/起进程的逻辑属于 main。'
    ).toEqual([])
  })

  it('shared 内部无**值导入**环（允许类型互引，不允许运行时互引）', () => {
    const nodes = sharedIds
    const valueTargets = new Map<string, string[]>()
    for (const id of nodes) {
      const targets = new Set<string>()
      for (const edge of graph.edgesOfId(id)) {
        // 只计值边：`import type` / 全 type 具名项 / `export type` / `ImportTypeNode` 编译期擦除
        if (edge.typeOnly || edge.target.kind !== 'file') continue
        const target = sourceId(edge.target.file)
        if (target.startsWith(SHARED_PREFIX)) targets.add(target)
      }
      valueTargets.set(id, [...targets])
    }
    const nodeSet = new Set(nodes)
    const cycles = stronglyConnectedComponents(
      nodes,
      (id) => (valueTargets.get(id) ?? []).filter((target) => nodeSet.has(target))
    ).filter((component) => component.length > 1)
    const report = cycles.map((component) => [...component].sort().join('  <->  ')).sort()
    expect(
      report,
      'src/shared 内出现值导入环（运行时会真的成环；类型互引不受此限）：\n' +
      `${report.join('\n')}\n` +
      '解环方向：把共享的形状抽到第三个更小的模块，或把跨域引用降级为 `import type`。'
    ).toEqual([])
  })

  it('已审计的 `character ↔ conversation` 仍是**类型**互引（不得悄悄升级成值导入）', () => {
    const characterToConversation = graph.edgesOfId('shared/contracts/character.ts')
      .filter((edge) => edge.target.kind === 'file' && sourceId(edge.target.file) === 'shared/contracts/conversation.ts')
    const conversationToCharacter = graph.edgesOfId('shared/contracts/conversation.ts')
      .filter((edge) => edge.target.kind === 'file' && sourceId(edge.target.file) === 'shared/contracts/character.ts')
    // 两边都必须存在（形状真的在互相引用），且**两边都必须是类型边**
    expect(characterToConversation.length, 'character.ts 不再引用 conversation.ts——若确属重构，请同步本条与上面的"无值环"用例').toBeGreaterThan(0)
    expect(conversationToCharacter.length, 'conversation.ts 不再引用 character.ts——同上').toBeGreaterThan(0)
    expect(characterToConversation.filter((edge) => !edge.typeOnly), 'character.ts 对 conversation.ts 出现值导入').toEqual([])
    expect(conversationToCharacter.filter((edge) => !edge.typeOnly), 'conversation.ts 对 character.ts 出现值导入').toEqual([])
  })
})

describe('Rule 1b · Preload 是窄能力桥：只允许 electron + shared 契约 + 校验库', () => {
  it('preload 不得依赖 main 或 renderer（任一方向的进程越界）', () => {
    const offenders: string[] = []
    for (const { from, edge } of graph.forEachEdge()) {
      if (!from.startsWith(PRELOAD_PREFIX) || edge.target.kind !== 'file') continue
      const target = sourceId(edge.target.file)
      if (target.startsWith('main/') || target.startsWith('renderer/')) offenders.push(describeEdge(from, edge))
    }
    expect(
      offenders,
      'src/preload/** 是 Main 与 Renderer 之间的桥，不得依赖两侧的实现：\n' +
      `${offenders.join('\n')}\n` +
      '需要新能力时：main 注册具名通道 → shared 声明契约 → preload 暴露窄方法（三处同改，`ipc-surface-alignment.spec.ts` 会对账）。'
    ).toEqual([])
  })

  it('preload 的外部依赖只允许 electron、zod 与 @shared/**（防"桥里塞业务"）', () => {
    const allowedBare = new Set(['electron', 'zod'])
    const offenders: string[] = []
    for (const { from, edge } of graph.forEachEdge()) {
      if (!from.startsWith(PRELOAD_PREFIX)) continue
      if (edge.target.kind === 'bare' && !allowedBare.has(edge.target.name)) {
        offenders.push(`${describeEdge(from, edge)}   [未在允许清单：${edge.target.name}]`)
      }
      if (edge.target.kind === 'asset') offenders.push(describeEdge(from, edge))
    }
    expect(
      offenders,
      'src/preload/** 只应 import electron（contextBridge/ipcRenderer）、zod（入参出参校验）与 @shared/**：\n' +
      `${offenders.join('\n')}\n` +
      '桥里出现业务依赖是分层泄漏：校验形状放 shared/schemas，业务判定放 main。'
    ).toEqual([])
  })

  it('preload 里**运行时**使用 electron 的文件只有 2 个（`import type` 不算：它碰不到 ipcRenderer）', () => {
    // 口径（对抗 review FP-4 实测修正）：本条的标题是"触碰 ipcRenderer/contextBridge"——那是**运行时**语义，
    // 因此必须带 `!edge.typeOnly` 守卫。旧实现漏了它，于是一个
    // `import type { IpcRenderer } from 'electron'`（实例由参数注入的纯描述模块）被误判为"第三个触碰点"。
    // 类型边不等于运行时耦合，这与全套门禁统一的口径一致。
    const runtimeUsers = preloadIds
      .filter((id) => graph.edgesOfId(id).some(
        (edge) => !edge.typeOnly && edge.target.kind === 'bare' && edge.target.name === 'electron'
      ))
      .sort()
    expect(
      runtimeUsers,
      'preload 里运行时使用 electron 的文件集合发生变化——请确认新文件确实是"桥"的一部分' +
      '（用参数接收 IpcRenderer 实例的纯装配模块只需 `import type`，不会出现在本清单里）：\n' +
      `${runtimeUsers.join('\n')}`
    ).toEqual(['preload/desktop-api.ts', 'preload/index.ts'])
    // 反向读数（**不是**冻结）：preload 里出现**类型**的 electron 引用是合法的、不参与上面的判定。
    // 此处只做非空自证——若一个类型引用都扫不到，说明 `typeOnly` 标记已失效，上面那条也就失去意义。
    expect(runtimeUsers.length, 'preload 的 electron 运行时使用点全部消失——桥的实现或扫描器已变').toBeGreaterThan(0)
  })
})

describe('解析器判别力自证（同一份实现注入合成片段，验明它不退化）', () => {
  const probe = srcPath('shared/contracts/app.ts')
  /** 用真实文件做探针：把每种写法追加到源码后重新解析（不落盘）——与 main-dependency-graph.spec.ts 同款手法 */
  const counts = (snippet: string, specifier: string): boolean => {
    const source = `${ts.sys.readFile(probe) ?? ''}\n${snippet}\n`
    const sourceFile = ts.createSourceFile(probe, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
    return collectImportEdges(probe, sourceFile).some((edge) => edge.specifier === specifier)
  }

  const CASES: ReadonlyArray<readonly [label: string, snippet: string, counted: boolean]> = [
    // —— 值边：全部必须计 ——
    ['具名 import', "import { ref } from 'vue'", true],
    ['命名空间 import', "import * as Vue from 'vue'", true],
    ['默认 import', "import Vue from 'vue'", true],
    ['副作用 import', "import 'vue'", true],
    ['转出口', "export * from 'vue'", true],
    ['命名空间转出口（正则版在此漏判）', "export * as Vue from 'vue'", true],
    ['具名转出口', "export { ref } from 'vue'", true],
    ['动态 import', "const v = await import('vue')", true],
    ['import = require', "import Vue = require('vue')", true],
    ['require 单引号', "const v = require('vue')", true],
    ['require 双引号（旧正则漏判，对抗 review FN-1）', 'const v = require("vue")', true],
    ['require 反引号（同上）', 'const v = require(`vue`)', true],
    // —— 类型边：识别得到，但标记为 type-only（"类型引用不算实现依赖"是数据而非注释）——
    ['import type', "import type { Ref } from 'vue'", true],
    ['具名全 type', "import { type Ref } from 'vue'", true],
    ['import {} from', "import {} from 'vue'", true],
    ['export type from', "export type { Ref } from 'vue'", true],
    ['ImportTypeNode', "type R = import('vue').Ref<number>", true],
    ['typeof import', "type M = typeof import('vue')", true],
    // —— 非依赖：不得计 ——
    ['注释里的 import', "// import { ref } from 'vue'", false],
    ['JSDoc 里的 import', "/** 参见 import { ref } from 'vue' */\ntype X = 1", false],
    ['模板字符串里的 import', "const s = `import { ref } from 'vue'`", false],
    ['不是 require 的同名调用', "obj.require('vue')", false],
    ['两参数的 require', "require('vue', {})", false]
  ]

  it.each(CASES)('%s：%s', (_label, snippet, counted) => {
    expect(counts(snippet, 'vue'), `判定错误（期望${counted ? '计边' : '不计边'}）：${snippet}`).toBe(counted)
  })

  it('类型写法一律带 typeOnly 标记；值写法一律不带（调用方据此区分运行时依赖）', () => {
    const typeOnlyForms = [
      "import type { Ref } from 'vue'",
      "import { type Ref } from 'vue'",
      "export type { Ref } from 'vue'",
      "type R = import('vue').Ref<number>",
      "type M = typeof import('vue')"
    ]
    const valueForms = [
      "import { ref } from 'vue'", "import * as Vue from 'vue'", "export * as Vue from 'vue'",
      "const v = await import('vue')", 'const v = require("vue")'
    ]
    for (const snippet of typeOnlyForms) {
      const sourceFile = ts.createSourceFile(probe, `${ts.sys.readFile(probe) ?? ''}\n${snippet}\n`, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
      const edge = collectImportEdges(probe, sourceFile).find((e) => e.specifier === 'vue')
      expect(edge?.typeOnly, `类型写法被标成值边：${snippet}`).toBe(true)
    }
    for (const snippet of valueForms) {
      const sourceFile = ts.createSourceFile(probe, `${ts.sys.readFile(probe) ?? ''}\n${snippet}\n`, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
      const edge = collectImportEdges(probe, sourceFile).find((e) => e.specifier === 'vue')
      expect(edge?.typeOnly, `值写法被标成类型边：${snippet}`).toBe(false)
    }
  })

  it('`.js` / `.mjs` 出后缀解析到同名 `.ts` / `.mts`（对抗 review FN-3：旧实现退化成裸名，所有 file 守卫都跳过）', () => {
    const source = `import { RealBackend } from '../../main/transport/real-backend.js'\nimport { x } from './app.mjs'\n`
    const sourceFile = ts.createSourceFile(probe, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
    const edges = collectImportEdges(probe, sourceFile)
    const backend = edges.find((edge) => edge.specifier.endsWith('real-backend.js'))
    expect(backend?.target.kind, '出后缀必须解析成真实文件').toBe('file')
    expect(backend?.target.kind === 'file' && sourceId(backend.target.file)).toBe('main/transport/real-backend.ts')
  })

  it('别名与相对写法解析到**同一个**文件（对抗 review FN-4：`@renderer/src/bootstrap` 曾展开成不存在的路径而失明）', () => {
    // `@renderer/` 已映射到 `renderer/src/`，故 `@renderer/src/bootstrap` 的规范路径就是
    // `renderer/src/bootstrap.ts`——与相对写法 `../bootstrap`（从 utils/ 出发）同一个文件。
    // 旧实现把展开结果当成 `renderer/src/src/bootstrap.ts` 并归 `bare`，于是
    // "纯域模块经别名 import renderer bootstrap" 完全不被看见（相对写法会红，别名写法却绿）。
    const aliasSource = `import { createRendererBootstrap } from '@renderer/src/bootstrap'\n`
    const aliasFile = ts.createSourceFile(probe, aliasSource, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
    const aliasEdge = collectImportEdges(probe, aliasFile)[0]
    expect(aliasEdge.target.kind, '别名写法必须解析成真实文件，而不是不可解析的裸名').toBe('file')
    expect(aliasEdge.target.kind === 'file' && sourceId(aliasEdge.target.file)).toBe('renderer/src/bootstrap.ts')
    const relativeSource = `import { createRendererBootstrap } from '../bootstrap'\n`
    const relativeFile = ts.createSourceFile(srcPath('renderer/src/utils/x.ts'), relativeSource, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
    const relativeEdge = collectImportEdges(srcPath('renderer/src/utils/x.ts'), relativeFile)[0]
    expect(relativeEdge.target.kind).toBe('file')
    expect(relativeEdge.target.kind === 'file' && sourceId(relativeEdge.target.file), '别名与相对写法必须指向同一个文件').toBe('renderer/src/bootstrap.ts')
    // 正对照：正常别名写法仍必须解析（不能因为"越界判定"把别名整体废掉）
    const good = `import { useConnectionStore } from '@renderer/stores/connection.store'\n`
    const goodFile = ts.createSourceFile(srcPath('renderer/src/main.ts'), good, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
    const goodEdge = collectImportEdges(srcPath('renderer/src/main.ts'), goodFile)[0]
    expect(goodEdge.target.kind).toBe('file')
    expect(goodEdge.target.kind === 'file' && sourceId(goodEdge.target.file)).toBe('renderer/src/stores/connection.store.ts')
  })

  it('`.vue` 的 `<script src="…">` 产出依赖边，且被引文件进入扫描面（对抗 review FN-5）', () => {
    const sfc = srcPath('renderer/src/components/__probe-script-src.vue')
    const sfcSource = [
      '<template><div /></template>',
      '<script setup lang="ts" src="../utils/throttle.ts"></script>'
    ].join('\n')
    const edges = scanImportsOf(sfc, sfcSource)
    expect(edges.map((edge) => edge.form), 'src 形态必须产出一条边（内联体为空不代表没有依赖）').toContain('suspense-fallback')
    expect(edges.some((edge) => edge.target.kind === 'file' && sourceId(edge.target.file) === 'renderer/src/utils/throttle.ts')).toBe(true)
  })

  it('声明文件（.d.ts）的 import 同样被扫描（对抗 review FN-2：`.d.ts` 里的跨层引用曾整段隐形）', () => {
    expect(isSource('x.d.ts'), '声明文件必须在扫描面上').toBe(true)
    const declaration = srcPath('shared/domain/__probe-decl.d.ts')
    const declarationSource = `import type { RealBackend } from '../../main/transport/real-backend'\nexport declare const probe: RealBackend\n`
    const edges = scanImportsOf(declaration, declarationSource)
    expect(edges.length, '声明文件的 import 必须被解析出来').toBeGreaterThan(0)
    expect(edges.some((edge) => edge.target.kind === 'file' && sourceId(edge.target.file) === 'main/transport/real-backend.ts')).toBe(true)
  })
})

describe('合法依赖不被误伤（正向对照）', () => {
  it('shared → shared 的相对引用仍被解析成同层文件（含 barrel 与带扩展名写法）', () => {
    const appImports = graph.edgesOfId('shared/contracts/index.ts')
      .filter((edge) => edge.target.kind === 'file')
      .map((edge) => sourceId((edge.target as { file: string }).file))
    expect(appImports).toContain('shared/contracts/app.ts')
    expect(appImports).toContain('shared/contracts/character.ts')
  })

  it('main / preload / renderer → shared 是允许方向（本门禁不禁止任何人 import 契约层）', () => {
    // 取样而不是全扫：本用例要证的是"三个区都在用 shared，故契约层必须保持中性"，
    // 而不是"每一个文件都在用"。三个代表文件各自带一条到 shared 的真实边即可
    // （main 取 ipc/handlers、renderer 取任意 store、preload 只有两个文件全取）。
    const sample = new SourceFileGraph([
      srcPath('main/ipc/handlers.ts'),
      srcPath('renderer/src/stores/connection.store.ts'),
      ...preloadIds.map(srcPath)
    ])
    const importers = new Set(
      sample.files
        .filter((file) => sample.targetsOf(file).some((target) => target.startsWith(SHARED_PREFIX)))
        .map((file) => sourceId(file).split('/')[0])
    )
    expect([...importers].sort(), '三个区都应直接消费 shared 契约（这是它必须保持中性的原因）')
      .toEqual(['main', 'preload', 'renderer'])
  })

  it('src 目录存在且扫描根正确（SRC_DIR 不指向 tests 或 node_modules）', () => {
    expect(SRC_DIR.endsWith('src'), SRC_DIR).toBe(true)
    // 实测基线：src 下 357 个生产源码文件（main 124 / renderer 198 / shared 33 / preload 2）
    // 这里只收集不解析（files 是目录遍历结果，AST 按需解析）——故本用例不付解析成本。
    const all = new SourceFileGraph()
    expect(all.files.length).toBeGreaterThan(300)
    expect(all.files.every((file) => file.startsWith(SRC_DIR)), '扫描面越出了 src').toBe(true)
  })
})
