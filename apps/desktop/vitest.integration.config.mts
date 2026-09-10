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
    fileParallelism: false
  }
})
