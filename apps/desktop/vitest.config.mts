import { resolve } from 'path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared')
    }
  },
  plugins: [vue()],
  test: {
    include: ['tests/unit/**/*.spec.ts'],
    // 默认 node 环境（既有纯逻辑/store 测试保持）；组件测试文件头用 `// @vitest-environment happy-dom` 切换
    environment: 'node'
  }
})
