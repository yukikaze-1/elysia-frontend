import { resolve } from 'path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      // 阶段 5 批次 A（Task 5）：适配器 import '@framework/*' 在单测运行时解析到 vendored Framework
      // 真实源码（类型走 ambient live2d/framework.d.ts，见 Task 1 Important B；本测试对用到的模块
      // 经 vi.mock 拦截，未 mock 到的相对导入仍可经 alias 解析）
      '@framework': resolve('src/renderer/src/live2d/framework')
    }
  },
  plugins: [vue()],
  test: {
    include: ['tests/unit/**/*.spec.ts'],
    // 默认 node 环境（既有纯逻辑/store 测试保持）；组件测试文件头用 `// @vitest-environment happy-dom` 切换
    environment: 'node'
  }
})
