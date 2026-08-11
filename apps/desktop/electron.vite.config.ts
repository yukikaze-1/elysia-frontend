import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => ({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: { __APP_MODE__: JSON.stringify(mode) }, // CJS main 文本替换，可靠
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    // 沙箱 preload 只能 require 有限模块，zod 必须 bundle 进产物（externalize → require('zod') 运行时报错，
    // contextBridge 不执行 → window.desktopApi undefined）。main 非沙箱不受限。
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    plugins: [vue()],
    resolve: { alias: { '@renderer': resolve('src/renderer/src'), '@shared': resolve('src/shared') } }
  }
}))
