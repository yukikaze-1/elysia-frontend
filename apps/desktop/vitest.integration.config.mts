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
    // 文件级钩子：回收上次中断运行遗留的测试应用（孤儿 Electron 进程）。孤儿跨运行累积会与
    // 本次运行争抢 CPU/GPU，造成 electron-live2d 等重型 spec 偶发首交互超时。
    setupFiles: ['tests/integration/setup/orphan-apps.setup.ts'],
    environment: 'node',
    testTimeout: 60000,   // Electron 冷启动 8–20s
    hookTimeout: 60000,   // beforeAll launchApp 冷启动(默认 10000 会在启动前中止)
    fileParallelism: false
  }
})
