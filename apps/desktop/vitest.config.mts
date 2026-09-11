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
    // 套件级钩子（整个套件只跑一次）：回收本仓库测试命名空间下遗留的临时目录（P2-6 / L-28）。
    // 实测本机累积 6,720 个 cy* 目录 / 22.6 MB，且绝大多数来自单元 spec（它们 mkdtemp 后从不清理）。
    // 集中回收 + tests/unit/temp-dirs.spec.ts 的防漂移门禁，胜过逐个 spec 补 afterEach。
    globalSetup: ['tests/unit/global-setup.ts'],
    // 全局 setup：提供 Live2D Cubism Core 全局桩（真实运行时由 renderer 的
    // live2dcubismcore.min.js <script> 提供）。缺它则任何「组件 → live2d.store」import 链
    // 会在模块加载期抛 ReferenceError，使无关组件测试以 0 test 崩掉——可测性不该取决于
    // 间接依赖顺序。详见 tests/unit/setup/live2dcubismcore.ts。
    setupFiles: ['tests/unit/setup/live2dcubismcore.ts'],
    // 默认 node 环境（既有纯逻辑/store 测试保持）；组件测试文件头用 `// @vitest-environment happy-dom` 切换
    environment: 'node'
  }
})
