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
    environment: 'node',
    testTimeout: 60000,   // Electron 冷启动 8–20s
    hookTimeout: 60000,   // beforeAll launchApp 冷启动(默认 10000 会在启动前中止)
    fileParallelism: false
  }
})
