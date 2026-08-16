import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { buildDevCsp } from './src/main/config/dev-csp'
import { getTrustedDevOrigins } from './src/main/config/trusted-renderer-origin'

/** 开发 CSP 中间件（B3）：serve 下对全部响应注入 CSP 头——frame-ancestors 只能经响应头（meta 不支持） */
function devCspPlugin(): Plugin {
  return {
    name: 'cyrene:dev-csp',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Content-Security-Policy', buildDevCsp(getTrustedDevOrigins()))
        next()
      })
    }
  }
}

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
    plugins: [vue(), devCspPlugin()],
    resolve: { alias: { '@renderer': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
    build: {
      // P4-B Task 10：pcm-worklet.js 必须以同源文件 asset 输出（cyrene://renderer），
      // 不能被 Vite 默认 4KB assetsInlineLimit 内联为 data: URL——CSP script-src 'self' 会拦 data:，
      // AudioWorklet.addModule 将加载失败（design §4.8 / D-P7：CSP 零改动）。
      assetsInlineLimit: 0
    }
  }
}))
