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
    environment: 'node',
    // 2026-09-13（real-backend-search 一族"偶发"的根因）：vitest 的 happy-dom 环境默认把窗口 URL 设成
    // `http://localhost:3000`，而 happy-dom 会**真的去 fetch 那个地址**建文档（无服务 ⇒ ECONNREFUSED）；
    // 这次 fetch 经常在环境拆卸**之后**才落定，于是抛 "AsyncTaskManager … browser frame is closed"
    // 的**未处理错误**——vitest 把它记到**当时正在跑的那个文件**头上。
    // 实测：全量单测连跑 15 次里 2 次因此变红，且**每次红的文件都不同**（real-backend-search／
    // diagnostics-handlers／session-store 各一次，断言本身与 happy-dom 毫无关系），这正是"重跑即绿"的真身。
    // 改成 about:blank（happy-dom 不发起网络请求）即可根除；若将来有测试真的依赖该 URL，再按需显式指定。
    environmentOptions: { happyDOM: { url: 'about:blank' } },
    // 2026-09-13（同一族"偶发"的第二条根因）：默认 5s 的**单测预算**在机器被压满时会被 I/O 重的用例撞破
    // ——实测复现里红的是 `session-store.spec.ts`（连写 52 条会话）与 `diagnostics-handlers.spec.ts`，
    // 报的是 `Test timed out in 5000ms`，紧随其后还有一条 `ENOTEMPTY: directory not empty, rmdir …`
    // （超时后 afterEach 清理与仍在跑的异步写撞上）。两者成对出现、且**与断言无关**，
    // 属于"预算不够"而不是"产品坏了"。故按实测把预算提到 15s（真卡死仍会被抓住，只是晚 10 秒）；
    // 与集成套件对 flake 的处置口径一致（提预算，而不是加 retry 掩盖）。
    testTimeout: 15_000,
    hookTimeout: 15_000
  }
})
