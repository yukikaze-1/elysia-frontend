import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

// type-aware（需要类型信息的）规则必须知道每个文件属于哪个 tsconfig。
// `projectService` 走 TS 的 project service 自动匹配；`.vue` 是非标准扩展名，还要 `extraFileExtensions`。
// ⚠️ 这两个键与 `parser` **必须写在同一个块里**：再开一个块设 `languageOptions.parserOptions` 会**整体
// 覆盖**掉本块的 parserOptions（flat config 对 parserOptions 是替换而非深合并），`.vue` 会退回按 JS 解析
// 并报 `'>' expected` —— 2026-09-13 实测踩到过（59 个 .vue 全部解析失败）。
const TS_PROJECT = {
  projectService: true,
  tsconfigRootDir: import.meta.dirname
}

export default tseslint.config(
  {
    // 阶段 5 批次 A（Task 1）：vendored Live2D（Framework 源码 59 ts + public Core min.js/13 shaders）三方产物不参与 lint
    // （*.d.ts 已被下方忽略覆盖；public/live2d 的 min.js 为压缩产物，lint 必爆单行表达式错误）
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      '*.d.ts',
      '**/*.d.ts',
      // 2026-09-13：脚本的手写声明文件与 .d.ts 同类（`scripts/*.d.mts`）——它们没有值级代码，
      // 放进来只会得到 "was not found by the project service" 的解析失败（4 处）。
      '**/*.d.mts',
      'src/renderer/src/live2d/framework/**',
      'src/renderer/public/live2d/**'
    ]
  },
  ...tseslint.configs.recommended,
  // 用 essential 而非 recommended:只保留正确性规则,不做格式化噪音(格式化交给后续引入的 Prettier)
  pluginVue.configs['flat/essential'],
  {
    rules: {
      // Mock 实现里 `_` 前缀参数表示"本实现不使用但接口要求"
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  {
    // P1-11（2026-09-11）：**生产代码**接入三条高信号 type-aware 规则。
    //
    // 为什么是这三条：本仓库近几批的真实缺陷都属「异步语义用错 / promise 没人管」——
    // fire-and-forget 的调用抛错无人接、`shell.openExternal` 漏 `.catch`（同文件另一分支却有）、
    // `await` 一个同步函数造成"存在持久化屏障"的错觉。这三条正是抓它们的。
    //
    // P1-11 续（2026-09-13）：**全集接入**。全量 `recommendedTypeChecked` 实测 1238 条命中，
    // 其中生产代码（src/**）约 150 条、其余在测试代码；本轮把生产代码清零并启用全集，
    // 测试代码分区的口径见下方 tests 块。
    //
    // 注意 `.vue` 的同类规则在下方 `<template>` 前那个 .vue 块里（那边必须与 parser/extraFileExtensions 写在一起）。
    files: ['src/**/*.ts', 'src/**/*.mts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: { parserOptions: { ...TS_PROJECT } }
  },
  {
    files: ['**/*.vue'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        ecmaVersion: 'latest',
        sourceType: 'module',
        ...TS_PROJECT,
        extraFileExtensions: ['.vue']
      }
    },
    rules: {
      // 图标 SVG path 是组件内静态常量(非用户输入),v-html 无 XSS 面
      'vue/no-v-html': 'off'
    }
  },
  {
    // Stage H 集成 runner（scripts/integration/**）：与生产代码同口径（全集）。
    files: ['scripts/**/*.ts', 'scripts/**/*.mts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: { parserOptions: { ...TS_PROJECT } }
  },
  {
    // `require-await`：**用实测把这条规则否掉**（2026-09-13，与之前"单测不得 import electron"那次同款做法：
    // 先量，再决定改代码还是改配置）。
    //
    // 实测 64 处命中，**没有一处**是它要抓的缺陷形态（"写了 async 却忘了 await"）：
    //   · 52 处在两个适配器**实现**里（`mock-backend.ts` 38／`real-backend.ts` 14），逐个核对签名——
    //     它们实现 `BackendAdapter` 接口，契约要求返回 `Promise<T>`，而 mock 与部分真实桩本就没有可 await 的
    //     异步步骤，`async` 是满足该契约的惯用写法；
    //   · 其余 12 处（`main/index.ts` mock 采集桩、`ipc/tool-handlers.ts`、`attachments/media-service.ts`、
    //     `tools/tool-service.ts`、`CyCharacterPane.vue`、`conversation.store.ts`）逐处看过，结论相同：
    //     都是"实现 Promise 返回的接口/API"，函数体内没有异步步骤。
    // 而"忘了 await"这个缺陷类**不由它兜**——函数里只要别处有 await，本条就不触发；真正把关的是已开启的
    // `no-floating-promises` / `no-misused-promises` / `await-thenable`。
    // 要"修"这 64 处只能逐个改写成 `f() { return Promise.resolve(x) }`：纯形式改写、零行为收益、
    // 且 52 处落在适配器主路径上。故**关掉并写明理由**，而不是逐处 disable 或批量 disable 别处。
    files: ['src/**/*.ts', 'src/**/*.mts', 'src/**/*.vue', 'scripts/**/*.ts', 'scripts/**/*.mts'],
    rules: { '@typescript-eslint/require-await': 'off' }
  },
  {
    // 测试目录接入 type-aware（2026-09-13，口径 A ＝ **全集**减两条经实测豁免的规则）。
    //
    // 为什么值得做：测试自己吞掉 rejection、或在 `any` 上做断言，会把"实现坏了"伪装成"测试通过"。
    // 实测全集 **455 条 / 74 文件**；其中 208 条 `no-unnecessary-type-assertion` 可自动修，其余逐条判语义后修完。
    // 修法口径：**优先给值标注真实类型**（例如把 `vi.fn((input) => …)` 写成
    // `vi.fn((input: CharacterListQuery) => …)`，类型从 `@shared/contracts` import）——这样契约漂移时
    // 测试会**编译失败**，价值不止于消警；其次才是 `unknown` + 判型收窄。
    //
    // 两条豁免（**有计数、有理由**，与生产侧同款）：
    //   · `require-await` 474 条：`async` 测试替身——它们实现 `Promise<T>` 返回的接口，函数体内没有可 await 的步骤；
    //   · `unbound-method` 73 条：实测绝大多数是 vitest 的 `expect(obj.method).toHaveBeenCalled…` 惯例
    //     （vitest 自己的文档亦建议对该规则豁免），其余是 `originalConfirm = window.confirm` 这类原生
    //     this 无关函数。两者都不是"分离后 this 会指错"的真实风险。
    // 两个口径的实测比较见 docs/review/2026-09-13-type-aware-lint全集接入生产代码-决策记录.md §6。
    files: ['tests/**/*.ts', 'tests/**/*.mts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: { parserOptions: { ...TS_PROJECT } },
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off'
    }
  },
  {
    // .cjs 脚本(scripts/verify-artifact.cjs)以 CommonJS 运行,require 是合法机制,
    // 不在 recommended 的 no-require-imports 规则范围内
    files: ['**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  }
)
