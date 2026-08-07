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
    testTimeout: 15000
  }
})
