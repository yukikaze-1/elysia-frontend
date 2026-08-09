import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

export default tseslint.config(
  {
    ignores: ['out/**', 'dist/**', 'node_modules/**', '*.d.ts', '**/*.d.ts']
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
        sourceType: 'module'
      }
    },
    rules: {
      // 图标 SVG path 是组件内静态常量(非用户输入),v-html 无 XSS 面
      'vue/no-v-html': 'off'
    }
  },
  {
    rules: {
      // Mock 实现里 `_` 前缀参数表示"本实现不使用但接口要求"
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
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
