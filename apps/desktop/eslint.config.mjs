import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

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
      'src/renderer/src/live2d/framework/**',
      'src/renderer/public/live2d/**'
    ]
  },
  ...tseslint.configs.recommended,
  // 用 essential 而非 recommended:只保留正确性规则,不做格式化噪音(格式化交给后续引入的 Prettier)
  pluginVue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        ecmaVersion: 'latest',
        sourceType: 'module',
        // P1-11：type-aware 规则需要 projectService；`.vue` 是非标准扩展名，必须显式登记，
        // 否则每个 .vue 都报 "was not found by the project service"。
        // 这两项与 parser 必须写在**同一个** parserOptions 里：再开一个 .vue 块设置它们会覆盖本块。
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.vue']
      }
    },
    rules: {
      // 图标 SVG path 是组件内静态常量(非用户输入),v-html 无 XSS 面
      'vue/no-v-html': 'off',
      // P1-11：三条高信号 type-aware 规则同样覆盖 .vue（reason 见下方 ts 块注释）
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error'
    }
  },
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
    // 为什么**不**开 `recommendedTypeChecked` 全集：实测 **1171** 条，绝大多数是风格类
    // （`require-await` 约 250、`no-unnecessary-type-assertion` 约 185），会淹没真正的语义问题；
    // 与门禁加固混在一个提交里做，只能靠批量 disable 收场——那等于用"关规则"冒充"加门禁"。
    // 全集接入属独立一轮。
    //
    // 范围为什么只限 `src/**`：这三条在测试代码里另有 85 条命中，而测试里「发起 promise 不等待」
    // 常是有意为之（故意不 await 的清理等），需逐个判断语义，同属那一独立轮。
    // 生产代码实测仅 **4** 条，已全部当场修完（见本提交）。
    //
    // 注意 `.vue` 的同类规则在上方 .vue 块里（那边必须与 parser/extraFileExtensions 写在一起）。
    files: ['src/**/*.ts', 'src/**/*.mts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error'
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
