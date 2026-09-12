import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared')
    }
  },
  test: {
    include: ['tests/integration/**/*.spec.ts'],
    // 套件级钩子（整个套件只跑一次）：回收上次中断运行遗留的测试应用（孤儿 Electron 进程）。
    // 孤儿跨运行累积会与本次运行争抢 CPU/GPU，造成 electron-live2d 等重型 spec 偶发首交互超时。
    globalSetup: ['tests/integration/global-setup.ts'],
    environment: 'node',
    testTimeout: 60000,   // Electron 冷启动 8–20s
    hookTimeout: 60000,   // beforeAll launchApp 冷启动(默认 10000 会在启动前中止)
    fileParallelism: false,
    // 窗口呈现模式（Silent Test Window Mode，2026-09-12）：**默认 silent**，即本套件启动的 Electron
    // 一律不显示窗口/不抢焦点/不进任务栏。可视化调试模式见 vitest.integration.config.visible.mts。
    // 此处刻意不写 `env`：silent 由 helpers/app.ts 与 Main 的 runtime-environment 双层默认，
    // 单一机制（本文件只负责把 visible 那一种显式打开），避免三处各写一次默认值。
  }
})
